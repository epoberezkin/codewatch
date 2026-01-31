import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { callClaude, parseJsonResponse } from './claude';
import type { ScannedFile } from './git';
import { loadPrompt, renderPrompt } from './prompts';

// ---------- Constants ----------

const SONNET_MODEL = 'claude-sonnet-4-5-20250929';

// Planning phase budget: ~5% of the audit's token budget
// Uses Sonnet 4.5 ($3/$15 per Mtok) for cost efficiency
const PLANNING_MODEL = SONNET_MODEL;

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
    16384,
  );

  const rankedFiles = parseJsonResponse<RankedFile[]>(response.content);
  return { rankedFiles, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
}

// ---------- Step 3: Token-Budget File Selection ----------

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
  let tokenBudget: number;
  switch (level) {
    case 'full':
      tokenBudget = totalTokens; // 100%
      break;
    case 'thorough':
      tokenBudget = Math.round(totalTokens * 0.33); // 33%
      break;
    case 'opportunistic':
      tokenBudget = Math.round(totalTokens * 0.10); // 10%
      break;
    default:
      tokenBudget = totalTokens;
  }

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

  const planningResult = await runPlanningCall(
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

  // Calculate planning cost from actual token usage (Sonnet 4.5: $3/$15 per Mtok)
  const planningCostUsd =
    (planningResult.inputTokens / 1_000_000) * 3 + (planningResult.outputTokens / 1_000_000) * 15;

  return { plan, planningCostUsd };
}
