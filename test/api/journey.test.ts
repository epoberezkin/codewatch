// Product: product/flows/audit-lifecycle.md
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestSession, authenticatedFetch } from '../helpers';

/**
 * End-to-end journey test (Issue #32):
 * Create project → Classify → Audit → Publish → Browse → Verify
 */

const mockData = vi.hoisted(() => ({
  classificationResponse: {
    category: 'client_server',
    description: 'A web application with authentication.',
    involved_parties: {
      vendor: 'journey-org',
      operators: ['server operators'],
      end_users: ['users'],
      networks: [],
    },
    components: [
      { repo: 'journey-repo', role: 'Server', languages: ['TypeScript'] },
    ],
    threat_model_found: false,
    threat_model_files: [],
    threat_model: {
      generated: 'Server operators can access all data.',
      parties: [
        { name: 'User', can: ['access own data'], cannot: ['access other data'] },
      ],
    },
  },
  analysisResponse: {
    findings: [
      {
        severity: 'high',
        cwe_id: 'CWE-89',
        cvss_score: 8.0,
        file: 'journey-repo/src/app.ts',
        line_start: 10,
        line_end: 12,
        title: 'SQL Injection in user lookup',
        description: 'User input directly in SQL query.',
        exploitation: 'Inject SQL via query param.',
        recommendation: 'Use parameterized queries.',
        code_snippet: 'db.query("SELECT * FROM users WHERE id = " + id)',
      },
      {
        severity: 'low',
        cwe_id: 'CWE-200',
        cvss_score: 3.0,
        file: 'journey-repo/src/app.ts',
        line_start: 20,
        line_end: 20,
        title: 'Debug info in error response',
        description: 'Stack trace exposed in error handler.',
        exploitation: 'Trigger error to see internals.',
        recommendation: 'Remove stack traces in production.',
        code_snippet: 'res.json({ error: err.stack })',
      },
    ],
    responsible_disclosure: { contact: 'security@journey-org.example.com' },
    dependencies: [],
    security_posture: 'Moderate risk. SQL injection needs immediate fix.',
  },
  synthesisResponse: {
    executive_summary: 'Found SQL injection and debug info leak.',
    security_posture: 'Moderate risk with one high severity finding.',
    responsible_disclosure: { contact: 'security@journey-org.example.com', policy: 'None' },
  },
}));

const mockOwnershipState = vi.hoisted(() => ({
  ownerUserIds: new Set<string>(),
}));

vi.mock('../../src/server/services/github', () => ({
  getOAuthUrl: () => 'https://github.com/login/oauth/authorize?client_id=test',
  exchangeCodeForToken: async () => ({ accessToken: 'mock-token', scope: 'read:org' }),
  getAuthenticatedUser: async () => ({
    id: 12345, login: 'testuser', type: 'User',
    avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  }),
  listOrgRepos: async () => [
    {
      id: 2001, name: 'journey-repo', full_name: 'journey-org/journey-repo',
      description: 'Journey test repo', language: 'TypeScript',
      stargazers_count: 10, forks_count: 2, default_branch: 'main',
      license: { spdx_id: 'MIT' }, html_url: 'https://github.com/journey-org/journey-repo',
    },
  ],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/journey-org/journey-repo/issues/1' }),
  getGitHubEntity: async () => ({
    login: 'journey-org', type: 'Organization',
    avatarUrl: 'https://avatars.githubusercontent.com/u/99999',
  }),
  listRepoBranches: async () => [{ name: 'main' }],
  getRepoDefaultBranch: async () => 'main',
  getCommitDate: async () => new Date('2025-06-01'),
}));

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
      headSha: 'journey123abc456def789',
    }),
    scanCodeFiles: () => [
      { relativePath: 'src/app.ts', size: 2000, roughTokens: 606 },
      { relativePath: 'src/config.ts', size: 500, roughTokens: 152 },
      { relativePath: 'package.json', size: 300, roughTokens: 91 },
    ],
    readFileContent: (_repoPath: string, relativePath: string) => {
      const files: Record<string, string> = {
        'src/app.ts': 'import express from "express";\napp.get("/user", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); });\napp.use((err, req, res, next) => { res.json({ error: err.stack }); });',
        'src/config.ts': 'export const PORT = 3000;',
        'package.json': '{ "name": "journey-app", "dependencies": { "express": "^4.18" } }',
      };
      return files[relativePath] || '{}';
    },
    getHeadSha: async () => 'journey123abc456def789',
    getDefaultBranchName: async () => 'main',
  };
});

vi.mock('../../src/server/services/claude', () => ({
  callClaude: async (_apiKey: string, systemPrompt: string) => {
    if (systemPrompt.includes('classification expert')) {
      return {
        content: JSON.stringify(mockData.classificationResponse),
        inputTokens: 800,
        outputTokens: 400,
      };
    }
    if (systemPrompt.includes('audit planner')) {
      return {
        content: JSON.stringify([
          { file: 'journey-repo/src/app.ts', priority: 9, reason: 'SQL injection risk' },
          { file: 'journey-repo/src/config.ts', priority: 3, reason: 'Configuration' },
          { file: 'journey-repo/package.json', priority: 2, reason: 'Dependencies' },
        ]),
        inputTokens: 600,
        outputTokens: 200,
      };
    }
    if (systemPrompt.includes('report writer')) {
      return {
        content: JSON.stringify(mockData.synthesisResponse),
        inputTokens: 1500,
        outputTokens: 800,
      };
    }
    return {
      content: JSON.stringify(mockData.analysisResponse),
      inputTokens: 3000,
      outputTokens: 1200,
    };
  },
  parseJsonResponse: <T>(content: string): T => JSON.parse(content),
}));

