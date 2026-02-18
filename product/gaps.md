# Gaps and Recommendations

All `[GAP]` and `[REC]` annotations collected from product view and flow documents, grouped by area.

---

## UI: Input Validation & Error Feedback

### GAP: GitHub URL parser rejects `www.github.com`
**Source:** [home.md](views/home.md) (Step 1)
The parser requires exactly `github.com` as the hostname. URLs with `www.github.com` or GitHub Enterprise domains are rejected without a specific error message.

**REC:** Accept `www.github.com` as a valid alias, or provide a more specific error message when the hostname is close but not exact.

### GAP: Org-only URLs rejected despite API support
**Source:** [home.md](views/home.md) (Step 1)
The URL parser requires at least two path segments (`/owner/repo`). Entering `https://github.com/org` is rejected, even though the API supports fetching entity info by owner alone.

**REC:** Support owner-only URLs (fetch all repos for the owner) or clarify in the placeholder/label that a specific repo URL is required.

### GAP: Branch fetch errors silently swallowed
**Source:** [home.md](views/home.md) (Step 2)
The catch block just restores the UI. The user gets no feedback about why the dropdown disappeared.

**REC:** Show a brief inline error or tooltip when branch fetching fails.

### GAP: No server-side API key validation before expensive operations
**Source:** [estimate.md](views/estimate.md) (API Key Section)
An invalid key that passes the `sk-ant-` prefix check will fail at the Anthropic API call. The user sees this as an analysis failure error toast.

**REC:** Add a lightweight `POST /api/validate-key` endpoint that tests the key before enabling analysis.

### GAP: Missing redirect error on audit page
**Source:** [audit.md](views/audit.md)
The page redirects to `/` if `auditId` query param is missing, with no error message explaining why.

**REC:** Show a brief error notice before redirecting, or redirect to a page that explains the issue.

---

## UI: List & Selection Behavior

### GAP: "Select all" ignores search filter
**Source:** [home.md](views/home.md) (Step 2)
The "Select all" checkbox toggles all checkboxes in the list, including those hidden by the filter.

**REC:** Make "Select all" only toggle currently visible (non-hidden) repo checkboxes.

### ~~GAP: Repo list not re-rendered after checkbox change~~ (RESOLVED)
**Source:** [home.md](views/home.md) (Step 2)
**Fixed:** `renderAllReposList()` is now called after every checkbox change and after removing a repo via the remove button, keeping both lists in sync.

### GAP: No debounce on component checkbox changes
**Source:** [estimate.md](views/estimate.md) (Component Selection)
Each toggle fires an API call immediately. Rapid toggling could cause race conditions in estimate display.

**REC:** Debounce `onComponentSelectionChange` by ~300ms to batch rapid toggles into a single API call.

### GAP: No pagination on projects browser
**Source:** [projects.md](views/projects.md)
The API query has `LIMIT 50` but there is no pagination UI. Users with more than 50 visible projects cannot access those beyond the first page.

**REC:** Add pagination controls (next/previous or infinite scroll) and pass `offset` to the API.

### GAP: No pagination or lazy loading for findings
**Source:** [report.md](views/report.md)
Large audits with many findings render all cards at once.

**REC:** Implement virtual scrolling or "Show more" pagination for findings lists exceeding ~50 items.

---

## UI: Loading States & Feedback

### GAP: Project creation loading overlay has no timeout or cancel
**Source:** [home.md](views/home.md) (Step 3)
If the API call hangs, the user is stuck on a spinner with no way to retry.

**REC:** Add a timeout and ensure the error handler restores the UI. Consider adding a "Cancel" button on the overlay.

### GAP: Branch editor Apply has no proper loading/error state
**Source:** [estimate.md](views/estimate.md) (Branch Editor)
No loading/disabled state besides text change to "Applying...". If the PUT fails, the editor remains open with stale data.

**REC:** Disable the Apply button, show a spinner, and close the editor or re-fetch data on error.

