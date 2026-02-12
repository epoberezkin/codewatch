# ownership service

Resolves and caches GitHub org/user ownership for authenticated users, gating write operations behind verified ownership.

Source: [`ownership.ts`](../../src/server/services/ownership.ts)

## Types

### [`OwnershipResult`](../../src/server/services/ownership.ts#L5-L10)

```ts
interface OwnershipResult {
  isOwner: boolean;
  role?: string;
  needsReauth?: boolean;
  cached: boolean;
}
```

| Field | Type | Description |
|---|---|---|
| `isOwner` | `boolean` | Whether the user is an admin/owner of the GitHub org (or the personal account matches) |
| `role` | `string \| undefined` | GitHub role string (`"admin"`, `"member"`, `"personal"`) — absent on cache hits where the original role was `undefined` |
| `needsReauth` | `boolean \| undefined` | Set to `true` by the GitHub service when the token lacks required scopes; never cached |
| `cached` | `boolean` | `true` when the result was served from `ownership_cache` |

## Exported functions

### [`resolveOwnership()`](../../src/server/services/ownership.ts#L18-L69)

```ts
async function resolveOwnership(
  pool: Pool,
  userId: string,
  githubOrg: string,
  githubUsername: string,
  githubToken: string,
  hasOrgScope: boolean,
): Promise<OwnershipResult>
```

**Steps:**

1. **Cache lookup** — SELECT from `ownership_cache` where `user_id` and `github_org` match and `expires_at > NOW()`. (L27-L31)
2. **Cache hit** — return `{ isOwner, role, cached: true }`. (L33-L39)
3. **Cache miss** — call `checkGitHubOwnership(githubOrg, githubUsername, githubToken, hasOrgScope)` from the github service. (L42-L47)
4. **Conditional cache write** — if the result does NOT have `needsReauth`, INSERT into `ownership_cache` with `expires_at = NOW() + INTERVAL '15 minutes'`. Uses `ON CONFLICT (user_id, github_org) DO UPDATE` (upsert) to overwrite stale rows. (L50-L61)
5. **Return** — `{ isOwner, role, needsReauth, cached: false }`. (L63-L68)

**Database operations (`ownership_cache` table):**

| Operation | SQL | Condition |
|---|---|---|
| SELECT | `WHERE user_id = $1 AND github_org = $2 AND expires_at > NOW()` | Always (step 1) |
| INSERT / UPDATE (upsert) | `ON CONFLICT (user_id, github_org) DO UPDATE SET ...` | Only when `needsReauth` is falsy (step 4) |

**Cache TTL:** 15 minutes (`NOW() + INTERVAL '15 minutes'`).

**External calls:** `checkGitHubOwnership` from `./github` — hits the GitHub membership API (and optionally the repo-permissions fallback).

---

### [`invalidateOwnershipCache()`](../../src/server/services/ownership.ts#L76-L81)

```ts
async function invalidateOwnershipCache(
  pool: Pool,
  userId: string,
): Promise<void>
```

**Steps:**

1. DELETE all rows from `ownership_cache` where `user_id = $1`. (L77-L80)

**Database operations (`ownership_cache` table):**

| Operation | SQL |
|---|---|
| DELETE | `WHERE user_id = $1` |

**External calls:** None.

## Dependencies

| Module | Import | Used by |
|---|---|---|
| `pg` | `Pool` | Both functions (database access) |
| `./github` | `checkGitHubOwnership`, `OwnershipCheck` (type) | `resolveOwnership` |

## Cache invalidation strategy

`invalidateOwnershipCache` is called from `src/server/routes/auth.ts` (L89) during the OAuth callback, immediately after a user re-authenticates. This ensures the next ownership check uses a fresh GitHub API call with the new token (which may carry different scopes).

Results where `needsReauth === true` are never written to the cache, so a stale "needs reauth" state cannot persist.

## Gaps and recommendations

- [GAP] There is no periodic cleanup of expired rows. Rows with `expires_at` in the past remain in the table indefinitely until overwritten by an upsert or removed by `invalidateOwnershipCache`. [REC] Add a scheduled job or `DELETE ... WHERE expires_at < NOW()` sweep to prevent unbounded table growth.
- [GAP] No explicit error handling around the cache SELECT or INSERT queries. A database error will propagate as an unhandled rejection. [REC] Consider wrapping DB calls so that a cache failure degrades gracefully to a live GitHub API call rather than a 500.
- [GAP] The `role` column is stored as a nullable text column, but the `OwnershipCheck` type from the GitHub service returns specific string literals (`"admin"`, `"member"`, `"personal"`). There is no validation on read that the cached value is still a valid role. [REC] Low risk in practice since the module itself writes the values, but a CHECK constraint or enum column would add defense in depth.
