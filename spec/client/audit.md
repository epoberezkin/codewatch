# audit.ts -- Audit Progress Module

**Source**: [`audit.ts`](../../src/client/audit.ts#L1-L258)
**HTML**: `public/audit.html`

---

## Overview

Polls audit status every 3 seconds and renders progress (bar, file list, status icons). Pauses polling when the tab is hidden. Stops on completion, failure, or 5 consecutive errors.

---

## [Interfaces](../../src/client/audit.ts#L7-L64)

### [ProgressDetail discriminated union](../../src/client/audit.ts#L9-L40)

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

All variants share a `warnings: string[]` field via `ProgressBase`. The `type` discriminant enables type-safe narrowing in rendering logic. `files` is only present on `analyzing` and `done` variants.

### [AuditStatus](../../src/client/audit.ts#L44-L64)

```ts
interface AuditStatus {
  id: string;
  projectId: string;
  projectName: string;
  githubOrg: string;
  status: string;  // pending | cloning | classifying | planning | estimating | analyzing | synthesizing | completed | completed_with_warnings | failed
  auditLevel: string;
  isIncremental: boolean;
  isOwner: boolean;
  isRequester: boolean;
  totalFiles: number;
  filesToAnalyze: number;
  filesAnalyzed: number;
  progressDetail: ProgressDetail | null;
  commits: Array<{ repoName: string; commitSha: string; branch: string }>;
  maxSeverity: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

---

## [State Variables](../../src/client/audit.ts#L73-L75)

| Variable | Type | Description |
|---|---|---|
| `pollInterval` | `ReturnType<typeof setInterval> \| null` | Active polling interval handle |
| `consecutiveErrors` | `number` | Consecutive poll failure counter |

**Constants**:
- `MAX_CONSECUTIVE_ERRORS = 5` (L75)

---

## Functions

### [poll](../../src/client/audit.ts#L78-L109)

| Function | Signature | Description |
|---|---|---|
| `poll` | `() => Promise<void>` | Fetches audit status. Resets `consecutiveErrors` on success. Computes `isTerminal` flag BEFORE calling `renderStatus` (ensuring the flag survives render errors). Wraps `renderStatus` in try/catch to isolate render errors. Clears interval after render if terminal status (`completed`, `completed_with_warnings`, `failed`). On fetch error, increments counter; at 5 consecutive, stops polling and shows error. |

### [renderStatus](../../src/client/audit.ts#L112-L217)

| Function | Signature | Description |
|---|---|---|
| `renderStatus` | `(data: AuditStatus) => void` | Renders all UI elements from audit status data using type-discriminated `progressDetail` |

Rendering logic:
1. **Status badge** (L116-L128): Maps status to badge CSS class (`badge-pending`, `badge-running`, `badge-completed`, `badge-failed`)
2. **Audit level** (L129): Sets audit level text
3. **Ownership badge** (L132-L134): Shows owner badge if `isOwner`
4. **Commit info** (L137-L142): Formats `repoName@sha7` for each commit
5. **Incremental badge** (L144-L146): Shows "incremental" badge if applicable
6. **Progress bar** (L148-L173): Calculates percentage, sets fill width, sets status label from status map. Enhanced clone progress: when `detail.type === 'cloning'`, overrides label with `Cloning repositories (current/total: repoName)...`
7. **File list** (L175-L182): Extracts `files` via type discrimination — only when `detail.type === 'analyzing'` or `detail.type === 'done'`. Delegates to `renderFileList`. On terminal states (`failed`, `completed`, `completed_with_warnings`) without files, clears the file-list loading spinner.
8. **Findings summary** (L184-L188): Shows total findings count (derived from files if available)
9. **Warnings** (L190-L197): When `detail.warnings` has entries, shows `#warnings-notice` and populates `#warnings-list` with escaped warning items.
10. **Completion card** (L199-L210): Shows on `completed` / `completed_with_warnings`. Sets report link, summary text with max severity. Appends warnings note for `completed_with_warnings`.
11. **Error notice** (L212-L216): Shows on `failed` with error message

### [renderFileList](../../src/client/audit.ts#L220-L238)

| Function | Signature | Description |
|---|---|---|
| `renderFileList` | `(files: FileProgress[]) => void` | Renders file items with status icons into `#file-list` |

**Status icons**:
| Status | Icon |
|---|---|
| `pending` | `\u00B7` (middle dot) |
| `analyzing` | `\u25CB` (circle) |
| `done` | `\u2713` (check) |
| `error` | `\u2717` (cross) |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `document` | `visibilitychange` | L241-L253 | Pauses polling when tab hidden (`clearInterval`). Resumes with immediate poll when visible. |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/audit/{auditId}` | poll | L80 |

---

## DOM Element IDs

| ID | Purpose |
|---|---|
| `audit-status-badge` | Status badge container |
| `audit-level` | Audit level text |
| `audit-owner-badge` | Owner badge |
| `audit-commit` | Commit SHA info |
| `audit-type` | Incremental badge |
| `progress-text` | Progress status label |
| `progress-count` | `X / Y files` counter |
| `progress-fill` | Progress bar fill element (width %) |
| `file-list` | Per-file progress list |
| `findings-summary` | Total findings count |
| `completion-card` | Completion card container |
| `view-report-link` | Link to report page |
| `completion-summary` | Completion summary text |
| `error-notice` | Error notice container |
| `error-message` | Error message text |
| `warnings-notice` | Warnings notice container (shown when `detail.warnings` has entries) |
| `warnings-list` | `<ul>` for warning `<li>` items |

---

## Polling Lifecycle

```
DOMContentLoaded
  -> poll() (immediate)
  -> setInterval(poll, 3000)

On each poll:
  Success -> compute isTerminal flag
    -> try { renderStatus() } catch { log }
    -> if isTerminal -> clearInterval
  Error -> consecutiveErrors++
    >= 5? -> clearInterval + showError

Tab hidden -> clearInterval
Tab visible -> setInterval + immediate poll
```

---

## State Management

- Minimal closure state: `pollInterval` and `consecutiveErrors`.
- All display state derived from each poll response (stateless rendering).
- `progressDetail` is a discriminated union (`ProgressDetail | null`); rendering logic uses `detail.type` to narrow and extract type-specific fields (e.g. `files` only on `analyzing`/`done`, `repoName` only on `cloning`).
- No auth wait -- audit page renders for any visitor.

---

## [GAP] No Auth-Gated Rendering

The audit page does not call `waitForAuth()` or check `currentUser`. Ownership badges are derived from the API response's `isOwner` field, but there is no client-side auth gate.

## [GAP] No Elapsed Time Display

No timer showing how long the audit has been running (despite having `createdAt` and `startedAt`).

## [GAP] Polling Resumes Without Error Count Reset

When the tab becomes visible again (L247-L252), `consecutiveErrors` is not reset. If there were prior errors, the counter carries over, potentially triggering the 5-error stop prematurely.

## [REC] Reset `consecutiveErrors = 0` when resuming polling on visibility change. Consider showing elapsed time from `startedAt`.
