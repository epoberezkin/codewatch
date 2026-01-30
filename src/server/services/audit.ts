import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { callClaude, parseJsonResponse } from './claude';
import { cloneOrUpdate, scanCodeFiles, readFileContent, getHeadSha, getDefaultBranchName, diffBetweenCommits } from './git';
import type { ScannedFile } from './git';
import { roughTokenCount } from './tokens';
import { createIssue } from './github';

// ---------- Types ----------

interface ClassificationResult {
  category: string;
  description: string;
  involved_parties: Record<string, unknown>;
  components: Array<{ repo: string; role: string; languages: string[] }>;
  threat_model_found: boolean;
  threat_model_files: string[];
  threat_model: {
    evaluation?: string;
    generated?: string;
    parties: Array<{ name: string; can: string[]; cannot: string[] }>;
  };
}

interface FindingResult {
  severity: string;
  cwe_id: string;
  cvss_score: number;
  file: string;
  line_start: number;
  line_end: number;
  title: string;
  description: string;
  exploitation: string;
  recommendation: string;
  code_snippet: string;
}

interface AnalysisResult {
  findings: FindingResult[];
  responsible_disclosure: Record<string, string>;
  dependencies: Array<{ name: string; concern: string }>;
  security_posture: string;
}

interface AuditOptions {
  auditId: string;
  projectId: string;
  level: 'full' | 'thorough' | 'opportunistic';
  apiKey: string;
  baseAuditId?: string;
}

// Security-critical path patterns for thorough mode
const SECURITY_CRITICAL_PATTERNS = [
  /\bauth\b/i, /\bcrypto\b/i, /\bapi\b/i, /\broute/i, /\bmiddleware\b/i,
  /\bhandler/i, /\bcontroller/i, /\bmodel/i, /\bdb\b/i, /\bdatabase\b/i,
  /\bconfig\b/i, /\bsecur/i, /\bsession\b/i, /\btoken\b/i, /\bpassword\b/i,
  /\bpermission\b/i, /\baccess\b/i, /\bvalidat/i, /\bsaniti/i,
];

const MAX_BATCH_TOKENS = 150000;

// ---------- Prompt Loading ----------