### GAP: No loading state for finding status changes
**Source:** [report.md](views/report.md)
The dropdown updates optimistically but there is no spinner or disabled state during the API call.

**REC:** Disable the dropdown and show a brief loading indicator while the PATCH request is in flight.

### GAP: "Notify Owner" success uses error toast styling
**Source:** [report.md](views/report.md)
The success message uses `showError()` (red toast) for what is actually a success confirmation.

**REC:** Use a success-styled notification (green) or a dedicated `showSuccess()` helper.

### GAP: Publish/unpublish and notify-owner reload the entire page
**Source:** [report.md](views/report.md)
This loses scroll position and feels jarring.

**REC:** Update in-memory state and re-render affected sections without a full page reload.

### GAP: "Add as Project" button has no inline feedback
**Source:** [project.md](views/project.md), [report.md](views/report.md)
After clicking, the user must navigate to the newly created project manually.

**REC:** After success, replace the button with a "View Project" link pointing to the newly created project.

### GAP: No retry button after polling failure on audit page
**Source:** [audit.md](views/audit.md)
After 5 consecutive poll errors, the user must manually refresh the page.

**REC:** Add a "Retry" button that resets `consecutiveErrors` and restarts polling.

---

## UI: Information Display

### ~~GAP: Threat model truncated without indication~~ (RESOLVED)
**Source:** [project.md](views/project.md), [report.md](views/report.md)
**Fixed:** Threat model text is no longer truncated. The API now parses the stored threat model into structured fields (`threatModel`, `threatModelParties`, `threatModelFileLinks`) and sends them in full. Client renders all fields without truncation.

### GAP: Component descriptions and security profiles truncated without indication
**Source:** [project.md](views/project.md)
The `filePatterns`, `languages`, and `threat_surface` fields are fetched but not displayed.

**REC:** Add expandable rows or tooltips to show full descriptions and the omitted fields.

### GAP: Access tier preview hidden inside Step 3
**Source:** [estimate.md](views/estimate.md)
Users may not see the access tier warning until they have already invested time in component analysis.

**REC:** Surface access tier preview earlier (e.g., below project header) so non-owners understand limitations before investing time.

### GAP: No elapsed time or ETA on audit progress page
**Source:** [audit.md](views/audit.md)
The user sees file counts but has no sense of duration or remaining time.

**REC:** Show elapsed time since `startedAt` and optionally estimate remaining time based on progress rate.

### GAP: Branch name not displayed on audit progress page
**Source:** [audit.md](views/audit.md)
The `branch` field from commits is available but not shown in the UI.

**REC:** Display branch name alongside commit SHA (e.g., `repoName@abc1234 (main)`).

### GAP: `isRequester` unused on audit progress page
**Source:** [audit.md](views/audit.md)
Requesters see the same view as unauthenticated users.

**REC:** Show requester-specific context (e.g., "You requested this audit") if distinct behavior is desired.

### GAP: `estimating` status undocumented in lifecycle
**Source:** [audit.md](views/audit.md)
The status label map includes `estimating` but it is not mentioned in the audit lifecycle documentation.

**REC:** Clarify whether `estimating` is a distinct backend phase or an artifact; if used, document it.

### GAP: Audit count label changes based on filter state
**Source:** [projects.md](views/projects.md)
The same project card shows "public audits" vs "audits" depending on the "My Projects" toggle.

**REC:** Always show both counts (e.g., "3 audits (2 public)") to avoid confusion.

### GAP: Filter dropdowns not cross-filtered
**Source:** [projects.md](views/projects.md)
Category and severity dropdowns show values from the base set, not adjusted for the current filter selection.

**REC:** Add counts next to filter options (e.g., "Critical (3)") so users can see match counts before selecting.

### GAP: No incremental audit diff view
**Source:** [report.md](views/report.md)
The `isIncremental` flag is shown in the header but there is no diff view showing what changed from the previous audit.

**REC:** Add a "Changes from previous audit" section highlighting new, resolved, and unchanged findings.

