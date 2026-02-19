# planning.ts -- Module Specification

**Purpose:** Orchestrates the audit planning phase by scanning files for security-relevant patterns, calling Claude to rank files by audit priority, and selecting a token-budgeted subset as the final audit plan.

**Source:** [`planning.ts`](../../src/server/services/planning.ts)

---

## Types

### `GrepHit` (exported)

| Field      | Type                                                   | Description                                    |
| ---------- | ------------------------------------------------------ | ---------------------------------------------- |
| `file`     | `string`                                               | Relative file path (e.g. `repo/src/foo.ts`)    |
| `tokens`   | `number`                                               | Rough token count for the file                 |
| `grepHits` | `number`                                               | Total number of security pattern matches       |
| `samples`  | `Array<{ pattern: string; lineNo: number; text: string }>` | Up to 3 representative match samples           |

### `RankedFile` (exported)

| Field      | Type     | Description                                   |
| ---------- | -------- | --------------------------------------------- |
| `file`     | `string` | Relative file path                            |
| `priority` | `number` | Priority score assigned by Claude              |
| `reason`   | `string` | Explanation of why the file is security-relevant |

### `AuditPlanEntry` (exported)

| Field      | Type     | Description                                   |
| ---------- | -------- | --------------------------------------------- |
| `file`     | `string` | Relative file path                            |
| `tokens`   | `number` | Rough token count                             |
| `priority` | `number` | Priority score (from `RankedFile`)             |
| `reason`   | `string` | Reason (from `RankedFile`)                     |

### `ComponentProfile` (internal, not exported)

| Field             | Type                                                                                     | Description                        |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| `name`            | `string`                                                                                 | Component name                     |
| `role`            | `string`                                                                                 | Component role/description         |
| `securityProfile` | `{ summary: string; sensitive_areas: Array<{ path: string; reason: string }>; threat_surface: string[] }` (optional) | Security metadata if available |

---

## Constants

### `PLANNING_MODEL` (internal)

Value: `'claude-opus-4-5-20251101'`

### `TARGET_FILES_PER_BATCH` (internal)

Value: `100`. Files per batch in `runBatchedPlanningCalls()`. Each ranked file entry ≈ 60 output tokens; 100 × 60 = 6,000 tokens, well under 10,000 (50% of the 20K max output).

### `MIN_BATCH_SIZE` (internal)

Value: `25`. Floor for recursive halving in `runPlanningCallWithRetry()`. Bounds recursion to ~3 levels (log₂(250/25) ≈ 3.3).

### `SECURITY_GREP_PATTERNS` (exported)

Type: `Array<{ category: string; pattern: RegExp }>`

28 patterns across 6 categories:

| Category    | Patterns                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `injection` | `eval(`, `exec(`, `spawn(`, `Function(`                                   |
| `sql`       | `.query(`, `.raw(`, `.execute(`                                           |
| `auth`      | `password`, `token`, `secret`, `credential`, `auth`, `session` (all case-insensitive) |
| `crypto`    | `crypto`, `hash`, `encrypt`, `decrypt`, `sign`, `verify` (all case-insensitive)       |
| `network`   | `fetch(`, `http`, `socket`, `listen(`, `cors` (all case-insensitive)      |
| `file_io`   | `readFile`, `writeFile`, `unlink`, `chmod`                                |

---

## Exported Functions

### `runSecurityGreps()`

