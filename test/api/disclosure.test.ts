// Product: product/flows/responsible-disclosure.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// Hoisted mutable state for configurable GitHub ownership mock
const mockGitHubState = vi.hoisted(() => ({
  ownershipResult: { isOwner: true } as { isOwner: boolean; role?: string; needsReauth?: boolean },
  issueCreated: false,
  issueTitle: '',
  issueBody: '',
}));

// Mock GitHub service
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
  checkGitHubOwnership: async () => mockGitHubState.ownershipResult,
  createIssue: async (_token: string, _owner: string, _repo: string, title: string, body: string) => {
    mockGitHubState.issueCreated = true;
    mockGitHubState.issueTitle = title;
    mockGitHubState.issueBody = body;
    return { html_url: 'https://github.com/test-org/repo-alpha/issues/1' };
  },
  getGitHubEntity: async () => ({
    login: 'test-org', type: 'Organization',
    avatarUrl: 'https://avatars.githubusercontent.com/u/99999',
  }),
  listRepoBranches: async () => [{ name: 'main' }, { name: 'dev' }],
  getRepoDefaultBranch: async () => 'main',
  getCommitDate: async () => new Date('2025-01-01'),
}));

// Mock git service
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

// Mock audit service
vi.mock('../../src/server/services/audit', () => ({
  runAudit: async () => {},
}));