async function waitForAudit(baseUrl: string, auditId: string, maxAttempts = 60): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${baseUrl}/api/audit/${auditId}`);
    const data = await res.json();
    if (['completed', 'completed_with_warnings', 'failed'].includes(data.status)) {
      return data;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Audit ${auditId} did not complete after ${maxAttempts} attempts`);
}

describe('End-to-end journey', () => {
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

  it('complete flow: create → classify → audit → publish → browse → verify', async () => {
    // Step 1: Create authenticated session
    const session = await createTestSession(ctx.pool);
    mockOwnershipState.ownerUserIds.add(session.userId);

    // Step 2: Create project
    const createRes = await authenticatedFetch(`${ctx.baseUrl}/api/projects`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubOrg: 'journey-org',
        repoNames: ['journey-repo'],
      }),
    });
    expect(createRes.status).toBe(200);
    const { projectId } = await createRes.json();
    expect(projectId).toBeDefined();

    // Step 3: Verify project was created
    const projectRes = await fetch(`${ctx.baseUrl}/api/projects/${projectId}`);
    expect(projectRes.status).toBe(200);
    const project = await projectRes.json();
    expect(project.githubOrg).toBe('journey-org');
    expect(project.repos).toHaveLength(1);

    // Step 4: Start audit (triggers classify → plan → analyze → synthesize)
    const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, level: 'full', apiKey: 'sk-ant-journey-key' }),
    });
    expect(startRes.status).toBe(200);
    const { auditId } = await startRes.json();
    expect(auditId).toBeDefined();

    // Step 5: Wait for audit completion
    const auditResult = await waitForAudit(ctx.baseUrl, auditId);
    expect(['completed', 'completed_with_warnings']).toContain(auditResult.status);

    // Step 6: Verify classification was stored
    const classifiedProject = await (await fetch(`${ctx.baseUrl}/api/projects/${projectId}`)).json();
    expect(classifiedProject.category).toBe('client_server');

    // Step 7: Verify findings via report (as owner)
    const reportRes = await authenticatedFetch(
      `${ctx.baseUrl}/api/audit/${auditId}/report`,
      session.cookie,
    );
    expect(reportRes.status).toBe(200);
    const report = await reportRes.json();
    expect(report.isOwner).toBe(true);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.some((f: any) => f.severity === 'high')).toBe(true);
    expect(report.findings.some((f: any) => f.severity === 'low')).toBe(true);
    expect(report.reportSummary).toBeDefined();
    expect(report.reportSummary.executive_summary).toContain('SQL injection');
    expect(report.severityCounts.high).toBe(1);
    expect(report.severityCounts.low).toBe(1);

    // Step 8: Verify non-owner cannot see findings (before publish)
    const anonReportRes = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
    const anonReport = await anonReportRes.json();
    expect(anonReport.findings).toHaveLength(0); // high finding redacted
    expect(anonReport.severityCounts.high).toBe(1); // but counts visible

    // Step 9: Not in public reports yet
    const prePublishReports = await (await fetch(`${ctx.baseUrl}/api/reports`)).json();
    expect(prePublishReports).toHaveLength(0);

    // Step 10: Publish the audit
    const publishRes = await authenticatedFetch(
      `${ctx.baseUrl}/api/audit/${auditId}/publish`,
      session.cookie,
      { method: 'POST' },
    );
    expect(publishRes.status).toBe(200);

    // Step 11: Verify public reports listing
    const publicReports = await (await fetch(`${ctx.baseUrl}/api/reports`)).json();
    expect(publicReports).toHaveLength(1);
    expect(publicReports[0].projectName).toBe('journey-repo');
    expect(publicReports[0].maxSeverity).toBe('high');

    // Step 12: Verify all findings visible after publish
    const publicReportRes = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
    const publicReport = await publicReportRes.json();
    expect(publicReport.isPublic).toBe(true);
    expect(publicReport.findings).toHaveLength(2);
    expect(publicReport.redactedSeverities).toHaveLength(0);

    // Step 13: Verify audit history
    const historyRes = await authenticatedFetch(
      `${ctx.baseUrl}/api/project/${projectId}/audits`,
      session.cookie,
    );
    const history = await historyRes.json();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(auditId);
    expect(history[0].auditLevel).toBe('full');
    expect(history[0].severityCounts).toBeDefined();

    // Step 14: Verify cost was recorded
    const { rows: auditRows } = await ctx.pool.query(
      'SELECT actual_cost_usd, max_severity, report_summary FROM audits WHERE id = $1',
      [auditId]
    );
    expect(parseFloat(auditRows[0].actual_cost_usd)).toBeGreaterThan(0);
    expect(auditRows[0].max_severity).toBe('high');
    expect(auditRows[0].report_summary).toBeDefined();
  });
});
