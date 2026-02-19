# Refactor progress_detail to Discriminated Union + Fix Audit Page Bugs

**Date:** 2026-02-19

---

## Context

The `progress_detail` JSONB column in the `audits` table stores three incompatible shapes:
1. **Object** `{ clone_progress: string }` during cloning (audit.ts L123-126)
2. **Object** `{ warning: string }` on diff/planning errors (audit.ts L230-232, L412-414)
3. **Array** `[{ file, status, findingsCount }]` during/after analysis (audit.ts L428-436, L547-549)

This causes two bugs:
- **TypeError**: When audit fails before analysis phase, the API returns a truthy object (shape 1 or 2). Client calls `.reduce()` on it (audit.ts:134), crashing with `data.progressDetail?.reduce is not a function`.
- **Infinite polling**: The crash in `renderStatus()` prevents the terminal-status check at L51 from executing. `consecutiveErrors` resets to 0 each poll (fetch succeeds at L48), so the counter never reaches MAX_CONSECUTIVE_ERRORS.

Additionally, clone progress was intended to be shown in the UI (per plans/20260130_02.md L237-240) but the client-side rendering was never implemented.

---

## Solution Summary

Refactor `progress_detail` to always store a **discriminated union** object with a `type` field. Define a proper TypeScript sum type with a shared base interface. Warnings accumulate in `warnings: string[]` across phases. Client uses `switch (detail.type)` for type-safe rendering. Code must be resilient to unknown `type` values (show no status) and missing properties (show something, not crash). No DB migration needed for stale data.

---

## Technical Design

### 1. TypeScript Sum Type

Define in `src/server/services/audit.ts` (server) and mirror in `src/client/audit.ts` (client).

