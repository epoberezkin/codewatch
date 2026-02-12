// Product: product/views/gate.md
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { config } from '../../src/server/config';

// Save original gate password so we can restore between tests
const originalGatePassword = config.gatePassword;

describe('Development Gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Enable gate for tests
    config.gatePassword = 'test-gate-password';
    ctx = await startTestServer();
  });

  afterAll(async () => {
    config.gatePassword = originalGatePassword;
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
    config.gatePassword = 'test-gate-password';
  });

  it('redirects to /gate.html when no gate cookie', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/projects`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/gate.html');
  });

  it('allows access to static assets without cookie', async () => {
    // gate.html is a static asset served before the gate middleware
    const res = await fetch(`${ctx.baseUrl}/gate.html`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('password');
  });

  it('allows access to /api/health without cookie', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('rejects wrong password', async () => {
    const res = await fetch(`${ctx.baseUrl}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Wrong password');
  });

  it('sets signed cookie on correct password', async () => {
    const res = await fetch(`${ctx.baseUrl}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-gate-password' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('gate=');
  });

  it('allows access with valid gate cookie', async () => {
    // First, authenticate to get the cookie
    const authRes = await fetch(`${ctx.baseUrl}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-gate-password' }),
    });
    const setCookie = authRes.headers.get('set-cookie')!;

    // Extract the cookie value for subsequent requests
    const cookieMatch = setCookie.match(/gate=[^;]+/);
    expect(cookieMatch).toBeTruthy();
    const gateCookie = cookieMatch![0];

    // Now access a gated route with the cookie
    const res = await fetch(`${ctx.baseUrl}/api/health`, {
      headers: { Cookie: gateCookie },
    });
    expect(res.status).toBe(200);
  });

  it('rejects forged gate cookie', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/projects`, {
      redirect: 'manual',
      headers: { Cookie: 'gate=forged-value' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/gate.html');
  });

  it('disables gate when GATE_PASSWORD not set', async () => {
    config.gatePassword = '';

    // Should pass through without gate cookie
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
