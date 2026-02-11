# GitHub Service

Wrapper around the GitHub REST API v3 and GraphQL API v4. Provides OAuth authentication, repository listing, entity lookup, ownership verification, issue creation, and commit metadata retrieval.

Source: [`github.ts`](../../src/server/services/github.ts)

---

## Types

### `GitHubUser` (L6-L11)

Represents the authenticated user returned by the GitHub `/user` endpoint.

| Field        | Type     | Notes                          |
|-------------|----------|--------------------------------|
| `id`        | `number` |                                |
| `login`     | `string` |                                |
| `type`      | `string` | `'User'` or `'Organization'`  |
| `avatar_url`| `string` |                                |

### `GitHubRepo` (L13-L24)

Represents a GitHub repository as returned by list/get endpoints.

| Field              | Type                            | Notes |
|-------------------|---------------------------------|-------|
| `id`              | `number`                        |       |
| `name`            | `string`                        |       |
| `full_name`       | `string`                        |       |
| `description`     | `string \| null`                |       |
| `language`        | `string \| null`                |       |
| `stargazers_count`| `number`                        |       |
| `forks_count`     | `number`                        |       |
| `default_branch`  | `string`                        |       |
| `license`         | `{ spdx_id: string } \| null`  |       |
| `html_url`        | `string`                        |       |

### `GitHubEntity` (L26-L30)

Normalized representation of a GitHub user or organization. Uses camelCase (`avatarUrl`) unlike the raw API (`avatar_url`).

| Field       | Type                          |
|------------|-------------------------------|
| `login`    | `string`                      |
| `type`     | `'User' \| 'Organization'`   |
| `avatarUrl`| `string`                      |

### `GitHubBranch` (L32-L34)

Minimal branch representation returned by `listRepoBranches`.

| Field  | Type     |
|--------|----------|
| `name` | `string` |

### `OrgMembership` (L38-L41)

Organization membership details for the authenticated user.

| Field   | Type                       |
|---------|----------------------------|
| `role`  | `'admin' \| 'member'`      |
| `state` | `'active' \| 'pending'`    |

### `OwnershipCheck` (L43-L47)

Result of an ownership verification check.

| Field          | Type      | Notes                                    |
|---------------|-----------|------------------------------------------|
| `isOwner`     | `boolean` | Whether the user is an owner/admin       |
| `role`        | `string?` | `'personal'`, `'admin'`, or `'member'`   |
| `needsReauth` | `boolean?`| [GAP] The `needsReauth` field is declared on the `OwnershipCheck` type but no code path in the current codebase sets it to `true`. It exists as a placeholder in the interface contract. |

---

## Functions

### OAuth

#### [`getOAuthUrl()`](../../src/server/services/github.ts) (L52-L62)

```ts
function getOAuthUrl(state?: string): string
```

Builds a GitHub OAuth authorization URL.

- **Endpoint:** `https://github.com/login/oauth/authorize`
- **Auth required:** No (uses `config.github.clientId`).
- **Behavior:** Constructs query params with `client_id`, `redirect_uri`, and `scope: 'read:org'`. Appends optional `state` param for CSRF protection.
- **Error handling:** None; pure URL construction.
- **[REC]** The scope is hardcoded to `read:org`. If additional scopes are needed in the future, this would need parameterization.

#### [`exchangeCodeForToken()`](../../src/server/services/github.ts) (L65-L84)

```ts
function exchangeCodeForToken(code: string): Promise<{ accessToken: string; scope: string }>
```

Exchanges an OAuth authorization code for an access token.

- **Endpoint:** `POST https://github.com/login/oauth/access_token`
- **Auth required:** No (uses `client_id` + `client_secret` from config).
- **Behavior:** Posts JSON with `client_id`, `client_secret`, and `code`. Parses the JSON response.
- **Error handling:** Throws `Error` with `error_description` (or `error`) from the response body if present. Uses non-null assertion (`!`) on `access_token`.
- **[GAP]** Does not check for a non-ok HTTP status (`res.ok`); relies solely on the `error` field in the response body.

---

### User Info

#### [`getAuthenticatedUser()`](../../src/server/services/github.ts) (L89-L98)

```ts
function getAuthenticatedUser(token: string): Promise<GitHubUser>
```

Fetches the profile of the currently authenticated user.

- **Endpoint:** `GET https://api.github.com/user`
- **Auth required:** Yes (Bearer token).
- **Behavior:** Returns the full `GitHubUser` object.
- **Error handling:** Throws on non-ok response with the HTTP status code.

---

### Repos

#### [`listOrgRepos()`](../../src/server/services/github.ts) (L103-L134)

```ts
function listOrgRepos(org: string, token?: string): Promise<GitHubRepo[]>
```

Lists all public repositories for an organization, with automatic pagination.

