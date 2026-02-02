import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// Hoisted mutable state for ownership mock
const mockOwnershipState = vi.hoisted(() => ({
  ownerUserIds: new Set<string>(),
}));

// Mock GitHub and git services
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
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
  getGitHubEntity: async () => ({
    login: 'test-org', type: 'Organization',
    avatarUrl: 'https://avatars.githubusercontent.com/u/99999',
  }),
  listRepoBranches: async () => [{ name: 'main' }, { name: 'dev' }],
  getRepoDefaultBranch: async () => 'main',
  getCommitDate: async () => new Date('2025-01-01'),
}));

// Mock ownership service — uses hoisted state to control per-test ownership
vi.mock('../../src/server/services/ownership', () => ({
  resolveOwnership: async (_pool: any, userId: string) => ({
    isOwner: mockOwnershipState.ownerUserIds.has(userId),
    cached: false,
  }),
  invalidateOwnershipCache: async () => {},
}));

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

describe('Unpublish API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
    mockOwnershipState.ownerUserIds.clear();
  });

  // Helper: create a project and insert a completed audit directly in the DB — registers session as owner
  async function createProjectWithAudit(session: { userId: string; cookie: string }) {
    mockOwnershipState.ownerUserIds.add(session.userId);
    // Create project via API
    const createRes = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubOrg: 'test-org', repoNames: ['repo-alpha'] }),
    });
    const { projectId } = await createRes.json();

    // Insert a completed audit directly
    const { rows } = await ctx.pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner)
       VALUES ($1, $2, 'full', 'completed', TRUE)
       RETURNING id`,
      [projectId, session.userId]
    );
    return { projectId, auditId: rows[0].id };
  }

  it('owner can unpublish a published audit', async () => {
    const session = await createTestSession(ctx.pool);
    const { auditId } = await createProjectWithAudit(session);

    // Publish first
    const pubRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
      method: 'POST',
    });
    expect(pubRes.status).toBe(200);

    // Verify it's published
    const { rows: beforeRows } = await ctx.pool.query('SELECT is_public FROM audits WHERE id = $1', [auditId]);
    expect(beforeRows[0].is_public).toBe(true);

    // Unpublish
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/unpublish`, session.cookie, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify it's unpublished and publishable_after is NULL
    const { rows } = await ctx.pool.query('SELECT is_public, publishable_after FROM audits WHERE id = $1', [auditId]);
    expect(rows[0].is_public).toBe(false);
    expect(rows[0].publishable_after).toBeNull();
  });

  it('non-owner cannot unpublish', async () => {
    const owner = await createTestSession(ctx.pool);
    const { auditId } = await createProjectWithAudit(owner);

    // Publish as owner
    await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, owner.cookie, { method: 'POST' });

    // Try unpublish as different user
    const otherUser = await createTestSession(ctx.pool);
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/unpublish`, otherUser.cookie, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('unpublish is idempotent', async () => {
    const session = await createTestSession(ctx.pool);
    const { auditId } = await createProjectWithAudit(session);

    // Unpublish an already-private audit
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/unpublish`, session.cookie, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
