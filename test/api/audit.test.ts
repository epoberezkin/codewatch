import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestSession, authenticatedFetch } from '../helpers';

// Use vi.hoisted to define mock data before vi.mock factories run
const mockData = vi.hoisted(() => ({
  classificationResponse: {
    category: 'client_server',
    description: 'A simple web application with Express backend and user authentication.',
    involved_parties: {
      vendor: 'test-org',
      operators: ['server operators'],
      end_users: ['web application users'],
      networks: [],
    },
    components: [
      { repo: 'repo-alpha', role: 'Web server', languages: ['JavaScript', 'Python'] },
    ],
    threat_model_found: false,
    threat_model_files: [],
    threat_model: {
      generated: 'Server operators can access all user data.',
      parties: [
        {
          name: 'Authenticated user',
          can: ['access own data'],
          cannot: ['access other users data'],
        },
      ],
    },
  },
  analysisResponse: {
    findings: [
      {
        severity: 'critical',
        cwe_id: 'CWE-89',
        cvss_score: 9.8,
        file: 'repo-alpha/src/index.js',
        line_start: 3,
        line_end: 4,
        title: 'SQL Injection in user query',
        description: 'User input is directly concatenated into SQL query.',
        exploitation: 'Inject SQL via the id parameter.',
        recommendation: 'Use parameterized queries.',
        code_snippet: 'db.query("SELECT * FROM users WHERE id = " + id);',
      },
      {
        severity: 'high',
        cwe_id: 'CWE-78',
        cvss_score: 8.5,
        file: 'repo-alpha/src/utils.py',
        line_start: 2,
        line_end: 2,
        title: 'OS Command Injection',
        description: 'User input passed to os.system().',
        exploitation: 'Execute arbitrary OS commands.',
        recommendation: 'Use subprocess with shell=False.',
        code_snippet: 'def run(cmd): return os.system(cmd)',
      },
      {
        severity: 'medium',
        cwe_id: 'CWE-798',
        cvss_score: 5.5,
        file: 'repo-alpha/src/auth.js',
        line_start: 1,
        line_end: 1,
        title: 'Hardcoded credential check',
        description: 'Password comparison uses hardcoded value.',
        exploitation: 'Authenticate with the hardcoded password.',
        recommendation: 'Use proper password hashing.',
        code_snippet: 'return pass === "admin";',
      },
    ],
    responsible_disclosure: { contact: 'security@test-org.example.com' },
    dependencies: [{ name: 'express', concern: 'none' }],
    security_posture: 'The application has critical security vulnerabilities.',
  },
  synthesisResponse: {
    executive_summary: 'The security audit revealed critical vulnerabilities.',
    security_posture: 'The application security posture is poor.',
    responsible_disclosure: { contact: 'security@test-org.example.com', policy: 'None found' },
  },
}));

// Hoisted mutable state for ownership mock
const mockOwnershipState = vi.hoisted(() => ({
  ownerUserIds: new Set<string>(),
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
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
  getCommitDate: async () => new Date('2025-01-15T12:00:00Z'),
}));

// Mock ownership service — uses hoisted state to control per-test ownership
vi.mock('../../src/server/services/ownership', () => ({
  resolveOwnership: async (_pool: any, userId: string) => ({
    isOwner: mockOwnershipState.ownerUserIds.has(userId),
    cached: false,
  }),
  invalidateOwnershipCache: async () => {},
}));

