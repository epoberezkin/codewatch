# report.ts -- Report Page Module

**Source**: [`report.ts`](../../src/client/report.ts) (L1-L541)
**HTML**: `public/report.html`

---

## Overview

Renders a security audit report with three-tier access control:
- **Owner**: Full findings, status updates, publish/unpublish, new audit link
- **Requester**: Redacted findings (medium+ severity), notify owner button
- **Public**: Summary only (if published)

Also includes: finding filters, comments section, dependency "Add as Project", classification/threat model display, component breakdown.

---

## Interfaces (L6-L80)

```ts
interface Finding {
  id, severity, cweId, cvssScore, title, description,
  exploitation, recommendation, codeSnippet,
  filePath, lineStart, lineEnd, repoName, status;
}

interface ReportData {
  id, projectId, projectName, auditLevel, isIncremental,
  isOwner, isRequester, isPublic,
  publishableAfter, ownerNotified, ownerNotifiedAt,
  maxSeverity, category, projectDescription,
  involvedParties, threatModel, threatModelSource,
  commits, reportSummary: { executive_summary, security_posture, responsible_disclosure },
  severityCounts, findings: Finding[],
  redactedSeverities, redactionNotice,
  componentBreakdown: Array<{ componentId, name, role, tokensAnalyzed, findingsCount }>,
  dependencies: Array<{ id, name, version, ecosystem, sourceRepoUrl, linkedProjectId, repoName }>,
  accessTier: 'owner' | 'requester' | 'public',
  createdAt, completedAt;
}

interface Comment {
  id, userId, username, content, findingId, createdAt;
}
```

---

## State Variables (L92)

| Variable | Type | Description |
|---|---|---|
| `reportData` | `ReportData \| null` | Loaded report data, persisted for finding status rollback |

---

## Functions

### renderReport (L103-L306)

| Function | Signature | Description |
|---|---|---|
| `renderReport` | `(data: ReportData) => void` | Master render function. Calls all sub-renderers. |

Rendering sections (in order):
1. **Header** (L105-L111): Title, meta (project link, date, level, incremental flag, commits)
2. **Back to Project link** (L114-L129): Creates link if not in HTML
3. **Access tier badge** (L132)
4. **Severity summary** (L135-L140): Ordered severity count badges
5. **Owner controls** (L143-L152): Shows `#owner-controls`, sets new audit link. Toggles publish/unpublish visibility based on `isPublic`.
6. **Requester controls** (L155-L157): Shows notify owner button (only if requester, not owner, not already notified)
7. **Notification status** (L160-L166): Shows if owner was notified, with dates
8. **Executive summary** (L169-L186): Summary text or "No summary" fallback
9. **Security posture** (L173-L174): Posture paragraph
10. **Responsible disclosure** (L177-L183): Key-value disclosure entries
11. **Classification** (L189-L197): Category badge + project description
12. **Threat model** (L200-L238): Involved parties table (party/can/cannot) with source badge, or plain text threat model
13. **Component breakdown** (L241-L254): Table with name, role, findings count, tokens
14. **Dependencies** (L257-L286): Grouped by ecosystem. Linked projects show "View Project" link; unlinked show "Add as Project" button (authenticated) or "source" link.
15. **Redacted notice** (L289-L295)
16. **Findings** (L298): Delegates to `renderFindings`
17. **Comments** (L301-L305): Loads comments, shows form for participants

### renderFindings (L308-L375)

| Function | Signature | Description |
|---|---|---|
| `renderFindings` | `(findings: Finding[], isOwner: boolean) => void` | Shows empty state or sets up filters + renders list |

**Filter logic** (L317-L374):
- `#severity-filter` dropdown: populated with only severities present in findings
- `#status-filter` dropdown: populated with only statuses present in findings
- `applyFilters()` closure: filters findings array and re-renders
- `updateFilterCount()` closure: shows/hides `#filter-count-badge` with active filter count

### renderFindingsList (L377-L453)

| Function | Signature | Description |
|---|---|---|
| `renderFindingsList` | `(findings: Finding[]) => void` | Renders finding cards with all fields. Owner gets status `<select>` dropdown per finding. |

**Finding card structure**:
- Header: title (or "[Redacted]"), status badge, severity badge
- Location: `repo/file:lineStart-lineEnd`, CWE, CVSS
- Body: description, exploitation, recommendation, code snippet
- Actions (owner only): status select (open, fixed, false_positive, accepted, wont_fix)

