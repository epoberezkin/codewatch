# API Routes

## Module Purpose

Central REST API router for CodeWatch. Handles all server-side endpoints: GitHub integration proxying, project CRUD, cost estimation, audit lifecycle, findings with three-tier access control, responsible disclosure, comments, component analysis, dependency linking, and public report listing.

**Source:** [`api.ts`](../src/server/routes/api.ts)

---

## Health Check

### `GET /api/health`

Defined in [`app.ts`](../src/server/app.ts) (not in `routes/api.ts`). Returns `{ status: 'ok' }`. No authentication required. Positioned after the gate middleware — explicitly bypassed by the gate via path check.

---

## Helper Functions

### `escapeILike` (L20)

Escapes `%`, `_`, and `\` in user-provided strings before use in PostgreSQL `ILIKE` clauses to prevent pattern injection.

```ts
function escapeILike(input: string): string
```

### `deriveProjectName` (L26)

Derives a display name from repo names: 1–3 repos joined with `' + '`, 4+ repos shows first 2 + `'N more'`. Returns empty string for empty input. Used by all endpoints that return `projectName` or `name` — the display name is always computed from the project's repos, never read from `projects.name`.

```ts
function deriveProjectName(repoNames: string[]): string
```

### `getSessionInfo` (L42)

Resolves the current viewer's session from a `session` cookie. Joins `sessions` and `users` tables, checks `expires_at > NOW()`. Returns `null` if no cookie or expired/invalid session.

```ts
interface SessionInfo {
  userId: string;
  githubToken: string;
  githubUsername: string;
  githubType: string;
  hasOrgScope: boolean;
}
async function getSessionInfo(pool, sessionId): Promise<SessionInfo | null>
```

### `resolveAccessTier` (L64)

Three-tier access control for audit reports/findings.

```ts
type AccessTier = 'owner' | 'requester' | 'public';
function resolveAccessTier(audit, requesterId, isOwner): AccessTier
```

Logic:
1. If `audit.is_public` OR (owner was notified AND `publishable_after` date has passed) OR `isOwner` => **`owner`** (full access).
2. Else if viewer is the audit requester => **`requester`** (partial access).
3. Else => **`public`** (summary only).

### `getRedactedSeverities` (L77)

Returns the set of severity levels whose finding details should be redacted for a given access tier.

- `owner` => empty set (no redaction)
- `requester` => empty set (no redaction) [GAP] This contradicts the actual report endpoint logic at L1464 which redacts medium/high/critical for requesters. The helper is defined but never called; the report endpoint uses inline logic instead.
- `public` => `{ critical, high }`

[REC] Either remove `getRedactedSeverities` or refactor the report/findings endpoints to use it, keeping the source of truth in one place.

### `parseThreatModel` (L84)

Parses the `threat_model` TEXT column (which may contain plain text or a JSON string) into structured fields.

```ts
function parseThreatModel(raw: string | null): {
  text: string | null;
  parties: Array<{name: string; can: string[]; cannot: string[]}>
}
```

- If `raw` is null/empty: returns `{ text: null, parties: [] }`
- If `raw` is valid JSON with `evaluation`/`generated` and `parties`: extracts structured fields
- If `raw` is plain text (JSON parse fails): returns `{ text: raw, parties: [] }`

### `buildThreatModelFileLinks` (L101)

Constructs GitHub blob URLs from stored `threat_model_files` paths and classification audit commit data. File paths from Claude are prefixed with repo name (e.g., `"repo-name/SECURITY.md"`); the helper strips the prefix and matches by repo name.

```ts
function buildThreatModelFileLinks(
  threatModelFiles: string[] | null,
  commits: Array<{repo_url: string; repo_name: string; commit_sha: string}>
): Array<{path: string; url: string}>
```

**Sanitization**: Rejects paths containing `..` or starting with `/`. URLs are constructed from stored `repo_url` (always `https://github.com/...`).

**Backwards compatibility note**: The `threat_model` TEXT column may contain either plain text or a JSON string. API consumers MUST handle both. Future schema extensions to classification data MUST be backwards-compatible with existing stored data.

### `findDuplicateProject` ([L120-L132](../src/server/routes/api.ts#L120-L132))

Checks whether a project with the same GitHub org, user, and sorted repo set already exists.

```ts
async function findDuplicateProject(
  pool: any, githubOrg: string, userId: string, sortedRepoNames: string
): Promise<string | null>
```

Returns the existing project ID if a duplicate is found, or `null` otherwise. Compares by aggregating `repo_name` values (sorted, comma-joined) for each of the user's projects in the given org.

