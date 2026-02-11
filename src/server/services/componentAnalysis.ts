// Spec: spec/services/componentAnalysis.md
import Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { parseJsonResponse } from './claude';
import { readFileContent, SKIP_DIRS } from './git';
import type { ScannedFile } from './git';
import { loadPrompt, renderPrompt } from './prompts';

// ---------- Constants ----------

const ANALYSIS_MODEL = 'claude-opus-4-5-20251101';
const ANALYSIS_INPUT_PRICE = 5;   // $/Mtok
const ANALYSIS_OUTPUT_PRICE = 25;  // $/Mtok
const MAX_TURNS = 40;
const MAX_RETRIES = 5;
const MAX_READ_LINES = 500;
const MAX_CONSECUTIVE_ERRORS = 5;

// ---------- Types ----------

export interface RepoInfo {
  id: string;
  name: string;
  localPath: string;
  files: ScannedFile[];  // paths relative to repo root (not namespaced)
}

interface ComponentData {
  name: string;
  description: string;
  role: string;
  repo: string;
  file_patterns: string[];
  languages: string[];
  security_profile?: {
    summary: string;
    sensitive_areas: Array<{ path: string; reason: string }>;
    threat_surface: string[];
  };
}

interface DependencyData {
  name: string;
  version?: string;
  ecosystem: string;
  repo: string;
  source_repo_url?: string;
}

interface ComponentAnalysisResult {
  components: ComponentData[];
  dependencies?: DependencyData[];
}

// ---------- Tool Definitions ----------

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_directory',
    description: 'List files and directories at the given path in a repository. Returns entry names with sizes for files and trailing / for directories.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo_name: { type: 'string', description: 'The repository name' },
        path: { type: 'string', description: 'Relative path within the repository (use "" or "." for root)' },
      },
      required: ['repo_name', 'path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in a repository. Files longer than 500 lines are truncated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo_name: { type: 'string', description: 'The repository name' },
        path: { type: 'string', description: 'Relative path to the file within the repository' },
      },
      required: ['repo_name', 'path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for code files matching a glob pattern in a repository. Only searches indexed code files (skips node_modules, .git, etc).',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo_name: { type: 'string', description: 'The repository name' },
        pattern: { type: 'string', description: 'Glob pattern to match against file paths (e.g., "src/**/*.ts", "*.json", "**/*auth*")' },
      },
      required: ['repo_name', 'pattern'],
    },
  },
];

// ---------- Retry Helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(err: unknown): number {
  const headers = (err as any)?.headers;
  if (headers) {
    const retryAfter = typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return 60;
}

async function createMessageWithRetry(
  client: Anthropic,
  system: string,
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create({
        model: ANALYSIS_MODEL,
        max_tokens: 16384,
        system,
        tools,
        messages,
      });
    } catch (err: unknown) {
      const status = (err as any)?.status;
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if ((!isRateLimit && !isServerError) || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitSeconds: number;
      if (isRateLimit) {
        waitSeconds = getRetryAfterSeconds(err) + 5;
      } else {
        waitSeconds = Math.min(10 * Math.pow(2, attempt), 120);
      }

      console.log(
        `[ComponentAnalysis] ${isRateLimit ? 'Rate limited' : `Server error (${status})`}. ` +
        `Waiting ${waitSeconds}s before retry ${attempt + 1}/${MAX_RETRIES}...`
      );
      await sleep(waitSeconds * 1000);
    }
  }
  throw new Error('Exhausted all retries calling Claude API');
}

// ---------- Main Entry ----------

