# Batch Planning Calls + Fix Audit Page Spinner

**Date:** 2026-02-19

---

## Context

The planning phase (`runPlanningPhase()` in `planning.ts`) sends ALL project files to Claude in a single API call with `max_tokens: 16384`. For repos with 303+ files, Claude's JSON response exceeds the output limit, producing truncated JSON that `parseJsonResponse()` cannot parse. The audit fails with: `Failed to extract JSON from response. Starts with: "```json [...]"`.

Additionally, when an audit fails before the analysis phase, the file-list card on the audit page shows a "Loading..." spinner indefinitely because `renderStatus()` only replaces it when `ProgressAnalyzing`/`ProgressDone` files exist.

---

## Solution Summary

1. **Raise global `max_tokens` default** in `callClaude()` from `16384` → `64000`. The LLM doesn't adjust output based on `max_tokens` — a lower limit only risks truncation with zero benefit. 64,000 is the API max for Opus 4.5.
2. **Batch planning calls**: Split files into batches of ~250, call Claude per batch, merge ranked results. On parse failure, retry with half the batch size (recursive halving down to min 25 files).
3. **Add `stopReason` to `ClaudeResponse`**: Surface `response.stop_reason` from the SDK for truncation detection.
4. **Fix client spinner**: Clear the file-list loading spinner on terminal audit states.

---

## Technical Design

### 1. Raise global `max_tokens` default (`claude.ts` L49)

Change the default from `16384` to `64000`:

```typescript
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-opus-4-5-20251101',
  maxTokens: number = 64000,  // was 16384
): Promise<ClaudeResponse> {
```

This benefits ALL callers — planning, analysis, classification, synthesis. The LLM generates tokens until it naturally completes; `max_tokens` is just a safety cap. A lower value only causes silent truncation.

### 2. Planning batch constants (`planning.ts`, after L12)

```typescript
const TARGET_FILES_PER_BATCH = 250;  // ~15K output tokens, well under 32K (50% of 64K)
const MIN_BATCH_SIZE = 25;           // Floor for retry halving
```

**Rationale**: Each ranked file entry ≈ 60 output tokens. 250 × 60 = 15,000 tokens — under 32,000 (50% of 64K max). MIN_BATCH_SIZE of 25 bounds recursion to ~3 levels.

### 3. `ClaudeResponse.stopReason` (`claude.ts`)

Add `stopReason: string` to `ClaudeResponse` (L6-10) and capture `response.stop_reason` in the return (L68-72):

```typescript
export interface ClaudeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;  // SDK StopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'
}
```

At L68-72, add `stopReason: response.stop_reason || 'end_turn'` to the return object (default handles null).

**Impact**: Non-breaking addition. All existing callers (`audit.ts`, `planning.ts`) destructure only `content`/`inputTokens`/`outputTokens`.

### 4. Update `runPlanningCall()` (`planning.ts`)

One change:
- L197-202: Remove the explicit `16384` argument from `callClaude()` — it now uses the global default of `64000`

```typescript
const response = await callClaude(
  apiKey,
  'You are a security audit planner. Return valid JSON only.',
  prompt,
  PLANNING_MODEL,
  // maxTokens omitted — uses global default (64000)
);

const rankedFiles = parseJsonResponse<RankedFile[]>(response.content);
return { rankedFiles, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
```

Return type unchanged: `{ rankedFiles: RankedFile[]; inputTokens: number; outputTokens: number }`. `stopReason` is available on `ClaudeResponse` but not needed here — retry logic uses `SyntaxError` catch from `parseJsonResponse()`.

### 5. New `runPlanningCallWithRetry()` (`planning.ts`, after `runPlanningCall`)

Wraps `runPlanningCall()` with recursive retry on `SyntaxError`:

```typescript
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
    const r = await runPlanningCall(apiKey, files, grepResults, componentProfiles, threatModel, category, description, level);
    return { rankedFiles: r.rankedFiles, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
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
```

**Key**: On `SyntaxError`, split in half and retry both halves recursively. Non-SyntaxError exceptions (API errors) propagate up unchanged. Max recursion depth: ~log2(250/25) = ~3 levels.

### 6. New `runBatchedPlanningCalls()` (`planning.ts`, after retry function)

Orchestrates batch splitting and sequential execution:

```typescript
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
```

**Design choices**:
- **Short-circuit**: ≤250 files → single call (no batching overhead)
- **Sequential**: Predictable cost tracking, no concurrent API races
- **Each batch gets full context**: Grep results + component profiles + threat model shared. Only the file list is split.
- **Prompt template unchanged**: "Rank ALL files below" naturally refers to the batch's file list section

### 7. Wire into `runPlanningPhase()` (`planning.ts` L289)

Replace `runPlanningCall` with `runBatchedPlanningCalls`:

```typescript
// L289: change runPlanningCall → runBatchedPlanningCalls
const planningResult = await runBatchedPlanningCalls(
  apiKey, files, grepResults, componentProfiles,
  threatModelText, classification.category, classification.description, level,
);
```

Rest of `runPlanningPhase()` unchanged — `planningResult` has same `{ rankedFiles, inputTokens, outputTokens }` shape. Cost calculation and `selectFilesByBudget()` work as before.

### 8. Client spinner fix (`src/client/audit.ts` L176-179)

```typescript
// After:
const files = (detail?.type === 'analyzing' || detail?.type === 'done') ? detail.files : null;
if (files && files.length > 0) {
  renderFileList(files);
} else if (data.status === 'failed' || data.status === 'completed' || data.status === 'completed_with_warnings') {
  const list = $('file-list');
  if (list) list.innerHTML = '';
}
```

### 9. Test mock update (`test/services/planning.test.ts` L26-30)

Add `stopReason: 'end_turn'` to mock `callClaude` return:

```typescript
return {
  content: mockClaudeState.responseContent,
  inputTokens: 1000,
  outputTokens: 500,
  stopReason: 'end_turn',
};
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/server/services/claude.ts` | Raise default `maxTokens` from 16384 → 64000 (L49); add `stopReason: string` to `ClaudeResponse` (L6-10); capture `response.stop_reason` in return (L68-72) |
| `src/server/services/planning.ts` | Add 2 constants; remove explicit maxTokens from `runPlanningCall()`, add `stopReason` to return; add `runPlanningCallWithRetry()`; add `runBatchedPlanningCalls()`; wire into `runPlanningPhase()` |
| `src/client/audit.ts` | Clear file-list on terminal states without files |
| `test/services/planning.test.ts` | Add `stopReason` to mock return |
| `spec/services/claude.md` | Document `stopReason` field |
| `spec/services/planning.md` | Document constants, new functions, updated behavior |
| `spec/client/audit.md` | Document spinner clearing for terminal states |
| `product/views/audit.md` | Note spinner behavior on early failure |

---

## Verification

1. **Build**: `npm run build` — zero errors
2. **Tests**: `npm test` — existing tests pass with mock update
3. **Manual test (small repo)**: Start audit on a small repo (~50 files) — should use single call, no batching
4. **Manual test (large repo)**: Start audit on a 300+ file repo — should see `[Planning] Batch 1/2` log messages, audit completes successfully
5. **Failure test**: Temporarily set `TARGET_FILES_PER_BATCH = 5` and verify retry halving works on a 20-file repo
6. **Spinner test**: Start an audit and kill the server mid-planning — verify the client shows "Audit failed" without a loading spinner
