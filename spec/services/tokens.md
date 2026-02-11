# tokens.ts -- Token Estimation & Cost Calculation Service

**Source:** [`tokens.ts`](../../src/server/services/tokens.ts)

## Module Purpose

Estimates token counts and USD costs for security audit runs at three audit levels (full, thorough, opportunistic). Fetches per-model pricing from the database and applies a cost formula that accounts for analysis overhead and output token generation.

---

## Types

### `LevelEstimate` (exported, line 7)

```ts
export interface LevelEstimate {
  files: number;
  tokens: number;
  costUsd: number;
}
```

Per-audit-level summary: file count, input token count, and estimated cost in USD.

### `CostEstimate` (exported, line 13)

```ts
export interface CostEstimate {
  totalFiles: number;
  totalTokens: number;
  estimates: {
    full: LevelEstimate;
    thorough: LevelEstimate;
    opportunistic: LevelEstimate;
  };
  isPrecise: boolean;
}
```

Aggregate estimate across all three audit levels. `isPrecise` is `true` only when produced from a known exact token count (via `estimateCostsFromTokenCount`); all other paths set it to `false`.

### `ModelPricing` (internal, line 24)

```ts
interface ModelPricing {
  modelId: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  contextWindow: number;
  maxOutput: number;
}
```

Row shape returned from the `model_pricing` database table. Not exported.

---

## Constants

### `SECURITY_CRITICAL_PATTERNS` (exported, line 33)

```ts
export const SECURITY_CRITICAL_PATTERNS: RegExp[]
```

18 case-insensitive regexes matching security-sensitive path segments (e.g. `auth`, `crypto`, `api`, `middleware`, `token`, `password`, `permission`, `validat`, `saniti`). Used externally to prioritize files for thorough-mode scanning.

[GAP] No function in this module consumes `SECURITY_CRITICAL_PATTERNS`; it is exported for use elsewhere but the consuming call-site is not documented here.

### `BUDGET_PERCENTAGES` (exported, line 41)

```ts
export const BUDGET_PERCENTAGES: Record<string, number> = {
  full: 1.0,
  thorough: 0.33,
  opportunistic: 0.10,
};
```

Fraction of total tokens analysed per audit level. These values are duplicated as inline literals inside `estimateCosts`, `estimateCostsFromTokenCount`, and `estimateCostsForComponents`.

[REC] Replace the inline `0.33` / `0.10` literals in the three estimation functions with lookups into `BUDGET_PERCENTAGES` to eliminate duplication and ensure consistency.

### `ANALYSIS_OVERHEAD` (internal, line 133)

```ts
const ANALYSIS_OVERHEAD = 0.05;
```

Fixed 5% of **total project tokens** added to every level's input cost to represent component-analysis overhead.

### `ESTIMATED_OUTPUT_RATIO` (internal, line 137)

```ts
const ESTIMATED_OUTPUT_RATIO = 0.15;
```

Output tokens are estimated as 15% of input tokens (structured JSON findings).

---

## Functions

### `roughTokenCount` (exported, line 50)

