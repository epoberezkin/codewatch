# Business Rules & Invariants

Comprehensive list of invariants that MUST be maintained across the codebase. Every rule links to its enforcement location and test coverage.

---

## Security & Access Control

### RULE-01: Owners always see full audit reports
**Rule:** Users verified as GitHub owners of the audited entity receive `owner`-tier access with all finding fields unredacted.
**Enforced by:** [src/server/routes/api.ts:resolveAccessTier](../src/server/routes/api.ts) (L56-66) -- `if (fullAccessForAll || isOwner) return 'owner'`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `owner sees all findings via resolveOwnership (Tier 1)`; [test/api/ownership.test.ts](../test/api/ownership.test.ts) -- `returns accessTier=owner for project owner`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-02: Requester sees redacted medium/high/critical findings
**Rule:** The audit requester (non-owner) sees all findings but medium, high, and critical findings are redacted to only `id`, `severity`, `cweId`, `repoName`, and `status` -- all other fields are set to `null`.
**Enforced by:** [src/server/routes/api.ts:GET /api/audit/:id/report](../src/server/routes/api.ts) (L1371-1411) -- `redactedSevs = new Set(['medium', 'high', 'critical'])`; also [L1561-1581](../src/server/routes/api.ts) in `GET /api/audit/:id/findings`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `non-owner requester sees redacted findings list (Tier 2)`, `requester redaction notice explains contribution to project security`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-03: Public tier sees summary only, never individual findings
**Rule:** Unauthenticated or unrelated users receive an empty `findings` array, with only `severityCounts` and `reportSummary` visible. All severity levels are listed in `redactedSeverities`.
**Enforced by:** [src/server/routes/api.ts:GET /api/audit/:id/report](../src/server/routes/api.ts) (L1413-1418) -- `visibleFindings = []`; also [L1540-1543](../src/server/routes/api.ts) in `GET /api/audit/:id/findings` -- `res.json([])`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `anonymous user sees summary only (Tier 3)`, `other authenticated user sees summary only (Tier 3)`; [test/api/ownership.test.ts](../test/api/ownership.test.ts) -- `returns accessTier=public for non-public audit viewed anonymously`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-04: returnTo parameter must be a relative path (prevents open redirect)
**Rule:** The `returnTo` query parameter on `/auth/github` is only accepted if it starts with `/` and does not start with `//`. Verified both at sign-in and at callback.
**Enforced by:** [src/server/routes/auth.ts:GET /auth/github](../src/server/routes/auth.ts) (L44-47) -- `if (returnTo.startsWith('/') && !returnTo.startsWith('//'))`, and again at callback (L107)
**Tested by:** [test/api/auth.test.ts](../test/api/auth.test.ts) -- `includes state parameter for returnTo`, `respects returnTo state parameter`
**Spec:** [spec/auth.md](../spec/auth.md)

### RULE-05: Session cookies are httpOnly with 14-day expiry
**Rule:** The `session` cookie is set with `httpOnly: true`, `sameSite: lax`, and `maxAge` of 14 days. Session expiry is also enforced server-side via `expires_at > NOW()` in all session queries.
**Enforced by:** [src/server/routes/auth.ts:GET /auth/github/callback](../src/server/routes/auth.ts) (L95-100) -- `httpOnly: true`; [src/server/config.ts](../src/server/config.ts) (L15) -- `sessionMaxAgeDays: 14`
**Tested by:** [test/api/auth.test.ts](../test/api/auth.test.ts) -- `creates user and session on successful callback`, `returns 401 for expired session`
**Spec:** [spec/auth.md](../spec/auth.md)

### RULE-06: File read operations have path traversal guards
**Rule:** All file read operations validate that the resolved path stays within the repository root. Paths resolving outside the root return an error or are silently skipped.
**Enforced by:** [src/server/services/git.ts:readFileContent](../src/server/services/git.ts) (L228-231) -- `if (!fullPath.startsWith(path.resolve(repoPath) + path.sep))` returns `{ content: null, error: 'path_traversal' }`; [src/server/services/componentAnalysis.ts:executeListDirectory](../src/server/services/componentAnalysis.ts) (L365-367); [src/server/services/componentAnalysis.ts:executeReadFile](../src/server/services/componentAnalysis.ts) (L392-395); [src/server/services/planning.ts](../src/server/services/planning.ts) (L103-105)
**Tested by:** [test/services/git.test.ts](../test/services/git.test.ts) -- basic scanning tests; `[UNTESTED]` -- no dedicated path traversal test
**Spec:** [spec/services/git.md](../spec/services/git.md)