function loadPrompt(name: string): string {
  const promptsDir = path.join(__dirname, '..', '..', '..', 'prompts');
  let filePath = path.join(promptsDir, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    // Try from source directory
    const altDir = path.join(__dirname, '..', '..', 'prompts');
    filePath = path.join(altDir, `${name}.md`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// ---------- Main Orchestrator ----------

export async function runAudit(pool: Pool, options: AuditOptions): Promise<void> {
  const { auditId, projectId, level, apiKey } = options;
  let actualCostUsd = 0;

  try {
    // ---- Step 0: Clone repos ----
    await updateStatus(pool, auditId, 'cloning');

    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, r.repo_path
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1`,
      [projectId]
    );

    const repoData: Array<{
      id: string;
      name: string;
      url: string;
      localPath: string;
      headSha: string;
      branch: string;
      files: ScannedFile[];
    }> = [];

    for (const repo of repos) {
      const { localPath, headSha } = await cloneOrUpdate(repo.repo_url);
      const branch = await getDefaultBranchName(localPath);

      // Record commit
      await pool.query(
        `INSERT INTO audit_commits (audit_id, repo_id, commit_sha, branch)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (audit_id, repo_id) DO UPDATE SET commit_sha = $3, branch = $4`,
        [auditId, repo.id, headSha, branch]
      );

      const files = scanCodeFiles(localPath).map(f => ({
        ...f,
        relativePath: `${repo.repo_name}/${f.relativePath}`,
      }));

      repoData.push({
        id: repo.id,
        name: repo.repo_name,
        url: repo.repo_url,
        localPath,
        headSha,
        branch,
        files,
      });
    }

    const allFiles = repoData.flatMap(r => r.files);

    // Update audit stats
    await pool.query(
      `UPDATE audits SET total_files = $1, total_tokens = $2, started_at = NOW() WHERE id = $3`,
      [allFiles.length, roughTokenCount(allFiles), auditId]
    );

    // ---- Incremental: compute diff and inherit findings ----
    let filesToAnalyzeOverride: ScannedFile[] | null = null;
    let inheritedFindingCount = 0;

    if (options.baseAuditId) {
      // Get base audit's commits per repo
      const { rows: baseCommits } = await pool.query(
        `SELECT ac.repo_id, ac.commit_sha, r.repo_name
         FROM audit_commits ac
         JOIN repositories r ON r.id = ac.repo_id
         WHERE ac.audit_id = $1`,
        [options.baseAuditId]
      );

      const diffFilesAdded: string[] = [];
      const diffFilesModified: string[] = [];
      const diffFilesDeleted: string[] = [];
      const renamedPaths: Array<{ from: string; to: string; repoName: string }> = [];

      for (const repo of repoData) {
        const baseCommit = baseCommits.find(c => c.repo_id === repo.id);
        if (!baseCommit) {
          // Repo wasn't in base audit — all files are new
          for (const f of repo.files) {
            diffFilesAdded.push(f.relativePath);
          }
          continue;
        }

        if (baseCommit.commit_sha === repo.headSha) {
          // No changes in this repo
          continue;
        }

        const diff = await diffBetweenCommits(repo.localPath, baseCommit.commit_sha, repo.headSha);

        for (const f of diff.added) {
          diffFilesAdded.push(`${repo.name}/${f}`);
        }
        for (const f of diff.modified) {
          diffFilesModified.push(`${repo.name}/${f}`);
        }
        for (const f of diff.deleted) {
          diffFilesDeleted.push(`${repo.name}/${f}`);
        }
        for (const r of diff.renamed) {
          renamedPaths.push({ from: `${repo.name}/${r.from}`, to: `${repo.name}/${r.to}`, repoName: repo.name });
        }
      }

      // Update diff stats
      await pool.query(
        `UPDATE audits SET diff_files_added = $1, diff_files_modified = $2, diff_files_deleted = $3 WHERE id = $4`,
        [diffFilesAdded.length, diffFilesModified.length, diffFilesDeleted.length, auditId]
      );

      // Only analyze added + modified files
      const changedPaths = new Set([...diffFilesAdded, ...diffFilesModified]);
      filesToAnalyzeOverride = allFiles.filter(f => changedPaths.has(f.relativePath));

      // Inherit open findings from base audit
      const { rows: baseFindings } = await pool.query(
        `SELECT * FROM audit_findings WHERE audit_id = $1 AND status = 'open'`,
        [options.baseAuditId]
      );

      for (const finding of baseFindings) {
        let filePath = finding.file_path;
        let status = finding.status;

        // Check if file was deleted
        if (diffFilesDeleted.includes(filePath)) {
          status = 'fixed';
        }

        // Check if file was renamed
        const rename = renamedPaths.find(r => r.from === filePath);
        if (rename) {
          filePath = rename.to;
        }

        // Insert inherited finding (with new audit ID)
        await pool.query(
          `INSERT INTO audit_findings
           (audit_id, repo_id, file_path, line_start, line_end, fingerprint,
            severity, cwe_id, cvss_score, title, description, exploitation,
            recommendation, code_snippet, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            auditId, finding.repo_id, filePath,
            finding.line_start, finding.line_end, finding.fingerprint,
            finding.severity, finding.cwe_id, finding.cvss_score,
            finding.title, finding.description, finding.exploitation,
            finding.recommendation, finding.code_snippet, status,
          ]
        );
        inheritedFindingCount++;
      }

      // Mark base findings in deleted files as resolved in this audit
      if (diffFilesDeleted.length > 0) {
        await pool.query(
          `UPDATE audit_findings
           SET resolved_in_audit_id = $1
           WHERE audit_id = $2 AND file_path = ANY($3) AND status = 'open'`,
          [auditId, options.baseAuditId, diffFilesDeleted]
        );
      }
    }

    // ---- Step 1: Classification ----
    const { rows: existingProject } = await pool.query(
      'SELECT category FROM projects WHERE id = $1',
      [projectId]
    );

    let classification: ClassificationResult | null = null;
    if (!existingProject[0].category) {
      await updateStatus(pool, auditId, 'classifying');
      console.log(`[Audit ${auditId.substring(0, 8)}] Classifying project...`);
      classification = await classifyProject(pool, projectId, auditId, apiKey, repoData);
      console.log(`[Audit ${auditId.substring(0, 8)}] Classification complete: ${classification.category}`);
      actualCostUsd += 0.05; // approximate classification cost
    } else {
      // Load existing classification
      const { rows: proj } = await pool.query(
        'SELECT category, description, involved_parties, threat_model FROM projects WHERE id = $1',
        [projectId]
      );
      classification = {
        category: proj[0].category,
        description: proj[0].description || '',
        involved_parties: proj[0].involved_parties || {},
        components: [],
        threat_model_found: false,
        threat_model_files: [],
        threat_model: { parties: [] },
      };
    }

    // ---- Step 2: Select files for analysis ----
    await updateStatus(pool, auditId, 'analyzing');
    // For incremental audits, only analyze changed files; for fresh audits, apply level selection
    const filesToAnalyze = filesToAnalyzeOverride || selectFiles(allFiles, level);

    await pool.query(
      `UPDATE audits SET files_to_analyze = $1, tokens_to_analyze = $2 WHERE id = $3`,
      [filesToAnalyze.length, roughTokenCount(filesToAnalyze), auditId]
    );

    // Initialize progress detail
    const progressDetail = filesToAnalyze.map(f => ({
      file: f.relativePath,
      status: 'pending',
      findingsCount: 0,
    }));
    await pool.query(
      `UPDATE audits SET progress_detail = $1 WHERE id = $2`,
      [JSON.stringify(progressDetail), auditId]
    );

    // ---- Step 3: Batch and analyze ----
    const batches = createBatches(filesToAnalyze, repoData);
    const systemPrompt = buildSystemPrompt(classification, level);
    let totalFindings = 0;
    let batchesSucceeded = 0;
    let batchesFailed = 0;
    let lastBatchError = '';

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(
        `[Audit ${auditId.substring(0, 8)}] Processing batch ${i + 1}/${batches.length} ` +
        `(${batch.files.length} files, ~${batch.totalTokens} tokens)...`
      );

      // Build user message with file contents
      const fileContents = batch.files.map(f => {
        const [repoName, ...rest] = f.relativePath.split('/');
        const relPath = rest.join('/');
        const repo = repoData.find(r => r.name === repoName);
        if (!repo) return `// File: ${f.relativePath}\n// Could not read file`;
        const content = readFileContent(repo.localPath, relPath);
        return `// File: ${f.relativePath}\n${content || '// Could not read file'}`;
      }).join('\n\n---\n\n');

      // For incremental audits: include context about previous findings for modified files
      let previousFindingsContext = '';
      if (options.baseAuditId) {
        const batchFilePaths = batch.files.map(f => f.relativePath);
        const { rows: prevFindings } = await pool.query(
          `SELECT file_path, title, severity, description
           FROM audit_findings
           WHERE audit_id = $1 AND file_path = ANY($2)`,
          [options.baseAuditId, batchFilePaths]
        );
        if (prevFindings.length > 0) {
          previousFindingsContext = `\n\nPrevious audit findings for these files (check if still present or resolved):\n${
            prevFindings.map(f => `- [${f.severity}] ${f.title} in ${f.file_path}: ${f.description.substring(0, 150)}`).join('\n')
          }\n`;
        }
      }

      const userMessage = `Analyze the following source code files:\n\n${fileContents}${previousFindingsContext}`;

      try {
        const response = await callClaude(apiKey, systemPrompt, userMessage);
        actualCostUsd += estimateCallCost(response.inputTokens, response.outputTokens);
        console.log(
          `[Audit ${auditId.substring(0, 8)}] Batch ${i + 1}/${batches.length} complete ` +
          `(${response.inputTokens} in, ${response.outputTokens} out)`
        );

        const result = parseJsonResponse<AnalysisResult>(response.content);

        // Insert findings (with dedup for incremental audits)
        for (const finding of result.findings) {
          const repoName = finding.file.split('/')[0];
          const repo = repoData.find(r => r.name === repoName);
          const fingerprint = generateFingerprint(finding);

          // For incremental audits: skip if inherited finding with same fingerprint exists
          if (options.baseAuditId) {
            const { rows: existing } = await pool.query(
              'SELECT id FROM audit_findings WHERE audit_id = $1 AND fingerprint = $2',
              [auditId, fingerprint]
            );
            if (existing.length > 0) continue; // Already inherited
          }

          await pool.query(
            `INSERT INTO audit_findings
             (audit_id, repo_id, file_path, line_start, line_end, fingerprint,
              severity, cwe_id, cvss_score, title, description, exploitation,
              recommendation, code_snippet)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              auditId, repo?.id || null, finding.file,
              finding.line_start, finding.line_end, fingerprint,
              finding.severity, finding.cwe_id, finding.cvss_score,
              finding.title, finding.description, finding.exploitation,
              finding.recommendation, finding.code_snippet,
            ]
          );
          totalFindings++;
        }

        // Update progress
        for (const f of batch.files) {
          const entry = progressDetail.find(p => p.file === f.relativePath);
          if (entry) {
            entry.status = 'done';
            entry.findingsCount = result.findings.filter(
              finding => finding.file === f.relativePath
            ).length;
          }
        }
        batchesSucceeded++;
      } catch (err) {
        console.error(`[Audit ${auditId.substring(0, 8)}] Batch ${i + 1}/${batches.length} failed:`, err);
        batchesFailed++;
        lastBatchError = (err as Error).message || String(err);
        for (const f of batch.files) {
          const entry = progressDetail.find(p => p.file === f.relativePath);
          if (entry) entry.status = 'error';
        }
      }

      // Update progress in DB
      const filesAnalyzed = progressDetail.filter(p => p.status === 'done' || p.status === 'error').length;
      await pool.query(
        `UPDATE audits SET files_analyzed = $1, progress_detail = $2 WHERE id = $3`,
        [filesAnalyzed, JSON.stringify(progressDetail), auditId]
      );

      // Stop immediately on first failure — don't waste money on remaining batches
      if (batchesFailed > 0) break;
    }

    // ---- Fail if analysis is incomplete ----
    // For security audits, partial results are worse than no results —
    // a report missing batches could hide critical findings and give false confidence.
    if (batchesFailed > 0) {
      const msg = batchesSucceeded === 0
        ? `All ${batchesFailed} analysis batches failed. ${lastBatchError}`
        : `${batchesFailed} of ${batches.length} analysis batches failed — ` +
          `incomplete analysis cannot produce a reliable security report. ${lastBatchError}`;
      console.error(`[Audit ${auditId.substring(0, 8)}] ${msg}`);
      await pool.query(
        `UPDATE audits SET status = 'failed', error_message = $1, actual_cost_usd = $2 WHERE id = $3`,
        [msg, actualCostUsd, auditId]
      );
      return;
    }

    // ---- Step 4: Synthesis ----
    await updateStatus(pool, auditId, 'synthesizing');
    console.log(`[Audit ${auditId.substring(0, 8)}] Synthesizing report from ${totalFindings} findings...`);

    const { rows: allFindings } = await pool.query(
      `SELECT severity, title, file_path, description FROM audit_findings WHERE audit_id = $1`,
      [auditId]
    );

    const synthesisPrompt = `Synthesize the following security audit findings into an executive summary and overall security posture assessment.

Project: ${classification.description || 'Unknown'}
Category: ${classification.category || 'Unknown'}
Total findings: ${allFindings.length}

Findings summary:
${allFindings.map(f => `- [${f.severity}] ${f.title} in ${f.file_path}: ${f.description.substring(0, 100)}`).join('\n')}

Return JSON: {
  "executive_summary": "2-3 paragraph executive summary",
  "security_posture": "overall security assessment paragraph",
  "responsible_disclosure": { "contact": "...", "policy": "..." }
}`;

    try {
      const synthResponse = await callClaude(apiKey, 'You are a security audit report writer. Return valid JSON only.', synthesisPrompt);
      actualCostUsd += estimateCallCost(synthResponse.inputTokens, synthResponse.outputTokens);
      const synthesis = parseJsonResponse<any>(synthResponse.content);

      // Compute max severity
      const severityOrder = ['critical', 'high', 'medium', 'low', 'informational', 'none'];
      let maxSev = 'none';
      for (const f of allFindings) {
        if (severityOrder.indexOf(f.severity) < severityOrder.indexOf(maxSev)) {
          maxSev = f.severity;
        }
      }

      // Compute publishable_after based on severity
      let publishableAfter = null;
      if (maxSev === 'critical') {
        publishableAfter = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000); // 6 months
      } else if (maxSev === 'high' || maxSev === 'medium') {
        publishableAfter = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000); // 3 months
      }

      await pool.query(
        `UPDATE audits SET
          report_summary = $1,
          max_severity = $2,
          actual_cost_usd = $3,
          publishable_after = $4,
          status = 'completed',
          completed_at = NOW()
         WHERE id = $5`,
        [
          JSON.stringify(synthesis),
          maxSev,
          actualCostUsd,
          publishableAfter,
          auditId,
        ]
      );

      // ---- Step 5: Notify owner if non-owner audit ----
      await notifyOwnerIfNeeded(pool, auditId, projectId, allFindings.length, maxSev);
    } catch (err) {
      console.error('Synthesis error:', err);
      // Complete without synthesis
      await pool.query(
        `UPDATE audits SET
          status = 'completed',
          actual_cost_usd = $1,
          completed_at = NOW()
         WHERE id = $2`,
        [actualCostUsd, auditId]
      );
    }
  } catch (err) {
    console.error('Audit error:', err);
    await pool.query(
      `UPDATE audits SET status = 'failed', error_message = $1, actual_cost_usd = $2 WHERE id = $3`,
      [(err as Error).message, actualCostUsd, auditId]
    );
  }
}

// ---------- Classification ----------

async function classifyProject(
  pool: Pool,
  projectId: string,
  auditId: string,
  apiKey: string,
  repoData: Array<{ name: string; localPath: string; files: ScannedFile[] }>
): Promise<ClassificationResult> {
  // Build repo listing
  const repoListParts: string[] = [];
  for (const repo of repoData) {
    const dirTree = repo.files.map(f => f.relativePath).sort().join('\n');
    const readmeContent = readFileContent(repo.localPath, 'README.md') || '';
    repoListParts.push(
      `## Repository: ${repo.name}\n\nDirectory structure:\n${dirTree}\n\nREADME:\n${readmeContent.substring(0, 5000)}`
    );
  }

  const classifyPrompt = loadPrompt('classify');
  const userMessage = renderPrompt(classifyPrompt, { repo_list: repoListParts.join('\n\n---\n\n') });

  const response = await callClaude(
    apiKey,
    'You are a software classification expert. Analyze projects and respond with valid JSON only.',
    userMessage,
  );

  const classification = parseJsonResponse<ClassificationResult>(response.content);

  // Store classification in project
  await pool.query(
    `UPDATE projects SET
      category = $1,
      description = $2,
      involved_parties = $3,
      threat_model = $4,
      threat_model_source = $5,
      classification_audit_id = $6
     WHERE id = $7`,
    [
      classification.category,
      classification.description,
      JSON.stringify(classification.involved_parties),
      classification.threat_model?.generated || JSON.stringify(classification.threat_model),
      classification.threat_model_found ? 'repo' : 'generated',
      auditId,
      projectId,
    ]
  );

  return classification;
}

// ---------- File Selection ----------

function selectFiles(allFiles: ScannedFile[], level: string): ScannedFile[] {
  if (level === 'full') return allFiles;

  // Score files by security criticality
  const scored = allFiles.map(f => ({
    ...f,
    score: SECURITY_CRITICAL_PATTERNS.reduce(
      (s, p) => s + (p.test(f.relativePath) ? 1 : 0), 0
    ),
  }));
  scored.sort((a, b) => b.score - a.score);

  if (level === 'thorough') {
    const count = Math.ceil(allFiles.length * 0.33);
    return scored.slice(0, count);
  }
  if (level === 'opportunistic') {
    const count = Math.ceil(allFiles.length * 0.10);
    return scored.slice(0, Math.max(1, count));
  }

  return allFiles;
}

// ---------- Batching ----------

interface Batch {
  files: ScannedFile[];
  totalTokens: number;
}

function createBatches(
  files: ScannedFile[],
  repoData: Array<{ name: string; localPath: string }>
): Batch[] {
  // Sort by directory to keep related code together
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const batches: Batch[] = [];
  let currentBatch: ScannedFile[] = [];
  let currentTokens = 0;

  for (const file of sorted) {
    if (currentTokens + file.roughTokens > MAX_BATCH_TOKENS && currentBatch.length > 0) {
      batches.push({ files: currentBatch, totalTokens: currentTokens });
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(file);
    currentTokens += file.roughTokens;
  }

  if (currentBatch.length > 0) {
    batches.push({ files: currentBatch, totalTokens: currentTokens });
  }

  return batches;
}

// ---------- System Prompt ----------

function buildSystemPrompt(classification: ClassificationResult, level: string): string {
  const systemTemplate = loadPrompt('system');
  const levelPrompt = loadPrompt(level);

  const systemPrompt = renderPrompt(systemTemplate, {
    category: classification.category || 'unknown',
    description: classification.description || '',
    components: JSON.stringify(classification.components || []),
    involved_parties: JSON.stringify(classification.involved_parties || {}),
    threat_model: classification.threat_model?.generated
      || JSON.stringify(classification.threat_model?.parties || []),
  });

  return `${systemPrompt}\n\n${levelPrompt}`;
}

// ---------- Helpers ----------

async function updateStatus(pool: Pool, auditId: string, status: string): Promise<void> {
  await pool.query('UPDATE audits SET status = $1 WHERE id = $2', [status, auditId]);
}

function generateFingerprint(finding: FindingResult): string {
  // Simple fingerprint for dedup across incremental audits
  const raw = `${finding.file}:${finding.title}:${finding.code_snippet?.substring(0, 100) || ''}`;
  // Use a simple hash
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

function estimateCallCost(inputTokens: number, outputTokens: number): number {
  // Default to Opus 4.5 pricing: $5/Mtok input, $25/Mtok output
  return (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25;
}

// ---------- Owner Notification ----------

async function notifyOwnerIfNeeded(
  pool: Pool,
  auditId: string,
  projectId: string,
  findingsCount: number,
  maxSeverity: string,
): Promise<void> {
  try {
    // Get audit and project info
    const { rows } = await pool.query(
      `SELECT a.is_owner, a.requester_id, p.github_org, p.name as project_name,
              s.github_token
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN sessions s ON s.user_id = a.requester_id AND s.expires_at > NOW()
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0 || rows[0].is_owner) return; // Owner ran it, no notification needed

    const { github_org, project_name, github_token } = rows[0];
    if (!github_token) return; // Can't create issue without token

    // Find the first repo in the project (for issue creation)
    const { rows: repoRows } = await pool.query(
      `SELECT r.repo_name FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1
       ORDER BY r.stars DESC NULLS LAST
       LIMIT 1`,
      [projectId]
    );
    if (repoRows.length === 0) return;

    const repoName = repoRows[0].repo_name;
    const title = `[CodeWatch] Security audit completed - ${findingsCount} finding${findingsCount !== 1 ? 's' : ''} (max: ${maxSeverity})`;
    const body = `A community member has run a security audit on **${project_name}** using [CodeWatch](https://codewatch.dev).

**Results:**
- Total findings: ${findingsCount}
- Maximum severity: ${maxSeverity}
- Audit ID: \`${auditId}\`

As the project owner, you have full access to all findings. Visit CodeWatch to view the complete report, add comments, and publish the report when ready.

---
*This issue was automatically created by CodeWatch. The audit was sponsored by a community member to improve this project's security.*`;

    await createIssue(github_token, github_org, repoName, title, body);

    // Mark owner as notified
    await pool.query('UPDATE audits SET owner_notified = TRUE WHERE id = $1', [auditId]);
  } catch (err) {
    // Non-critical: log but don't fail the audit
    console.error('Failed to notify owner:', err);
  }
}
