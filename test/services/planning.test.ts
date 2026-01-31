import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';

// ---------- Mock state ----------

const mockClaudeState = vi.hoisted(() => ({
  lastSystem: null as string | null,
  lastMessage: null as string | null,
  lastModel: null as string | null,
  lastMaxTokens: null as number | null,
  responseContent: '[]',
}));

const mockFileContents = vi.hoisted(() => new Map<string, string>());

// ---------- Mock Claude service ----------

vi.mock('../../src/server/services/claude', () => ({
  callClaude: async (apiKey: string, system: string, message: string, model?: string, maxTokens?: number) => {
    mockClaudeState.lastSystem = system;
    mockClaudeState.lastMessage = message;
    mockClaudeState.lastModel = model ?? null;
    mockClaudeState.lastMaxTokens = maxTokens ?? null;
    return {
      content: mockClaudeState.responseContent,
      inputTokens: 1000,
      outputTokens: 500,
    };
  },
  parseJsonResponse: <T>(content: string): T => {
    const text = content.trim();
    try { return JSON.parse(text); } catch {}
    const bracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (bracket !== -1 && lastBracket > bracket) {
      return JSON.parse(text.substring(bracket, lastBracket + 1));
    }
    throw new SyntaxError('Failed to parse JSON');
  },
}));

// ---------- Mock fs for file content reading ----------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    readFileSync: (p: string, enc?: string) => {
      const content = mockFileContents.get(p);
      if (content !== undefined) return content;
      return actual.readFileSync(p, enc);
    },
    existsSync: (p: string) => actual.existsSync(p),
  };
});

// ---------- Mock git + github ----------

vi.mock('../../src/server/services/git', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    cloneOrUpdate: async () => ({ localPath: '/tmp/claude/test-repo', headSha: 'abc123' }),
    scanCodeFiles: () => [],
  };
});

vi.mock('../../src/server/services/github', () => ({
  getOAuthUrl: () => 'https://github.com/login/oauth/authorize?client_id=test',
  exchangeCodeForToken: async () => ({ accessToken: 'mock-token', scope: 'read:org' }),
  getAuthenticatedUser: async () => ({ id: 12345, login: 'testuser', type: 'User', avatar_url: '' }),
  listOrgRepos: async () => [],
  getOrgMembershipRole: async () => ({ role: 'admin', state: 'active' }),
  checkGitHubOwnership: async () => ({ isOwner: true }),
  createIssue: async () => ({ html_url: 'https://github.com/test/test/issues/1' }),
}));

// ---------- Import after mocks ----------

import {
  runSecurityGreps,
  runPlanningCall,
  selectFilesByBudget,
  runPlanningPhase,
  SECURITY_GREP_PATTERNS,
} from '../../src/server/services/planning';
import type { GrepHit, RankedFile, AuditPlanEntry } from '../../src/server/services/planning';
import type { ScannedFile } from '../../src/server/services/git';

// ---------- Test data ----------

const TEST_REPO_PATH = '/tmp/claude/test-repo';

function makeFiles(files: Array<{ path: string; tokens: number }>): ScannedFile[] {
  return files.map(f => ({
    relativePath: `test-repo/${f.path}`,
    size: f.tokens * 3.3,
    roughTokens: f.tokens,
  }));
}

const REPO_DATA = [{ name: 'test-repo', localPath: TEST_REPO_PATH }];

// ---------- Tests ----------