### RULE-07: API key format validated (must start with sk-ant-)
**Rule:** Anthropic API keys submitted by users must be a string starting with `sk-ant-`. Rejected with 400 otherwise.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/start](../src/server/routes/api.ts) (L1129-1132) -- `!apiKey.startsWith('sk-ant-')`; also [POST /api/projects/:id/analyze-components](../src/server/routes/api.ts) (L2142-2144)
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `validates required fields`; [test/api/audit.test.ts](../test/api/audit.test.ts) -- `never exposes API key in responses or DB`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-08: Only project creator or GitHub org owner can delete a project
**Rule:** Project deletion is restricted to the user who created the project (`created_by`) or a verified GitHub owner of the org (via `resolveOwnership`).
**Enforced by:** [src/server/routes/api.ts:DELETE /api/projects/:id](../src/server/routes/api.ts) (L2069-2078) -- `if (!isCreator) { ... if (!delOwnership.isOwner) { res.status(403) } }`
**Tested by:** [test/api/delete.test.ts](../test/api/delete.test.ts) -- `creator can delete project with zero audits`, `non-creator cannot delete project`; [test/api/ownership.test.ts](../test/api/ownership.test.ts) -- `DELETE /api/projects/:id allows non-creator GitHub owner`
**Spec:** [spec/api.md](../spec/api.md)

### RULE-09: Project deletion blocked if foreign audits reference the project
**Rule:** A project cannot be deleted if other users have audits on it. The system returns 409 Conflict.
**Enforced by:** [src/server/routes/api.ts:DELETE /api/projects/:id](../src/server/routes/api.ts) (L2082-2089) -- `SELECT id FROM audits WHERE project_id = $1 AND requester_id != $2`
**Tested by:** [test/api/delete.test.ts](../test/api/delete.test.ts) -- `rejects deletion when other users have audits`
**Spec:** [spec/api.md](../spec/api.md)

### RULE-10: Gate bypasses health check, gate page, and static asset extensions only
**Rule:** When `GATE_PASSWORD` is set, the gate middleware redirects all requests to `/gate.html` except: `/api/health` (health check), `/gate.html` (gate page itself), static asset extensions via `STATIC_ASSET_EXT` regex (CSS, JS, images, fonts), and `POST /gate` (password submission handler, mounted before the middleware).
**Enforced by:** [src/server/middleware/gate.ts:gateMiddleware](../src/server/middleware/gate.ts) (L27-30) -- `if (req.path === '/api/health' || req.path === '/gate.html' || STATIC_ASSET_EXT.test(req.path))`
**Tested by:** [test/api/gate.test.ts](../test/api/gate.test.ts) -- `allows access to /api/health without cookie`, `allows access to static assets without cookie`, `redirects to /gate.html when no gate cookie`, `redirects root HTML page to /gate.html`, `allows CSS files without gate cookie`, `allows JS files without gate cookie`
**Spec:** [spec/auth.md](../spec/auth.md)

### RULE-11: Only the project owner can publish/unpublish reports
**Rule:** `POST /api/audit/:id/publish` and `POST /api/audit/:id/unpublish` both require verified GitHub ownership. Non-owners receive 403.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/publish](../src/server/routes/api.ts) (L1822-1824); [POST /api/audit/:id/unpublish](../src/server/routes/api.ts) (L1874-1877)
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `allows owner to publish`, `rejects non-owner publish`; [test/api/unpublish.test.ts](../test/api/unpublish.test.ts) -- `owner can unpublish a published audit`, `non-owner cannot unpublish`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-12: Only the project owner can change finding status
**Rule:** `PATCH /api/findings/:id/status` requires verified GitHub ownership. If the session lacks org scope, returns 403 with `needsReauth: true`.
**Enforced by:** [src/server/routes/api.ts:PATCH /api/findings/:id/status](../src/server/routes/api.ts) (L1635-1646)
**Tested by:** [test/api/ownership.test.ts](../test/api/ownership.test.ts) -- `PATCH /api/findings/:id/status allows owner`, `PATCH /api/findings/:id/status rejects non-owner`, `returns 403 with needsReauth when scope missing`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