- **Endpoint:** `GET https://api.github.com/orgs/{org}/repos?per_page=100&page={n}&type=public&sort=stars&direction=desc`
- **Auth required:** Optional (token adds rate-limit headroom and visibility into repos the user can access).
- **Behavior:** Paginates in batches of 100 until a batch returns fewer than 100 items. On 404 (first page only), falls back to `listUserRepos()` treating the org name as a username.
- **Error handling:** Throws on non-ok response (except the 404 fallback).

#### [`listUserRepos()`](../../src/server/services/github.ts) (L137-L160)

```ts
// NOT exported
async function listUserRepos(username: string, token?: string): Promise<GitHubRepo[]>
```

Lists all public repositories for a user. Called as a fallback from `listOrgRepos()` when the org endpoint 404s.

- **Endpoint:** `GET https://api.github.com/users/{username}/repos?per_page=100&page={n}&type=public&sort=stars&direction=desc`
- **Auth required:** Optional.
- **Behavior:** Same pagination pattern as `listOrgRepos`.
- **Error handling:** Throws on non-ok response.
- **Note:** Not exported; internal fallback only.

#### [`getGitHubEntity()`](../../src/server/services/github.ts) (L285-L302)

```ts
function getGitHubEntity(name: string, token?: string): Promise<GitHubEntity>
```

Looks up a GitHub user or organization by login name and returns a normalized `GitHubEntity`.

- **Endpoint:** `GET https://api.github.com/users/{name}`
- **Auth required:** Optional.
- **Behavior:** Fetches the raw user/org object and maps `avatar_url` to camelCase `avatarUrl`.
- **Error handling:** Throws on non-ok response.

#### [`getRepoDefaultBranch()`](../../src/server/services/github.ts) (L307-L324)

```ts
function getRepoDefaultBranch(owner: string, repo: string, token?: string): Promise<string>
```

Returns the default branch name for a repository.

- **Endpoint:** `GET https://api.github.com/repos/{owner}/{repo}`
- **Auth required:** Optional.
- **Behavior:** Fetches the repo object and extracts `default_branch`.
- **Error handling:** Throws on non-ok response.
- **[REC]** Fetches the full repo object to read a single field. Could use a conditional request or share data with callers that already have the repo object.

#### [`listRepoBranches()`](../../src/server/services/github.ts) (L329-L388)

```ts
function listRepoBranches(owner: string, repo: string, token?: string): Promise<GitHubBranch[]>
```

Lists all branches for a repository, sorted by most recent commit date descending.

- **Endpoint:** `POST https://api.github.com/graphql` (GitHub GraphQL API v4)
- **Auth required:** Optional (but GraphQL requires authentication to function; unauthenticated calls will fail). [GAP] Token is optional in the signature, but the GraphQL API always requires auth. Calling without a token will result in a 401.
- **GraphQL query:** Fetches `refs(refPrefix: "refs/heads/")` with `name` and `committedDate` on each node. Paginates via `pageInfo.hasNextPage` / `endCursor` in batches of 100.
- **Behavior:** Collects all branches, sorts by `committedDate` descending, and returns `{ name }[]`.
- **Error handling:** Throws on non-ok HTTP response. Also throws if the GraphQL response contains an `errors` array (uses first error message). Gracefully breaks if `refs` is null/undefined (e.g., empty repo).
- **Note:** This is the only function in the module that uses GraphQL. All others use the REST API.

---

### Ownership

#### [`getOrgMembershipRole()`](../../src/server/services/github.ts) (L165-L188)

```ts
function getOrgMembershipRole(
  org: string, token: string
): Promise<{ membership: OrgMembership | null; httpStatus: number }>
```

Checks the authenticated user's membership role in a given organization.

- **Endpoint:** `GET https://api.github.com/user/memberships/orgs/{org}`
- **Auth required:** Yes (Bearer token). Requires `read:org` scope.
- **Behavior:** Returns `{ membership, httpStatus }`. On success, parses `role` and `state`. On failure, returns `null` membership with the HTTP status code (e.g., 403 for third-party app restrictions, 404 for non-member).
- **Error handling:** Does not throw; returns `null` membership on any non-ok response.

#### [`checkOrgRoleViaRepoPermissions()`](../../src/server/services/github.ts) (L198-L242)

```ts
// NOT exported
async function checkOrgRoleViaRepoPermissions(
  org: string, token: string
): Promise<'admin' | 'write' | 'read' | null>
```

Fallback ownership check when the membership API returns 403 (org has third-party app restrictions). Infers the user's role from repo-level permissions on the org's most recently pushed public repo.

- **Endpoints:**
  1. `GET https://api.github.com/orgs/{org}/repos?per_page=1&type=public&sort=pushed` -- fetches one public repo with its permissions.
  2. `GET https://api.github.com/repos/{org}/{repo}` -- secondary fetch if `permissions` not present in list response.
