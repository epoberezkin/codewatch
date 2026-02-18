# Plan: Duplicate Project Preflight Check + Graceful 409 Handling

**Date:** 2026-02-18

## 1. Problem Statement

When a user selects repos matching an existing project (same org, same sorted repo set, same user), the API returns 409 with `{ projectId, existing: true, message }`. The client shows a cryptic "Project already exists" error with no navigation to the existing project.

Two improvements needed:
- **Proactive**: Preflight check on every repo selection change — button becomes "Open Project" when duplicate detected
- **Reactive**: 409 fallback — if the create call hits a race-condition duplicate, redirect instead of showing error

Documented gaps: `product/views/home.md` L155-157, `product/gaps.md` L229-233, `spec/client/home.md` L157-159.

## 2. Solution Summary

1. Extract duplicate-check SQL into `findDuplicateProject()` helper in `api.ts`
2. Add `POST /api/projects/check` endpoint (auth-required, lightweight)
3. Add `ApiResponseError` class to `common.ts` so `apiFetch` preserves status + body on errors
4. Modify `updateStep3()` in `home.ts` to call check endpoint on every repo change
5. Button text: "Open Project (N repos)" when exists, click navigates directly
6. Create handler catches 409 via `ApiResponseError` and redirects (race condition fallback)
7. Enhance `attachAddAsProjectHandlers` in `common.ts` to handle 409 on "Add as Project" buttons

## 3. Detailed Technical Design

### 3.1 Server: `findDuplicateProject()` helper

**File:** `src/server/routes/api.ts` — insert near existing helpers (after `buildThreatModelFileLinks`, ~L109)

