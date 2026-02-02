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

describe('Delete API', () => {
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

  // Helper: create project via API — registers session as owner
  async function createProject(session: { cookie: string; userId: string }): Promise<string> {
    mockOwnershipState.ownerUserIds.add(session.userId);
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
  async function insertFinding(auditId: string, repoId?: string): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO audit_findings (audit_id, repo_id, severity, title, description, file_path)
       VALUES ($1, $2, 'high', 'Test Finding', 'A test finding', 'src/index.ts')
       RETURNING id`,
      [auditId, repoId || null]
    );
    return rows[0].id;
  }

  // Helper: insert an audit commit
  async function insertCommit(auditId: string, repoId: string): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO audit_commits (audit_id, repo_id, commit_sha, branch)
       VALUES ($1, $2, 'abc123', 'main')`,
      [auditId, repoId]
    );
  }

  // ============================================================
  // DELETE /api/audit/:id
  // ============================================================

  describe('DELETE /api/audit/:id', () => {
    it('requester can delete their own audit', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, session.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify audit is gone
      const { rows } = await ctx.pool.query('SELECT id FROM audits WHERE id = $1', [auditId]);
      expect(rows).toHaveLength(0);
    });

    it('other user cannot delete audit', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);

      const otherUser = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, otherUser.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);

      // Audit should still exist
      const { rows } = await ctx.pool.query('SELECT id FROM audits WHERE id = $1', [auditId]);
      expect(rows).toHaveLength(1);
    });

    it('cascades audit_findings and audit_commits', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Get repo id for the project
      const { rows: repoRows } = await ctx.pool.query(
        `SELECT r.id FROM repositories r
         JOIN project_repos pr ON pr.repo_id = r.id
         WHERE pr.project_id = $1 LIMIT 1`,
        [projectId]
      );
      const repoId = repoRows[0].id;

      // Insert related records
      const findingId = await insertFinding(auditId, repoId);
      await insertCommit(auditId, repoId);

      // Add a comment on the finding
      await ctx.pool.query(
        `INSERT INTO audit_comments (audit_id, finding_id, user_id, content)
         VALUES ($1, $2, $3, 'test comment')`,
        [auditId, findingId, session.userId]
      );

      // Delete audit
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}`, session.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify all related rows are gone
      const { rows: findingRows } = await ctx.pool.query('SELECT id FROM audit_findings WHERE audit_id = $1', [auditId]);
      expect(findingRows).toHaveLength(0);

      const { rows: commitRows } = await ctx.pool.query('SELECT audit_id FROM audit_commits WHERE audit_id = $1', [auditId]);
      expect(commitRows).toHaveLength(0);

      const { rows: commentRows } = await ctx.pool.query('SELECT id FROM audit_comments WHERE audit_id = $1', [auditId]);
      expect(commentRows).toHaveLength(0);
    });

    it('returns 404 for nonexistent audit', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/00000000-0000-0000-0000-000000000000`,
        session.cookie,
        { method: 'DELETE' }
      );
      expect(res.status).toBe(404);
    });
  });

  // ============================================================
  // DELETE /api/projects/:id
  // ============================================================

  describe('DELETE /api/projects/:id', () => {
    it('creator can delete project with zero audits', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, session.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify project is gone
      const { rows } = await ctx.pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
      expect(rows).toHaveLength(0);

      // Verify project_repos are gone
      const { rows: prRows } = await ctx.pool.query('SELECT project_id FROM project_repos WHERE project_id = $1', [projectId]);
      expect(prRows).toHaveLength(0);
    });

    it('creator can delete project with only own audits', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);
      await insertFinding(auditId);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, session.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify cascaded
      const { rows: auditRows } = await ctx.pool.query('SELECT id FROM audits WHERE project_id = $1', [projectId]);
      expect(auditRows).toHaveLength(0);

      const { rows: findingRows } = await ctx.pool.query('SELECT id FROM audit_findings WHERE audit_id = $1', [auditId]);
      expect(findingRows).toHaveLength(0);
    });

    it('rejects deletion when other users have audits', async () => {
      const creator = await createTestSession(ctx.pool);
      const projectId = await createProject(creator);

      // Create another user who has an audit on this project
      const otherUser = await createTestUser(ctx.pool, { githubId: 99999, username: 'otheruser' });
      await insertAudit(projectId, otherUser.id, false);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, creator.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('other users');
    });

    it('non-creator cannot delete project', async () => {
      const creator = await createTestSession(ctx.pool);
      const projectId = await createProject(creator);

      const otherUser = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, otherUser.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(403);

      // Project should still exist
      const { rows } = await ctx.pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
      expect(rows).toHaveLength(1);
    });

    it('returns 404 for nonexistent project', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/00000000-0000-0000-0000-000000000000`,
        session.cookie,
        { method: 'DELETE' }
      );
      expect(res.status).toBe(404);
    });

    it('cascades to audit_plan and component_analyses on delete', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await insertAudit(projectId, session.userId);

      // Set audit_plan on the audit
      await ctx.pool.query(
        `UPDATE audits SET audit_plan = $1 WHERE id = $2`,
        [JSON.stringify([{ file: 'src/index.ts', tokens: 300, priority: 9, reason: 'test' }]), auditId]
      );

      // Create a component_analysis for this project
      const { rows: [ca] } = await ctx.pool.query(
        `INSERT INTO component_analyses (project_id, status) VALUES ($1, 'completed') RETURNING id`,
        [projectId]
      );

      // Link project to the component_analysis
      await ctx.pool.query(
        `UPDATE projects SET component_analysis_id = $1 WHERE id = $2`,
        [ca.id, projectId]
      );

      // Delete project
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects/${projectId}`, session.cookie, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);

      // Verify audit is gone (and its audit_plan with it)
      const { rows: auditRows } = await ctx.pool.query('SELECT id FROM audits WHERE id = $1', [auditId]);
      expect(auditRows).toHaveLength(0);

      // Verify component_analyses row is gone
      const { rows: caRows } = await ctx.pool.query('SELECT id FROM component_analyses WHERE id = $1', [ca.id]);
      expect(caRows).toHaveLength(0);
    });
  });
});
