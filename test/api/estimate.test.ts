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
  listOrgRepos: async () => [],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
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
      { relativePath: 'src/index.ts', size: 3300, roughTokens: 1000 },
      { relativePath: 'src/auth.ts', size: 6600, roughTokens: 2000 },
      { relativePath: 'src/routes/api.ts', size: 9900, roughTokens: 3000 },
      { relativePath: 'src/utils.ts', size: 1650, roughTokens: 500 },
      { relativePath: 'config.json', size: 330, roughTokens: 100 },
      { relativePath: 'package.json', size: 660, roughTokens: 200 },
    ],
  };
});

describe('Estimation API', () => {
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

  async function createProject(): Promise<string> {
    const session = await createTestSession(ctx.pool);
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubOrg: 'test-org',
        repoNames: ['repo-alpha'],
      }),
    });
    const body = await res.json();
    return body.projectId;
  }

  describe('POST /api/estimate', () => {
    it('requires projectId', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns rough estimate with 3 levels', async () => {
      const projectId = await createProject();

      const res = await fetch(`${ctx.baseUrl}/api/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.isPrecise).toBe(false);
      expect(data.totalFiles).toBe(6);
      expect(data.totalTokens).toBe(6800); // sum of rough tokens

      // Full should cover all files
      expect(data.estimates.full.files).toBe(6);
      expect(data.estimates.full.tokens).toBe(6800);
      expect(data.estimates.full.costUsd).toBeGreaterThan(0);

      // Thorough covers ~33%
      expect(data.estimates.thorough.files).toBe(2); // ceil(6 * 0.33) = 2
      expect(data.estimates.thorough.tokens).toBeLessThan(data.estimates.full.tokens);
      expect(data.estimates.thorough.costUsd).toBeLessThan(data.estimates.full.costUsd);

      // Opportunistic covers ~10%
      expect(data.estimates.opportunistic.files).toBe(1); // ceil(6 * 0.10) = 1
      expect(data.estimates.opportunistic.tokens).toBeLessThan(data.estimates.thorough.tokens);
      expect(data.estimates.opportunistic.costUsd).toBeLessThan(data.estimates.thorough.costUsd);

      // Repo breakdown should be present
      expect(data.repoBreakdown).toBeDefined();
      expect(data.repoBreakdown).toHaveLength(1);
      expect(data.repoBreakdown[0].repoName).toBe('repo-alpha');
    });

    it('updates project stats in DB', async () => {
      const projectId = await createProject();

      await fetch(`${ctx.baseUrl}/api/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });

      const { rows } = await ctx.pool.query(
        'SELECT total_files, total_tokens FROM projects WHERE id = $1',
        [projectId]
      );
      expect(rows[0].total_files).toBe(6);
      expect(rows[0].total_tokens).toBe(6800);
    });

    it('cost estimates include planning overhead', async () => {
      const projectId = await createProject();

      const res = await fetch(`${ctx.baseUrl}/api/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();

      // Planning uses Sonnet 4.5 ($3/$15 per Mtok) on total tokens (6800)
      // planInput = round(6800*0.05) + 3000 = 3340
      // planOutput = max(50, round(6800/300)*50) = max(50, 1150) = 1150
      // planningCost ≈ (3340/1M)*3 + (1150/1M)*15 ≈ 0.0273
      // This overhead is the same for all levels (planning always covers all files)

      // Verify planning overhead makes opportunistic cost > 0.02
      // (without planning, opportunistic on 680 tokens would cost ~0.01)
      expect(data.estimates.opportunistic.costUsd).toBeGreaterThan(0.02);

      // Verify all levels still maintain correct ordering
      // (full > thorough > opportunistic, since analysis cost varies but planning is constant)
      expect(data.estimates.full.costUsd).toBeGreaterThan(data.estimates.thorough.costUsd);
      expect(data.estimates.thorough.costUsd).toBeGreaterThan(data.estimates.opportunistic.costUsd);
    });

    it('returns previousAudit when one exists', async () => {
      const projectId = await createProject();

      // Insert a completed audit
      await ctx.pool.query(
        `INSERT INTO audits (project_id, audit_level, status, max_severity, completed_at)
         VALUES ($1, 'full', 'completed', 'medium', NOW())`,
        [projectId]
      );

      const res = await fetch(`${ctx.baseUrl}/api/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();

      expect(data.previousAudit).toBeDefined();
      expect(data.previousAudit.level).toBe('full');
      expect(data.previousAudit.maxSeverity).toBe('medium');
    });
  });
});
