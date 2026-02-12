// Product: product/flows/authentication.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// Hoisted mutable state for configurable GitHub ownership mock
const mockGitHubState = vi.hoisted(() => ({
  ownershipResult: { isOwner: true } as { isOwner: boolean; role?: string; needsReauth?: boolean },
  checkCallCount: 0,
}));

// Mock GitHub service with configurable ownership result
vi.mock('../../src/server/services/github', () => ({
  getOAuthUrl: () => 'https://github.com/login/oauth/authorize?client_id=test',
  exchangeCodeForToken: async () => ({ accessToken: 'mock-token', scope: 'read:org' }),
  getAuthenticatedUser: async () => ({
    id: 12345, login: 'testuser', type: 'User',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  }),
  listOrgRepos: async () => [
    {
      id: 1001, name: 'repo-alpha', full_name: 'test-org/repo-alpha',
      description: 'Main repo', language: 'TypeScript',
      stargazers_count: 500, forks_count: 50, default_branch: 'main',
      license: { spdx_id: 'MIT' }, html_url: 'https://github.com/test-org/repo-alpha',
    },
  ],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => {
    mockGitHubState.checkCallCount++;
    return mockGitHubState.ownershipResult;
  },
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
  getGitHubEntity: async () => ({
    login: 'test-org', type: 'Organization',
    avatarUrl: 'https://avatars.githubusercontent.com/u/99999',
  }),
  listRepoBranches: async () => [{ name: 'main' }, { name: 'dev' }],
  getRepoDefaultBranch: async () => 'main',
  getCommitDate: async () => new Date('2025-01-01'),
}));

// Mock git service for project creation
vi.mock('../../src/server/services/git', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    cloneOrUpdate: async () => ({
      localPath: '/tmp/claude/test-repo',
      headSha: 'abc123def456',
    }),
    scanCodeFiles: () => [
      { relativePath: 'src/index.ts', size: 1000, roughTokens: 303 },
    ],
  };
});

// Mock audit service to prevent background task errors
vi.mock('../../src/server/services/audit', () => ({
  runAudit: async () => {},
}));

// DO NOT mock ownership.ts — test the real resolveOwnership with DB caching