// Mock git service
vi.mock('../../src/server/services/git', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    cloneOrUpdate: async () => ({
      localPath: '/tmp/claude/test-repo',
      headSha: 'abc123def456789abc123def456789abc1234567',
    }),
    scanCodeFiles: () => [
      { relativePath: 'src/index.js', size: 585, roughTokens: 178 },
      { relativePath: 'src/auth.js', size: 373, roughTokens: 114 },
      { relativePath: 'src/utils.py', size: 315, roughTokens: 96 },
      { relativePath: 'config.json', size: 88, roughTokens: 27 },
      { relativePath: 'package.json', size: 189, roughTokens: 58 },
    ],
    readFileContent: (_repoPath: string, relativePath: string) => {
      const files: Record<string, string> = {
        'README.md': '# Test Project\nA test project.',
        'src/index.js': 'const express = require("express");\napp.get("/user", (req, res) => { db.query("SELECT * FROM users WHERE id = " + req.query.id); });',
        'src/auth.js': 'module.exports.login = (user, pass) => { return pass === "admin"; };',
        'src/utils.py': 'import os\ndef run(cmd): return os.system(cmd)',
      };
      return files[relativePath] || '{}';
    },
    getHeadSha: async () => 'abc123def456789abc123def456789abc1234567',
    getDefaultBranchName: async () => 'main',
    diffBetweenCommits: async (_repoPath: string, baseSha: string, headSha: string) => {
      if (baseSha === headSha) {
        return { added: [], modified: [], deleted: [], renamed: [] };
      }
      // Simulate: auth.js modified, utils.py deleted
      return {
        added: [],
        modified: ['src/auth.js'],
        deleted: ['src/utils.py'],
        renamed: [],
      };
    },
  };
});

// Mock Claude service
vi.mock('../../src/server/services/claude', () => ({
  callClaude: async (_apiKey: string, systemPrompt: string, _userMessage: string) => {
    if (systemPrompt.includes('classification expert')) {
      return {
        content: JSON.stringify(mockData.classificationResponse),
        inputTokens: 1000,
        outputTokens: 500,
      };
    }
    if (systemPrompt.includes('audit planner')) {
      // Planning phase: return ranked file list matching scanned files
      return {
        content: JSON.stringify([
          { file: 'repo-alpha/src/index.js', priority: 9, reason: 'SQL injection risk' },
          { file: 'repo-alpha/src/auth.js', priority: 8, reason: 'Password handling' },
          { file: 'repo-alpha/src/utils.py', priority: 7, reason: 'OS command execution' },
          { file: 'repo-alpha/config.json', priority: 3, reason: 'Configuration' },
          { file: 'repo-alpha/package.json', priority: 2, reason: 'Dependencies' },
        ]),
        inputTokens: 800,
        outputTokens: 300,
      };
    }
    if (systemPrompt.includes('report writer')) {
      return {
        content: JSON.stringify(mockData.synthesisResponse),
        inputTokens: 2000,
        outputTokens: 1000,
      };
    }
    // Analysis response
    return {
      content: JSON.stringify(mockData.analysisResponse),
      inputTokens: 5000,
      outputTokens: 2000,
    };
  },
  parseJsonResponse: <T>(content: string): T => JSON.parse(content),
}));

// Helper to wait for audit completion
async function waitForAudit(baseUrl: string, auditId: string, maxAttempts = 50): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${baseUrl}/api/audit/${auditId}`);
    const data = await res.json();
    if (data.status === 'completed' || data.status === 'failed') {
      return data;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Audit ${auditId} did not complete after ${maxAttempts} attempts`);
}

