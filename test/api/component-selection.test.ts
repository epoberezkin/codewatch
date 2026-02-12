// Product: product/flows/component-analysis.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

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

describe('Component selection & supply chain', () => {
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

  // Helper: create project with repos and components
  async function createProjectWithComponents(): Promise<{
    projectId: string;
    repoId: string;
    session: { sessionId: string; userId: string; cookie: string };
    componentIds: string[];
  }> {
    const user = await createTestUser(ctx.pool);
    const session = await createTestSession(ctx.pool, user.id);

    // Create project
    const { rows: [project] } = await ctx.pool.query(
      `INSERT INTO projects (name, github_org, created_by)
       VALUES ('test-project', 'test-org', $1) RETURNING id`,
      [user.id]
    );

    // Create repo
    const { rows: [repo] } = await ctx.pool.query(
      `INSERT INTO repositories (repo_url, repo_name, github_org, repo_path, github_id)
       VALUES ('https://github.com/test-org/test-repo', 'test-repo', 'test-org', 'test-org/test-repo', $1)
       RETURNING id`,
      [Math.floor(Math.random() * 100000)]
    );

    await ctx.pool.query(
      `INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`,
      [project.id, repo.id]
    );

    // Create two components
    const { rows: [comp1] } = await ctx.pool.query(
      `INSERT INTO components (project_id, repo_id, name, description, role, file_patterns, languages, estimated_files, estimated_tokens)
       VALUES ($1, $2, 'Auth Module', 'Handles authentication', 'server', $3, $4, 2, 3000)
       RETURNING id`,
      [project.id, repo.id, ['src/auth/**', 'src/routes/**'], ['TypeScript']]
    );

    const { rows: [comp2] } = await ctx.pool.query(
      `INSERT INTO components (project_id, repo_id, name, description, role, file_patterns, languages, estimated_files, estimated_tokens)
       VALUES ($1, $2, 'Utilities', 'Shared utility functions', 'library', $3, $4, 1, 500)
       RETURNING id`,
      [project.id, repo.id, ['src/utils.*'], ['TypeScript']]
    );

    return {
      projectId: project.id,
      repoId: repo.id,
      session,
      componentIds: [comp1.id, comp2.id],
    };
  }

  // ============================================================
  // POST /api/estimate/components
  // ============================================================

  describe('POST /api/estimate/components', () => {
    it('returns scoped cost estimates for selected components', async () => {
      const { projectId, componentIds } = await createProjectWithComponents();

      // Select only the first component (3000 tokens)
      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, componentIds: [componentIds[0]], totalTokens: 3500 }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.totalFiles).toBe(2);
      expect(data.totalTokens).toBe(3000);
      expect(data.estimates.full.tokens).toBe(3000);
      expect(data.estimates.thorough.tokens).toBeLessThan(3000);
      expect(data.estimates.opportunistic.tokens).toBeLessThan(data.estimates.thorough.tokens);
      expect(data.estimates.full.costUsd).toBeGreaterThan(0);
    });

    it('returns zero estimates for empty component selection', async () => {
      const { projectId } = await createProjectWithComponents();

      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, componentIds: [], totalTokens: 3500 }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.totalFiles).toBe(0);
      expect(data.totalTokens).toBe(0);
      expect(data.estimates.full.costUsd).toBe(0);
      expect(data.estimates.thorough.costUsd).toBe(0);
      expect(data.estimates.opportunistic.costUsd).toBe(0);
    });

    it('returns full project estimate when all components selected', async () => {
      const { projectId, componentIds } = await createProjectWithComponents();

      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, componentIds, totalTokens: 3500 }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      // Both components: 3000 + 500 = 3500 tokens
      expect(data.totalTokens).toBe(3500);
      expect(data.totalFiles).toBe(3); // 2 + 1
    });

    it('rejects invalid componentIds for the project', async () => {
      const { projectId } = await createProjectWithComponents();

      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          componentIds: ['00000000-0000-0000-0000-000000000000'],
          totalTokens: 3500,
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('invalid');
    });

    it('requires componentIds as array', async () => {
      const { projectId } = await createProjectWithComponents();

      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, componentIds: 'not-an-array' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent project', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/estimate/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: '00000000-0000-0000-0000-000000000000',
          componentIds: [],
          totalTokens: 3500,
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ============================================================
  // POST /api/audit/start with componentIds
  // ============================================================

  describe('Component-scoped audits', () => {
    it('POST /api/audit/start accepts componentIds', async () => {
      const { projectId, componentIds, session } = await createProjectWithComponents();

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-key',
          componentIds: [componentIds[0]],
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.auditId).toBeDefined();

      // Verify selected_component_ids stored in DB
      const { rows } = await ctx.pool.query(
        'SELECT selected_component_ids FROM audits WHERE id = $1',
        [data.auditId]
      );
      expect(rows[0].selected_component_ids).toEqual([componentIds[0]]);
    });

    it('POST /api/audit/start rejects invalid componentIds', async () => {
      const { projectId, session } = await createProjectWithComponents();

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-key',
          componentIds: ['00000000-0000-0000-0000-000000000000'],
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('component');
    });

    it('POST /api/audit/start works without componentIds (backward compat)', async () => {
      const { projectId, session } = await createProjectWithComponents();

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-key',
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      const { rows } = await ctx.pool.query(
        'SELECT selected_component_ids FROM audits WHERE id = $1',
        [data.auditId]
      );
      expect(rows[0].selected_component_ids).toBeNull();
    });
  });

  // ============================================================
  // POST /api/dependencies/:id/link
  // ============================================================

  describe('Supply chain', () => {
    it('POST /api/dependencies/:id/link links dependency to project', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      // Create a dependency
      const { rows: [dep] } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem, source_repo_url)
         VALUES ($1, $2, 'express', '^5.0.0', 'npm', 'https://github.com/expressjs/express')
         RETURNING id`,
        [projectId, repoId]
      );

      // Create a target project to link to
      const { rows: [targetProject] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('express', 'expressjs', $1) RETURNING id`,
        [session.userId]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/dependencies/${dep.id}/link`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedProjectId: targetProject.id }),
        }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify linked_project_id is set
      const { rows } = await ctx.pool.query(
        'SELECT linked_project_id FROM project_dependencies WHERE id = $1',
        [dep.id]
      );
      expect(rows[0].linked_project_id).toBe(targetProject.id);
    });

    it('POST /api/dependencies/:id/link returns 404 for nonexistent dependency', async () => {
      const { session } = await createProjectWithComponents();

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/dependencies/00000000-0000-0000-0000-000000000000/link`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedProjectId: '00000000-0000-0000-0000-000000000001' }),
        }
      );
      expect(res.status).toBe(404);
    });

    it('POST /api/dependencies/:id/link returns 404 for nonexistent linked project', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      const { rows: [dep] } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem)
         VALUES ($1, $2, 'lodash', '^4.17.0', 'npm')
         RETURNING id`,
        [projectId, repoId]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/dependencies/${dep.id}/link`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedProjectId: '00000000-0000-0000-0000-000000000000' }),
        }
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain('project');
    });

    it('POST /api/dependencies/:id/link requires auth', async () => {
      const res = await fetch(
        `${ctx.baseUrl}/api/dependencies/00000000-0000-0000-0000-000000000000/link`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedProjectId: '00000000-0000-0000-0000-000000000001' }),
        }
      );
      expect(res.status).toBe(401);
    });

    it('POST /api/dependencies/:id/link requires linkedProjectId', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      const { rows: [dep] } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem)
         VALUES ($1, $2, 'lodash', '^4.17.0', 'npm')
         RETURNING id`,
        [projectId, repoId]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/dependencies/${dep.id}/link`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(res.status).toBe(400);
    });
  });

  // ============================================================
  // Report: component breakdown and dependencies
  // ============================================================

  describe('Report component breakdown and dependencies', () => {
    it('report includes componentBreakdown when audit has audit_components', async () => {
      const { projectId, repoId, componentIds, session } = await createProjectWithComponents();

      // Create a completed audit
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, report_summary, selected_component_ids, completed_at)
         VALUES ($1, $2, 'full', 'completed', true, $3, $4, NOW()) RETURNING id`,
        [
          projectId,
          session.userId,
          JSON.stringify({
            executive_summary: 'Test summary',
            security_posture: 'Good',
            responsible_disclosure: {},
          }),
          componentIds,
        ]
      );

      // Insert audit_components
      await ctx.pool.query(
        `INSERT INTO audit_components (audit_id, component_id, tokens_analyzed, findings_count)
         VALUES ($1, $2, 3000, 2)`,
        [audit.id, componentIds[0]]
      );
      await ctx.pool.query(
        `INSERT INTO audit_components (audit_id, component_id, tokens_analyzed, findings_count)
         VALUES ($1, $2, 500, 0)`,
        [audit.id, componentIds[1]]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${audit.id}/report`,
        session.cookie
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.componentBreakdown).toBeDefined();
      expect(data.componentBreakdown).toHaveLength(2);
      // Ordered by findings_count DESC
      expect(data.componentBreakdown[0].name).toBe('Auth Module');
      expect(data.componentBreakdown[0].findingsCount).toBe(2);
      expect(data.componentBreakdown[0].tokensAnalyzed).toBe(3000);
      expect(data.componentBreakdown[1].name).toBe('Utilities');
      expect(data.componentBreakdown[1].findingsCount).toBe(0);
    });

    it('report includes empty componentBreakdown when no audit_components', async () => {
      const { projectId, session } = await createProjectWithComponents();

      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, report_summary, completed_at)
         VALUES ($1, $2, 'full', 'completed', true, $3, NOW()) RETURNING id`,
        [
          projectId,
          session.userId,
          JSON.stringify({
            executive_summary: 'Test summary',
            security_posture: 'Good',
            responsible_disclosure: {},
          }),
        ]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${audit.id}/report`,
        session.cookie
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.componentBreakdown).toEqual([]);
    });

    it('report includes dependencies from project_dependencies', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      // Insert dependencies
      await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem, source_repo_url)
         VALUES ($1, $2, 'express', '^5.0.0', 'npm', 'https://github.com/expressjs/express')`,
        [projectId, repoId]
      );
      await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem)
         VALUES ($1, $2, 'lodash', '^4.17.0', 'npm')`,
        [projectId, repoId]
      );

      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, report_summary, completed_at)
         VALUES ($1, $2, 'full', 'completed', true, $3, NOW()) RETURNING id`,
        [
          projectId,
          session.userId,
          JSON.stringify({
            executive_summary: 'Test summary',
            security_posture: 'Good',
            responsible_disclosure: {},
          }),
        ]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${audit.id}/report`,
        session.cookie
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dependencies).toBeDefined();
      expect(data.dependencies).toHaveLength(2);

      // Ordered by ecosystem, name
      const express = data.dependencies.find((d: any) => d.name === 'express');
      expect(express).toBeDefined();
      expect(express.version).toBe('^5.0.0');
      expect(express.ecosystem).toBe('npm');
      expect(express.sourceRepoUrl).toBe('https://github.com/expressjs/express');
      expect(express.repoName).toBe('test-repo');
    });

    it('findings are attributed to components via component_id', async () => {
      const { projectId, repoId, componentIds, session } = await createProjectWithComponents();

      // Create a completed audit with component selection
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, report_summary, selected_component_ids, completed_at)
         VALUES ($1, $2, 'full', 'completed', true, $3, $4, NOW()) RETURNING id`,
        [
          projectId,
          session.userId,
          JSON.stringify({
            executive_summary: 'Test summary',
            security_posture: 'Good',
            responsible_disclosure: {},
          }),
          componentIds,
        ]
      );

      // Insert findings with component_id attribution
      await ctx.pool.query(
        `INSERT INTO audit_findings (audit_id, repo_id, component_id, severity, title, description, file_path)
         VALUES ($1, $2, $3, 'high', 'SQL Injection', 'Found SQL injection', 'src/auth/login.ts')`,
        [audit.id, repoId, componentIds[0]]
      );
      await ctx.pool.query(
        `INSERT INTO audit_findings (audit_id, repo_id, component_id, severity, title, description, file_path)
         VALUES ($1, $2, $3, 'low', 'Unused import', 'Unused import found', 'src/utils.ts')`,
        [audit.id, repoId, componentIds[1]]
      );

      // Insert audit_components with correct findings_count
      await ctx.pool.query(
        `INSERT INTO audit_components (audit_id, component_id, tokens_analyzed, findings_count)
         VALUES ($1, $2, 3000, 1)`,
        [audit.id, componentIds[0]]
      );
      await ctx.pool.query(
        `INSERT INTO audit_components (audit_id, component_id, tokens_analyzed, findings_count)
         VALUES ($1, $2, 500, 1)`,
        [audit.id, componentIds[1]]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${audit.id}/report`,
        session.cookie
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      // Verify component breakdown has correct findings counts
      expect(data.componentBreakdown).toHaveLength(2);
      const authComp = data.componentBreakdown.find((c: any) => c.name === 'Auth Module');
      expect(authComp.findingsCount).toBe(1);
      const utilComp = data.componentBreakdown.find((c: any) => c.name === 'Utilities');
      expect(utilComp.findingsCount).toBe(1);

      // Verify findings exist in the report
      expect(data.findings).toHaveLength(2);
    });

    it('Add as Project: creates new project from dependency and links it', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      // Insert a dependency without linked_project_id
      const { rows: [dep] } = await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem, source_repo_url)
         VALUES ($1, $2, 'express', '^5.0.0', 'npm', 'https://github.com/expressjs/express')
         RETURNING id`,
        [projectId, repoId]
      );

      // Step 1: Create a new project for the dependency
      const createRes = await authenticatedFetch(
        `${ctx.baseUrl}/api/projects`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            githubOrg: 'expressjs',
            repoNames: ['express'],
          }),
        }
      );
      expect(createRes.status).toBe(200);
      const { projectId: newProjectId } = await createRes.json();
      expect(newProjectId).toBeDefined();

      // Step 2: Link the dependency to the new project
      const linkRes = await authenticatedFetch(
        `${ctx.baseUrl}/api/dependencies/${dep.id}/link`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkedProjectId: newProjectId }),
        }
      );
      expect(linkRes.status).toBe(200);

      // Verify link
      const { rows } = await ctx.pool.query(
        'SELECT linked_project_id FROM project_dependencies WHERE id = $1',
        [dep.id]
      );
      expect(rows[0].linked_project_id).toBe(newProjectId);
    });

    it('report includes linked project info in dependencies', async () => {
      const { projectId, repoId, session } = await createProjectWithComponents();

      // Create a linked project
      const { rows: [linkedProject] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by)
         VALUES ('express-project', 'expressjs', $1) RETURNING id`,
        [session.userId]
      );

      // Insert dependency with linked_project_id
      await ctx.pool.query(
        `INSERT INTO project_dependencies (project_id, repo_id, name, version, ecosystem, linked_project_id)
         VALUES ($1, $2, 'express', '^5.0.0', 'npm', $3)`,
        [projectId, repoId, linkedProject.id]
      );

      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, requester_id, audit_level, status, is_owner, report_summary, completed_at)
         VALUES ($1, $2, 'full', 'completed', true, $3, NOW()) RETURNING id`,
        [
          projectId,
          session.userId,
          JSON.stringify({
            executive_summary: 'Test summary',
            security_posture: 'Good',
            responsible_disclosure: {},
          }),
        ]
      );

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${audit.id}/report`,
        session.cookie
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.dependencies).toHaveLength(1);
      expect(data.dependencies[0].linkedProjectId).toBe(linkedProject.id);
    });
  });
});
