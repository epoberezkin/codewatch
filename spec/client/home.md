# home.ts -- Home Page Module

**Source**: [`home.ts`](../../src/client/home.ts#L1-L448)
**HTML**: `public/index.html`

---

## Overview

Three-step wizard for creating a new project:
1. **Step 1**: Enter a GitHub URL -> fetch entity info + repo list
2. **Step 2**: Select/deselect repos, configure branches per repo
3. **Step 3**: Auth check + create project (redirects to estimate page)

---

## [Interfaces](../../src/client/home.ts#L7-L23)

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

## [State Variables](../../src/client/home.ts#L36-L42)

| Variable | Type | Description |
|---|---|---|
| `entityInfo` | `EntityInfo \| null` | Fetched entity metadata |
| `parsedOwner` | `string` | GitHub owner/org extracted from URL |
| `allRepos` | `RepoInfo[]` | All repos for the entity |
| `selectedRepos` | `Map<string, { name, branch, defaultBranch }>` | Currently selected repos with branch config |
| `branchCache` | `Map<string, string[]>` | Cached branch lists per repo name |

---

## Functions

### [URL Parsing](../../src/client/home.ts#L45-L55)

| Function | Signature | Description |
|---|---|---|
| `parseGitHubUrl` | `(url: string) => { owner: string; repo: string } \| null` | Extracts owner + repo from a GitHub URL. Validates hostname is `github.com`. Strips `.git` suffix. |

### [Entity Card](../../src/client/home.ts#L129-L156)

| Function | Signature | Description |
|---|---|---|
| `renderEntityCard` | `(entity: EntityInfo) => void` | Sets avatar, name, type badge. Shows/hides owner/member/reauth badges. |

### [Selected Repos](../../src/client/home.ts#L161-L207)

| Function | Signature | Description |
|---|---|---|
| `renderSelectedRepos` | `() => void` | Renders `#selected-repos` list with remove buttons. Branch selector (trigger button) is only rendered when `currentUser` is truthy (authenticated). Attaches per-item remove and branch-open handlers. |

### [Branch Dropdown](../../src/client/home.ts#L209-L300)

| Function | Signature | Description |
|---|---|---|
| `openBranchDropdown` | `(repoName: string, trigger: HTMLButtonElement) => Promise<void>` | Fetches branches (or uses cache), replaces trigger with `<select>`. On change, updates `selectedRepos` branch. On blur, closes after 150ms delay. |
| `closeBranchDropdown` | `(container: HTMLElement, repoName: string) => void` | Removes select, restores trigger button text |

### [All Repos List](../../src/client/home.ts#L334-L387)

| Function | Signature | Description |
|---|---|---|
| `renderAllReposList` | `() => void` | Renders available (non-selected) repos with checkboxes into `#all-repos-list`. Checkbox change adds/removes from `selectedRepos`. Row click toggles checkbox. |

### [Step 3](../../src/client/home.ts#L404-L420)

| Function | Signature | Description |
|---|---|---|
| `updateStep3` | `() => Promise<void>` | Waits for auth, shows/hides `#auth-required`, enables/disables create button with selection count label |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#add-project-btn` | click | L58-L116 | Parses URL, fetches entity+repos in parallel, pre-selects entered repo, shows steps 2+3 |
| `#repo-url` (input) | keydown (Enter) | L119-L124 | Triggers `addProjectBtn.click()` |
| `#add-repos-btn` | click | L304-L319 | Toggles `#all-repos-section` visibility, renders repo list, focuses search |
| `#repo-search` (input) | input | L322-L331 | Filters `#all-repos-list` items by name/description substring match |
| `#select-all` (checkbox) | change | L390-L399 | Toggles all visible repo checkboxes |
| `#create-project-btn` | click | L422-L448 | Builds repo array with branch overrides, posts to `/api/projects`, redirects to `/estimate.html?projectId=` |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/github/entity/{owner}` | addProjectBtn click | L80 |
| GET | `/api/github/orgs/{owner}/repos` | addProjectBtn click | L81 |
| GET | `/api/github/repos/{owner}/{repo}/branches` | openBranchDropdown | L242-L243 |
| POST | `/api/projects` | createBtn click | L436 |

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

## [GAP] No Duplicate Project Detection

No check whether a project for the same org already exists before creation.

## [REC] Consider adding `?url=` query parameter support for deep-linking from external tools.