---

## Data Integrity

### RULE-13: Audit fails immediately on first batch error -- no partial results
**Rule:** If any analysis batch fails, the audit loop breaks immediately and the audit is marked `failed`. Partial results are considered unreliable for security audits.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L552-553) -- `if (batchesFailed > 0) break;` and (L559-570) -- `if (batchesFailed > 0) { ... status = 'failed' }`
**Tested by:** `[UNTESTED]` -- no explicit batch failure test
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-14: Finding fingerprints deduplicate across incremental audits
**Rule:** Each finding gets a fingerprint: `SHA-256(file_path : line_range : title : first_100_chars_of_snippet)` truncated to 16 hex chars. Inherited findings with duplicate fingerprints are skipped.
**Enforced by:** [src/server/services/audit.ts:generateFingerprint](../src/server/services/audit.ts) (L823-829); dedup at (L499-505) -- `if (existing.length > 0) continue;` and inherited dedup at (L272-277) -- `inheritedFingerprints.has(finding.fingerprint)`
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `deduplicates findings with same fingerprint`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-15: Projects deduplicated by sorted repo names per user
**Rule:** Before creating a project, the system checks for an existing project with the same `github_org`, `created_by`, and identical sorted comma-joined repo names. Returns 409 with existing project ID if found.
**Enforced by:** [src/server/routes/api.ts:POST /api/projects](../src/server/routes/api.ts) (L216-230) -- `SELECT p.id FROM projects p WHERE p.github_org = $1 AND p.created_by = $2 AND (...sorted names...) = $3`
**Tested by:** `[UNTESTED]` -- no explicit duplicate project test in test suite
**Spec:** [spec/api.md](../spec/api.md)

### RULE-16: Component analysis limited to 40 turns, 5 consecutive tool errors
**Rule:** The agentic component analysis loop runs at most `MAX_TURNS = 40` turns. If tools produce errors 5 consecutive times (`MAX_CONSECUTIVE_ERRORS`), the analysis aborts.
**Enforced by:** [src/server/services/componentAnalysis.ts](../src/server/services/componentAnalysis.ts) (L17) -- `const MAX_TURNS = 40`; (L20) -- `const MAX_CONSECUTIVE_ERRORS = 5`; (L219) -- `while (turnsUsed < MAX_TURNS)`; (L308-309) -- `consecutiveErrors >= MAX_CONSECUTIVE_ERRORS`
**Tested by:** [test/services/componentAnalysis.test.ts](../test/services/componentAnalysis.test.ts) -- `respects max_turns limit`, `handles tool errors without crashing`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-17: Ownership cache TTL is 15 minutes, invalidated on re-auth
**Rule:** GitHub ownership lookups are cached in the `ownership_cache` table with a 15-minute TTL (`NOW() + INTERVAL '15 minutes'`). The entire cache for a user is invalidated on re-authentication. Results with `needsReauth` are never cached.
**Enforced by:** [src/server/services/ownership.ts:resolveOwnership](../src/server/services/ownership.ts) (L29) -- `expires_at > NOW()`; (L53-58) -- `INTERVAL '15 minutes'`; (L50) -- `if (!result.needsReauth)` guard; [src/server/services/ownership.ts:invalidateOwnershipCache](../src/server/services/ownership.ts) (L76-80); called from [src/server/routes/auth.ts](../src/server/routes/auth.ts) (L92)
**Tested by:** [test/api/ownership.test.ts](../test/api/ownership.test.ts) -- `populates ownership_cache on first call`, `returns cached result on subsequent calls`, `refreshes after cache entry expires`, `does not cache needsReauth results`, `re-auth via OAuth callback invalidates cache`
**Spec:** [spec/services/ownership.md](../spec/services/ownership.md)