**Finding status change handler** (L424-L453):
- `PATCH /api/findings/{findingId}/status` with `{ status }`
- On success: updates badge class+text, updates in-memory `reportData.findings`
- On error: shows error, reverts select to previous status from `reportData`

### loadComments (L456-L478)

| Function | Signature | Description |
|---|---|---|
| `loadComments` | `(auditId: string) => Promise<void>` | Fetches and renders comments list. "No comments yet" for empty. Silently ignores errors. |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#severity-filter` | change | L373 | Calls `applyFilters` |
| `#status-filter` | change | L374 | Calls `applyFilters` |
| `.finding-status-select` (each) | change | L425-L452 | PATCHes finding status (owner only) |
| `#submit-comment-btn` | click | L482-L498 | Posts comment, clears input, reloads comments |
| `#publish-btn` | click | L503-L510 | Confirms, posts publish, reloads page |
| `#unpublish-btn` | click | L514-L522 | Confirms, posts unpublish, reloads page |
| `#notify-owner-btn` | click | L527-L540 | Confirms (explains GitHub issue + disclosure timer), posts notify, shows result, reloads |
| `.add-dep-project-btn` (each) | click | L285 | Via `attachAddAsProjectHandlers` from common.ts |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/audit/{auditId}/report` | init | L95 |
| PATCH | `/api/findings/{findingId}/status` | finding select change | L431-L433 |
| GET | `/api/audit/{auditId}/comments` | loadComments | L458 |
| POST | `/api/audit/{auditId}/comments` | submitCommentBtn click | L493 |
| POST | `/api/audit/{auditId}/publish` | publishBtn click | L506 |
| POST | `/api/audit/{auditId}/unpublish` | unpublishBtn click | L518 |
| POST | `/api/audit/{auditId}/notify-owner` | notifyBtn click | L530 |
| POST | `/api/projects` | attachAddAsProjectHandlers (common.ts) | -- |
| POST | `/api/dependencies/{depId}/link` | attachAddAsProjectHandlers (common.ts) | -- |

---

## DOM Element IDs

| ID | Purpose |
|---|---|
| `report-title` | Report heading text |
| `report-meta` | Meta info (project, date, level, commits) |
| `back-to-project` | Back to project link |
| `access-tier-badge` | Access tier badge container |
| `severity-summary` | Severity count badges |
| `owner-controls` | Owner action buttons container |
| `new-audit-link` | Link to start new audit |
| `publish-btn` | Publish report button |
| `unpublish-btn` | Unpublish report button |
| `requester-controls` | Requester actions container |
| `notify-owner-btn` | Notify owner button |
| `notification-status` | Notification status info |
| `executive-summary` | Executive summary content |
| `posture-section` | Security posture section |
| `security-posture` | Posture content |
| `disclosure-section` | Responsible disclosure section |
| `disclosure-content` | Disclosure key-value pairs |
| `classification-section` | Classification section |
| `classification-content` | Category + description |
| `threat-model-section` | Threat model section |
| `threat-model-content` | Threat model content (parties table or text) |
| `component-breakdown-section` | Component breakdown section |
| `component-breakdown-body` | Component table body |
| `dependencies-section` | Dependencies section |
| `dependencies-content` | Dependencies list |
| `redacted-notice` | Redaction notice |
| `findings-header` | Findings section header (with filters) |
| `findings-list` | Findings card list |
| `severity-filter` | Severity filter dropdown |
| `status-filter` | Status filter dropdown |
| `filter-count-badge` | Active filter count badge (dynamically created) |
| `comments-section` | Comments section |
| `comments-list` | Comments list container |
| `comment-form` | Comment input form |
| `comment-input` | Comment textarea |
| `submit-comment-btn` | Submit comment button |

---

## State Management

- `reportData` persisted for finding status rollback on PATCH failure.
- Filter state is ephemeral (dropdown values + closure-captured `findings` array).
- Comments are re-fetched (not locally appended) after submission.

---

## [GAP] Publish/Unpublish Reloads Entire Page

`window.location.reload()` after publish/unpublish is a blunt refresh. No optimistic UI update.

## [GAP] Comment Submission Has No Loading State

The submit button is not disabled during POST, allowing double-submission.

## [GAP] No Finding Search

Findings can be filtered by severity and status, but not searched by text (title, description, file path).

## [GAP] Notify Owner Success Uses showError

L532-L534: Success messages after notifying owner are displayed via `showError()`, which renders as an error-styled notice.

## [REC] Disable comment submit button during POST. Use a success-styled notice for notify-owner confirmation. Consider adding text search for findings.