```typescript
// ---- progress_detail discriminated union ----

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
  current: number;      // 1-based index of repo being cloned
  total: number;        // total repos
  repoName: string;     // name of current repo
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

**How the sum type works**: `type` is the discriminator literal. TypeScript narrows the union when you check `detail.type === 'cloning'`, giving compile-time access to `detail.current`, `detail.total`, `detail.repoName`. A `switch (detail.type)` is exhaustive — the compiler warns if a variant is unhandled.

### 2. Server Writes (`src/server/services/audit.ts`)

Add `const warnings: string[] = [];` near the start of `runAudit()` (after L67).

**5 write locations:**

| # | Line | Current Shape | New Shape | Notes |
|---|------|--------------|-----------|-------|
| 1 | L123-126 | `{ clone_progress: "Cloning N/M: repo" }` | `{ type: 'cloning', current: N, total: M, repoName: repo, warnings }` | Inside clone loop, one write per repo |
| 2 | L230-232 | `{ warning: msg }` | Push `msg` to `warnings`, write `{ type: 'cloning', current: repos.length, total: repos.length, repoName: repo.name, warnings }` | Diff failure during incremental — cloning is still the phase |
| 3 | L412-414 | `{ warning: msg }` | Push `msg` to `warnings`, write `{ type: 'planning', warnings }` | Planning returned no files |
| 4 | L428-436 | `[{ file, status, findingsCount }]` | `{ type: 'analyzing', files: [...], warnings }` | Analysis initialization |
| 5 | L547-549 | Updated array | `{ type: 'analyzing', files: progressDetail, warnings }` | Per-batch update |

**Additional write — completion state**: After the analysis loop succeeds and before `UPDATE audits SET status = 'completed'` (~L653), write:
```typescript
{ type: 'done', files: progressDetail, warnings }
```
This ensures completed audits have the `done` type in progress_detail.

**Helper function** (optional, for DRY):
```typescript
function writeProgress(pool: Pool, auditId: string, detail: ProgressDetail): Promise<void> {
  return pool.query(
    `UPDATE audits SET progress_detail = $1 WHERE id = $2`,
    [JSON.stringify(detail), auditId]
  ).then(() => {});
}
```

### 3. API Layer (`src/server/routes/api.ts`)

**Location:** GET `/api/audit/:id` response at L1362.

Current code:
```typescript
progressDetail: isPrivileged ? (audit.progress_detail || []) : [],
```

Change to:
```typescript
progressDetail: isPrivileged ? (audit.progress_detail || null) : null,
```

No normalization function needed. The client handles any shape, including stale DB data, by checking `type` and guarding all property access. Unknown shapes (including old `{ clone_progress }`, `{ warning }`, bare arrays, and null) are treated as "no progress data" by the client.

### 4. Client Changes (`src/client/audit.ts`)

#### 4a. Interface update (L7-31)

Replace `progressDetail: Array<...>` with the full sum type:

```typescript
interface FileProgress {
  file: string;
  status: string;
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

interface AuditStatus {
  // ... existing fields ...
  progressDetail: ProgressDetail | null;  // null when not available or non-privileged
  // ...
}
```

#### 4b. Fix polling bug (L45-68)

Move terminal-status check BEFORE `renderStatus()`, wrap render in try/catch:

```typescript
async function poll() {
  try {
    const data = await apiFetch<AuditStatus>(`/api/audit/${auditId}`);
    consecutiveErrors = 0;

    // Terminal check FIRST — must execute even if rendering throws
    const isTerminal = data.status === 'completed'
      || data.status === 'completed_with_warnings'
      || data.status === 'failed';

    try {
      renderStatus(data);
    } catch (renderErr) {
      console.error('Render error:', renderErr);
    }

    if (isTerminal && pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  } catch (err) {
    consecutiveErrors++;
    // ... existing error handling unchanged
  }
}
```

#### 4c. Update `renderStatus()` — type-discriminated rendering

**Clone progress (L110-122)**: Enhance the `cloning` label using progressDetail when available:

```typescript
const detail = data.progressDetail;
if (data.status === 'cloning' && detail?.type === 'cloning') {
  statusLabels['cloning'] = `Cloning repositories (${detail.current}/${detail.total}: ${detail.repoName})...`;
}
```

**File list (L128-131)**: Extract files safely:
```typescript
const files = (detail?.type === 'analyzing' || detail?.type === 'done') ? detail.files : null;
if (files && files.length > 0) {
  renderFileList(files);
}
```

**Findings summary (L134)**: Use the same extracted `files`:
```typescript
const totalFindings = files?.reduce((sum, f) => sum + (f.findingsCount || 0), 0) || 0;
```

**Warnings**: If `detail?.warnings?.length > 0`, render into warnings notice:
```typescript
if (detail?.warnings && detail.warnings.length > 0) {
  show('warnings-notice');
  const list = $('warnings-list');
  if (list) {
    list.innerHTML = detail.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
  }
}
```

**Resilience rules**:
- Unknown `type` (including stale data where `type` is undefined) → show no progress detail, just the status label
- Missing `files` on analyzing/done → show empty file list (guarded by `files && files.length > 0`)
- Missing `warnings` → show no warnings (guarded by `detail?.warnings?.length > 0`)
- Missing `current`/`total`/`repoName` on cloning → the default "Cloning repositories..." label is used (guarded by `detail?.type === 'cloning'` check)
- `null` progressDetail → all checks naturally fail, no crash

### 5. HTML Changes (`public/audit.html`)

Add warnings notice between file-list card (L70) and completion card (L72):

```html
<!-- Warnings -->
<div class="notice notice-warn hidden" id="warnings-notice">
    <strong>Warnings:</strong>
    <ul id="warnings-list"></ul>
</div>
```

---

## Exhaustive Write/Read Consistency Check

### Writes (all in `src/server/services/audit.ts`)

| # | Line | Audit Status | Shape Written | `type` | Has `files`? | Has `warnings`? |
|---|------|-------------|--------------|--------|-------------|----------------|
| 1 | L123-126 | `cloning` | ProgressCloning | `'cloning'` | No | Yes |
| 2 | L230-232 | `cloning` (incremental diff fail) | ProgressCloning | `'cloning'` | No | Yes (appended) |
| 3 | L412-414 | `planning` | ProgressPlanning | `'planning'` | No | Yes (appended) |
| 4 | L428-436 | `analyzing` | ProgressAnalyzing | `'analyzing'` | Yes (all pending) | Yes |
| 5 | L547-549 | `analyzing` | ProgressAnalyzing | `'analyzing'` | Yes (mutated) | Yes |
| 6 | ~L650 (new) | before `completed` | ProgressDone | `'done'` | Yes (final) | Yes |

### Reads

| Location | Current Code | New Code | Resilience |
|----------|-------------|----------|------------|
| api.ts L1362 | `audit.progress_detail \|\| []` | `audit.progress_detail \|\| null` | Null for missing data |
| audit.ts L129 | `data.progressDetail && data.progressDetail.length > 0` | `files && files.length > 0` (extracted via type check) | Null-safe, unknown-type-safe |
| audit.ts L134 | `data.progressDetail?.reduce(...)` | `files?.reduce(...)` (only when type is analyzing/done) | Null-safe, no crash |
| audit.ts L160 | `renderFileList(data.progressDetail)` | `renderFileList(files)` (typed as FileProgress[]) | Only called when files exist |

### Status × ProgressDetail alignment

| Audit Status | Expected progress_detail type | Client behavior |
|-------------|------------------------------|-----------------|
| `pending` | null (DB default `'[]'`) | No progress detail shown |
| `cloning` | `ProgressCloning` | Shows "Cloning (N/M: repo)..." |
| `classifying` | `ProgressCloning` (last clone write) | Shows status label only |
| `planning` | `ProgressPlanning` or `ProgressCloning` | Shows status label only |
| `analyzing` | `ProgressAnalyzing` | Shows file list + findings |
| `synthesizing` | `ProgressAnalyzing` (unchanged) | Shows file list + findings |
| `completed` | `ProgressDone` | Shows file list + findings + completion card |
| `completed_with_warnings` | `ProgressDone` | Shows file list + findings + completion card |
| `failed` | Whatever was last written | Shows what it can, error notice shown |

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/server/services/audit.ts` | Add sum type; add `warnings: string[]` local var; refactor 5 writes + add 1 new write; add optional `writeProgress()` helper |
| `src/server/routes/api.ts` | Change `progress_detail \|\| []` to `progress_detail \|\| null` at L1362 |
| `src/client/audit.ts` | Add sum type; update `AuditStatus` interface; fix poll() (terminal check first + try/catch); type-discriminated rendering in renderStatus(); update renderFileList parameter type |
| `public/audit.html` | Add `#warnings-notice` and `#warnings-list` elements |
| `spec/client/audit.md` | Update interface, DOM IDs, function descriptions |
| `spec/services/audit.md` | Document ProgressDetail sum type, write locations |
| `spec/api.md` | Update GET `/api/audit/:id` response shape |
| `product/views/audit.md` | Document clone progress display, warnings display |

---

## Implementation Steps

1. **Server types + writes** (`src/server/services/audit.ts`)
   - Define `FileProgress`, `ProgressBase`, `ProgressCloning`, `ProgressPlanning`, `ProgressAnalyzing`, `ProgressDone`, `ProgressDetail`
   - Add `const warnings: string[] = [];` after L67
   - Refactor writes #1-5 per table above
   - Add write #6 (done state before completion UPDATE)

2. **API passthrough** (`src/server/routes/api.ts`)
   - Change L1362 from `|| []` to `|| null`

3. **Client types + polling fix** (`src/client/audit.ts`)
   - Define the same sum type (client-side mirror)
   - Update `AuditStatus.progressDetail` type
   - Fix poll() — terminal check before render, try/catch around render

4. **Client rendering** (`src/client/audit.ts`)
   - Type-discriminated rendering in renderStatus()
   - Extract `files` via type check, use for file list and findings
   - Enhanced clone progress label
   - Warning rendering

5. **HTML** (`public/audit.html`)
   - Add warnings notice element

6. **Documentation** — update spec and product docs

---

## Verification

1. **Build**: `npm run build` must succeed
2. **New audit**: Start audit, verify clone progress shows "Cloning (1/N: repo)...", file list appears during analysis, completion works
3. **Failed audit**: Trigger failure, verify no TypeError, polling stops, error message shows
4. **Stale data resilience**: If old-format progress_detail is in DB — page shows status label but no progress detail (doesn't crash)
5. **Tests**: `npm test` (if DB available)