describe('Planning service', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
    mockClaudeState.lastSystem = null;
    mockClaudeState.lastMessage = null;
    mockClaudeState.lastModel = null;
    mockClaudeState.lastMaxTokens = null;
    mockClaudeState.responseContent = '[]';
    mockFileContents.clear();
  });

  describe('Local security greps', () => {
    it('detects injection patterns (eval, exec, spawn)', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/danger.ts`, [
        'import child from "child_process";',
        'const result = eval(userInput);',
        'child.exec(command);',
        'child.spawn("ls", ["-la"]);',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/danger.ts', tokens: 500 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(1);
      expect(results[0].file).toBe('test-repo/src/danger.ts');
      expect(results[0].grepHits).toBeGreaterThanOrEqual(3); // eval, exec, spawn
      expect(results[0].samples.some(s => s.pattern === 'injection')).toBe(true);
    });

    it('detects SQL patterns (query, raw, execute)', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/db.ts`, [
        'const result = await pool.query(`SELECT * FROM users WHERE id = ${id}`);',
        'await knex.raw("DROP TABLE students");',
        'stmt.execute();',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/db.ts', tokens: 400 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(1);
      expect(results[0].grepHits).toBeGreaterThanOrEqual(3);
      expect(results[0].samples.some(s => s.pattern === 'sql')).toBe(true);
    });

    it('detects auth patterns (password, token, session)', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/auth.ts`, [
        'function verifyPassword(password: string) {',
        '  const token = generateToken();',
        '  session.set("user", token);',
        '}',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/auth.ts', tokens: 300 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(1);
      expect(results[0].grepHits).toBeGreaterThanOrEqual(3); // password, token, session
      expect(results[0].samples.some(s => s.pattern === 'auth')).toBe(true);
    });

    it('returns zero hits for clean files', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/utils.ts`, [
        'function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        'export const PI = 3.14159;',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/utils.ts', tokens: 200 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(0);
    });

    it('limits sample hits to top 3', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/many-hits.ts`, [
        'const a = password;',
        'const b = password;',
        'const c = password;',
        'const d = password;',
        'const e = password;',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/many-hits.ts', tokens: 300 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(1);
      expect(results[0].grepHits).toBeGreaterThanOrEqual(5);
      expect(results[0].samples).toHaveLength(3); // capped at 3
    });

    it('includes line number and trimmed text in samples', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/sample.ts`, [
        '// line 1',
        '// line 2',
        'const hash = crypto.createHash("sha256");',
      ].join('\n'));

      const files = makeFiles([{ path: 'src/sample.ts', tokens: 200 }]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(1);
      const sample = results[0].samples[0];
      expect(sample.lineNo).toBe(3); // 1-indexed
      expect(sample.text).toContain('crypto.createHash');
      expect(sample.pattern).toBeTruthy();
    });

    it('sorts results by grep hits descending', () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/few.ts`, 'const x = password;\n');
      mockFileContents.set(`${TEST_REPO_PATH}/src/many.ts`, [
        'password token secret auth session credential',
      ].join('\n'));

      const files = makeFiles([
        { path: 'src/few.ts', tokens: 100 },
        { path: 'src/many.ts', tokens: 100 },
      ]);
      const results = runSecurityGreps(files, REPO_DATA);

      expect(results).toHaveLength(2);
      expect(results[0].grepHits).toBeGreaterThanOrEqual(results[1].grepHits);
    });
  });

  describe('Claude planning call', () => {
    it('sends grep results, component profiles, and threat model to Claude', async () => {
      const rankedResponse = JSON.stringify([
        { file: 'test-repo/src/auth.ts', priority: 9, reason: 'Auth handling' },
        { file: 'test-repo/src/utils.ts', priority: 3, reason: 'Utility functions' },
      ]);
      mockClaudeState.responseContent = rankedResponse;

      const files = makeFiles([
        { path: 'src/auth.ts', tokens: 500 },
        { path: 'src/utils.ts', tokens: 200 },
      ]);

      const grepResults: GrepHit[] = [
        { file: 'test-repo/src/auth.ts', tokens: 500, grepHits: 5, samples: [
          { pattern: 'auth', lineNo: 1, text: 'verifyPassword(pw)' },
        ] },
      ];

      const componentProfiles = [
        {
          name: 'Auth Module',
          role: 'server',
          securityProfile: {
            summary: 'Handles authentication',
            sensitive_areas: [{ path: 'src/auth.ts', reason: 'Password handling' }],
            threat_surface: ['authentication'],
          },
        },
      ];

      const result = await runPlanningCall(
        'sk-ant-test-key', files, grepResults, componentProfiles,
        'Admin: can [manage users], cannot [read encrypted data]',
        'web-app', 'Test web application', 'thorough',
      );

      // Verify Claude was called with correct params
      expect(mockClaudeState.lastSystem).toContain('security audit planner');
      expect(mockClaudeState.lastMessage).toContain('test-repo/src/auth.ts');
      expect(mockClaudeState.lastMessage).toContain('Auth Module');
      expect(mockClaudeState.lastMessage).toContain('Handles authentication');
      expect(mockClaudeState.lastMessage).toContain('Admin');
      expect(mockClaudeState.lastMessage).toContain('thorough');
      expect(mockClaudeState.lastModel).toBe('claude-sonnet-4-5-20250929');

      // Verify parsed result
      expect(result.rankedFiles).toHaveLength(2);
      expect(result.rankedFiles[0].file).toBe('test-repo/src/auth.ts');
      expect(result.rankedFiles[0].priority).toBe(9);

      // Verify actual token counts are returned from Claude response
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
    });

    it('parses ranked file list from Claude response', async () => {
      mockClaudeState.responseContent = JSON.stringify([
        { file: 'repo/a.ts', priority: 10, reason: 'Critical auth' },
        { file: 'repo/b.ts', priority: 5, reason: 'Moderate risk' },
        { file: 'repo/c.ts', priority: 2, reason: 'Low risk' },
      ]);

      const files = makeFiles([
        { path: 'a.ts', tokens: 100 },
        { path: 'b.ts', tokens: 100 },
        { path: 'c.ts', tokens: 100 },
      ]);

      const result = await runPlanningCall(
        'sk-ant-test-key', files, [], [], '', 'unknown', 'Test', 'full',
      );

      expect(result.rankedFiles).toHaveLength(3);
      expect(result.rankedFiles[0].priority).toBe(10);
      expect(result.rankedFiles[2].priority).toBe(2);
    });
  });

  describe('Token-budget file selection', () => {
    const rankedFiles: RankedFile[] = [
      { file: 'repo/auth.ts', priority: 9, reason: 'Auth handling' },
      { file: 'repo/api.ts', priority: 7, reason: 'API routes' },
      { file: 'repo/config.ts', priority: 5, reason: 'Config' },
      { file: 'repo/utils.ts', priority: 3, reason: 'Utilities' },
    ];

    const allFiles: ScannedFile[] = [
      { relativePath: 'repo/auth.ts', size: 1320, roughTokens: 400 },
      { relativePath: 'repo/api.ts', size: 1320, roughTokens: 400 },
      { relativePath: 'repo/config.ts', size: 660, roughTokens: 200 },
      { relativePath: 'repo/utils.ts', size: 660, roughTokens: 200 },
    ];
    // Total: 1200 tokens

    it('full level includes all files', () => {
      const plan = selectFilesByBudget(rankedFiles, allFiles, 'full');
      expect(plan).toHaveLength(4);
      expect(plan.reduce((sum, p) => sum + p.tokens, 0)).toBe(1200);
    });

    it('thorough level includes ~33% of tokens', () => {
      // Budget = 1200 * 0.33 = 396 tokens
      // auth.ts (400) exceeds budget alone but is first file → included
      const plan = selectFilesByBudget(rankedFiles, allFiles, 'thorough');
      expect(plan.length).toBeGreaterThanOrEqual(1);
      const totalSelected = plan.reduce((sum, p) => sum + p.tokens, 0);
      // Should not exceed 33% budget (396) by more than one file
      expect(totalSelected).toBeLessThanOrEqual(800); // at most 2 files (400 + 400)
    });

    it('opportunistic level includes ~10% of tokens', () => {
      // Budget = 1200 * 0.10 = 120 tokens
      // No single file fits, but at least one file always included
      const plan = selectFilesByBudget(rankedFiles, allFiles, 'opportunistic');
      expect(plan).toHaveLength(1); // Only the highest priority file
      expect(plan[0].file).toBe('repo/auth.ts');
      expect(plan[0].priority).toBe(9);
    });

    it('selects files by priority order (highest first)', () => {
      const plan = selectFilesByBudget(rankedFiles, allFiles, 'full');
      // Full level includes all, sorted by priority descending
      expect(plan[0].priority).toBeGreaterThanOrEqual(plan[1].priority);
      expect(plan[1].priority).toBeGreaterThanOrEqual(plan[2].priority);
    });

    it('always includes at least one file even if it exceeds budget', () => {
      const bigFile: RankedFile[] = [
        { file: 'repo/huge.ts', priority: 10, reason: 'Critical' },
      ];
      const bigScanned: ScannedFile[] = [
        { relativePath: 'repo/huge.ts', size: 33000, roughTokens: 10000 },
      ];
      // Budget = 10000 * 0.10 = 1000, but file is 10000 → still included
      const plan = selectFilesByBudget(bigFile, bigScanned, 'opportunistic');
      expect(plan).toHaveLength(1);
      expect(plan[0].file).toBe('repo/huge.ts');
    });

    it('skips files not in scanned list', () => {
      const extraRanked: RankedFile[] = [
        ...rankedFiles,
        { file: 'repo/ghost.ts', priority: 10, reason: 'Does not exist' },
      ];
      const plan = selectFilesByBudget(extraRanked, allFiles, 'full');
      expect(plan).toHaveLength(4); // ghost.ts skipped
      expect(plan.every(p => p.file !== 'repo/ghost.ts')).toBe(true);
    });
  });

  describe('Combined planning phase (runPlanningPhase)', () => {
    it('stores audit_plan in database', async () => {
      // Set up file content for grep scanning
      mockFileContents.set(`${TEST_REPO_PATH}/src/auth.ts`, 'const token = getSession();\n');
      mockFileContents.set(`${TEST_REPO_PATH}/src/utils.ts`, 'function add(a, b) { return a + b; }\n');

      // Claude returns ranked files
      mockClaudeState.responseContent = JSON.stringify([
        { file: 'test-repo/src/auth.ts', priority: 9, reason: 'Auth code' },
        { file: 'test-repo/src/utils.ts', priority: 2, reason: 'Utilities' },
      ]);

      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, audit_level, status) VALUES ($1, 'full', 'planning') RETURNING id`,
        [project.id]
      );

      const files = makeFiles([
        { path: 'src/auth.ts', tokens: 500 },
        { path: 'src/utils.ts', tokens: 200 },
      ]);

      const { plan, planningCostUsd } = await runPlanningPhase(
        ctx.pool, audit.id, 'sk-ant-test-key', files, REPO_DATA, 'full',
        { category: 'web-app', description: 'Test app' },
        [],
      );

      // Verify plan stored in DB
      const { rows } = await ctx.pool.query(
        'SELECT audit_plan FROM audits WHERE id = $1',
        [audit.id]
      );
      expect(rows[0].audit_plan).toBeDefined();
      const storedPlan = rows[0].audit_plan;
      expect(storedPlan).toHaveLength(plan.length);
      expect(storedPlan[0].file).toBe(plan[0].file);

      // Verify planning cost is positive
      expect(planningCostUsd).toBeGreaterThan(0);
    });

    it('uses component security profiles when available', async () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/auth.ts`, 'password check;\n');

      mockClaudeState.responseContent = JSON.stringify([
        { file: 'test-repo/src/auth.ts', priority: 9, reason: 'Auth' },
      ]);

      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, audit_level, status) VALUES ($1, 'thorough', 'planning') RETURNING id`,
        [project.id]
      );

      const files = makeFiles([{ path: 'src/auth.ts', tokens: 500 }]);

      const componentProfiles = [{
        name: 'Auth Module',
        role: 'server',
        securityProfile: {
          summary: 'Handles all authentication',
          sensitive_areas: [{ path: 'src/auth.ts', reason: 'Password verification' }],
          threat_surface: ['authentication', 'brute_force'],
        },
      }];

      await runPlanningPhase(
        ctx.pool, audit.id, 'sk-ant-test-key', files, REPO_DATA, 'thorough',
        { category: 'web-app', description: 'Test app' },
        componentProfiles,
      );

      // Verify Claude received component profiles in the prompt
      expect(mockClaudeState.lastMessage).toContain('Auth Module');
      expect(mockClaudeState.lastMessage).toContain('Handles all authentication');
      expect(mockClaudeState.lastMessage).toContain('brute_force');
    });

    it('includes threat model parties in planning prompt', async () => {
      mockFileContents.set(`${TEST_REPO_PATH}/src/index.ts`, 'console.log("hello");\n');

      mockClaudeState.responseContent = JSON.stringify([
        { file: 'test-repo/src/index.ts', priority: 5, reason: 'Entry point' },
      ]);

      const user = await createTestUser(ctx.pool);
      const { rows: [project] } = await ctx.pool.query(
        `INSERT INTO projects (name, github_org, created_by) VALUES ('test', 'test-org', $1) RETURNING id`,
        [user.id]
      );
      const { rows: [audit] } = await ctx.pool.query(
        `INSERT INTO audits (project_id, audit_level, status) VALUES ($1, 'full', 'planning') RETURNING id`,
        [project.id]
      );

      const files = makeFiles([{ path: 'src/index.ts', tokens: 300 }]);

      await runPlanningPhase(
        ctx.pool, audit.id, 'sk-ant-test-key', files, REPO_DATA, 'full',
        {
          category: 'messaging',
          description: 'Encrypted messaging app',
          threat_model: {
            parties: [
              { name: 'Server operator', can: ['access metadata'], cannot: ['read messages'] },
            ],
          },
        },
        [],
      );

      expect(mockClaudeState.lastMessage).toContain('Server operator');
      expect(mockClaudeState.lastMessage).toContain('access metadata');
      expect(mockClaudeState.lastMessage).toContain('read messages');
    });
  });
});
