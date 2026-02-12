// Product: product/views/gate.md
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';

describe('Smoke tests', () => {
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

  it('GET / returns 200', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('CodeWatch');
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('database tables exist', async () => {
    const { rows } = await ctx.pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const tables = rows.map(r => r.tablename);
    expect(tables).toContain('users');
    expect(tables).toContain('sessions');
    expect(tables).toContain('projects');
    expect(tables).toContain('repositories');
    expect(tables).toContain('project_repos');
    expect(tables).toContain('audits');
    expect(tables).toContain('audit_commits');
    expect(tables).toContain('audit_findings');
    expect(tables).toContain('audit_comments');
    expect(tables).toContain('model_pricing');
    expect(tables).toContain('project_watches');
  });

  it('model_pricing is seeded', async () => {
    const { rows } = await ctx.pool.query('SELECT model_id, display_name, input_cost_per_mtok, output_cost_per_mtok FROM model_pricing ORDER BY model_id');
    expect(rows).toHaveLength(3);
    const opus = rows.find(r => r.model_id.includes('opus'));
    expect(opus).toBeDefined();
    expect(parseFloat(opus!.input_cost_per_mtok)).toBe(5.0);
    expect(parseFloat(opus!.output_cost_per_mtok)).toBe(25.0);
  });
});