### RULE-18: Audit commits record exact SHA analyzed per repo
**Rule:** For each repo in an audit, the exact HEAD commit SHA at clone time is recorded in the `audit_commits` table. This establishes provenance for the analysis.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L134-138) -- `INSERT INTO audit_commits (audit_id, repo_id, commit_sha, branch)`
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- report response includes `commits` array; [test/api/delete.test.ts](../test/api/delete.test.ts) -- `cascades audit_findings and audit_commits`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-19: Files larger than 1MB are excluded from scanning
**Rule:** During `scanCodeFiles`, any file with `stat.size > MAX_FILE_SIZE` (1MB = 1,048,576 bytes) is skipped entirely.
**Enforced by:** [src/server/services/git.ts:scanCodeFiles](../src/server/services/git.ts) (L33) -- `const MAX_FILE_SIZE = 1024 * 1024;` and (L165) -- `if (stat.size > MAX_FILE_SIZE) continue;`
**Tested by:** `[UNTESTED]` -- no test for 1MB file exclusion
**Spec:** [spec/services/git.md](../spec/services/git.md)

### RULE-20: Batch size capped at 150K tokens
**Rule:** Analysis batches are capped at `MAX_BATCH_TOKENS = 150000`. Files are added to a batch until the next file would exceed this limit, then a new batch is started.
**Enforced by:** [src/server/services/audit.ts:createBatches](../src/server/services/audit.ts) (L59) -- `const MAX_BATCH_TOKENS = 150000;` and (L783) -- `if (currentTokens + file.roughTokens > MAX_BATCH_TOKENS && currentBatch.length > 0)`
**Tested by:** `[UNTESTED]` -- no explicit batch-size boundary test
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

---

## Disclosure

### RULE-21: publishable_after computed from max_severity at notification time
**Rule:** When the requester notifies the owner, `publishable_after` is set based on max severity: critical = 6 months, high/medium = 3 months, low/informational/none = null (no delay).
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/notify-owner](../src/server/routes/api.ts) (L1982-1991) -- severity-to-delay mapping
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `sets publishable_after based on max severity -- critical = 6 months`, `sets publishable_after based on max severity -- high = 3 months`, `sets no publishable_after for low severity`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-22: Notify-owner is idempotent (creates GitHub issue once)
**Rule:** If `owner_notified` is already `true`, `POST /api/audit/:id/notify-owner` returns the existing `publishable_after` with `alreadyNotified: true` and does not create another GitHub issue.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/notify-owner](../src/server/routes/api.ts) (L1928-1935) -- `if (audit.owner_notified) { ... res.json({ ok: true, ..., alreadyNotified: true }) }`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `notification is idempotent`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-23: Owner notification sets owner_notified_at and publishable_after
**Rule:** On first notification, the system atomically sets `owner_notified = TRUE`, `owner_notified_at = NOW()`, and `publishable_after` in a single UPDATE.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/notify-owner](../src/server/routes/api.ts) (L1993-1997) -- `UPDATE audits SET owner_notified = TRUE, owner_notified_at = NOW(), publishable_after = $1`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `requester can notify owner`, `includes ownerNotifiedAt after notification`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-24: Auto-publish is lazy (checked on each report access, not background job)
**Rule:** There is no background cron or scheduler for auto-publication. Instead, `resolveAccessTier` checks `now >= publishableAfter` on every report request. If the deadline has passed and `owner_notified` is true, `fullAccessForAll` becomes true.
**Enforced by:** [src/server/routes/api.ts:resolveAccessTier](../src/server/routes/api.ts) (L57-60) -- `const isAutoPublished = publishableAfter && audit.owner_notified && now >= publishableAfter`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `all users see full findings after publishable_after (lazy auto-publish)`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-25: Unpublish clears publishable_after
**Rule:** When the owner unpublishes a report, `is_public` is set to `FALSE` and `publishable_after` is set to `NULL`, preventing future auto-publication.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/unpublish](../src/server/routes/api.ts) (L1879-1882) -- `UPDATE audits SET is_public = FALSE, publishable_after = NULL`
**Tested by:** [test/api/unpublish.test.ts](../test/api/unpublish.test.ts) -- `owner can unpublish a published audit`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

---

## Cost & Estimation