// Spec: spec/services/componentAnalysis.md#runComponentAnalysis
export async function runComponentAnalysis(
  pool: Pool,
  projectId: string,
  apiKey: string,
  repoData: RepoInfo[],
  existingAnalysisId?: string,
): Promise<string> {
  // Use pre-created analysis record or create a new one
  let analysisId: string;
  if (existingAnalysisId) {
    analysisId = existingAnalysisId;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO component_analyses (project_id, status)
       VALUES ($1, 'pending') RETURNING id`,
      [projectId]
    );
    analysisId = rows[0].id;
  }

  try {
    await pool.query(
      `UPDATE component_analyses SET status = 'running' WHERE id = $1`,
      [analysisId]
    );

    // Build system prompt with initial repo listings
    const promptTemplate = loadPrompt('component_analysis');
    const repoListParts = repoData.map(repo => {
      const entries = safeReaddir(repo.localPath);
      const listing = entries
        .filter(e => !SKIP_DIRS.has(e.name))
        .map(e => e.isDirectory() ? `${e.name}/` : e.name)
        .sort()
        .join('\n');
      return `### ${repo.name}\n\nTop-level contents:\n\`\`\`\n${listing}\n\`\`\``;
    }).join('\n\n');

    const systemPrompt = renderPrompt(promptTemplate, { repo_list: repoListParts });

    // Initialize conversation
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: 'Please analyze the repositories listed above using the provided tools. Explore the structure, identify components with security profiles, and detect dependencies. Output your final analysis as JSON.',
      },
    ];

    const client = new Anthropic({ apiKey, maxRetries: 0 });
    let turnsUsed = 0;
    let inputTokensUsed = 0;
    let outputTokensUsed = 0;

    let consecutiveErrors = 0;

    // Agentic loop
    while (turnsUsed < MAX_TURNS) {
      const response = await createMessageWithRetry(client, systemPrompt, TOOLS, messages);

      turnsUsed++;
      inputTokensUsed += response.usage.input_tokens;
      outputTokensUsed += response.usage.output_tokens;
      const costUsd = (inputTokensUsed / 1_000_000) * ANALYSIS_INPUT_PRICE +
                       (outputTokensUsed / 1_000_000) * ANALYSIS_OUTPUT_PRICE;

      // Update progress in DB (every 3 turns to reduce DB roundtrips)
      if (turnsUsed % 3 === 0 || response.stop_reason === 'end_turn') {
        await pool.query(
          `UPDATE component_analyses
           SET turns_used = $1, input_tokens_used = $2, output_tokens_used = $3, cost_usd = $4
           WHERE id = $5`,
          [turnsUsed, inputTokensUsed, outputTokensUsed, costUsd, analysisId]
        );
      }

      console.log(
        `[ComponentAnalysis ${analysisId.substring(0, 8)}] Turn ${turnsUsed}/${MAX_TURNS} ` +
        `(${response.usage.input_tokens} in, ${response.usage.output_tokens} out, ` +
        `stop: ${response.stop_reason})`
      );

      if (response.stop_reason === 'end_turn') {
        // Extract final JSON from text content
        const textContent = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('');

        const result = parseJsonResponse<ComponentAnalysisResult>(textContent);

        // Store components and dependencies
        await storeResults(pool, projectId, analysisId, result, repoData);

        // Mark completed
        const finalCost = (inputTokensUsed / 1_000_000) * ANALYSIS_INPUT_PRICE +
                           (outputTokensUsed / 1_000_000) * ANALYSIS_OUTPUT_PRICE;
        await pool.query(
          `UPDATE component_analyses
           SET status = 'completed', completed_at = NOW(), cost_usd = $1
           WHERE id = $2`,
          [finalCost, analysisId]
        );

        // Update project reference
        await pool.query(
          `UPDATE projects SET component_analysis_id = $1, components_analyzed_at = NOW()
           WHERE id = $2`,
          [analysisId, projectId]
        );

        return analysisId;
      }

      if (response.stop_reason === 'tool_use') {
        // Add assistant response to messages
        messages.push({ role: 'assistant', content: response.content as any });

        // Execute tool calls and build tool results
        const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
        let hasError = false;

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            try {
              const toolResult = executeTool(block.name, block.input as Record<string, string>, repoData);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: toolResult,
              });
            } catch (toolErr) {
              hasError = true;
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error executing tool: ${(toolErr as Error).message}`,
                is_error: true,
              });
            }
          }
        }

        // Track consecutive tool errors (#4)
        if (hasError) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error(`Tool execution failed ${MAX_CONSECUTIVE_ERRORS} times consecutively, aborting analysis`);
          }
        } else {
          consecutiveErrors = 0;
        }

        messages.push({ role: 'user', content: toolResults as any });
        continue;
      }

      // max_tokens or unexpected stop_reason
      console.warn(
        `[ComponentAnalysis ${analysisId.substring(0, 8)}] Unexpected stop_reason: ${response.stop_reason}`
      );
      break;
    }

    // Reached max turns or unexpected stop
    throw new Error(`Component analysis did not complete within ${MAX_TURNS} turns`);

  } catch (err) {
    await pool.query(
      `UPDATE component_analyses SET status = 'failed', error_message = $1
       WHERE id = $2`,
      [(err as Error).message, analysisId]
    );
    throw err;
  }
}

// ---------- Tool Execution ----------

function executeTool(
  name: string,
  input: Record<string, string>,
  repoData: RepoInfo[],
): string {
  const repo = repoData.find(r => r.name === input.repo_name);
  if (!repo) {
    return `Error: repository "${input.repo_name}" not found. Available: ${repoData.map(r => r.name).join(', ')}`;
  }

  switch (name) {
    case 'list_directory':
      return executeListDirectory(repo, input.path || '');
    case 'read_file':
      return executeReadFile(repo, input.path);
    case 'search_files':
      return executeSearchFiles(repo, input.pattern);
    default:
      return `Error: unknown tool "${name}"`;
  }
}

function executeListDirectory(repo: RepoInfo, dirPath: string): string {
  const resolved = dirPath === '' || dirPath === '.' ? repo.localPath : path.join(repo.localPath, dirPath);
  // Prevent path traversal outside the repository root
  if (!path.resolve(resolved).startsWith(path.resolve(repo.localPath))) {
    return `Error: path "${dirPath}" is outside repository bounds`;
  }
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = entries
      .filter(e => !SKIP_DIRS.has(e.name))
      .map(e => {
        if (e.isDirectory()) return `${e.name}/`;
        try {
          const stat = fs.statSync(path.join(resolved, e.name));
          return `${e.name} (${formatSize(stat.size)})`;
        } catch {
          return e.name;
        }
      })
      .sort();

    if (lines.length === 0) return '(empty directory)';
    return lines.join('\n');
  } catch {
    return `Error: directory "${dirPath}" not found in ${repo.name}`;
  }
}

function executeReadFile(repo: RepoInfo, filePath: string): string {
  // Prevent path traversal outside the repository root
  const resolved = path.resolve(path.join(repo.localPath, filePath));
  if (!resolved.startsWith(path.resolve(repo.localPath))) {
    return `Error: path "${filePath}" is outside repository bounds`;
  }
  const { content, error } = readFileContent(repo.localPath, filePath);
  if (content === null) {
    if (error === 'path_traversal') return `Error: path "${filePath}" is outside repository bounds`;
    return `Error: file "${filePath}" not found or unreadable in ${repo.name}`;
  }

  const lines = content.split('\n');
  if (lines.length > MAX_READ_LINES) {
    return lines.slice(0, MAX_READ_LINES).join('\n') +
      `\n\n... (truncated, ${lines.length - MAX_READ_LINES} more lines)`;
  }
  return content;
}

function executeSearchFiles(repo: RepoInfo, pattern: string): string {
  const matches = repo.files
    .filter(f => minimatch(f.relativePath, pattern))
    .map(f => f.relativePath)
    .sort();

  if (matches.length === 0) return `No files matching "${pattern}" in ${repo.name}`;
  if (matches.length > 100) {
    return matches.slice(0, 100).join('\n') + `\n\n... (${matches.length - 100} more matches)`;
  }
  return matches.join('\n');
}

// ---------- Store Results ----------

async function storeResults(
  pool: Pool,
  projectId: string,
  analysisId: string,
  result: ComponentAnalysisResult,
  repoData: RepoInfo[],
): Promise<void> {
  // Remove old components not referenced by any audit or finding (#19)
  await pool.query(
    `DELETE FROM components
     WHERE project_id = $1
     AND id NOT IN (SELECT component_id FROM audit_components WHERE component_id IS NOT NULL)
     AND id NOT IN (SELECT component_id FROM audit_findings WHERE component_id IS NOT NULL)`,
    [projectId]
  );

  // Remove old dependencies (always safe to recreate)
  await pool.query(
    `DELETE FROM project_dependencies WHERE project_id = $1`,
    [projectId]
  );

  // Insert components
  for (const comp of result.components) {
    const repo = repoData.find(r => r.name === comp.repo);
    if (!repo) {
      console.warn(`[ComponentAnalysis] Skipping component "${comp.name}": repo "${comp.repo}" not found`);
      continue;
    }

    // Match file patterns against scanned files for counts
    const matchingFiles = repo.files.filter(f =>
      comp.file_patterns.some(pattern => minimatch(f.relativePath, pattern))
    );
    const estimatedFiles = matchingFiles.length;
    const estimatedTokens = matchingFiles.reduce((sum, f) => sum + f.roughTokens, 0);

    await pool.query(
      `INSERT INTO components
       (project_id, repo_id, name, description, role, file_patterns, languages,
        security_profile, estimated_files, estimated_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        projectId,
        repo.id,
        comp.name,
        comp.description,
        comp.role || null,
        comp.file_patterns,
        comp.languages || [],
        comp.security_profile ? JSON.stringify(comp.security_profile) : null,
        estimatedFiles,
        estimatedTokens,
      ]
    );
  }

  // Insert dependencies
  if (result.dependencies) {
    for (const dep of result.dependencies) {
      const repo = repoData.find(r => r.name === dep.repo);
      const repoId = repo?.id || null;

      if (repoId) {
        // With repo_id: use ON CONFLICT for upsert (UNIQUE constraint covers this case)
        await pool.query(
          `INSERT INTO project_dependencies
           (project_id, repo_id, name, version, ecosystem, source_repo_url)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, repo_id, name, ecosystem) DO UPDATE SET
             version = EXCLUDED.version, source_repo_url = EXCLUDED.source_repo_url`,
          [projectId, repoId, dep.name, dep.version || null, dep.ecosystem, dep.source_repo_url || null]
        );
      } else {
        // Without repo_id: NULL defeats UNIQUE constraint, check for existing row manually
        const { rows: existing } = await pool.query(
          `SELECT id FROM project_dependencies
           WHERE project_id = $1 AND repo_id IS NULL AND name = $2 AND ecosystem = $3`,
          [projectId, dep.name, dep.ecosystem]
        );
        if (existing.length > 0) {
          await pool.query(
            `UPDATE project_dependencies SET version = $1, source_repo_url = $2 WHERE id = $3`,
            [dep.version || null, dep.source_repo_url || null, existing[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO project_dependencies
             (project_id, repo_id, name, version, ecosystem, source_repo_url)
             VALUES ($1, NULL, $2, $3, $4, $5)`,
            [projectId, dep.name, dep.version || null, dep.ecosystem, dep.source_repo_url || null]
          );
        }
      }
    }
  }
}

// ---------- Helpers ----------

function safeReaddir(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