### GAP: No export/download capability for reports
**Source:** [report.md](views/report.md)
Users cannot save the report as PDF or share a static snapshot.

**REC:** Add "Export as PDF" or "Print" button.

---

## UI: Access Control Display

### GAP: Public tier has no explicit UI handling
**Source:** [report.md](views/report.md)
The client has no explicit handling for `public` access tier -- it falls through the same rendering logic, potentially showing empty cards.

**REC:** Add explicit public tier UI: show a "Public Summary View" banner and suppress sections that would be empty.

### GAP: Delete button not shown to org owners who are not the creator
**Source:** [project.md](views/project.md)
The client only checks `currentUser.id === project.createdBy`, but the server also allows verified org owners to delete.

**REC:** Show the delete button when `project.ownership.isOwner === true` in addition to the creator check.

### GAP: No client-side indication of why deletion might fail
**Source:** [project.md](views/project.md)
When foreign audits exist, the API returns 409 but the error message is shown generically.

**REC:** Pre-check for foreign audits and show a disabled button with tooltip explaining the restriction.

---

## Flows: Cancel & Abort

### GAP: No cancel mechanism for component analysis
**Source:** [estimate.md](views/estimate.md)
User must wait for timeout or completion. No abort capability.

**REC:** Add a cancel button that calls a server endpoint to abort the analysis, or at minimum stops polling and resets the UI.

### GAP: No cancel/abort capability for running audits
**Source:** [audit.md](views/audit.md)
Once an audit starts, there is no UI mechanism to stop it.

**REC:** Add a "Cancel Audit" button (owner-only) that calls a cancel API endpoint.

---

## Flows: Data Integrity

### ~~GAP: No client-side duplicate-project detection~~ (RESOLVED)
**Source:** [home.md](views/home.md) (Step 3)
**Fixed:** Preflight check via `POST /api/projects/check` detects duplicates on every repo selection change. Button shows "Open Project" and navigates directly. 409 fallback redirects to existing project.

### GAP: Security posture relies on API sort order
**Source:** [project.md](views/project.md)
The posture section uses the first completed audit found in the array, relying on reverse chronological order.

**REC:** Explicitly sort audits by `completedAt` descending client-side, or have the API return a dedicated `latestCompletedAudit` field.

### GAP: `findingId` on Comment unused
**Source:** [report.md](views/report.md)
The data model supports per-finding comments but the UI only supports audit-level comments.

**REC:** Add per-finding comment threads -- a "Comment" button on each finding card that opens a scoped comment input.

---

## Flows: Auth & Session

### GAP: No timeout on `waitForAuth()` before fetching report
**Source:** [report.md](views/report.md)
If auth check hangs, the page never loads.

**REC:** Add a timeout to `waitForAuth()` and fall back to public-tier access if auth cannot be determined.

---

## Security

### ~~GAP: Gate serves static HTML before middleware~~ (RESOLVED)
**Source:** [gate.md](views/gate.md)
**Fixed:** Gate middleware now runs before `express.static`. HTML pages are gated; static assets (CSS, JS, images, fonts) are bypassed via extension check so the gate page can render.

### GAP: Gate cookie missing explicit `secure` flag
**Source:** [gate.md](views/gate.md)
In production over HTTPS this could allow the cookie to be sent over HTTP if proxy configuration is incorrect.

**REC:** Explicitly set `secure: true` in production (or conditionally based on `NODE_ENV`).

### GAP: No rate limiting on `POST /gate`
**Source:** [gate.md](views/gate.md)
The gate password could be brute-forced.

**REC:** Add rate limiting (e.g., `express-rate-limit`) to `POST /gate` to prevent brute-force attacks.

### GAP: Zero components from analysis produces no feedback
**Source:** [estimate.md](views/estimate.md)
If analysis returns zero components, Step 2 is not shown and the analyze section hides with no explanation.

**REC:** Show an explicit "No components found" message when analysis returns zero results.
