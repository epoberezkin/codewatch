// Spec: spec/services/planning.md
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { callClaude, parseJsonResponse } from './claude';
import type { ScannedFile } from './git';
import { loadPrompt, renderPrompt } from './prompts';
import { BUDGET_PERCENTAGES } from './tokens';

// ---------- Constants ----------

const PLANNING_MODEL = 'claude-opus-4-5-20251101';
const TARGET_FILES_PER_BATCH = 100;
const MIN_BATCH_SIZE = 25;

// ---------- Types ----------

export interface GrepHit {
  file: string;
  tokens: number;
  grepHits: number;
  samples: Array<{ pattern: string; lineNo: number; text: string }>;
}

export interface RankedFile {
  file: string;
  priority: number;
  reason: string;
}

export interface AuditPlanEntry {
  file: string;
  tokens: number;
  priority: number;
  reason: string;
}

interface ComponentProfile {
  name: string;
  role: string;
  securityProfile?: {
    summary: string;
    sensitive_areas: Array<{ path: string; reason: string }>;
    threat_surface: string[];
  };
}

// ---------- Security Grep Patterns ----------

export const SECURITY_GREP_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  // Injection
  { category: 'injection', pattern: /\beval\s*\(/ },
  { category: 'injection', pattern: /\bexec\s*\(/ },
  { category: 'injection', pattern: /\bspawn\s*\(/ },
  { category: 'injection', pattern: /\bFunction\s*\(/ },
  // SQL
  { category: 'sql', pattern: /\.query\s*\(/ },
  { category: 'sql', pattern: /\.raw\s*\(/ },
  { category: 'sql', pattern: /\.execute\s*\(/ },
  // Auth
  { category: 'auth', pattern: /\bpassword\b/i },
  { category: 'auth', pattern: /\btoken\b/i },
  { category: 'auth', pattern: /\bsecret\b/i },
  { category: 'auth', pattern: /\bcredential/i },
  { category: 'auth', pattern: /\bauth\b/i },
  { category: 'auth', pattern: /\bsession\b/i },
  // Crypto
  { category: 'crypto', pattern: /\bcrypto\b/i },
  { category: 'crypto', pattern: /\bhash\b/i },
  { category: 'crypto', pattern: /\bencrypt/i },
  { category: 'crypto', pattern: /\bdecrypt/i },
  { category: 'crypto', pattern: /\bsign\b/i },
  { category: 'crypto', pattern: /\bverify\b/i },
  // Network
  { category: 'network', pattern: /\bfetch\s*\(/ },
  { category: 'network', pattern: /\bhttp/i },
  { category: 'network', pattern: /\bsocket\b/i },
  { category: 'network', pattern: /\blisten\s*\(/ },
  { category: 'network', pattern: /\bcors\b/i },
  // File I/O
  { category: 'file_io', pattern: /\breadFile/ },
  { category: 'file_io', pattern: /\bwriteFile/ },
  { category: 'file_io', pattern: /\bunlink\b/ },
  { category: 'file_io', pattern: /\bchmod\b/ },
];

// ---------- Step 1: Local Security Greps ----------

// Spec: spec/services/planning.md#runSecurityGreps
export function runSecurityGreps(
  files: ScannedFile[],
  repoData: Array<{ name: string; localPath: string }>,
): GrepHit[] {
  const results: GrepHit[] = [];

  for (const file of files) {
    const [repoName, ...rest] = file.relativePath.split('/');
    const relPath = rest.join('/');
    const repo = repoData.find(r => r.name === repoName);
    if (!repo) continue;

    let content: string;
    try {
      const fullPath = path.resolve(repo.localPath, relPath);
      // Guard against path traversal
      if (!fullPath.startsWith(path.resolve(repo.localPath) + path.sep) && fullPath !== path.resolve(repo.localPath)) {
        continue;
      }
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const samples: Array<{ pattern: string; lineNo: number; text: string }> = [];
    let totalHits = 0;

    for (const { category, pattern } of SECURITY_GREP_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          totalHits++;
          if (samples.length < 3) {
            samples.push({
              pattern: category,
              lineNo: lineIdx + 1,
              text: line.trim().substring(0, 120),
            });
          }
        }
      }
    }

    if (totalHits > 0) {
      results.push({
        file: file.relativePath,
        tokens: file.roughTokens,
        grepHits: totalHits,
        samples,
      });
    }
  }

  // Sort by grep hits descending
  results.sort((a, b) => b.grepHits - a.grepHits);
  return results;
}

// ---------- Step 2: Claude Planning Call ----------

// Spec: spec/services/planning.md#runPlanningCall
export async function runPlanningCall(
  apiKey: string,
  files: ScannedFile[],
  grepResults: GrepHit[],
  componentProfiles: ComponentProfile[],
  threatModel: string,
  category: string,
  description: string,
  level: string,
): Promise<{ rankedFiles: RankedFile[]; inputTokens: number; outputTokens: number }> {
  const template = loadPrompt('planning');

  // Build grep results text
  const grepText = grepResults.length > 0
    ? grepResults.map(g =>
        `- ${g.file} (${g.tokens} tokens, ${g.grepHits} hits)\n` +
        g.samples.map(s => `  [${s.pattern}] L${s.lineNo}: ${s.text}`).join('\n')
      ).join('\n')
    : '(no security-relevant patterns detected)';

  // Build component profiles text
  const profilesText = componentProfiles.length > 0
    ? componentProfiles.map(c => {
        const sp = c.securityProfile;
        if (!sp) return `- ${c.name} (${c.role}): no security profile`;
        return `- ${c.name} (${c.role}): ${sp.summary}\n` +
          `  Sensitive areas: ${sp.sensitive_areas.map(a => `${a.path} (${a.reason})`).join(', ')}\n` +
          `  Threat surface: ${sp.threat_surface.join(', ')}`;
      }).join('\n')
    : '(no component profiles available)';

  // Build full file list for context
  const allFilesText = files.map(f => `- ${f.relativePath} (${f.roughTokens} tokens)`).join('\n');

  const prompt = renderPrompt(template, {
    category: category || 'unknown',
    description: description || 'Unknown project',
    threat_model: threatModel || '(no threat model available)',
    component_profiles: profilesText,
    grep_results: grepText + '\n\n### All files:\n' + allFilesText,
    audit_level: level,
  });

  const response = await callClaude(
    apiKey,
    'You are a security audit planner. Return valid JSON only.',
    prompt,
    PLANNING_MODEL,
  );

  const rankedFiles = parseJsonResponse<RankedFile[]>(response.content);
  return { rankedFiles, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
}

// ---------- Step 2b: Batched Planning with Retry ----------

// Spec: spec/services/planning.md#runPlanningCallWithRetry
async function runPlanningCallWithRetry(
  apiKey: string,
  files: ScannedFile[],
  grepResults: GrepHit[],
  componentProfiles: ComponentProfile[],
  threatModel: string,
  category: string,
  description: string,
  level: string,
): Promise<{ rankedFiles: RankedFile[]; inputTokens: number; outputTokens: number }> {
  try {
    return await runPlanningCall(apiKey, files, grepResults, componentProfiles, threatModel, category, description, level);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const halfSize = Math.ceil(files.length / 2);
    if (halfSize < MIN_BATCH_SIZE) {
      throw new Error(`Planning failed for ${files.length} files (min batch: ${MIN_BATCH_SIZE}). Response not valid JSON.`);
    }
    console.warn(`[Planning] Parse failed for ${files.length} files, splitting into ${halfSize}+${files.length - halfSize}`);
    const r1 = await runPlanningCallWithRetry(apiKey, files.slice(0, halfSize), grepResults, componentProfiles, threatModel, category, description, level);
    const r2 = await runPlanningCallWithRetry(apiKey, files.slice(halfSize), grepResults, componentProfiles, threatModel, category, description, level);
    return {
      rankedFiles: [...r1.rankedFiles, ...r2.rankedFiles],
      inputTokens: r1.inputTokens + r2.inputTokens,
      outputTokens: r1.outputTokens + r2.outputTokens,
    };
  }
}

// Spec: spec/services/planning.md#runBatchedPlanningCalls
async function runBatchedPlanningCalls(
  apiKey: string,
  files: ScannedFile[],
  grepResults: GrepHit[],
  componentProfiles: ComponentProfile[],
  threatModel: string,
  category: string,
  description: string,
  level: string,
): Promise<{ rankedFiles: RankedFile[]; inputTokens: number; outputTokens: number }> {
  if (files.length <= TARGET_FILES_PER_BATCH) {
    return runPlanningCallWithRetry(apiKey, files, grepResults, componentProfiles, threatModel, category, description, level);
  }

  const batches: ScannedFile[][] = [];
  for (let i = 0; i < files.length; i += TARGET_FILES_PER_BATCH) {
    batches.push(files.slice(i, i + TARGET_FILES_PER_BATCH));
  }

  const allRanked: RankedFile[] = [];
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < batches.length; i++) {
    console.log(`[Planning] Batch ${i + 1}/${batches.length} (${batches[i].length} files)`);
    const r = await runPlanningCallWithRetry(apiKey, batches[i], grepResults, componentProfiles, threatModel, category, description, level);
    allRanked.push(...r.rankedFiles);
    totalIn += r.inputTokens;
    totalOut += r.outputTokens;
  }

  return { rankedFiles: allRanked, inputTokens: totalIn, outputTokens: totalOut };
}

// ---------- Step 3: Token-Budget File Selection ----------

// Spec: spec/services/planning.md#selectFilesByBudget
export function selectFilesByBudget(
  rankedFiles: RankedFile[],
  allFiles: ScannedFile[],
  level: string,
): AuditPlanEntry[] {
  // Build a map of file -> tokens for quick lookup
  const tokenMap = new Map<string, number>();
  for (const f of allFiles) {
    tokenMap.set(f.relativePath, f.roughTokens);
  }

  const totalTokens = allFiles.reduce((sum, f) => sum + f.roughTokens, 0);

  // Budget by level (analysis portion only, not counting planning overhead)
  const budgetPct = BUDGET_PERCENTAGES[level] ?? 1.0;
  const tokenBudget = budgetPct === 1.0 ? totalTokens : Math.round(totalTokens * budgetPct);

  // Sort ranked files by priority descending
  const sorted = [...rankedFiles].sort((a, b) => b.priority - a.priority);

  const plan: AuditPlanEntry[] = [];
  let accumulated = 0;

  for (const rf of sorted) {
    const tokens = tokenMap.get(rf.file);
    if (tokens === undefined) continue; // File not in scanned list

    if (level === 'full') {
      // Full: include everything regardless of budget
      plan.push({ file: rf.file, tokens, priority: rf.priority, reason: rf.reason });
      accumulated += tokens;
    } else {
      // Check if adding this file stays within budget
      if (accumulated + tokens <= tokenBudget) {
        plan.push({ file: rf.file, tokens, priority: rf.priority, reason: rf.reason });
        accumulated += tokens;
      } else if (plan.length === 0) {
        // Always include at least one file
        plan.push({ file: rf.file, tokens, priority: rf.priority, reason: rf.reason });
        accumulated += tokens;
        break;
      } else {
        break;
      }
    }
  }

  return plan;
}

// ---------- Combined Planning Phase ----------

// Spec: spec/services/planning.md#runPlanningPhase
export async function runPlanningPhase(
  pool: Pool,
  auditId: string,
  apiKey: string,
  files: ScannedFile[],
  repoData: Array<{ name: string; localPath: string }>,
  level: string,
  classification: {
    category: string;
    description: string;
    threat_model?: { parties?: Array<{ name: string; can: string[]; cannot: string[] }> };
  },
  componentProfiles: ComponentProfile[],
): Promise<{ plan: AuditPlanEntry[]; planningCostUsd: number }> {
  // Step 1: Run local security greps
  const grepResults = runSecurityGreps(files, repoData);

  // Step 2: Call Claude for file ranking
  const threatModelText = classification.threat_model?.parties
    ? classification.threat_model.parties
        .map(p => `${p.name}: can [${p.can.join(', ')}], cannot [${p.cannot.join(', ')}]`)
        .join('\n')
    : '(no threat model)';

  const planningResult = await runBatchedPlanningCalls(
    apiKey,
    files,
    grepResults,
    componentProfiles,
    threatModelText,
    classification.category,
    classification.description,
    level,
  );

  // Step 3: Select files by token budget
  const plan = selectFilesByBudget(planningResult.rankedFiles, files, level);

  // Step 4: Store plan in DB
  await pool.query(
    `UPDATE audits SET audit_plan = $1 WHERE id = $2`,
    [JSON.stringify(plan), auditId]
  );

  // Calculate planning cost from actual token usage (Opus 4.5: $5/$25 per Mtok)
  const planningCostUsd =
    (planningResult.inputTokens / 1_000_000) * 5 + (planningResult.outputTokens / 1_000_000) * 25;

  return { plan, planningCostUsd };
}
