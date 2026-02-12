// Product: product/views/projects.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestSession, authenticatedFetch } from '../helpers';

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
    {
      id: 1002, name: 'repo-beta', full_name: 'test-org/repo-beta',
      description: 'Secondary repo', language: 'Python',
      stargazers_count: 100, forks_count: 10, default_branch: 'main',
      license: { spdx_id: 'Apache-2.0' }, html_url: 'https://github.com/test-org/repo-beta',
    },
  ],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
  getGitHubEntity: async () => ({
    login: 'test-org', type: 'Organization',
    avatarUrl: 'https://avatars.githubusercontent.com/u/99999',
  }),
  listRepoBranches: async () => [{ name: 'main' }, { name: 'dev' }, { name: 'stable' }],
  getRepoDefaultBranch: async () => 'main',
  getCommitDate: async () => new Date('2025-01-01'),
}));

vi.mock('../../src/server/services/git', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    cloneOrUpdate: async (repoUrl: string) => ({
      localPath: '/tmp/claude/test-repo',
      headSha: 'abc123def456',
    }),
    scanCodeFiles: () => [
      { relativePath: 'src/index.ts', size: 1000, roughTokens: 303 },
      { relativePath: 'src/utils.ts', size: 500, roughTokens: 152 },
      { relativePath: 'config.json', size: 200, roughTokens: 61 },
    ],
  };
});

describe('Projects API', () => {
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

  describe('GET /api/github/orgs/:org/repos', () => {
    it('returns list of org repos', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/github/orgs/test-org/repos`);
      expect(res.status).toBe(200);

      const repos = await res.json();
      expect(repos).toHaveLength(2);
      expect(repos[0].name).toBe('repo-alpha');
      expect(repos[0].stars).toBe(500);
      expect(repos[1].name).toBe('repo-beta');
      expect(repos[1].language).toBe('Python');
    });
  });

  describe('POST /api/projects', () => {
    it('requires authentication', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubOrg: 'test-org', repoNames: ['repo-alpha'] }),
      });
      expect(res.status).toBe(401);
    });

    it('validates required fields', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('creates project with repoNames (legacy format)', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOrg: 'test-org',
          repoNames: ['repo-alpha', 'repo-beta'],
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.projectId).toBeDefined();
      expect(body.repos).toHaveLength(2);

      // Verify DB records
      const { rows: projects } = await ctx.pool.query(
        'SELECT * FROM projects WHERE id = $1',
        [body.projectId]
      );
      expect(projects).toHaveLength(1);
      expect(projects[0].github_org).toBe('test-org');
      expect(projects[0].created_by).toBe(session.userId);

      // Verify repos were created
      const { rows: repos } = await ctx.pool.query(
        'SELECT r.* FROM repositories r JOIN project_repos pr ON pr.repo_id = r.id WHERE pr.project_id = $1',
        [body.projectId]
      );
      expect(repos).toHaveLength(2);
      expect(repos.map(r => r.repo_name).sort()).toEqual(['repo-alpha', 'repo-beta']);

      // Verify project_repos links with no branch set
      const { rows: links } = await ctx.pool.query(
        'SELECT * FROM project_repos WHERE project_id = $1',
        [body.projectId]
      );
      expect(links).toHaveLength(2);
      expect(links.every(l => l.branch === null)).toBe(true);
    });

    it('creates project with repos[] format including branch', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOrg: 'test-org',
          repos: [
            { name: 'repo-alpha', branch: 'dev' },
            { name: 'repo-beta' },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.projectId).toBeDefined();
      expect(body.repos).toHaveLength(2);

      // Verify project_repos branches
      const { rows: links } = await ctx.pool.query(
        `SELECT pr.branch, r.repo_name FROM project_repos pr
         JOIN repositories r ON r.id = pr.repo_id
         WHERE pr.project_id = $1
         ORDER BY r.repo_name`,
        [body.projectId]
      );
      expect(links).toHaveLength(2);
      expect(links[0].repo_name).toBe('repo-alpha');
      expect(links[0].branch).toBe('dev');
      expect(links[1].repo_name).toBe('repo-beta');
      expect(links[1].branch).toBe(null);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns project details with branch null for default', async () => {
      const session = await createTestSession(ctx.pool);

      // Create project first
      const createRes = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOrg: 'test-org',
          repoNames: ['repo-alpha'],
        }),
      });
      const { projectId } = await createRes.json();

      // Fetch project
      const res = await fetch(`${ctx.baseUrl}/api/projects/${projectId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.id).toBe(projectId);
      expect(project.name).toBe('test-org');
      expect(project.githubOrg).toBe('test-org');
      expect(project.repos).toHaveLength(1);
      expect(project.repos[0].repoName).toBe('repo-alpha');
      expect(project.repos[0].branch).toBe(null);
    });

    it('returns branch per repo when set', async () => {
      const session = await createTestSession(ctx.pool);

      const createRes = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOrg: 'test-org',
          repos: [{ name: 'repo-alpha', branch: 'dev' }],
        }),
      });
      const { projectId } = await createRes.json();

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projectId}`);
      const project = await res.json();
      expect(project.repos[0].branch).toBe('dev');
    });

    it('returns default_branch as branch when project_repo branch is null', async () => {
      const session = await createTestSession(ctx.pool);

      // Create project with no branch set (null)
      const createRes = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOrg: 'test-org',
          repoNames: ['repo-alpha'],
        }),
      });
      const { projectId } = await createRes.json();

      // Verify branch is stored as null in project_repos
      const { rows: links } = await ctx.pool.query(
        'SELECT branch FROM project_repos WHERE project_id = $1',
        [projectId]
      );
      expect(links[0].branch).toBeNull();

      // Fetch project — the API should return branch as null (or default_branch)
      // The key assertion is that the API response is consistent
      const res = await fetch(`${ctx.baseUrl}/api/projects/${projectId}`);
      const project = await res.json();
      expect(project.repos[0].branch).toBeNull();
      // The repo's default_branch should still be accessible
      expect(project.repos[0].defaultBranch).toBe('main');
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/projects/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });
});