[`runSecurityGreps()`](../../src/server/services/planning.ts#L90-L151)

```ts
function runSecurityGreps(
  files: ScannedFile[],
  repoData: Array<{ name: string; localPath: string }>,
): GrepHit[]
```

**Steps:**

1. Iterates over every `ScannedFile`. Splits `relativePath` on `/` to extract the repo name (first segment) and in-repo relative path (remaining segments).
2. Looks up the matching repo in `repoData` by name. Skips the file if no repo matches.
3. Resolves the full filesystem path via `path.resolve(repo.localPath, relPath)`. Guards against path traversal by verifying the resolved path starts with the repo root.
4. Reads the file synchronously (`fs.readFileSync`). Silently skips on read errors.
5. Tests every line of the file against every pattern in `SECURITY_GREP_PATTERNS`. Counts total hits and collects up to 3 sample matches (category, 1-indexed line number, trimmed text capped at 120 chars).
6. If `totalHits > 0`, pushes a `GrepHit` with the file path, its `roughTokens`, hit count, and samples.
7. Sorts results by `grepHits` descending and returns.

---

### `runPlanningCall()`

[`runPlanningCall()`](../../src/server/services/planning.ts#L156-L208)

```ts
async function runPlanningCall(
  apiKey: string,
  files: ScannedFile[],
  grepResults: GrepHit[],
  componentProfiles: ComponentProfile[],
  threatModel: string,
  category: string,
  description: string,
  level: string,
): Promise<{ rankedFiles: RankedFile[]; inputTokens: number; outputTokens: number }>
```

**Steps:**

1. Loads the `planning` prompt template via `loadPrompt('planning')`.
2. Builds a `grepText` string: for each `GrepHit`, formats the file path, token count, hit count, and sample lines. Falls back to `(no security-relevant patterns detected)` if empty.
3. Builds a `profilesText` string from `componentProfiles`: for each component, renders name, role, security summary, sensitive areas, and threat surface. Falls back to `(no component profiles available)` if empty.
4. Builds `allFilesText`: all scanned files with token counts.
5. Renders the prompt template via `renderPrompt()` with variables: `category`, `description`, `threat_model`, `component_profiles`, `grep_results` (grep text + full file list appended under `### All files:`), and `audit_level`.
6. Calls `callClaude()` with system prompt `'You are a security audit planner. Return valid JSON only.'`, the rendered user prompt, and model `PLANNING_MODEL`. Uses the global default `maxTokens` (20000).
7. Parses the Claude response as `RankedFile[]` via `parseJsonResponse<RankedFile[]>()`.
8. Returns `{ rankedFiles, inputTokens, outputTokens }`.

---

## Internal Functions

### `runPlanningCallWithRetry()`

[`runPlanningCallWithRetry()`](../../src/server/services/planning.ts#L213-L240)

Same parameters and return type as `runPlanningCall()`. Wraps the call with recursive retry on `SyntaxError` (truncated JSON):

1. Calls `runPlanningCall()`. On success, returns the result.
2. On `SyntaxError`: computes `halfSize = ceil(files.length / 2)`. If `halfSize < MIN_BATCH_SIZE`, throws `Error` (batch too small).
3. Otherwise, recursively calls itself with each half, then merges the `rankedFiles` arrays and sums token counts.

Non-`SyntaxError` exceptions propagate unchanged.

### `runBatchedPlanningCalls()`

[`runBatchedPlanningCalls()`](../../src/server/services/planning.ts#L243-L274)

Same parameters and return type as `runPlanningCall()`. Orchestrates batch splitting:

1. If `files.length <= TARGET_FILES_PER_BATCH`, delegates directly to `runPlanningCallWithRetry()` (no batching overhead).
2. Otherwise, splits files into batches of `TARGET_FILES_PER_BATCH` and processes each sequentially via `runPlanningCallWithRetry()`.
3. Each batch receives the full grep results, component profiles, and threat model — only the file list is split.
4. Merges all `rankedFiles` and sums token counts.

---

### `selectFilesByBudget()`

[`selectFilesByBudget()`](../../src/server/services/planning.ts#L279-L327)

```ts
function selectFilesByBudget(
  rankedFiles: RankedFile[],
  allFiles: ScannedFile[],
  level: string,
): AuditPlanEntry[]
```

**Steps:**

1. Builds a `Map<string, number>` mapping `relativePath` to `roughTokens` for O(1) lookup.
2. Computes `totalTokens` as the sum of all file tokens.
3. Resolves the budget percentage from `BUDGET_PERCENTAGES[level]` (imported from `./tokens`). Known values: `full` = 1.0, `thorough` = 0.33, `opportunistic` = 0.10. Defaults to `1.0` if level is unrecognized.
4. Calculates `tokenBudget`: if percentage is 1.0, uses `totalTokens` directly; otherwise `Math.round(totalTokens * budgetPct)`.
5. Sorts ranked files by `priority` descending (copy, does not mutate input).
6. Greedy selection loop:
   - **`full` level:** includes every ranked file regardless of budget.
   - **Other levels:** includes a file if `accumulated + tokens <= tokenBudget`. If no files have been selected yet (`plan.length === 0`), always includes the first file even if it exceeds the budget, then breaks.
7. Returns the plan as `AuditPlanEntry[]`.

---

### `runPlanningPhase()`

[`runPlanningPhase()`](../../src/server/services/planning.ts#L332-L381)

```ts
async function runPlanningPhase(
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
): Promise<{ plan: AuditPlanEntry[]; planningCostUsd: number }>
```

**Steps:**

1. **Step 1 -- Local greps:** Calls `runSecurityGreps(files, repoData)` to get `GrepHit[]`.
2. **Step 2 -- Claude ranking:** Serializes the threat model parties into a human-readable string (or `(no threat model)` if absent). Calls `runBatchedPlanningCalls()` which splits large file lists into batches of ~250, with recursive retry on parse failure.
3. **Step 3 -- Budget selection:** Calls `selectFilesByBudget()` with the ranked files, all scanned files, and the audit level.
4. **Step 4 -- DB update:** Persists the plan to the database (see Database Operations below).
5. **Step 5 -- Cost calculation:** Computes `planningCostUsd` from actual token usage (see Cost Calculation below).
6. Returns `{ plan, planningCostUsd }`.

---

## Database Operations

Single update in `runPlanningPhase()` (L371-L374):

```sql
UPDATE audits SET audit_plan = $1 WHERE id = $2
```

- `$1`: `JSON.stringify(plan)` -- the `AuditPlanEntry[]` serialized as a JSON string.
- `$2`: `auditId` -- the audit row identifier.

[GAP] No error handling around the DB query. A failed update silently propagates as an unhandled promise rejection. [REC] Wrap in try/catch or let the caller handle it explicitly.

---

## Cost Calculation

Planning phase cost (L376-L378):

```
planningCostUsd = (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25
```

Pricing reflects Claude Opus 4.5 rates: **$5 / M input tokens**, **$25 / M output tokens**.

[GAP] The pricing constants are hardcoded inline rather than imported from a shared config. [REC] Extract to a shared pricing constant or the `tokens` module to keep rates consistent if the model changes.

---

## Dependencies

| Import                          | Module                                       | Usage                                      |
| ------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `Pool`                          | `pg`                                         | Postgres connection pool for DB update      |
| `fs`, `path`                    | Node.js stdlib                               | File reading and path resolution            |
| `callClaude`, `parseJsonResponse` | [`./claude`](../../src/server/services/claude.ts)   | Claude API call and JSON extraction         |
| `ScannedFile`                   | [`./git`](../../src/server/services/git.ts)         | Type for scanned file metadata              |
| `loadPrompt`, `renderPrompt`   | [`./prompts`](../../src/server/services/prompts.ts) | Prompt template loading and variable substitution |
| `BUDGET_PERCENTAGES`            | [`./tokens`](../../src/server/services/tokens.ts)   | Token budget percentages by audit level     |

---

## Additional Notes

- `ComponentProfile` is not exported. Callers must construct objects matching the interface shape without importing the type. [REC] Export the type or move it to a shared types file.
- `runSecurityGreps` is synchronous (uses `readFileSync`). For large repos this blocks the event loop. [REC] Consider an async variant if latency becomes an issue.
- The `PLANNING_MODEL` constant is internal and not configurable per call. All planning calls use Opus 4.5.