```ts
async function findDuplicateProject(
  pool: Pool, githubOrg: string, userId: string, sortedRepoNames: string
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT p.id FROM projects p
     WHERE p.github_org = $1 AND p.created_by = $2
     AND (SELECT string_agg(r.repo_name, ',' ORDER BY r.repo_name)
          FROM project_repos pr JOIN repositories r ON r.id = pr.repo_id
          WHERE pr.project_id = p.id) = $3`,
    [githubOrg, userId, sortedRepoNames]
  );
  return rows.length > 0 ? rows[0].id : null;
}
```

Then replace the inline duplicate check in `POST /api/projects` (L251-266) with:
```ts
const sortedNames = repoInputs.map(r => r.name).sort().join(',');
const existingId = await findDuplicateProject(pool, githubOrg, userId, sortedNames);
if (existingId) {
  res.status(409).json({ projectId: existingId, existing: true, message: 'Project already exists' });
  return;
}
```

### 3.2 Server: `POST /api/projects/check` endpoint

**File:** `src/server/routes/api.ts` — insert before `GET /api/projects/browse`

- Auth-required (`requireAuth`)
- Body: `{ githubOrg: string, repos: string[] }` (accepts both plain strings and `{ name }` objects for flexibility)
- Response: `{ exists: boolean, projectId?: string }`
- Validates `githubOrg` is non-empty string, `repos` is non-empty array
- Calls `findDuplicateProject()` with sorted join of repo names

**Threat model:** Auth-scoped (only checks the authenticated user's projects). No information leak. Parameterized SQL — no injection risk.

### 3.3 Client: `ApiResponseError` class

**File:** `src/client/common.ts` — insert after `ApiError` interface (L39), before `apiFetch` (L42)

```ts
class ApiResponseError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
```

Then modify `apiFetch` error path (L56-70): parse body into a local variable, throw `ApiResponseError(msg, res.status, body)` instead of `new Error(msg)`. Backward-compatible — `ApiResponseError extends Error`.

### 3.4 Client: Preflight in `updateStep3()`

**File:** `src/client/home.ts`

New state variable near L44:
```ts
let existingProjectId: string | null = null;
```

In `updateStep3()` (L426-442), after auth/selection check, before button update:
```ts
existingProjectId = null;
if (isLoggedIn && hasSelection) {
  try {
    const repoNames = Array.from(selectedRepos.keys());
    const result = await apiPost<{ exists: boolean; projectId?: string }>(
      '/api/projects/check', { githubOrg: parsedOwner, repos: repoNames }
    );
    if (result.exists && result.projectId) existingProjectId = result.projectId;
  } catch { /* best-effort */ }
}
```

Button text logic:
- `existingProjectId` set → `"Open Project (N repos)"`
- Otherwise → `"Create Project (N repos)"` (existing logic)

No debouncing — per user instruction, repo selection changes are discrete click actions.

### 3.5 Client: Create handler 409 fallback

**File:** `src/client/home.ts` — create button handler (~L444)

- Early return if `existingProjectId`: navigate to `/estimate.html?projectId=${existingProjectId}`
- In catch block: check `err instanceof ApiResponseError && err.status === 409 && err.body?.projectId` → redirect instead of `showError()`

### 3.6 Client: `attachAddAsProjectHandlers` 409 handling

**File:** `src/client/common.ts` — catch block at L332-335

On 409 with `projectId`: link the dependency to existing project via `POST /api/dependencies/:id/link`, then replace button with "View Project" link. Same UX as success path.

## 4. Implementation Steps

| # | File | Change | Approx lines |
|---|------|--------|-------------|
| 1 | `src/client/common.ts` | Add `ApiResponseError` class after L39 | +8 |
| 2 | `src/client/common.ts` | Modify `apiFetch` error path (L56-70) to throw `ApiResponseError` | ~5 modified |
| 3 | `src/client/common.ts` | Enhance `attachAddAsProjectHandlers` catch (L332) for 409 | +5 |
| 4 | `src/server/routes/api.ts` | Add `findDuplicateProject()` helper (~L109) | +12 |
| 5 | `src/server/routes/api.ts` | Replace inline duplicate check in POST /api/projects with helper call | -8, +4 |
| 6 | `src/server/routes/api.ts` | Add `POST /api/projects/check` endpoint | +25 |
| 7 | `src/client/home.ts` | Add `existingProjectId` state var (~L44) | +1 |
| 8 | `src/client/home.ts` | Add preflight check + button text in `updateStep3()` | +15 |
| 9 | `src/client/home.ts` | Add early-return + 409 catch in create handler | +8 |
| 10 | `test/api/projects.test.ts` | Tests: check endpoint (auth, not-found, found, cross-user) + 409 duplicate create | +70 |
| 11 | Docs | Update spec/api.md, spec/client/common.md, spec/client/home.md, product/views/home.md, product/gaps.md | +40 |

## 5. Documentation Updates

- **spec/api.md**: Add `POST /api/projects/check` section + `findDuplicateProject` helper
- **spec/client/common.md**: Add `ApiResponseError` class, update `apiFetch` description, update `attachAddAsProjectHandlers` 409 handling
- **spec/client/home.md**: Add `existingProjectId` to state table, update `updateStep3` description, add check endpoint to API calls table, update create handler description, mark GAP resolved
- **product/views/home.md**: Update Step 3 to document "Open Project" button + 409 redirect, mark GAP resolved
- **product/gaps.md**: Mark "No client-side duplicate-project detection" as RESOLVED

## 6. Verification

1. **Build**: `npx tsc --noEmit` — no new errors beyond pre-existing DOM type issues
2. **Tests**: `npm test -- test/api/projects.test.ts` — all existing + new tests pass
3. **Manual**:
   - Create a project, then enter same URL + repos again → button shows "Open Project", click navigates to estimate page
   - Enter different repos for same org → button shows "Create Project"
   - Anonymous user → no preflight check, button disabled with auth notice
   - "Add as Project" on dependency that already exists → links and shows "View Project" link
4. **Adversarial self-review**: Verify cross-layer coherence (spec ↔ product ↔ src line refs)