describe('Responsible Disclosure', () => {
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
    mockGitHubState.issueCreated = false;
    mockGitHubState.issueTitle = '';
    mockGitHubState.issueBody = '';
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

  // Helper: insert a completed audit with findings
  async function insertAudit(
    projectId: string,
    requesterId: string,
    opts?: { isOwner?: boolean; maxSeverity?: string; reportSummary?: object }
  ): Promise<string> {
    const isOwner = opts?.isOwner ?? false;
    const maxSeverity = opts?.maxSeverity ?? 'high';
    const reportSummary = opts?.reportSummary ?? {
      executive_summary: 'Test summary',
      security_posture: 'Needs improvement',
      responsible_disclosure: {},
    };

    const { rows } = await ctx.pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, max_severity, report_summary)
       VALUES ($1, $2, 'full', 'completed', $3, $4, $5)
       RETURNING id`,
      [projectId, requesterId, isOwner, maxSeverity, JSON.stringify(reportSummary)]
    );
    return rows[0].id;
  }

  // Helper: insert a finding
  async function insertFinding(
    auditId: string,
    severity = 'high',
    title = 'Test Finding'
  ): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO audit_findings (audit_id, severity, title, description, exploitation, recommendation, code_snippet, file_path, line_start)
       VALUES ($1, $2, $3, 'Detailed description of the vulnerability', 'How to exploit it', 'How to fix it', 'const x = eval(input)', 'src/index.ts', 42)
       RETURNING id`,
      [auditId, severity, title]
    );
    return rows[0].id;
  }

  // ============================================================
  // POST /api/audit/:id/notify-owner
  // ============================================================

  describe('POST /api/audit/:id/notify-owner', () => {
    it('requester can notify owner', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'high' });
      await insertFinding(auditId, 'high');

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.publishableAfter).toBeTruthy();

      // Verify DB state
      const { rows } = await ctx.pool.query(
        'SELECT owner_notified, owner_notified_at, publishable_after FROM audits WHERE id = $1',
        [auditId]
      );
      expect(rows[0].owner_notified).toBe(true);
      expect(rows[0].owner_notified_at).toBeTruthy();
      expect(rows[0].publishable_after).toBeTruthy();
    });

    it('creates GitHub issue on notification', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'high' });
      await insertFinding(auditId, 'high');
      await insertFinding(auditId, 'medium');

      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });

      expect(mockGitHubState.issueCreated).toBe(true);
      expect(mockGitHubState.issueTitle).toContain('[CodeWatch]');
      expect(mockGitHubState.issueTitle).toContain('2 findings');
      expect(mockGitHubState.issueBody).toContain('responsible disclosure');
    });

    it('sets publishable_after based on max severity — critical = 6 months', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'critical' });
      await insertFinding(auditId, 'critical');

      const before = Date.now();
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      const body = await res.json();

      const publishDate = new Date(body.publishableAfter).getTime();
      const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
      // Should be approximately 6 months from now (within 10 seconds tolerance)
      expect(publishDate).toBeGreaterThan(before + sixMonthsMs - 10000);
      expect(publishDate).toBeLessThan(before + sixMonthsMs + 10000);
    });

    it('sets publishable_after based on max severity — high = 3 months', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'high' });

      const before = Date.now();
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      const body = await res.json();

      const publishDate = new Date(body.publishableAfter).getTime();
      const threeMonthsMs = 3 * 30 * 24 * 60 * 60 * 1000;
      expect(publishDate).toBeGreaterThan(before + threeMonthsMs - 10000);
      expect(publishDate).toBeLessThan(before + threeMonthsMs + 10000);
    });

    it('sets no publishable_after for low severity', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'low' });

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.publishableAfter).toBeNull();
    });

    it('notification is idempotent', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'high' });

      // First notification
      const res1 = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();

      // Reset to track if GitHub is called again
      mockGitHubState.issueCreated = false;

      // Second notification — should be idempotent
      const res2 = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);
      expect(body2.alreadyNotified).toBe(true);

      // GitHub issue should NOT be created again
      expect(mockGitHubState.issueCreated).toBe(false);
    });

    it('non-requester cannot notify', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const otherUser = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, otherUser.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(403);
    });

    it('unauthenticated request returns 401', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);

      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // Three-tier report access
  // ============================================================

  describe('Three-tier report access', () => {
    it('owner sees all findings via resolveOwnership (Tier 1)', async () => {
      const owner = await createTestSession(ctx.pool);
      const requester = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);
      await insertFinding(auditId, 'high', 'SQL Injection in login');

      mockGitHubState.ownershipResult = { isOwner: true };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, owner.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('owner');
      expect(body.isOwner).toBe(true);
      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].description).toBe('Detailed description of the vulnerability');
      expect(body.findings[0].exploitation).toBe('How to exploit it');
      expect(body.findings[0].recommendation).toBe('How to fix it');
      expect(body.findings[0].codeSnippet).toBe('const x = eval(input)');
      expect(body.findings[0].filePath).toBe('src/index.ts');
      expect(body.redactionNotice).toBeNull();
    });

    it('non-owner requester sees redacted findings list (Tier 2)', async () => {
      const owner = await createTestSession(ctx.pool);
      const requester = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);
      await insertFinding(auditId, 'high', 'SQL Injection in login');

      // Requester is not the owner
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, requester.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('requester');
      expect(body.isRequester).toBe(true);
      expect(body.findings).toHaveLength(1);

      // Visible fields for medium+ in Tier 2
      expect(body.findings[0].severity).toBe('high');
      expect(body.findings[0].status).toBe('open');

      // Redacted fields (title is also redacted for medium+ in Tier 2)
      expect(body.findings[0].title).toBeNull();
      expect(body.findings[0].description).toBeNull();
      expect(body.findings[0].exploitation).toBeNull();
      expect(body.findings[0].recommendation).toBeNull();
      expect(body.findings[0].codeSnippet).toBeNull();
      expect(body.findings[0].filePath).toBeNull();
      expect(body.findings[0].lineStart).toBeNull();
      expect(body.findings[0].lineEnd).toBeNull();
    });

    it('requester redaction notice explains contribution to project security', async () => {
      const owner = await createTestSession(ctx.pool);
      const requester = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);
      await insertFinding(auditId, 'high');

      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, requester.cookie);
      const body = await res.json();

      expect(body.redactionNotice).toContain('supporting the security');
      expect(body.redactionNotice).toContain('responsible disclosure');
    });

    it('anonymous user sees summary only (Tier 3)', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);
      await insertFinding(auditId, 'high', 'SQL Injection');
      await insertFinding(auditId, 'medium', 'XSS Vulnerability');

      // Anonymous (no session cookie)
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('public');
      expect(body.findings).toHaveLength(0);
      expect(body.severityCounts).toEqual({ high: 1, medium: 1 });
      expect(body.redactionNotice).toContain('Only project owners');
    });

    it('other authenticated user sees summary only (Tier 3)', async () => {
      const owner = await createTestSession(ctx.pool);
      const otherUser = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);
      await insertFinding(auditId, 'high');

      // Other user is not owner and not requester
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, otherUser.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('public');
      expect(body.findings).toHaveLength(0);
      expect(body.isOwner).toBe(false);
      expect(body.isRequester).toBe(false);
    });

    it('all users see full findings after publishable_after (lazy auto-publish)', async () => {
      const owner = await createTestSession(ctx.pool);
      const requester = await createTestSession(ctx.pool);
      const otherUser = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);
      await insertFinding(auditId, 'high', 'SQL Injection');

      // Set publishable_after to the past (simulating expired timer)
      await ctx.pool.query(
        `UPDATE audits SET owner_notified = TRUE, owner_notified_at = NOW() - INTERVAL '4 months',
         publishable_after = NOW() - INTERVAL '1 minute'
         WHERE id = $1`,
        [auditId]
      );

      // Other user (not owner, not requester) should now see full findings
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, otherUser.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('owner'); // Full access via auto-publish
      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].description).toBe('Detailed description of the vulnerability');
      expect(body.findings[0].filePath).toBe('src/index.ts');
    });

    it('all users see full findings when is_public', async () => {
      const owner = await createTestSession(ctx.pool);
      const otherUser = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId);
      await insertFinding(auditId, 'high', 'SQL Injection');

      // Publish the report
      await ctx.pool.query('UPDATE audits SET is_public = TRUE WHERE id = $1', [auditId]);

      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, otherUser.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.accessTier).toBe('owner'); // Full access via is_public
      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].description).toBeTruthy();
    });

    it('publishable_after is NULL when audit completes (not set at synthesis)', async () => {
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, owner.userId, { maxSeverity: 'critical' });

      // Verify that a newly completed audit has no publishable_after
      const { rows } = await ctx.pool.query(
        'SELECT publishable_after, owner_notified FROM audits WHERE id = $1',
        [auditId]
      );
      expect(rows[0].publishable_after).toBeNull();
      expect(rows[0].owner_notified).toBe(false);
    });
  });

  // ============================================================
  // Report response fields
  // ============================================================

  describe('Report response fields', () => {
    it('includes isRequester, ownerNotified, accessTier fields', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId);

      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, requester.cookie);
      const body = await res.json();

      expect(body).toHaveProperty('isRequester');
      expect(body).toHaveProperty('ownerNotified');
      expect(body).toHaveProperty('ownerNotifiedAt');
      expect(body).toHaveProperty('accessTier');
      expect(body).toHaveProperty('redactionNotice');
      expect(body.isRequester).toBe(true);
      expect(body.ownerNotified).toBe(false);
      expect(body.ownerNotifiedAt).toBeNull();
    });

    it('includes ownerNotifiedAt after notification', async () => {
      const requester = await createTestSession(ctx.pool);
      const owner = await createTestSession(ctx.pool);
      const projectId = await createProject(owner);
      const auditId = await insertAudit(projectId, requester.userId, { maxSeverity: 'high' });

      // Notify
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/notify-owner`, requester.cookie, {
        method: 'POST',
      });

      // Check report includes notification data
      mockGitHubState.ownershipResult = { isOwner: false };

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/report`, requester.cookie);
      const body = await res.json();

      expect(body.ownerNotified).toBe(true);
      expect(body.ownerNotifiedAt).toBeTruthy();
      expect(body.publishableAfter).toBeTruthy();
    });
  });
});