**Used by:** `POST /api/projects` (L276) and `POST /api/projects/check` (L360).

---

## 1. GitHub Integration

### GET /api/github/orgs/:org/repos (L139)

Lists repositories for a GitHub organization.

| Aspect | Detail |
|---|---|
| **Auth** | None required. Uses session token if available for higher rate limits. |
| **Path params** | `org` - GitHub org/user name |
| **Response (200)** | `Array<{ name, description, language, stars, forks, defaultBranch, license, url, githubId }>` |
| **Response (500)** | `{ error }` |
| **DB** | Reads `sessions`, `users` (for token) |
| **External** | `listOrgRepos(org, token)` |

### GET /api/github/entity/:name (L167)

Fetches GitHub entity info (user or organization) and resolves ownership if session exists.

| Aspect | Detail |
|---|---|
| **Auth** | None required. Optional session enriches response with `isOwner`, `role`, `needsReauth`. |
| **Path params** | `name` - GitHub username or org name |
| **Response (200)** | `{ ...entity, isOwner, role, needsReauth }` |
| **Response (500)** | `{ error }` |
| **DB** | Reads `sessions`, `users`; ownership resolution may read/write `ownership_cache` |
| **External** | `getGitHubEntity(name, token)`, `resolveOwnership(...)` |

### GET /api/github/repos/:owner/:repo/branches (L200)

Lists branches for a repository. Default branch is placed first in the returned array.

| Aspect | Detail |
|---|---|
| **Auth** | None required. Uses session token if available. |
| **Path params** | `owner`, `repo` |
| **Response (200)** | `{ defaultBranch, branches: Array<{ name, ... }> }` |
| **Response (500)** | `{ error }` |
| **DB** | Reads `sessions`, `users` |
| **External** | `listRepoBranches(owner, repo, token)`, `getRepoDefaultBranch(owner, repo, token)` in parallel |

---

## 2. Projects

### POST /api/projects (L232)

