# audit.ts -- Core Audit Orchestration Engine

Source: [`audit.ts`](../../src/server/services/audit.ts)

## Purpose

Orchestrates the full lifecycle of a security audit -- cloning repositories, classifying the project, planning file selection, batching code for Claude analysis, attributing findings to components, and synthesizing a final report.

---

## Types

### `ClassificationResult` (lines 15-27)

```ts
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
```

Holds the output of the project classification Claude call. Stored in the `projects` table across audits; only computed on the first audit (when `projects.category` is null).

### `FindingResult` (lines 29-41)

```ts
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
```

Shape of a single finding returned by Claude during batch analysis (Step 3). Mapped 1:1 into the `audit_findings` table.

### `AnalysisResult` (lines 43-48)

```ts
interface AnalysisResult {
  findings: FindingResult[];
  responsible_disclosure: Record<string, string>;
  dependencies: Array<{ name: string; concern: string }>;
  security_posture: string;
}
```

Top-level response shape from each batch analysis Claude call. Only `findings` is persisted; `responsible_disclosure`, `dependencies`, and `security_posture` are consumed but not stored. [GAP] `responsible_disclosure`, `dependencies`, and `security_posture` are parsed but never written to the database.

### `AuditOptions` (lines 50-57)

```ts
interface AuditOptions {
  auditId: string;
  projectId: string;
  level: 'full' | 'thorough' | 'opportunistic';
  apiKey: string;
  baseAuditId?: string;    // present for incremental audits
  componentIds?: string[];  // present for component-scoped audits
}
```

Input configuration passed by the caller. `baseAuditId` triggers incremental mode (diff + finding inheritance). `componentIds` triggers component-scoped file filtering and finding attribution.

### `ProgressDetail` discriminated union (lines 59-92)

```ts
interface FileProgress {
  file: string;
  status: string;       // 'pending' | 'done' | 'error'
  findingsCount: number;
}

interface ProgressBase {
  warnings: string[];
}

interface ProgressCloning extends ProgressBase {
  type: 'cloning';
  current: number;
  total: number;
  repoName: string;
}

interface ProgressPlanning extends ProgressBase {
  type: 'planning';
}

interface ProgressAnalyzing extends ProgressBase {
  type: 'analyzing';
  files: FileProgress[];
}

interface ProgressDone extends ProgressBase {
  type: 'done';
  files: FileProgress[];
}

type ProgressDetail = ProgressCloning | ProgressPlanning | ProgressAnalyzing | ProgressDone;
```

Discriminated union for the `audits.progress_detail` column. Every progress write uses one of these variants, ensuring the column always stores a well-typed object with a `type` discriminator. All variants carry a `warnings: string[]` field (via `ProgressBase`) for accumulating non-fatal warnings throughout the audit.

- **`ProgressCloning`**: written during Step 0 as each repo is cloned; includes clone index and repo name.
- **`ProgressPlanning`**: written during Step 2 fallback when planning returns 0 files.
- **`ProgressAnalyzing`**: written during Step 3 with per-file status tracking.
- **`ProgressDone`**: written after Step 3b (before synthesis) to mark analysis completion.

---

## Constants

| Name | Value | Line |
|------|-------|------|
| `MAX_BATCH_TOKENS` | `150000` | 101 |

---

## Main Function: `runAudit()` (lines 106-729)

```ts
export async function runAudit(pool: Pool, options: AuditOptions): Promise<void>
```

The sole export. Drives the entire audit through five sequential steps. All database state transitions and Claude API calls happen here. On any unhandled error, sets `audits.status = 'failed'` with the error message (lines 722-728).

A running `actualCostUsd` accumulator (line 108) tracks estimated spend across all Claude calls. A `warnings: string[]` array (line 109) accumulates non-fatal warning messages (e.g., diff failures, planning fallbacks) and is included in every `progress_detail` write via the `ProgressBase.warnings` field.

---

### Step 0: Clone Repos (lines 112-229)

**Status:** `cloning`

**Database reads:**

| Query | Table(s) | Purpose |
|-------|----------|---------|
| `SELECT r.id, r.repo_url, r.repo_name, r.repo_path, pr.branch FROM repositories r JOIN project_repos pr ...` (lines 115-121) | `repositories`, `project_repos` | Fetch all repos linked to the project |
| `SELECT ac.commit_sha, r.repo_name, r.repo_url FROM audit_commits ac JOIN repositories r ... WHERE ac.audit_id = $baseAuditId` (lines 137-143) | `audit_commits`, `repositories` | (Incremental only) Get base audit commit SHAs to compute `shallowSince` dates |