### RULE-26: Full = 100%, Thorough = 33%, Opportunistic = 10% of token budget
**Rule:** The `BUDGET_PERCENTAGES` constant defines the analysis portion: `full: 1.0`, `thorough: 0.33`, `opportunistic: 0.10`. These ratios determine both cost estimates and file selection.
**Enforced by:** [src/server/services/tokens.ts:BUDGET_PERCENTAGES](../src/server/services/tokens.ts) (L41-45) -- `{ full: 1.0, thorough: 0.33, opportunistic: 0.10 }`; used in file selection by [src/server/services/planning.ts](../src/server/services/planning.ts) (L226-227)
**Tested by:** [test/services/planning.test.ts](../test/services/planning.test.ts) -- `full level includes all files`, `thorough level includes ~33% of tokens`, `opportunistic level includes ~10% of tokens`; [test/api/estimate.test.ts](../test/api/estimate.test.ts) -- `returns rough estimate with 3 levels`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-27: Rough token count = file_size / 3.3
**Rule:** The rough token estimate for each file is `Math.ceil(stat.size / 3.3)`. This character-based heuristic is used for cost estimation and batch sizing.
**Enforced by:** [src/server/services/git.ts:scanCodeFiles](../src/server/services/git.ts) (L172) -- `roughTokens: Math.ceil(stat.size / 3.3)`
**Tested by:** [test/services/git.test.ts](../test/services/git.test.ts) -- `computes rough token counts`
**Spec:** [spec/services/tokens.md](../spec/services/tokens.md)

### RULE-28: Analysis overhead = 5% of total tokens, output ratio = 15% of input
**Rule:** Cost estimation adds a 5% overhead for classification/planning (`ANALYSIS_OVERHEAD = 0.05`), and estimates output tokens at 15% of input tokens (`ESTIMATED_OUTPUT_RATIO = 0.15`).
**Enforced by:** [src/server/services/tokens.ts:calculateLevelCost](../src/server/services/tokens.ts) (L133) -- `const ANALYSIS_OVERHEAD = 0.05`; (L137) -- `const ESTIMATED_OUTPUT_RATIO = 0.15`; (L144-145) -- `inputTokens = levelTokens + totalTokens * ANALYSIS_OVERHEAD`, `outputTokens = inputTokens * ESTIMATED_OUTPUT_RATIO`
**Tested by:** [test/api/estimate.test.ts](../test/api/estimate.test.ts) -- `cost estimates use multiplier-based formula with input + output`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-29: Planning phase uses BUDGET_PERCENTAGES of token budget
**Rule:** The planning phase selects files by priority until the token budget (determined by level percentage) is exhausted. Full level includes all ranked files regardless of budget.
**Enforced by:** [src/server/services/planning.ts:selectFilesByBudget](../src/server/services/planning.ts) (L226-227) -- `const tokenBudget = budgetPct === 1.0 ? totalTokens : Math.round(totalTokens * budgetPct)`; (L239-246) -- full vs. budgeted selection
**Tested by:** [test/services/planning.test.ts](../test/services/planning.test.ts) -- `full level includes all files`, `thorough level includes ~33% of tokens`, `opportunistic level includes ~10% of tokens`, `selects files by priority order (highest first)`, `always includes at least one file even if it exceeds budget`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-30: Precise estimate uses free count_tokens API endpoint
**Rule:** When `ANTHROPIC_SERVICE_KEY` is configured, the `/api/estimate/precise` endpoint reads actual file contents, batches them (max 20MB per batch), and calls the `count_tokens` API. Returns `isPrecise: true`.
**Enforced by:** [src/server/routes/api.ts:POST /api/estimate/precise](../src/server/routes/api.ts) (L813-946) -- reads files, batches, calls `countTokens()`, returns `isPrecise: true`
**Tested by:** `[UNTESTED]` -- no test for precise estimation (requires live API key)
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

---

## Audit Execution

