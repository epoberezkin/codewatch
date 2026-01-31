import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// Hoisted mutable state for configurable GitHub ownership mock
const mockGitHubState = vi.hoisted(() => ({
  ownershipResult: { isOwner: true } as { isOwner: boolean; role?: string; needsReauth?: boolean },
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
    {
      id: 1002, name: 'repo-beta', full_name: 'test-org/repo-beta',
      description: 'Secondary repo', language: 'Python',
      stargazers_count: 100, forks_count: 10, default_branch: 'main',
      license: { spdx_id: 'Apache-2.0' }, html_url: 'https://github.com/test-org/repo-beta',
    },
  ],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => mockGitHubState.ownershipResult,
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
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
      { relativePath: 'src/utils.ts', size: 500, roughTokens: 152 },
    ],
  };
});

// Mock audit service
vi.mock('../../src/server/services/audit', () => ({
  runAudit: async () => {},
}));

describe('Project Pages', () => {
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
  });

  // Helper: create a project via API
  async function createProject(session: { cookie: string; userId: string }, org = 'test-org'): Promise<string> {
    const res = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ githubOrg: org, repoNames: ['repo-alpha'] }),
    });
    const body = await res.json();
    return body.projectId;
  }

  // Helper: insert a completed audit
  async function insertAudit(
    projectId: string,
    requesterId: string,
    opts?: { isPublic?: boolean; maxSeverity?: string; auditLevel?: string }
  ): Promise<string> {
    const isPublic = opts?.isPublic ?? false;
    const maxSeverity = opts?.maxSeverity ?? 'high';
    const auditLevel = opts?.auditLevel ?? 'full';

    const { rows } = await ctx.pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, max_severity, is_public,
         report_summary, completed_at)
       VALUES ($1, $2, $3, 'completed', true, $4, $5, $6, NOW())
       RETURNING id`,
      [projectId, requesterId, auditLevel, maxSeverity,  isPublic,
        JSON.stringify({ executive_summary: 'Test summary', security_posture: 'OK', responsible_disclosure: {} })]
    );
    return rows[0].id;
  }

  // Helper: insert a finding
  async function insertFinding(auditId: string, severity = 'high'): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO audit_findings (audit_id, severity, title, description, exploitation, recommendation, file_path, line_start)
       VALUES ($1, $2, 'Test Finding', 'Description', 'Exploit', 'Fix', 'src/index.ts', 42)
       RETURNING id`,
      [auditId, severity]
    );
    return rows[0].id;
  }

  // Helper: set project category
  async function setProjectCategory(projectId: string, category: string) {
    await ctx.pool.query('UPDATE projects SET category = $1 WHERE id = $2', [category, projectId]);
  }

  // ============================================================
  // GET /api/projects/browse
  // ============================================================

  describe('GET /api/projects/browse', () => {
    it('returns only projects with public audits', async () => {
      const session = await createTestSession(ctx.pool);
      const projPublic = await createProject(session);
      const projPrivate = await createProject(session);

      // Create public audit on projPublic
      await insertAudit(projPublic, session.userId, { isPublic: true, maxSeverity: 'high' });
      // Create private audit on projPrivate
      await insertAudit(projPrivate, session.userId, { isPublic: false });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse`);
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(projPublic);
    });

    it('returns empty list when no public audits exist', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);
      // Create only private audit
      await insertAudit(projId, session.userId, { isPublic: false });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse`);
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(0);
    });

    it('filters by category', async () => {
      const session = await createTestSession(ctx.pool);
      const proj1 = await createProject(session);
      const proj2 = await createProject(session);

      await setProjectCategory(proj1, 'library');
      await setProjectCategory(proj2, 'cli_tool');

      await insertAudit(proj1, session.userId, { isPublic: true });
      await insertAudit(proj2, session.userId, { isPublic: true });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse?category=library`);
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].category).toBe('library');
    });

    it('filters by search term on name and org', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session, 'test-org');

      // Set a unique name for searching
      await ctx.pool.query('UPDATE projects SET name = $1 WHERE id = $2', ['UniqueSearchName', projId]);
      await insertAudit(projId, session.userId, { isPublic: true });

      // Search by name
      const res = await fetch(`${ctx.baseUrl}/api/projects/browse?search=UniqueSearch`);
      expect(res.status).toBe(200);
      const projects = await res.json();
      expect(projects).toHaveLength(1);

      // Search by org
      const res2 = await fetch(`${ctx.baseUrl}/api/projects/browse?search=test-org`);
      expect(res2.status).toBe(200);
      const projects2 = await res2.json();
      expect(projects2).toHaveLength(1);

      // Search with no match
      const res3 = await fetch(`${ctx.baseUrl}/api/projects/browse?search=nonexistent`);
      expect(res3.status).toBe(200);
      const projects3 = await res3.json();
      expect(projects3).toHaveLength(0);
    });

    it('filters by severity', async () => {
      const session = await createTestSession(ctx.pool);
      const proj1 = await createProject(session);
      const proj2 = await createProject(session);

      await insertAudit(proj1, session.userId, { isPublic: true, maxSeverity: 'critical' });
      await insertAudit(proj2, session.userId, { isPublic: true, maxSeverity: 'low' });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse?severity=critical`);
      expect(res.status).toBe(200);
      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(proj1);
    });

    it('mine=true requires auth', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/projects/browse?mine=true`);
      expect(res.status).toBe(401);
    });

    it('mine=true returns all user projects regardless of public status', async () => {
      const session = await createTestSession(ctx.pool);
      const proj1 = await createProject(session);
      const proj2 = await createProject(session);

      // proj1 has public audit, proj2 has only private audit
      await insertAudit(proj1, session.userId, { isPublic: true });
      await insertAudit(proj2, session.userId, { isPublic: false });

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/browse?mine=true`, session.cookie
      );
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(2);
    });

    it('mine=true includes ownership badges', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);
      await insertAudit(projId, session.userId, { isPublic: true });

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/browse?mine=true`, session.cookie
      );
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].ownership).toBeDefined();
      expect(projects[0].ownership.isOwner).toBe(true);
    });

    it('includes license from repositories', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      // Set license on the repository (POST /api/projects doesn't fetch GitHub metadata)
      await ctx.pool.query(
        `UPDATE repositories SET license = 'MIT' WHERE id IN (
          SELECT repo_id FROM project_repos WHERE project_id = $1
        )`, [projId]
      );

      await insertAudit(projId, session.userId, { isPublic: true });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse`);
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].license).toBe('MIT');
    });

    it('includes latestPublicSeverity and publicAuditCount', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      await insertAudit(projId, session.userId, { isPublic: true, maxSeverity: 'critical' });
      await insertAudit(projId, session.userId, { isPublic: true, maxSeverity: 'low' });
      await insertAudit(projId, session.userId, { isPublic: false, maxSeverity: 'high' });

      const res = await fetch(`${ctx.baseUrl}/api/projects/browse`);
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].publicAuditCount).toBe(2);
      // latestPublicSeverity should be from the most recent public audit
      expect(projects[0].latestPublicSeverity).toBeTruthy();
    });

    it('mine=true does not include other users projects', async () => {
      const session1 = await createTestSession(ctx.pool);
      const session2 = await createTestSession(ctx.pool);

      const proj1 = await createProject(session1);
      const proj2 = await createProject(session2);

      await insertAudit(proj1, session1.userId, { isPublic: true });
      await insertAudit(proj2, session2.userId, { isPublic: true });

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/browse?mine=true`, session1.cookie
      );
      expect(res.status).toBe(200);

      const projects = await res.json();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(proj1);
    });
  });

  // ============================================================
  // GET /api/projects/:id (detail with audits, license, ownership)
  // ============================================================

  describe('GET /api/projects/:id (detail)', () => {
    it('returns project metadata including license', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      // Set license on the repository (POST /api/projects doesn't fetch GitHub metadata)
      await ctx.pool.query(
        `UPDATE repositories SET license = 'MIT' WHERE id IN (
          SELECT repo_id FROM project_repos WHERE project_id = $1
        )`, [projId]
      );

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.id).toBe(projId);
      expect(project.githubOrg).toBe('test-org');
      expect(project.license).toBe('MIT');
      expect(project.repos).toHaveLength(1);
      expect(project.repos[0].license).toBe('MIT');
    });

    it('returns ownership for authenticated user', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/${projId}`, session.cookie
      );
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.ownership).toBeDefined();
      expect(project.ownership.isOwner).toBe(true);
    });

    it('returns null ownership for anonymous user', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.ownership).toBeNull();
    });

    it('returns audits with severity counts', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);
      const auditId = await insertAudit(projId, session.userId, { isPublic: true, maxSeverity: 'high' });
      await insertFinding(auditId, 'high');
      await insertFinding(auditId, 'high');
      await insertFinding(auditId, 'medium');

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/${projId}`, session.cookie
      );
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.audits).toHaveLength(1);
      expect(project.audits[0].severityCounts.high).toBe(2);
      expect(project.audits[0].severityCounts.medium).toBe(1);
    });

    it('owner sees all audits including non-public', async () => {
      const session = await createTestSession(ctx.pool);
      const otherSession = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      await insertAudit(projId, session.userId, { isPublic: true });
      await insertAudit(projId, otherSession.userId, { isPublic: false });

      // Owner should see both
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/${projId}`, session.cookie
      );
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.audits).toHaveLength(2);
    });

    it('anonymous user sees only public audits', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      await insertAudit(projId, session.userId, { isPublic: true });
      await insertAudit(projId, session.userId, { isPublic: false });

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.audits).toHaveLength(1);
      expect(project.audits[0].isPublic).toBe(true);
    });

    it('non-owner authenticated user sees public audits plus own audits', async () => {
      const owner = await createTestSession(ctx.pool);
      const other = await createTestSession(ctx.pool);
      const projId = await createProject(owner);

      await insertAudit(projId, owner.userId, { isPublic: true });
      await insertAudit(projId, owner.userId, { isPublic: false });
      await insertAudit(projId, other.userId, { isPublic: false });

      // non-owner should see: 1 public + 1 own = 2
      mockGitHubState.ownershipResult = { isOwner: false };
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/${projId}`, other.cookie
      );
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.audits).toHaveLength(2);
    });

    it('returns threat model and involved parties', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      // Set threat model data
      const involvedParties = {
        vendor: { can: 'Access servers', cannot: 'Read messages' },
        users: { can: 'Send messages', cannot: 'Impersonate others' },
      };
      await ctx.pool.query(
        `UPDATE projects SET category = 'library', threat_model = $1, threat_model_source = 'repo',
         involved_parties = $2 WHERE id = $3`,
        ['Security assessment text', JSON.stringify(involvedParties), projId]
      );

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.category).toBe('library');
      expect(project.threatModel).toBe('Security assessment text');
      expect(project.threatModelSource).toBe('repo');
      expect(project.involvedParties).toBeDefined();
      expect(project.involvedParties.vendor.can).toBe('Access servers');
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/projects/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });

    it('includes createdBy and creatorUsername', async () => {
      const user = await createTestUser(ctx.pool, { username: 'detailuser' });
      const session = await createTestSession(ctx.pool, user.id);
      const projId = await createProject(session);

      const res = await fetch(`${ctx.baseUrl}/api/projects/${projId}`);
      expect(res.status).toBe(200);

      const project = await res.json();
      expect(project.createdBy).toBe(user.id);
      expect(project.creatorUsername).toBe('detailuser');
    });

    it('audits include isPublic field', async () => {
      const session = await createTestSession(ctx.pool);
      const projId = await createProject(session);

      await insertAudit(projId, session.userId, { isPublic: true });
      await insertAudit(projId, session.userId, { isPublic: false });

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects/${projId}`, session.cookie
      );
      expect(res.status).toBe(200);

      const project = await res.json();
      const publicAudit = project.audits.find((a: any) => a.isPublic);
      const privateAudit = project.audits.find((a: any) => !a.isPublic);
      expect(publicAudit).toBeDefined();
      expect(privateAudit).toBeDefined();
    });
  });
});