```ts
export function roughTokenCount(files: ScannedFile[]): number
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `files` | `ScannedFile[]` | Array of scanned files (each has `roughTokens: number`) |

**Returns:** `number` -- sum of `roughTokens` across all files.

**Behavior:** Pure reduce; no I/O.

---

### `estimateCosts` (exported, async, line 57)

```ts
export async function estimateCosts(
  pool: Pool,
  files: ScannedFile[],
  modelId?: string, // default 'claude-opus-4-5-20251101'
): Promise<CostEstimate>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pool` | `Pool` | -- | Postgres connection pool |
| `files` | `ScannedFile[]` | -- | Files to estimate |
| `modelId` | `string` | `'claude-opus-4-5-20251101'` | Model whose pricing to use |

**Returns:** `Promise<CostEstimate>` with `isPrecise: false`.

**Behavior:**
1. Fetches pricing via `getModelPricing`.
2. Computes `totalTokens` via `roughTokenCount(files)`.
3. Derives `thoroughTokens` (33%) and `opportunisticTokens` (10%).
4. For each level, delegates to `calculateLevelCost(levelTokens, totalTokens, pricing)`.

---

### `estimateCostsFromTokenCount` (exported, async, line 97)

```ts
export async function estimateCostsFromTokenCount(
  pool: Pool,
  totalFiles: number,
  totalTokens: number,
  modelId?: string, // default 'claude-opus-4-5-20251101'
): Promise<CostEstimate>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pool` | `Pool` | -- | Postgres connection pool |
| `totalFiles` | `number` | -- | Known file count |
| `totalTokens` | `number` | -- | Known precise token count |
| `modelId` | `string` | `'claude-opus-4-5-20251101'` | Model whose pricing to use |

**Returns:** `Promise<CostEstimate>` with `isPrecise: true`.

**Behavior:** Same as `estimateCosts` but accepts pre-computed totals instead of `ScannedFile[]`. Sets `isPrecise: true`.

---

### `estimateCostsForComponents` (exported, async, line 156)

```ts
export async function estimateCostsForComponents(
  pool: Pool,
  componentIds: string[],
  projectTotalTokens: number,
  modelId?: string, // default 'claude-opus-4-5-20251101'
): Promise<CostEstimate>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pool` | `Pool` | -- | Postgres connection pool |
| `componentIds` | `string[]` | -- | UUIDs of selected components |
| `projectTotalTokens` | `number` | -- | Total tokens for the whole project (used for overhead calc) |
| `modelId` | `string` | `'claude-opus-4-5-20251101'` | Model whose pricing to use |

**Returns:** `Promise<CostEstimate>` with `isPrecise: false`.

**Behavior:**
1. Returns zero-cost estimate immediately if `componentIds` is empty (line 162).
2. Fetches pricing via `getModelPricing`.
3. Queries `components` table: `SELECT SUM(estimated_files), SUM(estimated_tokens) WHERE id = ANY($1)` (line 177).
4. Derives per-level estimates using component-scoped token counts but passes **`projectTotalTokens`** (not the component subset) as the second argument to `calculateLevelCost`, so analysis overhead scales with the whole project.

[GAP] `isPrecise` is always `false` for component-scoped estimates, but no comment explains why. Presumably because `estimated_tokens` in the `components` table is itself an approximation.

---

### `calculateLevelCost` (internal, line 139)

```ts
function calculateLevelCost(
  levelTokens: number,
  totalTokens: number,
  pricing: ModelPricing,
): number
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `levelTokens` | `number` | Tokens analysed at this audit level |
| `totalTokens` | `number` | Total project tokens (for overhead) |
| `pricing` | `ModelPricing` | Model pricing rates |

**Returns:** `number` -- USD cost rounded to 4 decimal places.

#### Cost Calculation Formula

```
inputTokens  = levelTokens + totalTokens * ANALYSIS_OVERHEAD
outputTokens = inputTokens * ESTIMATED_OUTPUT_RATIO

cost = (inputTokens  / 1,000,000) * pricing.inputCostPerMtok
     + (outputTokens / 1,000,000) * pricing.outputCostPerMtok

return round(cost, 4)   // Math.round(cost * 10000) / 10000
```

Where:
- `ANALYSIS_OVERHEAD` = 0.05 (5% of total project tokens, fixed cost independent of audit level)
- `ESTIMATED_OUTPUT_RATIO` = 0.15 (15% of input tokens)

---

### `getModelPricing` (internal, async, line 214)

```ts
async function getModelPricing(pool: Pool, modelId: string): Promise<ModelPricing>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pool` | `Pool` | Postgres connection pool |
| `modelId` | `string` | Model identifier to look up |

**Returns:** `Promise<ModelPricing>`.

#### Database Operation

```sql
SELECT model_id, input_cost_per_mtok, output_cost_per_mtok, context_window, max_output
FROM model_pricing
WHERE model_id = $1
```

**Fallback (line 220):** If no row is found, returns hardcoded Opus 4.5 defaults:

| Field | Fallback Value |
|-------|---------------|
| `modelId` | `'claude-opus-4-5-20251101'` |
| `inputCostPerMtok` | `5.0` |
| `outputCostPerMtok` | `25.0` |
| `contextWindow` | `200000` |
| `maxOutput` | `64000` |

[REC] `getModelPricing` is called on every cost estimate with no caching. If estimates are computed frequently, consider a short-lived cache keyed on `modelId`.

---

## Database Tables Referenced

| Table | Operation | Location |
|-------|-----------|----------|
| `model_pricing` | `SELECT ... WHERE model_id = $1` | `getModelPricing`, line 215 |
| `components` | `SELECT SUM(estimated_files), SUM(estimated_tokens) WHERE id = ANY($1)` | `estimateCostsForComponents`, line 177 |

---

## Summary of Gaps and Recommendations

| Tag | Line(s) | Description |
|-----|---------|-------------|
| [GAP] | 33-38 | `SECURITY_CRITICAL_PATTERNS` is exported but not consumed within this module; consuming call-site not documented. |
| [GAP] | 210 | `isPrecise: false` for component estimates is unexplained. |
| [REC] | 41-45, 66-67, 105-106, 187-188 | Inline `0.33`/`0.10` literals duplicate `BUDGET_PERCENTAGES`; use the constant instead. |
| [REC] | 214 | `getModelPricing` has no caching; could benefit from a short-lived cache. |