describe('Ownership', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
    mockGitHubState.ownershipResult = { isOwner: true };
    mockGitHubState.checkCallCount = 0;
  });

  // Helper: create a project via API
  async function createProject(session: { cookie: string; userId: string }): Promise<string> {
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubOrg: 'test-org', repoNames: ['repo-alpha'] }),
    });
    const body = await res.json();
    return body.projectId;
  }

  // Helper: insert a completed audit directly in DB
  async function insertAudit(projectId: string, requesterId: string, isOwner = true): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner)
       VALUES ($1, $2, 'full', 'completed', $3)
       RETURNING id`,
      [projectId, requesterId, isOwner]
    );
    return rows[0].id;
  }

  // Helper: insert a finding for an audit
  async function insertFinding(auditId: string): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO audit_findings (audit_id, severity, title, description, file_path)
       VALUES ($1, 'high', 'Test Finding', 'A test finding', 'src/index.ts')
       RETURNING id`,
      [auditId]
    );
    return rows[0].id;
  }

  // ============================================================
  // resolveOwnership caching
  // ============================================================

  describe('resolveOwnership caching', () => {
    it('populates ownership_cache on first call', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Trigger resolveOwnership via publish endpoint
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });

      // Verify cache was populated
      const { rows } = await ctx.pool.query(
        'SELECT * FROM ownership_cache WHERE user_id = $1 AND github_org = $2',
        [session.userId, 'test-org']
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_owner).toBe(true);
      expect(mockGitHubState.checkCallCount).toBe(1);
    });

    it('returns cached result on subsequent calls', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // First call — populates cache
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(mockGitHubState.checkCallCount).toBe(1);

      // Change mock to non-owner (to prove cache is being used)
      mockGitHubState.ownershipResult = { isOwner: false };

      // Reset audit to unpublished for second publish attempt
      await ctx.pool.query('UPDATE audits SET is_public = FALSE WHERE id = $1', [auditId]);

      // Second call — should hit cache (still returns owner)
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(200); // cached as owner
      expect(mockGitHubState.checkCallCount).toBe(1); // no additional GitHub call
    });

    it('refreshes after cache entry expires', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // First call — populate cache
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(mockGitHubState.checkCallCount).toBe(1);

      // Expire the cache entry
      await ctx.pool.query(
        `UPDATE ownership_cache SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`,
        [session.userId]
      );

      // Change mock to non-owner
      mockGitHubState.ownershipResult = { isOwner: false };

      // Reset audit to unpublished
      await ctx.pool.query('UPDATE audits SET is_public = FALSE WHERE id = $1', [auditId]);

      // Next call — cache expired, should call GitHub API again
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(403); // now non-owner from fresh check
      expect(mockGitHubState.checkCallCount).toBe(2);
    });

    it('does not cache needsReauth results', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Clear cache populated by createProject's ownership check
      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [session.userId]);

      mockGitHubState.ownershipResult = { isOwner: false, needsReauth: true };

      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });

      // Verify nothing was cached
      const { rows } = await ctx.pool.query(
        'SELECT * FROM ownership_cache WHERE user_id = $1',
        [session.userId]
      );
      expect(rows).toHaveLength(0);
    });

    it('re-auth via OAuth callback invalidates cache', async () => {
      // Create user with github_id=12345 to match the OAuth mock's getAuthenticatedUser
      const user = await createTestUser(ctx.pool, { githubId: 12345, username: 'testuser' });
      const session = await createTestSession(ctx.pool, user.id);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Populate cache via ownership check
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });

      // Verify cache exists
      const { rows: before } = await ctx.pool.query(
        'SELECT * FROM ownership_cache WHERE user_id = $1',
        [user.id]
      );
      expect(before).toHaveLength(1);

      // Re-authenticate via OAuth callback (triggers invalidateOwnershipCache)
      await fetch(`${ctx.baseUrl}/auth/github/callback?code=re-auth-code`, {
        redirect: 'manual',
      });

      // Verify cache was cleared
      const { rows: after } = await ctx.pool.query(
        'SELECT * FROM ownership_cache WHERE user_id = $1',
        [user.id]
      );
      expect(after).toHaveLength(0);
    });
  });

  // ============================================================
  // Ownership-gated endpoints
  // ============================================================

  describe('Ownership-gated endpoints', () => {
    it('POST /api/audit/start records is_owner=true for owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, level: 'full', apiKey: 'sk-ant-test-key-123' }),
      });
      expect(res.status).toBe(200);
      const { auditId } = await res.json();

      // Verify is_owner=true in DB
      const { rows } = await ctx.pool.query('SELECT is_owner FROM audits WHERE id = $1', [auditId]);
      expect(rows[0].is_owner).toBe(true);
    });

    it('POST /api/audit/start records is_owner=false for non-owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      // Clear cache populated by createProject's ownership check
      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [session.userId]);

      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, level: 'full', apiKey: 'sk-ant-test-key-123' }),
      });
      expect(res.status).toBe(200);
      const { auditId } = await res.json();

      // Verify is_owner=false in DB
      const { rows } = await ctx.pool.query('SELECT is_owner FROM audits WHERE id = $1', [auditId]);
      expect(rows[0].is_owner).toBe(false);
    });

    it('PATCH /api/findings/:id/status allows owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);
      const findingId = await insertFinding(auditId);

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/findings/${findingId}/status`, session.cookie, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'fixed' }),
      });
      expect(res.status).toBe(200);

      // Verify status updated
      const { rows } = await ctx.pool.query('SELECT status FROM audit_findings WHERE id = $1', [findingId]);
      expect(rows[0].status).toBe('fixed');
    });

    it('PATCH /api/findings/:id/status rejects non-owner', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);
      const findingId = await insertFinding(auditId);

      // Different user tries to update finding
      const otherUser = await createTestSession(ctx.pool);
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/findings/${findingId}/status`, otherUser.cookie, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'fixed' }),
      });
      expect(res.status).toBe(403);
    });

    it('POST /api/audit/:id/publish allows owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const { rows } = await ctx.pool.query('SELECT is_public FROM audits WHERE id = $1', [auditId]);
      expect(rows[0].is_public).toBe(true);
    });

    it('POST /api/audit/:id/publish rejects non-owner', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);

      const otherUser = await createTestSession(ctx.pool);
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, otherUser.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
    });

    it('returns 403 with needsReauth when scope missing', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Clear cache populated by createProject's ownership check
      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [session.userId]);

      mockGitHubState.ownershipResult = { isOwner: false, needsReauth: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.needsReauth).toBe(true);
    });

    it('DELETE /api/projects/:id allows non-creator GitHub owner', async () => {
      // Creator creates the project
      const creator = await createTestSession(ctx.pool);
      const projectId = await createProject(creator);

      // Different user who is a GitHub owner tries to delete
      const githubOwner = await createTestSession(ctx.pool);
      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, githubOwner.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify project is gone
      const { rows } = await ctx.pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
      expect(rows).toHaveLength(0);
    });
  });

  // ============================================================
  // Audit status endpoint — isOwner and isRequester
  // ============================================================

  describe('Audit status — isOwner and isRequester', () => {
    it('GET /api/audit/:id returns isOwner=true for org admin', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, session.cookie);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.isOwner).toBe(true);
      expect(data.isRequester).toBe(true); // also the requester
    });

    it('GET /api/audit/:id returns isOwner=false for non-owner', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);

      const other = await createTestSession(ctx.pool);
      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [other.userId]);
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, other.cookie);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.isOwner).toBe(false);
      expect(data.isRequester).toBe(false); // different user
    });

    it('GET /api/audit/:id returns isRequester=true for audit requester who is not owner', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);

      // Different user creates the audit (they're the requester)
      const requester = await createTestSession(ctx.pool);
      const auditId = await insertAudit(projectId, requester.userId, false);

      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [requester.userId]);
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, requester.cookie);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.isOwner).toBe(false);
      expect(data.isRequester).toBe(true);
    });

    it('GET /api/audit/:id returns githubOrg from project', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, session.cookie);
      const data = await res.json();
      expect(data.githubOrg).toBe('test-org');
    });
  });

  // ============================================================
  // Report access tier
  // ============================================================

  describe('Report access tier', () => {
    it('returns accessTier=owner for project owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);
      await insertFinding(auditId);

      // Add report_summary so the endpoint returns it
      await ctx.pool.query(
        `UPDATE audits SET report_summary = $1 WHERE id = $2`,
        [JSON.stringify({ executive_summary: 'Test', security_posture: 'OK', responsible_disclosure: {} }), auditId]
      );

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, session.cookie);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accessTier).toBe('owner');
      expect(data.isOwner).toBe(true);
      expect(data.redactionNotice).toBeNull();
      // All findings should be visible with full details
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toBe('Test Finding');
    });

    it('returns accessTier=requester for audit requester who is not owner', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);

      const requester = await createTestSession(ctx.pool);
      const auditId = await insertAudit(projectId, requester.userId, false);
      await insertFinding(auditId);

      await ctx.pool.query(
        `UPDATE audits SET report_summary = $1 WHERE id = $2`,
        [JSON.stringify({ executive_summary: 'Test', security_posture: 'OK', responsible_disclosure: {} }), auditId]
      );

      await ctx.pool.query('DELETE FROM ownership_cache WHERE user_id = $1', [requester.userId]);
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, requester.cookie);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accessTier).toBe('requester');
      expect(data.redactionNotice).toBeTruthy();
      // High finding should be redacted (title=null)
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].severity).toBe('high');
      expect(data.findings[0].title).toBeNull();
    });

    it('returns accessTier=owner for public audit viewed anonymously', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);
      await insertFinding(auditId);

      // Make audit public
      await ctx.pool.query('UPDATE audits SET is_public = true WHERE id = $1', [auditId]);
      await ctx.pool.query(
        `UPDATE audits SET report_summary = $1 WHERE id = $2`,
        [JSON.stringify({ executive_summary: 'Test', security_posture: 'OK', responsible_disclosure: {} }), auditId]
      );

      // Anonymous request (no cookie)
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      expect(res.status).toBe(200);
      const data = await res.json();
      // Public audits get full access (resolveAccessTier returns 'owner' for is_public)
      expect(data.accessTier).toBe('owner');
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].title).toBe('Test Finding');
    });

    it('returns accessTier=public for non-public audit viewed anonymously', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);
      await insertFinding(auditId);

      await ctx.pool.query(
        `UPDATE audits SET report_summary = $1 WHERE id = $2`,
        [JSON.stringify({ executive_summary: 'Test', security_posture: 'OK', responsible_disclosure: {} }), auditId]
      );

      // Anonymous request on non-public audit
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.accessTier).toBe('public');
      expect(data.redactionNotice).toBeTruthy();
      // Public tier: no individual findings
      expect(data.findings).toHaveLength(0);
    });
  });
});