**External calls:**

| Call | Module | Purpose |
|------|--------|---------|
| `getCommitDate(owner, repoName, commitSha)` (line 150) | `github.ts` | Get commit timestamp for shallow-clone optimization |
| `cloneOrUpdate(repoUrl, branch, shallowSince)` (line 172) | `git.ts` | Clone or update local repo checkout |
| `getDefaultBranchName(localPath)` (line 173) | `git.ts` | Resolve actual default branch name |
| `scanCodeFiles(localPath)` (line 183) | `git.ts` | List all code files with rough token counts |

**Database writes:**

| Query | Table | Purpose |
|-------|-------|---------|
| [`writeProgress()`](#writeprogress-lines-94-99) `ProgressCloning` (lines 166-168) | `audits` | Clone progress tracking |
| `INSERT INTO audit_commits ... ON CONFLICT DO UPDATE` (lines 176-181) | `audit_commits` | Record HEAD SHA per repo for this audit |
| `UPDATE audits SET total_files, total_tokens, started_at` (lines 226-229) | `audits` | Audit-level file/token stats |

**Logic:**

1. For each repo, clones/updates locally, records HEAD commit SHA.
2. File paths are namespaced as `{repoName}/{relativePath}` (line 185).
3. If `options.componentIds` is set, files are filtered using `minimatch` against component `file_patterns` (lines 202-223). Patterns are prefixed with the repo name for namespaced matching.

---

### Step 2b: Incremental Diff & Finding Inheritance (lines 231-363)

Runs only when `options.baseAuditId` is set. Executes between Step 0 and Step 1 in the code flow (before classification).

**Database reads:**

| Query | Table(s) | Purpose |
|-------|----------|---------|
| `SELECT ac.repo_id, ac.commit_sha, r.repo_name FROM audit_commits ac JOIN repositories r ... WHERE ac.audit_id = $baseAuditId` (lines 237-243) | `audit_commits`, `repositories` | Get base commit SHAs per repo |
| `SELECT * FROM audit_findings WHERE audit_id = $baseAuditId AND status = 'open'` (lines 307-309) | `audit_findings` | All open findings from the base audit for inheritance |

**External calls:**

| Call | Module | Purpose |
|------|--------|---------|
| `diffBetweenCommits(localPath, baseSha, headSha)` (line 267) | `git.ts` | Compute file-level diff (added/modified/deleted/renamed) |

**Database writes:**

| Query | Table | Purpose |
|-------|-------|---------|
| [`writeProgress()`](#writeprogress-lines-94-99) `ProgressCloning` (lines 273-275) | `audits` | Warning when diff fails due to shallow clone (warning pushed to `warnings` array) |
| `UPDATE audits SET diff_files_added, diff_files_modified, diff_files_deleted` (lines 297-300) | `audits` | Diff statistics |
| `INSERT INTO audit_findings (... status)` (lines 337-350) | `audit_findings` | Inherit each open finding from base audit into this audit |
| `UPDATE audit_findings SET resolved_in_audit_id` (lines 356-361) | `audit_findings` | Mark base findings in deleted files as resolved |

**Logic:**

1. For each repo, computes diff between base audit commit and current HEAD.
2. If a repo was not in the base audit, all its files are treated as added.
3. If `diffBetweenCommits` fails (e.g., shallow clone missing base SHA), all files in that repo are treated as added, a warning is pushed to `warnings`, and a `ProgressCloning` update is written.
4. `filesToAnalyzeOverride` is set to only added + modified + renamed-to files (lines 303-304).
5. Open findings from the base audit are inherited into the new audit:
   - Findings for deleted files get `status = 'fixed'` (line 327).
   - Findings for renamed files get their `file_path` updated to the new path (line 332).
   - Duplicate fingerprints are skipped to prevent double-insertion (lines 314-320).
6. Base findings on deleted files are also marked with `resolved_in_audit_id` pointing to this audit (lines 355-362).

---

### Step 1: Classification (lines 365-407)

**Status:** `classifying` (only when running classification)

**Condition:** Runs the Claude classification call only when `projects.category` is null (first audit). Otherwise, loads the existing classification from the database (lines 382-407).

**Database reads:**

| Query | Table | Purpose |
|-------|-------|---------|
| `SELECT category FROM projects WHERE id = $1` (lines 366-369) | `projects` | Check if already classified |
| `SELECT category, description, involved_parties, threat_model FROM projects WHERE id = $1` (lines 384-387) | `projects` | Load existing classification when present |

**External calls (first audit only):**

| Call | Module | Purpose |
|------|--------|---------|
| `classifyProject(pool, projectId, auditId, apiKey, repoData)` (line 379) | local | Claude API call for classification (see helper below) |

**Cost:** Hardcoded `$0.05` estimate for classification (line 381).

**Logic:**

- When loading an existing classification (lines 382-407), the threat model is parsed from JSON with a fallback to wrapping raw strings in `{ generated: ... }`.
- The reconstructed `ClassificationResult` has empty `components` and `threat_model_files` since those are not stored in the `projects` table. [GAP] `components` array is always empty when loading from DB -- only populated on first audit.

---

### Step 2: Planning Phase (lines 409-465)

**Status:** `planning` (fresh audits only), then `analyzing`

**Condition:** Runs only for fresh audits (`filesToAnalyzeOverride` is null). Incremental audits skip planning and go straight to `analyzing` (lines 412-415).

**Database reads:**

| Query | Table | Purpose |
|-------|-------|---------|
| `SELECT name, role, security_profile FROM components WHERE project_id = $1` (lines 422-425) | `components` | Load component profiles for planning context |

**External calls:**

| Call | Module | Purpose |
|------|--------|---------|
| `runPlanningPhase(pool, auditId, apiKey, allFiles, repos, level, classification, componentProfiles)` (lines 432-442) | `planning.ts` | AI-driven file selection; returns `{ plan, planningCostUsd }` |
| `selectFiles(allFiles, level)` (line 456) | local | Fallback heuristic file selection if planning returns 0 files |

**Database writes:**

| Query | Table | Purpose |
|-------|-------|---------|
| [`writeProgress()`](#writeprogress-lines-94-99) `ProgressPlanning` (line 455) | `audits` | Warning when falling back to heuristic selection (warning pushed to `warnings` array) |
| `UPDATE audits SET files_to_analyze, tokens_to_analyze` (lines 462-465) | `audits` | Final analysis scope |
| [`writeProgress()`](#writeprogress-lines-94-99) `ProgressAnalyzing` (line 473) | `audits` | Per-file progress tracker (all files start as `pending`) |

**Logic:**

1. Calls `runPlanningPhase` which uses Claude to select security-relevant files.
2. Maps the plan output back to `ScannedFile` objects (line 449).
3. If the plan returns 0 files, falls back to `selectFiles()` heuristic (line 456) -- scored by `SECURITY_CRITICAL_PATTERNS` regex matching, budget-capped by `BUDGET_PERCENTAGES[level]`.

---

### Step 3: Batch & Analyze (lines 475-607)

**Status:** `analyzing` (set in Step 2)

**Batching:** Files are split into batches of up to `MAX_BATCH_TOKENS` (150,000) tokens each via `createBatches()`.

**Per-batch processing (lines 483-591):**

For each batch:

1. **Build user message** (lines 491-517): Reads file contents from disk, concatenates with `---` separators. For incremental audits, appends context about previous findings for these files from the base audit.

2. **Claude API call** (line 520): `callClaude(apiKey, systemPrompt, userMessage)` -- system prompt is built from classification + level template via `buildSystemPrompt()`.

3. **Parse response** (line 527): `parseJsonResponse<AnalysisResult>(response.content)`.

4. **Insert findings** (lines 530-559): For each finding:
   - Generates a fingerprint via `generateFingerprint()`.
   - For incremental audits: checks if a finding with the same fingerprint already exists in this audit (inherited from base). Skips if duplicate (lines 537-541).
   - Inserts into `audit_findings` with all fields.

5. **Update progress** (lines 562-587): Marks batch files as `done` or `error` in the progress detail JSON. Writes updated `files_analyzed` and `progress_detail` (as `ProgressAnalyzing` with `satisfies` type assertion) to `audits`.

**Database reads (per batch, incremental only):**

| Query | Table | Purpose |
|-------|----------|---------|
| `SELECT file_path, title, severity, description FROM audit_findings WHERE audit_id = $baseAuditId AND file_path = ANY(...)` (lines 504-509) | `audit_findings` | Previous findings context for modified files |
| `SELECT id FROM audit_findings WHERE audit_id = $auditId AND fingerprint = $fp` (lines 537-540) | `audit_findings` | Dedup check against inherited findings |

**Database writes (per batch):**

| Query | Table | Purpose |
|-------|-------|---------|
| `INSERT INTO audit_findings (...)` (lines 544-557) | `audit_findings` | New findings from Claude analysis |
| `UPDATE audits SET files_analyzed, progress_detail` (lines 584-587) | `audits` | Progress tracking (`ProgressAnalyzing` written inline with `satisfies`) |

**Error handling (lines 593-607):**

- On first batch failure, the loop breaks immediately (`if (batchesFailed > 0) break;` at line 590).
- After the loop, if any batch failed, the audit is marked `failed` with a message explaining partial results are unsafe for security audits (lines 596-607).
- Sets `audits.status = 'failed'`, `error_message`, and `actual_cost_usd`.

---

### Step 3b: Component Attribution (lines 609-652)

**Condition:** Runs only when `componentPatterns` is non-null and non-empty (i.e., when `options.componentIds` was provided).

**Database reads:**

| Query | Table | Purpose |
|-------|-------|---------|
| `SELECT id, file_path FROM audit_findings WHERE audit_id = $1` (lines 612-614) | `audit_findings` | All findings for this audit (including inherited) |

**Database writes:**

| Query | Table | Purpose |
|-------|-------|---------|
| `UPDATE audit_findings SET component_id = $1 WHERE id = $2` (lines 632-634) | `audit_findings` | Attribute each finding to a component |
| `INSERT INTO audit_components ... ON CONFLICT DO UPDATE` (lines 644-650) | `audit_components` | Per-component summary: `tokens_analyzed`, `findings_count` |

**Logic:**

1. For each finding, iterates component patterns and uses `minimatch` to match `file_path` against patterns. First matching component wins (line 637).
2. Pre-computes per-component token counts from `filesToAnalyze` (lines 621-626).
3. Inserts or updates `audit_components` records with token and finding counts.

After component attribution, a `ProgressDone` is written via [`writeProgress()`](#writeprogress-lines-94-99) (line 655) to mark analysis completion before synthesis begins.

---

### Step 4: Synthesis (lines 657-721)

**Status:** `synthesizing`

**Database reads:**

| Query | Table | Purpose |
|-------|-------|---------|
| `SELECT severity, title, file_path, description FROM audit_findings WHERE audit_id = $1` (lines 661-664) | `audit_findings` | All findings for report synthesis |

**External calls:**

| Call | Module | Purpose |
|------|--------|---------|
| `loadPrompt('synthesize')` (line 670) | `prompts.ts` | Load synthesis prompt template |
| `renderPrompt(template, vars)` (line 670) | `prompts.ts` | Render with `description`, `category`, `totalFindings`, `findingsSummary` |
| `callClaude(apiKey, systemPrompt, synthesisPrompt)` (line 678) | `claude.ts` | Final Claude call for executive summary |

**System prompt for synthesis:** Hardcoded string `'You are a security audit report writer. Return valid JSON only.'` (line 678).

**Database writes:**

| Query | Table | Purpose |
|-------|-------|---------|
| `UPDATE audits SET report_summary, max_severity, actual_cost_usd, status = 'completed', completed_at = NOW()` (lines 693-707) | `audits` | Final audit completion |
| `UPDATE audits SET status = 'completed_with_warnings', error_message, actual_cost_usd, completed_at = NOW()` (lines 711-720) | `audits` | Completion when synthesis fails (findings are valid, summary is not) |

**Logic:**

1. Builds a textual summary of all findings (severity + title + file + truncated description, lines 666-668).
2. Calls Claude to synthesize an executive report.
3. Computes `max_severity` by iterating all findings against a severity ordering: `critical > high > medium > low > informational > none` (lines 683-691).
4. On synthesis failure: marks audit `completed_with_warnings` instead of `failed` -- findings are already persisted and valid.

---

## Helper Functions

### `writeProgress()` (lines 94-99)

```ts
function writeProgress(pool: Pool, auditId: string, detail: ProgressDetail): Promise<void>
```

Writes a `ProgressDetail` object (JSON-stringified) to `audits.progress_detail`. Most progress writes in `runAudit()` go through this function. The per-batch progress update (lines 584-587) writes inline via `pool.query` with a `satisfies ProgressAnalyzing` assertion because it combines the progress write with the `files_analyzed` counter in a single UPDATE. All writes use the `ProgressDetail` discriminated union, ensuring the column always contains a well-typed value. Returns a `Promise<void>` (uses `.then(() => {})` to discard the query result).

---

### `classifyProject()` (lines 734-786)

```ts
async function classifyProject(
  pool: Pool, projectId: string, auditId: string, apiKey: string,
  repoData: Array<{ name: string; localPath: string; files: ScannedFile[] }>
): Promise<ClassificationResult>
```

**Claude API call:**
- System prompt: `'You are a software classification expert. Analyze projects and respond with valid JSON only.'` (line 756)
- User message: rendered from `classify` prompt template with `repo_list` containing directory trees and READMEs (truncated to 5000 chars each) for all repos.

**Database writes:**
- `UPDATE projects SET category, description, involved_parties, threat_model, threat_model_source, threat_model_files, classification_audit_id` (lines 763-783)
- `threat_model_source` is `'repo'` if found in repo files, `'generated'` otherwise.
- `threat_model_files` stores the string array from `classification.threat_model_files` (file paths prefixed with repo name, e.g., `"repo-name/SECURITY.md"`).

---

### `selectFiles()` (lines 790-805)

```ts
function selectFiles(allFiles: ScannedFile[], level: string): ScannedFile[]
```

Fallback heuristic file selection when planning returns no files.

- Applies `BUDGET_PERCENTAGES[level]` (`full: 1.0`, `thorough: 0.33`, `opportunistic: 0.10`).
- If budget is >= 100%, returns all files.
- Otherwise, scores each file by counting regex matches against `SECURITY_CRITICAL_PATTERNS` (auth, crypto, api, route, middleware, handler, controller, model, db, config, session, token, password, etc.).
- Sorts descending by score, returns top `ceil(count * budgetPct)` files.

---

### `createBatches()` (lines 814-839)

```ts
function createBatches(files: ScannedFile[]): Batch[]
```

**Interface `Batch`** (lines 809-812): `{ files: ScannedFile[]; totalTokens: number }`

- Sorts files alphabetically by `relativePath` to keep related code together (line 818).
- Greedily fills batches up to `MAX_BATCH_TOKENS` (150,000) tokens.
- A single file exceeding the limit will still be placed in its own batch (the overflow check only triggers when the batch is non-empty, line 825).

---

### `buildSystemPrompt()` (lines 843-857)

```ts
function buildSystemPrompt(classification: ClassificationResult, level: string): string
```

- Loads and renders the `system` prompt template with classification fields (`category`, `description`, `components`, `involved_parties`, `threat_model`).
- Loads the level-specific prompt template (e.g., `full`, `thorough`, `opportunistic`).
- Concatenates both with `\n\n` separator.

---

### `updateStatus()` (lines 861-863)

```ts
async function updateStatus(pool: Pool, auditId: string, status: string): Promise<void>
```

Single-line helper: `UPDATE audits SET status = $1 WHERE id = $2`.

---

### `generateFingerprint()` (lines 865-871)

```ts
function generateFingerprint(finding: FindingResult): string
```

Generates a 16-character hex fingerprint (truncated SHA-256) for deduplication across incremental audits.

**Input:** `{file}:{lineStart}-{lineEnd}:{title}:{codeSnippet[0:100]}`

[GAP] The fingerprint includes line numbers, which means the same logical finding shifted by refactoring will produce a different fingerprint and appear as a new finding. [REC] Consider a line-number-independent fingerprint (e.g., based on normalized code snippet + title + CWE) for more robust dedup across refactors.

---

### `estimateCallCost()` (lines 873-876)

```ts
function estimateCallCost(inputTokens: number, outputTokens: number): number
```

**Formula:** `(inputTokens / 1,000,000) * 5 + (outputTokens / 1,000,000) * 25`

Based on Claude Opus 4.5 pricing: $5/Mtok input, $25/Mtok output.

[GAP] Pricing is hardcoded and does not account for model changes or different models being passed to `callClaude`. [REC] Source pricing from a config or from the model parameter.

---

## Database Operations Summary

### Tables Written

| Table | Operations | Steps |
|-------|-----------|-------|
| `audits` | UPDATE (status, progress_detail, total_files, total_tokens, files_to_analyze, tokens_to_analyze, files_analyzed, diff_files_added/modified/deleted, report_summary, max_severity, actual_cost_usd, started_at, completed_at, error_message) | 0, 1, 2, 2b, 3, 4 |
| `audit_commits` | INSERT ... ON CONFLICT DO UPDATE | 0 |
| `audit_findings` | INSERT (new findings), INSERT (inherited findings), UPDATE (component_id, resolved_in_audit_id) | 2b, 3, 3b |
| `audit_components` | INSERT ... ON CONFLICT DO UPDATE | 3b |
| `projects` | UPDATE (category, description, involved_parties, threat_model, threat_model_source, threat_model_files, classification_audit_id) | 1 |

### Tables Read

| Table | Steps |
|-------|-------|
| `repositories` | 0, 2b |
| `project_repos` | 0 |
| `audit_commits` | 0 (shallowSince), 2b (base commits) |
| `audit_findings` | 2b (inheritance), 3 (dedup), 3b (attribution), 4 (synthesis) |
| `projects` | 1 |
| `components` | 0 (file filtering), 2 (profiles) |

---

## External API Calls Summary

| # | Step | Target | Purpose | Model |
|---|------|--------|---------|-------|
| 1 | 1 | Claude | Project classification | Default (Opus 4.5) |
| 2 | 2 | Claude | Planning phase (via `runPlanningPhase`) | Default (Opus 4.5) |
| 3 | 3 | Claude | Batch analysis (1 call per batch) | Default (Opus 4.5) |
| 4 | 4 | Claude | Report synthesis | Default (Opus 4.5) |

Additionally, `getCommitDate` (Step 0) makes GitHub API calls for incremental audit shallow-clone optimization.

---

## Error Handling

The function uses a single top-level try/catch (lines 111-728):

- **Any unhandled exception:** Sets `audits.status = 'failed'` with the error message and accumulated cost (lines 722-728).
- **Batch failure (Step 3):** Breaks on first failed batch (line 590). Fails the audit with an explicit message that partial results are unreliable for security (lines 596-607). Does **not** throw -- returns early after updating the DB.
- **Synthesis failure (Step 4):** Does **not** fail the audit. Sets `status = 'completed_with_warnings'` since findings are already persisted and valid (lines 708-721).
- **Diff failure (Step 2b):** Falls back to treating all files as added; logs a warning and pushes to `warnings` array (lines 268-279).
- **shallowSince computation failure (Step 0):** Falls back to full clone; logs a warning (lines 153-155).

[REC] Consider adding structured error types to distinguish retryable (API rate limits) from fatal (missing project) errors at the orchestration level.

---

## Audit Status State Machine

```
cloning -> classifying -> planning -> analyzing -> synthesizing -> completed
                                                                -> completed_with_warnings
           (skip if classified)  (skip if incremental)
                                                      -> failed  (batch failure)
-> failed  (any unhandled exception)
```

---

## Cost Tracking

- Classification: hardcoded `$0.05` (line 381).
- Planning: `planningCostUsd` returned by `runPlanningPhase` (line 443).
- Batch analysis: `estimateCallCost(inputTokens, outputTokens)` per batch (line 521).
- Synthesis: `estimateCallCost(inputTokens, outputTokens)` (line 679).
- Accumulated in `actualCostUsd` and written to `audits.actual_cost_usd` on completion or failure.

---

## Dependencies

| Module | Imports Used |
|--------|-------------|
| `pg` | `Pool` |
| `crypto` | `createHash` |
| `./claude` | `callClaude`, `parseJsonResponse` |
| `./git` | `cloneOrUpdate`, `scanCodeFiles`, `readFileContent`, `getDefaultBranchName`, `diffBetweenCommits`, `ScannedFile` |
| `./tokens` | `roughTokenCount`, `SECURITY_CRITICAL_PATTERNS`, `BUDGET_PERCENTAGES` |
| `./github` | `getCommitDate` |
| `./planning` | `runPlanningPhase` |
| `./prompts` | `loadPrompt`, `renderPrompt` |
| `minimatch` | `minimatch` |
