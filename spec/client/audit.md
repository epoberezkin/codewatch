# audit.ts -- Audit Progress Module

**Source**: [`audit.ts`](../../src/client/audit.ts) (L1-L194)
**HTML**: `public/audit.html`

---

## Overview

Polls audit status every 3 seconds and renders progress (bar, file list, status icons). Pauses polling when the tab is hidden. Stops on completion, failure, or 5 consecutive errors.

---

## Interface (L6-L30)

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
  progressDetail: Array<{
    file: string;
    status: string;  // pending | analyzing | done | error
    findingsCount: number;
  }>;
  commits: Array<{ repoName: string; commitSha: string; branch: string }>;
  maxSeverity: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

---

## State Variables (L39-L41)

| Variable | Type | Description |
|---|---|---|
| `pollInterval` | `ReturnType<typeof setInterval> \| null` | Active polling interval handle |
| `consecutiveErrors` | `number` | Consecutive poll failure counter |

**Constants**:
- `MAX_CONSECUTIVE_ERRORS = 5` (L41)

---

## Functions

### poll (L43-L66)

| Function | Signature | Description |
|---|---|---|
| `poll` | `() => Promise<void>` | Fetches audit status. Resets `consecutiveErrors` on success. Calls `renderStatus`. Clears interval on terminal status (`completed`, `completed_with_warnings`, `failed`). On error, increments counter; at 5 consecutive, stops polling and shows error. |

### renderStatus (L68-L153)

| Function | Signature | Description |
|---|---|---|
| `renderStatus` | `(data: AuditStatus) => void` | Renders all UI elements from audit status data |

Rendering logic:
1. **Status badge** (L70-L82): Maps status to badge CSS class (`badge-pending`, `badge-running`, `badge-completed`, `badge-failed`)
2. **Audit level** (L83): Sets audit level text
3. **Ownership badge** (L86-L88): Shows owner badge if `isOwner`
4. **Commit info** (L91-L96): Formats `repoName@sha7` for each commit
5. **Incremental badge** (L98-L100): Shows "incremental" badge if applicable
6. **Progress bar** (L103-L123): Calculates percentage, sets fill width, sets status label from status map
7. **File list** (L126-L128): Delegates to `renderFileList`
8. **Findings summary** (L131-L134): Shows total findings count
9. **Completion card** (L137-L147): Shows on `completed` / `completed_with_warnings`. Sets report link, summary text with max severity.
10. **Error notice** (L150-L153): Shows on `failed` with error message

### renderFileList (L156-L174)

| Function | Signature | Description |
|---|---|---|
| `renderFileList` | `(files: AuditStatus['progressDetail']) => void` | Renders file items with status icons into `#file-list` |

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
| `document` | `visibilitychange` | L177-L189 | Pauses polling when tab hidden (`clearInterval`). Resumes with immediate poll when visible. |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/audit/{auditId}` | poll | L45 |

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

---

## Polling Lifecycle

```
DOMContentLoaded
  -> poll() (immediate)
  -> setInterval(poll, 3000)

On each poll:
  Success -> renderStatus()
    Terminal status? -> clearInterval
  Error -> consecutiveErrors++
    >= 5? -> clearInterval + showError

Tab hidden -> clearInterval
Tab visible -> setInterval + immediate poll
```

---

## State Management

- Minimal closure state: `pollInterval` and `consecutiveErrors`.
- All display state derived from each poll response (stateless rendering).
- No auth wait -- audit page renders for any visitor.

---

## [GAP] No Auth-Gated Rendering

The audit page does not call `waitForAuth()` or check `currentUser`. Ownership badges are derived from the API response's `isOwner` field, but there is no client-side auth gate.

## [GAP] No Elapsed Time Display

No timer showing how long the audit has been running (despite having `createdAt` and `startedAt`).

## [GAP] Polling Resumes Without Error Count Reset

When the tab becomes visible again (L183-L188), `consecutiveErrors` is not reset. If there were prior errors, the counter carries over, potentially triggering the 5-error stop prematurely.

## [REC] Reset `consecutiveErrors = 0` when resuming polling on visibility change. Consider showing elapsed time from `startedAt`.
