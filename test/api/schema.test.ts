// Product: product/flows/project-creation.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// Mock GitHub and git services (required for server startup)
vi.mock('../../src/server/services/github', () => ({
  getOAuthUrl: () => 'https://github.com/login/oauth/authorize?client_id=test',
  exchangeCodeForToken: async () => ({ accessToken: 'mock-token', scope: 'read:org' }),
  getAuthenticatedUser: async () => ({
    id: 12345, login: 'testuser', type: 'User',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  }),
  listOrgRepos: async () => [],
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

vi.mock('../../src/server/services/git', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    cloneOrUpdate: async () => ({
      localPath: '/tmp/claude/test-repo',
      headSha: 'abc123def456',
    }),
    scanCodeFiles: () => [],
  };
});

describe('Schema constraints', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
  });

  describe('project_dependencies self-reference check', () => {
    it('rejects self-referencing project dependency', async () => {
      // Create a project
      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test-project', 'test-org', $1) RETURNING id`,
        [user.id]
      );

      // Create a repo
      const { rows: [repo] } = await ctx.pool.query(
        `INSERT INTO repositories (repo_url, github_org, repo_name, repo_path)
         VALUES ('https://github.com/test-org/repo', 'test-org', 'repo', 'test-org/repo')
         RETURNING id`
      );

      // Attempt to insert a self-referencing dependency (linked_project_id = project_id)
      await expect(
        ctx.pool.query(
          `INSERT INTO project_dependencies (project_id, repo_id, name, ecosystem, linked_project_id)
           VALUES ($1, $2, 'self-dep', 'npm', $1)`,
          [project.id, repo.id]
        )
      ).rejects.toThrow(/chk_no_self_reference/);
    });

    it('allows dependency linking to a different project', async () => {
      const user = await createTestUser(ctx.pool);
      const { rows: [project1] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('project-1', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [project2] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('project-2', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [repo] } = await ctx.pool.query(
        `INSERT INTO repositories (repo_url, github_org, repo_name, repo_path)
         VALUES ('https://github.com/test-org/repo', 'test-org', 'repo', 'test-org/repo')
         RETURNING id`
      );

      // Should succeed — linking to a different project is allowed
      const { rows } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, ecosystem, linked_project_id)
         VALUES ($1, $2, 'other-dep', 'npm', $3)
         RETURNING id`,
        [project1.id, repo.id, project2.id]
      );
      expect(rows).toHaveLength(1);
    });

    it('allows dependency with null linked_project_id', async () => {
      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test-project', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [repo] } = await ctx.pool.query(
        `INSERT INTO repositories (repo_url, github_org, repo_name, repo_path)
         VALUES ('https://github.com/test-org/repo', 'test-org', 'repo', 'test-org/repo')
         RETURNING id`
      );

      // Should succeed — null linked_project_id is allowed
      const { rows } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, ecosystem)
         VALUES ($1, $2, 'express', 'npm')
         RETURNING id`,
        [project.id, repo.id]
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('audit_commits NOT NULL constraints', () => {
    it('rejects audit_commit with null repo_id', async () => {
      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, audit_level, status) VALUES ($1, 'full', 'pending') RETURNING id`,
        [project.id]
      );

      // Attempt to insert with null repo_id — should fail
      await expect(
        ctx.pool.query(
          `INSERT INTO audit_commits (audit_id, repo_id, commit_sha, branch) VALUES ($1, NULL, 'abc123', 'main')`,
          [audit.id]
        )
      ).rejects.toThrow(/not-null|null value/i);
    });
  });
});