- **Auth required:** Yes (Bearer token).
- **Behavior:** Checks `permissions.admin` then `permissions.push` on the first repo found. Returns the highest role detected, or `null` if no repos or no permissions available.
- **Error handling:** Catches all exceptions and returns `null`. Does not throw.
- **Note:** Not exported; called only from `checkGitHubOwnership`.

#### [`checkGitHubOwnership()`](../../src/server/services/github.ts) (L247-L280)

```ts
function checkGitHubOwnership(
  githubOrg: string,
  githubUsername: string,
  githubToken: string,
  hasOrgScope: boolean,
): Promise<OwnershipCheck>
```

Top-level ownership verification. Determines whether the authenticated user is an owner/admin of the given GitHub org.

- **Auth required:** Yes.
- **Behavior (multi-step):**
  1. **Personal account:** If `githubOrg` matches `githubUsername` (case-insensitive), returns `{ isOwner: true, role: 'personal' }` immediately.
  2. **Membership API:** Calls `getOrgMembershipRole()`. If membership exists and is `admin` + `active`, returns `isOwner: true`.
  3. **Repo fallback (403):** If membership API returns 403, calls `checkOrgRoleViaRepoPermissions()`. Only `admin` repo-level permission is treated as ownership. `write`/`read` are ignored because any authenticated user gets pull access to public repos.
  4. **Other failures:** Returns `{ isOwner: false }`.
- **Error handling:** Does not throw; delegates to sub-functions.
- **[GAP]** The `hasOrgScope` parameter is accepted but never used in the function body.

---

### Issues

#### [`createIssue()`](../../src/server/services/github.ts) (L416-L437)

```ts
function createIssue(
  token: string, owner: string, repo: string, title: string, body: string
): Promise<{ html_url: string }>
```

Creates a new issue in the specified repository.

- **Endpoint:** `POST https://api.github.com/repos/{owner}/{repo}/issues`
- **Auth required:** Yes (Bearer token). Requires write access to the repo.
- **Behavior:** Posts `{ title, body }` as JSON. Returns `{ html_url }` of the created issue.
- **Error handling:** Throws on non-ok response.

---

### Commits

#### [`getCommitDate()`](../../src/server/services/github.ts) (L393-L411)

```ts
function getCommitDate(
  owner: string, repo: string, sha: string, token?: string
): Promise<Date>
```

Fetches the author date of a specific commit. Used for `shallow-since` clone optimization.

- **Endpoint:** `GET https://api.github.com/repos/{owner}/{repo}/commits/{sha}`
- **Auth required:** Optional.
- **Behavior:** Parses `commit.author.date` into a `Date` object.
- **Error handling:** Throws on non-ok response with descriptive message including "fetching commit date".

---

## Design Notes

- **GraphQL vs REST:** `listRepoBranches` is the only function using the GraphQL API. This is because the REST branch-list endpoint does not return commit dates, which are needed to sort branches by recency. All other functions use the REST API v3.
- **Pagination:** Both `listOrgRepos`/`listUserRepos` (REST, `per_page=100`) and `listRepoBranches` (GraphQL cursor-based, `first: 100`) implement full pagination.
- **Auth pattern:** Most functions accept `token?: string` (optional). When provided, it is sent as `Bearer {token}`. This allows unauthenticated fallback for public data while gaining higher rate limits with auth.
- **Error pattern:** Most functions throw on non-ok responses. Exceptions are `getOrgMembershipRole` (returns null + status) and `checkOrgRoleViaRepoPermissions` (catches all errors, returns null).

## Gaps and Recommendations

| ID | Type | Location | Description |
|----|------|----------|-------------|
| 1 | [GAP] | `OwnershipCheck.needsReauth` (L46) | The `needsReauth` field is declared on the `OwnershipCheck` type but no code path in the current codebase sets it to `true`. It exists as a placeholder in the interface contract. |
| 2 | [GAP] | `exchangeCodeForToken` (L65-L84) | Does not check `res.ok` before parsing the response body. A non-200 response without an `error` field in the body would silently produce an undefined `accessToken`. |
| 3 | [GAP] | `checkGitHubOwnership` (L251) | The `hasOrgScope` parameter is accepted but unused. |
| 4 | [GAP] | `listRepoBranches` (L329-L333) | Token is optional in the signature, but the GitHub GraphQL API requires authentication. Unauthenticated calls will fail with 401. |
| 5 | [REC] | `getOAuthUrl` (L56) | Scope is hardcoded to `read:org`. Consider parameterizing if additional scopes are needed. |
| 6 | [REC] | `getRepoDefaultBranch` (L307-L324) | Fetches the full repo object to extract a single field. Could be optimized or shared with callers that already have the repo data. |
