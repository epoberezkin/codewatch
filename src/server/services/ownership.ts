// Spec: spec/services/ownership.md
import { Pool } from 'pg';
import { checkGitHubOwnership, type OwnershipCheck } from './github';

export interface OwnershipResult {
  isOwner: boolean;
  role?: string;
  needsReauth?: boolean;
  cached: boolean;
}

/**
 * Resolve ownership of a GitHub org/user for the given user.
 * Checks the ownership_cache table first (15-min TTL).
 * On cache miss, calls GitHub API and caches the result.
 */
// Spec: spec/services/ownership.md#resolveOwnership
export async function resolveOwnership(
  pool: Pool,
  userId: string,
  githubOrg: string,
  githubUsername: string,
  githubToken: string,
  hasOrgScope: boolean,
): Promise<OwnershipResult> {
  // Check cache first
  const { rows: cached } = await pool.query(
    `SELECT is_owner, role FROM ownership_cache
     WHERE user_id = $1 AND github_org = $2 AND expires_at > NOW()`,
    [userId, githubOrg]
  );

  if (cached.length > 0) {
    return {
      isOwner: cached[0].is_owner,
      role: cached[0].role || undefined,
      cached: true,
    };
  }

  // Cache miss — call GitHub API
  const result: OwnershipCheck = await checkGitHubOwnership(
    githubOrg,
    githubUsername,
    githubToken,
    hasOrgScope,
  );

  // Don't cache needsReauth results — user should re-auth and retry
  if (!result.needsReauth) {
    await pool.query(
      `INSERT INTO ownership_cache (user_id, github_org, is_owner, role, checked_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '15 minutes')
       ON CONFLICT (user_id, github_org) DO UPDATE SET
         is_owner = $3,
         role = $4,
         checked_at = NOW(),
         expires_at = NOW() + INTERVAL '15 minutes'`,
      [userId, githubOrg, result.isOwner, result.role || null]
    );
  }

  return {
    isOwner: result.isOwner,
    role: result.role,
    needsReauth: result.needsReauth,
    cached: false,
  };
}

/**
 * Invalidate all cached ownership entries for a user.
 * Called on re-authentication to force fresh GitHub API lookups.
 */
// Spec: spec/services/ownership.md#invalidateOwnershipCache
export async function invalidateOwnershipCache(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    'DELETE FROM ownership_cache WHERE user_id = $1',
    [userId]
  );
}