### RULE-31: Classification runs only on first audit for a project
**Rule:** The classification step (category, threat model, involved parties) is skipped if the project already has a `category` value in the database. The stored classification is reused for all subsequent audits.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L334) -- `if (!existingProject[0].category)` guards the classification call
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `skips classification on second audit if already classified`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-32: Incremental audits inherit open findings from base audit
**Rule:** When `baseAuditId` is provided, all findings with `status = 'open'` from the base audit are copied into the new audit. Duplicate fingerprints within the base are skipped.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L265-310) -- `SELECT * FROM audit_findings WHERE audit_id = $1 AND status = 'open'`, then inserts into new audit
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `inherits findings from base audit and marks deleted-file findings as fixed`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-33: Renamed files transfer findings to new path
**Rule:** During incremental audits, if a file was renamed (detected via `git diff --name-status`), inherited findings for the old path are updated to reference the new path.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L288-291) -- `const rename = renamedPaths.find(r => r.from === filePath); if (rename) { filePath = rename.to; }`
**Tested by:** `[UNTESTED]` -- no explicit rename finding transfer test (incremental test covers deletion but not renames)
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-34: Deleted files mark their findings as 'fixed'
**Rule:** During incremental audits, if a file was deleted, inherited findings for that file have their status set to `fixed`.
**Enforced by:** [src/server/services/audit.ts:runAudit](../src/server/services/audit.ts) (L283-285) -- `if (diffFilesDeleted.includes(filePath)) { status = 'fixed'; }`
**Tested by:** [test/api/audit.test.ts](../test/api/audit.test.ts) -- `inherits findings from base audit and marks deleted-file findings as fixed`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-35: Files selected by priority score within token budget
**Rule:** The planning phase ranks files by security relevance (priority 1-10). Files are selected highest-priority-first until the token budget for the chosen level is exhausted. At least one file is always included.
**Enforced by:** [src/server/services/planning.ts:selectFilesByBudget](../src/server/services/planning.ts) (L229-246) -- sorts by priority descending, accumulates tokens, stops at budget; (L252) -- `if (plan.length === 0 && rankedFiles.length > 0)` ensures minimum one file
**Tested by:** [test/services/planning.test.ts](../test/services/planning.test.ts) -- `selects files by priority order (highest first)`, `always includes at least one file even if it exceeds budget`, `includes at least one file even when all exceed budget`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)

### RULE-36: Only the audit requester can trigger owner notification
**Rule:** `POST /api/audit/:id/notify-owner` checks that `audit.requester_id === userId`. Non-requesters receive 403.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/notify-owner](../src/server/routes/api.ts) (L1921-1924) -- `if (audit.requester_id !== userId)`
**Tested by:** [test/api/disclosure.test.ts](../test/api/disclosure.test.ts) -- `non-requester cannot notify`
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-37: Audit must be completed before owner notification
**Rule:** `POST /api/audit/:id/notify-owner` requires `audit.status === 'completed'`. Returns 400 otherwise.
**Enforced by:** [src/server/routes/api.ts:POST /api/audit/:id/notify-owner](../src/server/routes/api.ts) (L1916-1918) -- `if (audit.status !== 'completed')`
**Tested by:** `[UNTESTED]` -- no test for pre-completion notification attempt
**Spec:** [product/flows/responsible-disclosure.md](./flows/responsible-disclosure.md)

### RULE-38: Only the audit requester can delete their own audit
**Rule:** `DELETE /api/audit/:id` uses `SELECT FOR UPDATE` to prevent race conditions and verifies `rows[0].requester_id === userId`.
**Enforced by:** [src/server/routes/api.ts:DELETE /api/audit/:id](../src/server/routes/api.ts) (L2016-2031) -- `SELECT id, requester_id FROM audits WHERE id = $1 FOR UPDATE`
**Tested by:** [test/api/delete.test.ts](../test/api/delete.test.ts) -- `requester can delete their own audit`, `other user cannot delete audit`
**Spec:** [spec/api.md](../spec/api.md)

### RULE-39: Only project owners can run incremental audits
**Rule:** Incremental audits (with `baseAuditId`) require verified GitHub ownership. `POST /api/estimate` omits `previousAudit` for non-owners. `POST /api/audit/start` rejects `baseAuditId` with 403 for non-owners. `baseAuditId` must reference a completed audit belonging to the same project.
**Enforced by:** [src/server/routes/api.ts:POST /api/estimate](../src/server/routes/api.ts) (L945) -- `if (prevAudits.length > 0 && isOwner)`; [src/server/routes/api.ts:POST /api/audit/start](../src/server/routes/api.ts) (L1319-1332) -- ownership + project-membership validation
**Tested by:** `[UNTESTED]`
**Spec:** [spec/api.md](../spec/api.md), [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)