Creates a project with linked repositories.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth` middleware) |
| **Body** | `{ githubOrg: string, repos?: Array<{ name, branch?, defaultBranch? }>, repoNames?: string[] }` |
| **Response (200)** | `{ projectId, repos: Array<{ id, repoName, repoUrl, branch }>, ownership }` |
| **Response (400)** | Missing/invalid `githubOrg`, repo names, or branch |
| **Response (409)** | `{ projectId, existing: true, message }` if duplicate (same org + same sorted repo names + same user) |
| **Response (500)** | `{ error }` |
| **DB writes** | `INSERT INTO projects`, `UPSERT INTO repositories`, `INSERT INTO project_repos` |
| **Validation** | `githubOrg` must match `^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$`. Repo names must match `^[a-zA-Z0-9._-]+$`. |
| **Business logic** | Project name is derived from repo names via `deriveProjectName()` (1–3 repos joined with ' + ', 4+ shows first 2 + 'N more'). Uses [`findDuplicateProject()`](../src/server/routes/api.ts#L120-L132) to deduplicate by comparing sorted repo names per user per org. Upserts repositories (updates `default_branch` on conflict). Resolves ownership for the creator post-creation. |

### POST /api/projects/check ([L339-L366](../src/server/routes/api.ts#L339-L366))

Checks whether a project with the same org, user, and repo set already exists without creating anything.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`) |
| **Body** | `{ githubOrg: string, repos: string[] }` |
| **Response (200)** | `{ exists: boolean, projectId?: string }` |
| **Response (400)** | Missing `githubOrg` or empty `repos[]` |
| **Response (401)** | Not authenticated |
| **Response (500)** | `{ error }` |
| **DB reads** | `projects`, `project_repos`, `repositories` (via `findDuplicateProject`) |
| **Business logic** | Normalizes `repos` entries (accepts strings or objects with `name`). Sorts and joins repo names, then delegates to [`findDuplicateProject()`](../src/server/routes/api.ts#L120-L132). Returns `exists: true` with `projectId` if duplicate found, `exists: false` otherwise. |

### GET /api/projects/browse (L369)

Unified browse endpoint with optional "My Projects" subset filter.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Required only when `mine=true`. |
| **Query params** | `category?`, `severity?`, `search?`, `mine?` (all optional) |
| **Response (200)** | `{ projects: Array<{ id, name, githubOrg, category, license, publicAuditCount, auditCount, latestSeverity, latestAuditDate, createdAt, ownership? }>, filters: { categories, severities } }` |
| **Response (401)** | If `mine=true` without auth |
| **Response (500)** | `{ error }` |
| **DB reads** | `projects`, `audits`, `repositories`, `project_repos`, `sessions`, `users` |
| **Business logic** | Anonymous: projects with at least one public audit. Authenticated: public-audit projects OR own projects. `mine=true` further filters to own. `search` uses `ILIKE` with `escapeILike`. Ownership resolved per unique org (deduplicated). Results ordered by `created_at DESC`, limit 50. Severities sorted by severity order (critical first). |

### GET /api/projects/:id (L505)

Fetches full project details including repos, components, dependencies, and last 10 audits.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Determines audit visibility and ownership badge. |
| **Path params** | `id` - project UUID |
| **Response (200)** | `{ id, name, description, githubOrg, category, license, involvedParties, threatModel, threatModelParties, threatModelFileLinks, threatModelSource, totalFiles, totalTokens, createdBy, creatorUsername, ownership, repos[], components[], dependencies[], audits[], createdAt }` |
| **Response (404)** | `{ error: 'Project not found' }` |
| **Response (500)** | `{ error }` |
| **DB reads** | `projects`, `users`, `repositories`, `project_repos`, `components`, `project_dependencies`, `audits`, `audit_findings`, `audit_commits` (for threat model file links) |
| **Business logic** | Audit visibility: owner sees all, authenticated non-owner sees public + own, anonymous sees public only. Limit 10 audits. License aggregated from repo records. Severity counts computed per audit. |

### PUT /api/projects/:id/branches (L716)

Updates branch selections for project repos.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be project creator or verified GitHub owner. |
| **Path params** | `id` - project UUID |
| **Body** | `{ repos: Array<{ repoId: string, branch?: string }> }` |
| **Response (200)** | `{ updated: true }` |
| **Response (400)** | Missing/invalid `repos[]` or branch values |
| **Response (403)** | Not creator/owner |
| **Response (404)** | Project not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `UPDATE project_repos SET branch` |
| **Business logic** | Branch existence is NOT validated server-side; invalid branches will fail at clone time. |

### DELETE /api/projects/:id (L2198)

Deletes a project and all associated data.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be project creator or verified GitHub owner. |
| **Path params** | `id` - project UUID |
| **Response (204)** | No body |
| **Response (403)** | Not creator/owner |
| **Response (404)** | Project not found |
| **Response (409)** | `{ error: 'Cannot delete project with audits by other users' }` |
| **Response (500)** | `{ error }` |
| **DB writes** | Transaction: cascading deletes across `audit_comments`, `audit_findings`, `audit_commits`, `audit_components`, `audits`, `project_dependencies`, `components`, `component_analyses`, `project_repos`, `projects`. Nullifies `component_analysis_id` before deleting analyses. |
| **Business logic** | Rejects deletion if any audit was created by a different user. |

---

## 3. Estimation

### POST /api/estimate (L804)

Rough cost estimation. Clones/updates repos, scans code files, computes rough token count.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Body** | `{ projectId: string }` |
| **Response (200)** | `{ totalFiles, totalTokens, repoBreakdown: Array<{ repoName, files, tokens, headSha?, branch? }>, estimates, isPrecise: false, cloneErrors?, previousAudit?, analysisCostHint: { costUsd, isEmpirical } }` |
| **Response (400)** | Missing `projectId` |
| **Response (404)** | Project not found or no repos |
| **Response (500)** | `{ error }` |
| **DB reads** | `repositories`, `project_repos`, `audits` (last completed), `component_analyses` + `projects` (empirical cost data) |
| **DB writes** | `UPDATE repositories` (total_files, total_tokens, last_cloned_at, default_branch), `UPDATE projects` (total_files, total_tokens) |
| **External** | `cloneOrUpdate`, `scanCodeFiles`, `getDefaultBranchName`, `roughTokenCount`, `estimateCosts` |
| **Business logic** | Auto-detects and updates default branch from cloned repo. Includes previous audit info if available. Clone errors are non-fatal; repos that fail are included with zero files/tokens. |

### POST /api/estimate/precise (L934)

Precise estimation using Anthropic count_tokens API with dynamic batching.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Body** | `{ projectId: string }` |
| **Response (200)** | `{ totalFiles, totalTokens, repoBreakdown, estimates, isPrecise: true, cloneErrors? }` |
| **Response (400)** | Missing `projectId` or no code files found |
| **Response (404)** | Project not found or no repos |
| **Response (503)** | `{ error: 'Precise estimation is not configured (missing ANTHROPIC_SERVICE_KEY)' }` |
| **Response (500)** | `{ error }` |
| **DB reads** | `repositories`, `project_repos` |
| **External** | `cloneOrUpdate`, `scanCodeFiles`, `countTokens` (Anthropic API), `estimateCostsFromTokenCount` |
| **Business logic** | Batches file contents into chunks of max 20MB each. Calls `countTokens` per batch. Per-repo token counts are proportionally scaled from the rough-to-precise ratio. |

### POST /api/estimate/components (L1073)

Scoped cost estimate for selected components.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Body** | `{ projectId: string, componentIds: string[], totalTokens: number }` |
| **Response (200)** | `{ totalFiles, totalTokens, estimates, isPrecise: false }` |
| **Response (400)** | Missing/invalid params or component IDs not belonging to project |
| **Response (404)** | Project not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `projects`, `components` |
| **External** | `estimateCostsForComponents` |
| **Validation** | `componentIds` must be an array. `totalTokens` must be a non-negative number. All component IDs must belong to the specified project. |

---

## 4. Audit Lifecycle

### POST /api/audit/start (L1239)

Starts a new audit asynchronously.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`) |
| **Body** | `{ projectId, level, apiKey, baseAuditId?, componentIds? }` |
| **Response (200)** | `{ auditId }` |
| **Response (400)** | Missing required fields, invalid level, invalid API key format, invalid component IDs |
| **Response (404)** | Project not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `INSERT INTO audits` |
| **Validation** | `level` must be `full`, `thorough`, or `opportunistic`. `apiKey` must start with `sk-ant-`. Component IDs validated against project. |
| **Business logic** | Resolves ownership to set `is_owner` flag on audit. If `baseAuditId` is set, marks as incremental. `runAudit` is fire-and-forget (not awaited). |

### GET /api/audit/:id (L1313)

Gets audit status and progress.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Determines privilege level for progress detail and error messages. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `{ id, projectId, projectName, githubOrg, status, auditLevel, isIncremental, isOwner, isRequester, totalFiles, filesToAnalyze, filesAnalyzed, progressDetail, maxSeverity, errorMessage, createdAt, startedAt, completedAt, commits[] }` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects`, `audit_commits`, `repositories` |
| **Business logic** | `progressDetail` is `ProgressDetail \| null` — a discriminated union (`type: 'cloning' \| 'planning' \| 'analyzing' \| 'done'`, each variant includes `warnings: string[]`). Returned to privileged users (owner or requester); `null` for others or when no detail exists. `errorMessage` is similarly privileged-only. |

### GET /api/audit/:id/report (L1394)

Full audit report with three-tier access control.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Determines access tier. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `{ id, projectId, projectName, auditLevel, isIncremental, isOwner, isRequester, isPublic, publishableAfter, ownerNotified, ownerNotifiedAt, maxSeverity, category, projectDescription, involvedParties, threatModel, threatModelParties, threatModelFileLinks, threatModelSource, commits[], reportSummary, severityCounts, findings[], redactedSeverities, redactionNotice, accessTier, componentBreakdown[], dependencies[], createdAt, completedAt }` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects`, `audit_commits`, `repositories`, `audit_findings`, `audit_components`, `components`, `project_dependencies` |
| **Access tiers** | **owner**: full findings. **requester**: low/informational in full; medium/high/critical redacted to severity + CWE + repo + status only. **public**: no individual findings (empty array), summary-only notice. |

### DELETE /api/audit/:id (L2153)

Deletes an audit. Requester-only.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be the audit requester. |
| **Path params** | `id` - audit UUID |
| **Response (204)** | No body |
| **Response (403)** | `{ error: 'Only the audit requester can delete' }` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB writes** | Transaction with `SELECT ... FOR UPDATE`. Cascading deletes: `audit_comments`, `audit_findings`, `audit_commits`, `audit_components`, `audits`. |

---

## 5. Audit History

### GET /api/project/:id/audits (L1130)

Lists audits for a project, visibility-filtered.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Determines visibility. |
| **Path params** | `id` - project UUID |
| **Response (200)** | `Array<{ id, auditLevel, isIncremental, status, maxSeverity, createdAt, completedAt, severityCounts, commits[] }>` |
| **Response (500)** | `{ error }` |
| **DB reads** | `projects`, `audits`, `audit_findings`, `audit_commits`, `repositories` |
| **Business logic** | Owner sees all audits. Authenticated non-owner sees public + own. Anonymous sees public only. No limit on returned audits. Includes severity counts and commit SHAs per audit. |

[GAP] No 404 returned when project does not exist; the query will simply return an empty array.

---

## 6. Findings

### GET /api/audit/:id/findings (L1639)

Lists findings for an audit with three-tier access control.

| Aspect | Detail |
|---|---|
| **Auth** | Optional. Determines access tier. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `Array<{ id, severity, cweId, cvssScore, title, description, exploitation, recommendation, codeSnippet, filePath, lineStart, lineEnd, repoName, status }>` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects`, `audit_findings`, `repositories` |
| **Access tiers** | **owner**: all fields. **requester**: medium/high/critical redacted (title, description, exploitation, recommendation, codeSnippet, filePath, lines nulled; severity, cweId, repoName, status preserved). **public**: empty array. |
| **Sort order** | By severity: critical > high > medium > low > informational. |

### PATCH /api/findings/:id/status (L1752)

Updates a finding's status. Owner-only.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be verified GitHub owner of the project. |
| **Path params** | `id` - finding UUID |
| **Body** | `{ status: string }` |
| **Response (200)** | `{ ok: true }` |
| **Response (400)** | Invalid status value |
| **Response (403)** | Not owner, or `{ error, needsReauth: true }` if re-auth needed |
| **Response (404)** | Finding not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `UPDATE audit_findings SET status` |
| **Validation** | `status` must be one of: `open`, `fixed`, `false_positive`, `accepted`, `wont_fix`. |

---

## 7. Responsible Disclosure

### POST /api/audit/:id/notify-owner (L2039)

Triggers responsible disclosure notification. Creates a GitHub issue on the project's top-starred repo and sets the auto-publish timer.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be the audit requester. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `{ ok: true, publishableAfter }` or `{ ok: true, publishableAfter, alreadyNotified: true }` |
| **Response (400)** | `{ error: 'Audit must be completed before notifying the owner' }` |
| **Response (403)** | Not the audit requester |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects`, `repositories`, `project_repos`, `audit_findings` (count) |
| **DB writes** | `UPDATE audits SET owner_notified = TRUE, owner_notified_at = NOW(), publishable_after` |
| **External** | `createIssue(githubToken, org, repo, title, body)` |
| **Business logic** | **Idempotent**: if already notified, returns existing data. **Publishable-after** timer based on max severity: critical = 6 months, high/medium = 3 months, low/informational/none = null (immediate). GitHub issue creation failure is non-fatal; notification is recorded regardless. Issue is created on the highest-starred repo in the project. |

### POST /api/audit/:id/publish (L1934)

Makes an audit report public.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be verified GitHub owner. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `{ ok: true }` |
| **Response (400)** | Audit not associated with a project |
| **Response (403)** | Not owner, or `{ error, needsReauth: true }` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `UPDATE audits SET is_public = TRUE` |

### POST /api/audit/:id/unpublish (L1987)

Makes a public report private again. Also clears `publishable_after`.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be verified GitHub owner. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `{ ok: true }` |
| **Response (400)** | Audit not associated with a project |
| **Response (403)** | Not owner, or `{ error, needsReauth: true }` |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `UPDATE audits SET is_public = FALSE, publishable_after = NULL` |

---

## 8. Comments

### POST /api/audit/:id/comments (L1808)

Adds a comment to an audit, optionally linked to a specific finding.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must have access to the audit (owner, requester, or audit is public). |
| **Path params** | `id` - audit UUID |
| **Body** | `{ content: string, findingId?: string }` |
| **Response (200)** | `{ id, createdAt }` |
| **Response (400)** | Empty content or content > 10,000 characters |
| **Response (403)** | Access denied (private audit and not owner/requester) |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `INSERT INTO audit_comments` |
| **Validation** | `content` is trimmed; must be 1..10000 characters after trim. |

### GET /api/audit/:id/comments (L1869)

Lists comments for an audit.

| Aspect | Detail |
|---|---|
| **Auth** | None for public audits. For private audits, requires session + must be owner or requester. |
| **Path params** | `id` - audit UUID |
| **Response (200)** | `Array<{ id, userId, username, findingId, content, createdAt }>` |
| **Response (403)** | Access denied (private audit without proper session) |
| **Response (404)** | Audit not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects`, `audit_comments`, `users` |
| **Sort order** | `created_at ASC` |

---

## 9. Component Analysis

### POST /api/projects/:id/analyze-components (L2284)

Starts an agentic component analysis in the background.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be project creator or verified GitHub owner. |
| **Path params** | `id` - project UUID |
| **Body** | `{ apiKey: string }` |
| **Response (200)** | `{ analysisId }` |
| **Response (400)** | Invalid API key or project has no repositories |
| **Response (403)** | Not creator/owner |
| **Response (404)** | Project not found |
| **Response (500)** | `{ error }` |
| **DB writes** | `INSERT INTO component_analyses` (status = 'pending') |
| **External** | `cloneOrUpdate`, `scanCodeFiles`, `runComponentAnalysis` (fire-and-forget) |
| **Business logic** | Clones all repos synchronously before starting background analysis. Analysis record is created before the background task. |

### GET /api/projects/:id/component-analysis/:analysisId (L2368)

Polls analysis status.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Path params** | `id` - project UUID, `analysisId` - analysis UUID |
| **Response (200)** | `{ id, projectId, status, turnsUsed, maxTurns, inputTokensUsed, outputTokensUsed, costUsd, errorMessage, createdAt, completedAt }` |
| **Response (404)** | Analysis not found (or project mismatch) |
| **Response (500)** | `{ error }` |
| **DB reads** | `component_analyses` |

[GAP] No auth check; anyone can poll any analysis status if they know the IDs.

[REC] Consider adding at minimum an ownership/requester check, or at least verify the analysis is associated with a visible project.

### GET /api/projects/:id/components (L2407)

Lists components for a project.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Path params** | `id` - project UUID |
| **Response (200)** | `Array<{ id, name, description, role, repoName, filePatterns, languages, securityProfile, estimatedFiles, estimatedTokens, createdAt }>` |
| **Response (500)** | `{ error }` |
| **DB reads** | `components`, `repositories` |
| **Sort order** | `estimated_tokens DESC NULLS LAST` |

[GAP] No 404 when project does not exist; returns empty array.

---

## 10. Dependencies

### POST /api/dependencies/:id/link (L2447)

Links a project dependency to an existing CodeWatch project.

| Aspect | Detail |
|---|---|
| **Auth** | **Required** (`requireAuth`). Must be project creator or verified GitHub owner. |
| **Path params** | `id` - dependency UUID |
| **Body** | `{ linkedProjectId: string }` |
| **Response (200)** | `{ ok: true }` |
| **Response (400)** | Missing `linkedProjectId` |
| **Response (403)** | Not owner/creator |
| **Response (404)** | Dependency not found, or linked project not found |
| **Response (500)** | `{ error }` |
| **DB reads** | `project_dependencies`, `projects` |
| **DB writes** | `UPDATE project_dependencies SET linked_project_id` |

---

## 11. Public

### GET /api/reports (L2515)

Lists public completed audit reports.

| Aspect | Detail |
|---|---|
| **Auth** | None required |
| **Response (200)** | `Array<{ id, auditLevel, maxSeverity, completedAt, projectName, githubOrg }>` |
| **Response (500)** | `{ error }` |
| **DB reads** | `audits`, `projects` |
| **Filter** | `is_public = TRUE AND status = 'completed'` |
| **Sort** | `completed_at DESC` |
| **Limit** | 50 |

---

## Gaps and Recommendations Summary

| Tag | Location | Description |
|---|---|---|
| [GAP] | `getRedactedSeverities` (L77) | Defined but never called. Its return values for `requester` tier (empty set) contradict the actual inline redaction logic in `/audit/:id/report` (L1477) and `/audit/:id/findings` (L1707) which redact medium/high/critical. |
| [REC] | `getRedactedSeverities` | Refactor report and findings endpoints to call this helper, or remove it entirely. |
| [GAP] | `GET /api/project/:id/audits` (L1130) | No 404 when project does not exist; returns empty array silently. |
| [GAP] | `GET /api/projects/:id/components` (L2407) | No 404 when project does not exist; returns empty array silently. |
| [GAP] | `GET /api/projects/:id/component-analysis/:analysisId` (L2368) | No auth check; anyone can poll any analysis status by ID. |
| [REC] | Component analysis polling | Add ownership/requester check or verify project visibility. |
| [GAP] | `POST /api/estimate` (L804) | No auth required; anyone can trigger repo cloning and disk I/O. |
| [REC] | Estimation endpoints | Consider rate-limiting or requiring auth for clone-triggering estimation endpoints. |
| [GAP] | `POST /api/estimate/precise` (L934) | No auth required, but consumes Anthropic API credits via the service key. |
| [REC] | Precise estimation | Require auth to prevent abuse of service-key-funded token counting. |
