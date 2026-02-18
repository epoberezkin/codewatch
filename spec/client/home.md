# home.ts -- Home Page Module

**Source**: [`home.ts`](../../src/client/home.ts#L1-L497)
**HTML**: `public/index.html`

---

## Overview

Three-step wizard for creating a new project:
1. **Step 1**: Enter a GitHub URL -> fetch entity info + repo list
2. **Step 2**: Select/deselect repos, configure branches per repo
3. **Step 3**: Auth check + create project (redirects to estimate page)

---

## [Interfaces](../../src/client/home.ts#L7-L22)

```ts
interface EntityInfo {
  login: string; type: 'User' | 'Organization';
  avatarUrl: string; isOwner: boolean | null;
  role: string | null; needsReauth: boolean;
}

interface RepoInfo {
  name: string; description: string; language: string;
  stars: number; defaultBranch: string;
}
```

---

## [State Variables](../../src/client/home.ts#L36-L46)

| Variable | Type | Description |
|---|---|---|
| `entityInfo` | `EntityInfo \| null` | Fetched entity metadata |
| `parsedOwner` | `string` | GitHub owner/org extracted from URL |
| `allRepos` | `RepoInfo[]` | All repos for the entity |
| `selectedRepos` | `Map<string, { name, branch, defaultBranch }>` | Currently selected repos with branch config |
| `branchCache` | `Map<string, string[]>` | Cached branch lists per repo name |
| `initialRepoName` | `string \| null` | Repo name from Step 1 URL (preserved on deselect-all) |
| `existingProjectId` | `string \| null` | Existing project ID from preflight check, null if no duplicate |

---

## Functions

### [URL Parsing](../../src/client/home.ts#L48-L59)

| Function | Signature | Description |
|---|---|---|
| `parseGitHubUrl` | `(url: string) => { owner: string; repo: string } \| null` | Extracts owner + repo from a GitHub URL. Validates hostname is `github.com`. Strips `.git` suffix. |

### [Entity Card](../../src/client/home.ts#L134-L161)

| Function | Signature | Description |
|---|---|---|
| `renderEntityCard` | `(entity: EntityInfo) => void` | Sets avatar, name, type badge. Shows/hides owner/member/reauth badges. |

### [Selected Repos](../../src/client/home.ts#L166-L213)

| Function | Signature | Description |
|---|---|---|
| `renderSelectedRepos` | `() => void` | Renders `#selected-repos` list with remove buttons. Branch selector (trigger button) is only rendered when `currentUser` is truthy (authenticated). Attaches per-item remove and branch-open handlers. |

### [Branch Dropdown](../../src/client/home.ts#L218-L306)

| Function | Signature | Description |
|---|---|---|
| `openBranchDropdown` | `(repoName: string, trigger: HTMLButtonElement) => Promise<void>` | Fetches branches (or uses cache), replaces trigger with `<select>`. On change, updates `selectedRepos` branch. On blur, closes after 150ms delay. |
| `closeBranchDropdown` | `(container: HTMLElement, repoName: string) => void` | Removes select, restores trigger button text |

### [All Repos List](../../src/client/home.ts#L340-L404)

| Function | Signature | Description |
|---|---|---|
| `renderAllReposList` | `() => void` | Renders available (non-selected) repos with checkboxes into `#all-repos-list`. Checkbox change adds/removes from `selectedRepos` and re-renders this list. Also called from remove button handler when section is visible. Re-applies active search filter after rendering. Row click toggles checkbox. |

### [Step 3](../../src/client/home.ts#L428-L457)

| Function | Signature | Description |
|---|---|---|
| `updateStep3` | `() => Promise<void>` | Waits for auth, shows/hides `#auth-required`. Runs preflight duplicate check via `POST /api/projects/check` -- sets `existingProjectId` if a matching project exists. Enables/disables create button with selection count label; button text changes to "Open Project" when duplicate detected. |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#add-project-btn` | click | L62-L121 | Parses URL, fetches entity+repos in parallel, pre-selects entered repo, shows steps 2+3 |
| `#repo-url` (input) | keydown (Enter) | L124-L129 | Triggers `addProjectBtn.click()` |
| `#add-repos-btn` | click | L310-L325 | Toggles `#all-repos-section` visibility, renders repo list, focuses search |
| `#repo-search` (input) | input | L329-L337 | Filters `#all-repos-list` items by name/description substring match |
| `#select-all` (checkbox) | change | L407-L423 | Batch adds/removes all repos to `selectedRepos` (preserves Step 1 repo on deselect), renders once |
| `#create-project-btn` | click | L459-L495 | If `existingProjectId` is set, navigates directly to existing project (early return). Otherwise builds repo array with branch overrides, posts to `/api/projects`, redirects to `/estimate.html?projectId=`. On 409 `ApiResponseError` with `body.projectId`, redirects to existing project (race-condition fallback). |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/github/entity/{owner}` | addProjectBtn click | L84 |
| GET | `/api/github/orgs/{owner}/repos` | addProjectBtn click | L85 |
| GET | `/api/github/repos/{owner}/{repo}/branches` | openBranchDropdown | L248 |
| POST | `/api/projects/check` | updateStep3 | L443 |
| POST | `/api/projects` | createBtn click | L479 |

**POST /api/projects/check body**:
```ts
{ githubOrg: string, repos: string[] }
```
Returns `{ exists: boolean, projectId?: string }`. Best-effort; errors are silently caught.

**POST /api/projects body**:
```ts
{ githubOrg: string, repos: Array<{ name: string; branch?: string; defaultBranch: string }> }
```

---

## DOM Element IDs

| ID | Type | Purpose |
|---|---|---|
| `repo-url` | input | GitHub URL input |
| `add-project-btn` | button | Step 1 submit |
| `repo-url-error` | div | URL validation error message |
| `step-2` | section | Repo selection step |
| `step-3` | section | Auth + create step |
| `create-project-btn` | button | Create project |
| `auth-required` | div | "Sign in" notice |
| `loading` | div | Loading spinner |
| `add-repos-btn` | button | Toggle additional repos panel |
| `select-all` | checkbox | Select all repos |
| `entity-avatar` | img | Entity avatar |
| `entity-name` | span | Entity login name |
| `entity-type-badge` | span | User/Organization badge |
| `owner-badge` | span | Owner badge |
| `member-badge` | span | Member badge |
| `reauth-badge` | span | Re-auth needed badge |
| `selected-repos` | ul | Selected repos list |
| `all-repos-section` | section | Expandable all-repos panel |
| `all-repos-list` | ul | All available repos |
| `repo-search` | input | Search filter for all repos |

---

## State Management

- All state in closure-scoped `let` variables inside `DOMContentLoaded`.
- `selectedRepos` Map is the primary state -- drives both UI and create payload.
- `branchCache` avoids redundant branch API calls.
- No persistence; navigating away loses all state.

---

## [GAP] No URL Pre-fill

The page does not read query parameters to pre-fill the URL input (e.g., `?url=https://github.com/org/repo`).

## ~~[GAP] No Duplicate Project Detection~~

**RESOLVED**: `updateStep3` now runs a preflight duplicate check via `POST /api/projects/check`. If a matching project exists, the create button changes to "Open Project" and navigates directly. A 409 fallback in the create handler catches race-condition duplicates.

## [REC] Consider adding `?url=` query parameter support for deep-linking from external tools.