describe('Audit API', () => {
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

  // Helper to create a project for testing — registers session as owner
  async function createProject(session: { cookie: string; userId: string }): Promise<string> {
    mockOwnershipState.ownerUserIds.add(session.userId);
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

  // Helper to start and wait for an audit
  async function runFullAudit(session: { cookie: string }, projectId: string, level = 'full'): Promise<string> {
    const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, level, apiKey: 'sk-ant-test-api-key' }),
    });
    const { auditId } = await startRes.json();
    await waitForAudit(ctx.baseUrl, auditId);
    return auditId;
  }

  // ============================================================
  // POST /api/audit/start
  // ============================================================

  describe('POST /api/audit/start', () => {
    it('requires authentication', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/audit/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'test', level: 'full', apiKey: 'key' }),
      });
      expect(res.status).toBe(401);
    });

    it('validates required fields', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('validates audit level', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, level: 'invalid', apiKey: 'key' }),
      });
      expect(res.status).toBe(400);
    });

    it('starts a fresh audit and returns auditId', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      const res = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, level: 'full', apiKey: 'sk-ant-test-api-key' }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.auditId).toBeDefined();

      // Verify audit record in DB
      const { rows } = await ctx.pool.query('SELECT * FROM audits WHERE id = $1', [body.auditId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBe(projectId);
      expect(rows[0].audit_level).toBe('full');
      expect(rows[0].is_owner).toBe(true);
      expect(rows[0].is_incremental).toBe(false);

      // Wait for async audit to finish to avoid leaking into next test
      await waitForAudit(ctx.baseUrl, body.auditId);
    });
  });

  // ============================================================
  // Full Audit Flow
  // ============================================================

  describe('Full audit flow', () => {
    it('completes fresh audit with classification and findings', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Verify classification was stored in project
      const { rows: projects } = await ctx.pool.query(
        'SELECT category, description, involved_parties, threat_model FROM projects WHERE id = $1',
        [projectId]
      );
      expect(projects[0].category).toBe('client_server');
      expect(projects[0].description).toContain('web application');
      expect(projects[0].involved_parties).toBeDefined();
      expect(projects[0].threat_model).toBeDefined();

      // Verify findings were inserted
      const { rows: findings } = await ctx.pool.query(
        'SELECT * FROM audit_findings WHERE audit_id = $1 ORDER BY severity',
        [auditId]
      );
      expect(findings.length).toBe(3);

      const severities = findings.map(f => f.severity).sort();
      expect(severities).toContain('critical');
      expect(severities).toContain('high');
      expect(severities).toContain('medium');

      // Verify SQL injection finding details
      const sqlInjection = findings.find(f => f.cwe_id === 'CWE-89');
      expect(sqlInjection).toBeDefined();
      expect(sqlInjection!.severity).toBe('critical');
      expect(sqlInjection!.file_path).toContain('index.js');
      expect(sqlInjection!.title).toContain('SQL Injection');

      // Verify report summary was stored
      const { rows: auditRows } = await ctx.pool.query(
        'SELECT report_summary, max_severity, actual_cost_usd FROM audits WHERE id = $1',
        [auditId]
      );
      expect(auditRows[0].report_summary).toBeDefined();
      expect(auditRows[0].max_severity).toBe('critical');
      expect(parseFloat(auditRows[0].actual_cost_usd)).toBeGreaterThan(0);

      // Verify audit commits recorded
      const { rows: commits } = await ctx.pool.query(
        'SELECT * FROM audit_commits WHERE audit_id = $1',
        [auditId]
      );
      expect(commits.length).toBe(1);
      expect(commits[0].commit_sha).toBe('abc123def456789abc123def456789abc1234567');
      expect(commits[0].branch).toBe('main');
    });

    it('publishable_after is NULL at completion (set via notify-owner)', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const { rows } = await ctx.pool.query(
        'SELECT publishable_after, owner_notified FROM audits WHERE id = $1',
        [auditId]
      );
      // Phase 3: publishable_after is no longer set at completion
      // It is set when the requester triggers notify-owner
      expect(rows[0].publishable_after).toBeNull();
      expect(rows[0].owner_notified).toBe(false);
    });

    it('skips classification on second audit if already classified', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      // First audit — triggers classification
      await runFullAudit(session, projectId);

      // Verify classification exists
      const { rows: proj1 } = await ctx.pool.query(
        'SELECT category FROM projects WHERE id = $1',
        [projectId]
      );
      expect(proj1[0].category).toBe('client_server');

      // Second audit — should reuse classification
      const auditId2 = await runFullAudit(session, projectId, 'thorough');

      // Project classification unchanged
      const { rows: proj2 } = await ctx.pool.query(
        'SELECT category FROM projects WHERE id = $1',
        [projectId]
      );
      expect(proj2[0].category).toBe('client_server');

      // Second audit completed successfully
      const { rows: audit2 } = await ctx.pool.query(
        'SELECT status, audit_level FROM audits WHERE id = $1',
        [auditId2]
      );
      expect(audit2[0].status).toBe('completed');
      expect(audit2[0].audit_level).toBe('thorough');
    });
  });

  // ============================================================
  // GET /api/audit/:id
  // ============================================================

  describe('GET /api/audit/:id', () => {
    it('returns audit status and progress', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe(auditId);
      expect(data.status).toBe('completed');
      expect(data.auditLevel).toBe('full');
      expect(data.isIncremental).toBe(false);
      expect(data.commits).toHaveLength(1);
      expect(data.maxSeverity).toBe('critical');
      expect(data.completedAt).toBeDefined();
    });

    it('returns 404 for nonexistent audit', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/audit/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  // ============================================================
  // GET /api/audit/:id/report
  // ============================================================

  describe('GET /api/audit/:id/report', () => {
    it('returns full report for owner', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      expect(res.status).toBe(200);

      const report = await res.json();
      expect(report.isOwner).toBe(true);
      expect(report.findings).toHaveLength(3);
      expect(report.reportSummary).toBeDefined();
      expect(report.severityCounts.critical).toBe(1);
      expect(report.severityCounts.high).toBe(1);
      expect(report.severityCounts.medium).toBe(1);
      expect(report.redactedSeverities).toHaveLength(0);
    });

    it('redacts medium+ findings for non-owner before time-gate', async () => {
      const ownerSession = await createTestSession(ctx.pool);
      const projectId = await createProject(ownerSession);
      const auditId = await runFullAudit(ownerSession, projectId);

      // Non-owner views report (no session cookie)
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      expect(res.status).toBe(200);

      const report = await res.json();
      expect(report.isOwner).toBe(false);
      // All findings are medium+ so none should be visible
      expect(report.findings).toHaveLength(0);
      expect(report.redactedSeverities).toContain('medium');
      expect(report.redactedSeverities).toContain('high');
      expect(report.redactedSeverities).toContain('critical');
      // Severity counts are still visible
      expect(report.severityCounts.critical).toBe(1);
    });

    it('report includes category and projectDescription from classification', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      const report = await res.json();
      expect(report.category).toBe('client_server');
      expect(report.projectDescription).toContain('web application');
    });

    it('report includes involvedParties from classification', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      const report = await res.json();
      expect(report.involvedParties).toBeDefined();
      expect(report.involvedParties.vendor).toBe('test-org');
      expect(report.involvedParties.operators).toContain('server operators');
    });

    it('report includes threatModel and threatModelSource from classification', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      const report = await res.json();
      expect(report.threatModel).toBeDefined();
      expect(report.threatModel).toContain('Server operators');
      expect(report.threatModelSource).toBe('generated');
    });

    it('report includes executive_summary and security_posture in reportSummary', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      const report = await res.json();
      expect(report.reportSummary).toBeDefined();
      expect(report.reportSummary.executive_summary).toBe('The security audit revealed critical vulnerabilities.');
      expect(report.reportSummary.security_posture).toBe('The application security posture is poor.');
      expect(report.reportSummary.responsible_disclosure).toBeDefined();
    });

    it('report includes classification fields as null for non-owner (public tier)', async () => {
      const ownerSession = await createTestSession(ctx.pool);
      const projectId = await createProject(ownerSession);
      const auditId = await runFullAudit(ownerSession, projectId);

      // Anonymous user views report — still gets classification data (it's project-level, not redacted)
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      const report = await res.json();
      // Classification fields are included for all access tiers
      expect(report.category).toBe('client_server');
      expect(report.threatModelSource).toBe('generated');
      expect(report.involvedParties).toBeDefined();
    });

    it('shows all findings for non-owner when report is public', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Publish report
      await authenticatedFetch(`${ctx.baseUrl}/api/audit/${auditId}/publish`, session.cookie, {
        method: 'POST',
      });

      // Non-owner views public report
      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/report`);
      const report = await res.json();
      expect(report.isPublic).toBe(true);
      expect(report.findings).toHaveLength(3);
      expect(report.redactedSeverities).toHaveLength(0);
    });
  });

  // ============================================================
  // GET /api/audit/:id/findings
  // ============================================================

  describe('GET /api/audit/:id/findings', () => {
    it('returns all findings sorted by severity', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/findings`);
      expect(res.status).toBe(200);

      const findings = await res.json();
      expect(findings).toHaveLength(3);
      expect(findings[0].severity).toBe('critical');
      expect(findings[0].cweId).toBe('CWE-89');
      expect(findings[1].severity).toBe('high');
      expect(findings[2].severity).toBe('medium');
    });
  });

  // ============================================================
  // Comments
  // ============================================================

  describe('Comments', () => {
    it('requires auth to add comment', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/audit/00000000-0000-0000-0000-000000000000/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects empty comment', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/00000000-0000-0000-0000-000000000000/comments`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '' }),
        },
      );
      expect(res.status).toBe(400);
    });

    it('adds and lists comments on report', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Add comment
      const addRes = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/comments`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Fixed the SQL injection issue' }),
        },
      );
      expect(addRes.status).toBe(200);
      const { id: commentId } = await addRes.json();
      expect(commentId).toBeDefined();

      // List comments
      const listRes = await fetch(`${ctx.baseUrl}/api/audit/${auditId}/comments`);
      expect(listRes.status).toBe(200);

      const comments = await listRes.json();
      expect(comments).toHaveLength(1);
      expect(comments[0].content).toBe('Fixed the SQL injection issue');
      expect(comments[0].username).toBeDefined();
    });

    it('adds comment on specific finding', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Get a finding ID
      const { rows: findings } = await ctx.pool.query(
        'SELECT id FROM audit_findings WHERE audit_id = $1 LIMIT 1',
        [auditId]
      );
      const findingId = findings[0].id;

      // Add comment on finding
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/comments`,
        session.cookie,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'This is a false positive',
            findingId,
          }),
        },
      );
      expect(res.status).toBe(200);

      // Verify finding ID stored
      const { rows: comments } = await ctx.pool.query(
        'SELECT finding_id FROM audit_comments WHERE audit_id = $1',
        [auditId]
      );
      expect(comments[0].finding_id).toBe(findingId);
    });
  });

  // ============================================================
  // POST /api/audit/:id/publish
  // ============================================================

  describe('POST /api/audit/:id/publish', () => {
    it('allows owner to publish', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/publish`,
        session.cookie,
        { method: 'POST' },
      );
      expect(res.status).toBe(200);

      const { rows } = await ctx.pool.query(
        'SELECT is_public FROM audits WHERE id = $1',
        [auditId]
      );
      expect(rows[0].is_public).toBe(true);
    });

    it('rejects non-owner publish', async () => {
      const ownerSession = await createTestSession(ctx.pool);
      const projectId = await createProject(ownerSession);
      const auditId = await runFullAudit(ownerSession, projectId);

      // Different user tries to publish
      const otherSession = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/publish`,
        otherSession.cookie,
        { method: 'POST' },
      );
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // GET /api/reports (public reports listing)
  // ============================================================

  describe('GET /api/reports', () => {
    it('lists only public reports', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Not public yet
      let res = await fetch(`${ctx.baseUrl}/api/reports`);
      let reports = await res.json();
      expect(reports).toHaveLength(0);

      // Publish
      await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/publish`,
        session.cookie,
        { method: 'POST' },
      );

      // Now visible in public listing
      res = await fetch(`${ctx.baseUrl}/api/reports`);
      reports = await res.json();
      expect(reports).toHaveLength(1);
      expect(reports[0].projectName).toBe('test-org');
      expect(reports[0].maxSeverity).toBe('critical');
    });
  });

  // ============================================================
  // GET /api/project/:id/audits (audit history)
  // ============================================================

  describe('GET /api/project/:id/audits', () => {
    it('lists audit history for project', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      // Run two audits
      const auditId1 = await runFullAudit(session, projectId, 'full');
      const auditId2 = await runFullAudit(session, projectId, 'thorough');

      const res = await fetch(`${ctx.baseUrl}/api/project/${projectId}/audits`);
      expect(res.status).toBe(200);

      const audits = await res.json();
      expect(audits).toHaveLength(2);
      // Newest first
      expect(audits[0].id).toBe(auditId2);
      expect(audits[0].auditLevel).toBe('thorough');
      expect(audits[1].id).toBe(auditId1);
      expect(audits[1].auditLevel).toBe('full');

      // Severity counts present
      expect(audits[0].severityCounts).toBeDefined();
      expect(audits[0].commits).toBeDefined();
    });
  });

  // ============================================================
  // Incremental Audits
  // ============================================================

  describe('Incremental audit', () => {
    it('inherits findings from base audit and marks deleted-file findings as fixed', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      // Run base (fresh) audit
      const baseAuditId = await runFullAudit(session, projectId);

      // Verify base audit has 3 findings
      const { rows: baseFindings } = await ctx.pool.query(
        'SELECT * FROM audit_findings WHERE audit_id = $1',
        [baseAuditId]
      );
      expect(baseFindings.length).toBe(3);

      // Change the base audit's commit SHA so diff detection works
      // (mock diffBetweenCommits returns a diff when baseSha != headSha)
      await ctx.pool.query(
        `UPDATE audit_commits SET commit_sha = 'old_commit_sha_000000000000000000000000' WHERE audit_id = $1`,
        [baseAuditId]
      );

      // Start incremental audit
      const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-api-key',
          baseAuditId,
        }),
      });
      expect(startRes.status).toBe(200);
      const { auditId: incrAuditId } = await startRes.json();

      // Wait for completion
      const auditStatus = await waitForAudit(ctx.baseUrl, incrAuditId);
      expect(auditStatus.status).toBe('completed');

      // Verify it's marked as incremental
      const { rows: incrAudit } = await ctx.pool.query(
        'SELECT is_incremental, base_audit_id, diff_files_modified, diff_files_deleted FROM audits WHERE id = $1',
        [incrAuditId]
      );
      expect(incrAudit[0].is_incremental).toBe(true);
      expect(incrAudit[0].base_audit_id).toBe(baseAuditId);
      expect(incrAudit[0].diff_files_modified).toBe(1); // auth.js
      expect(incrAudit[0].diff_files_deleted).toBe(1);  // utils.py

      // Verify findings were inherited
      const { rows: incrFindings } = await ctx.pool.query(
        'SELECT file_path, severity, status, title FROM audit_findings WHERE audit_id = $1 ORDER BY file_path',
        [incrAuditId]
      );

      // Should have inherited findings (some may be deduped with analysis results)
      expect(incrFindings.length).toBeGreaterThanOrEqual(3);

      // The utils.py finding should be marked as 'fixed' (file was deleted)
      const utilsFinding = incrFindings.find(f => f.file_path.includes('utils.py'));
      expect(utilsFinding).toBeDefined();
      expect(utilsFinding!.status).toBe('fixed');

      // The index.js finding should still be 'open' (file unchanged)
      const indexFinding = incrFindings.find(f => f.file_path.includes('index.js'));
      expect(indexFinding).toBeDefined();
      expect(indexFinding!.status).toBe('open');
    });

    it('deduplicates findings with same fingerprint', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      // Run base audit
      const baseAuditId = await runFullAudit(session, projectId);

      // Change base commit for diff detection
      await ctx.pool.query(
        `UPDATE audit_commits SET commit_sha = 'old_commit_sha_000000000000000000000000' WHERE audit_id = $1`,
        [baseAuditId]
      );

      // Run incremental audit
      const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-api-key',
          baseAuditId,
        }),
      });
      const { auditId: incrAuditId } = await startRes.json();
      await waitForAudit(ctx.baseUrl, incrAuditId);

      // Check for duplicates: no two findings should have the same fingerprint
      const { rows: findings } = await ctx.pool.query(
        'SELECT fingerprint, COUNT(*) as cnt FROM audit_findings WHERE audit_id = $1 GROUP BY fingerprint HAVING COUNT(*) > 1',
        [incrAuditId]
      );
      expect(findings.length).toBe(0); // No duplicate fingerprints
    });

    it('records diff stats in audit record', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const baseAuditId = await runFullAudit(session, projectId);

      await ctx.pool.query(
        `UPDATE audit_commits SET commit_sha = 'old_commit_sha_000000000000000000000000' WHERE audit_id = $1`,
        [baseAuditId]
      );

      const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          level: 'full',
          apiKey: 'sk-ant-test-api-key',
          baseAuditId,
        }),
      });
      const { auditId } = await startRes.json();
      await waitForAudit(ctx.baseUrl, auditId);

      const { rows } = await ctx.pool.query(
        'SELECT diff_files_added, diff_files_modified, diff_files_deleted, is_incremental FROM audits WHERE id = $1',
        [auditId]
      );
      expect(rows[0].is_incremental).toBe(true);
      expect(rows[0].diff_files_added).toBe(0);
      expect(rows[0].diff_files_modified).toBe(1);
      expect(rows[0].diff_files_deleted).toBe(1);
    });
  });

  // ============================================================
  // PATCH /api/findings/:id/status
  // ============================================================

  describe('PATCH /api/findings/:id/status', () => {
    it('allows owner to update finding status', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      // Get a finding
      const { rows: findings } = await ctx.pool.query(
        'SELECT id FROM audit_findings WHERE audit_id = $1 LIMIT 1',
        [auditId]
      );
      const findingId = findings[0].id;

      // Update status to false_positive
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/findings/${findingId}/status`,
        session.cookie,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'false_positive' }),
        },
      );
      expect(res.status).toBe(200);

      // Verify in DB
      const { rows: updated } = await ctx.pool.query(
        'SELECT status FROM audit_findings WHERE id = $1',
        [findingId]
      );
      expect(updated[0].status).toBe('false_positive');
    });

    it('rejects non-owner status update', async () => {
      const ownerSession = await createTestSession(ctx.pool);
      const projectId = await createProject(ownerSession);
      const auditId = await runFullAudit(ownerSession, projectId);

      const { rows: findings } = await ctx.pool.query(
        'SELECT id FROM audit_findings WHERE audit_id = $1 LIMIT 1',
        [auditId]
      );
      const findingId = findings[0].id;

      // Different user tries to update
      const otherSession = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/findings/${findingId}/status`,
        otherSession.cookie,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'accepted' }),
        },
      );
      expect(res.status).toBe(403);
    });

    it('rejects invalid status value', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/findings/00000000-0000-0000-0000-000000000000/status`,
        session.cookie,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'invalid_status' }),
        },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent finding', async () => {
      const session = await createTestSession(ctx.pool);
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/api/findings/00000000-0000-0000-0000-000000000000/status`,
        session.cookie,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'accepted' }),
        },
      );
      expect(res.status).toBe(404);
    });

    it('supports all valid status transitions', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);
      const auditId = await runFullAudit(session, projectId);

      const { rows: findings } = await ctx.pool.query(
        'SELECT id FROM audit_findings WHERE audit_id = $1 LIMIT 1',
        [auditId]
      );
      const findingId = findings[0].id;

      const statuses = ['fixed', 'false_positive', 'accepted', 'wont_fix', 'open'];
      for (const status of statuses) {
        const res = await authenticatedFetch(
          `${ctx.baseUrl}/api/findings/${findingId}/status`,
          session.cookie,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        );
        expect(res.status).toBe(200);

        const { rows } = await ctx.pool.query(
          'SELECT status FROM audit_findings WHERE id = $1',
          [findingId]
        );
        expect(rows[0].status).toBe(status);
      }
    });
  });

  // ============================================================
  // API key security
  // ============================================================

  describe('API key security', () => {
    it('never exposes API key in responses or DB', async () => {
      const session = await createTestSession(ctx.pool);
      const projectId = await createProject(session);

      const startRes = await authenticatedFetch(`${ctx.baseUrl}/api/audit/start`, session.cookie, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, level: 'full', apiKey: 'sk-ant-secret-api-key-12345' }),
      });
      const { auditId } = await startRes.json();
      await waitForAudit(ctx.baseUrl, auditId);

      // Check audit status response
      const statusRes = await fetch(`${ctx.baseUrl}/api/audit/${auditId}`);
      const statusText = await statusRes.text();
      expect(statusText).not.toContain('secret-api-key-12345');

      // Check report response
      const reportRes = await authenticatedFetch(
        `${ctx.baseUrl}/api/audit/${auditId}/report`,
        session.cookie,
      );
      const reportText = await reportRes.text();
      expect(reportText).not.toContain('secret-api-key-12345');

      // Check DB — API key should not be stored
      const { rows } = await ctx.pool.query('SELECT * FROM audits WHERE id = $1', [auditId]);
      const auditJson = JSON.stringify(rows[0]);
      expect(auditJson).not.toContain('secret-api-key-12345');
    });
  });
});
