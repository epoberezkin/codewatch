import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestUser, createTestSession, authenticatedFetch } from '../helpers';
import { testGitHubUser } from '../mocks/github';

// Hoisted mutable state for configurable token scope
const mockAuthState = vi.hoisted(() => ({
  tokenScope: 'read:org',
}));

// Mock the github service module before importing anything that uses it
vi.mock('../../src/server/services/github', () => ({
  getOAuthUrl: (state?: string) => `https://github.com/login/oauth/authorize?client_id=test&scope=read%3Aorg${state ? `&state=${state}` : ''}`,
  exchangeCodeForToken: async (_code: string) => ({ accessToken: 'mock-github-token-abc123', scope: mockAuthState.tokenScope }),
  getAuthenticatedUser: async (_token: string) => ({
    id: 12345,
    login: 'testuser',
    type: 'User',
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

vi.mock('../../src/server/services/ownership', () => ({
  resolveOwnership: async () => ({ isOwner: true, cached: false }),
  invalidateOwnershipCache: async () => {},
}));

describe('Auth API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool);
    mockAuthState.tokenScope = 'read:org';
  });

  describe('GET /auth/github', () => {
    it('redirects to GitHub OAuth URL', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/github`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('github.com/login/oauth/authorize');
    });

    it('includes state parameter for returnTo', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/github?returnTo=/project/abc123`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      const location = res.headers.get('location')!;
      expect(location).toContain('&state=');
    });

    it('OAuth URL includes read:org scope', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/github`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location')!;
      // The scope parameter should contain read:org (URL-encoded as read%3Aorg)
      expect(location).toMatch(/scope=read%3Aorg/);
    });
  });

  describe('GET /auth/github/callback', () => {
    it('returns 400 without code parameter', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/github/callback`);
      expect(res.status).toBe(400);
    });

    it('creates user and session on successful callback', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/github/callback?code=test-code`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      // Check cookie was set
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('session=');

      // Verify user was created in DB
      const { rows: users } = await ctx.pool.query(
        'SELECT * FROM users WHERE github_id = $1',
        [testGitHubUser.id]
      );
      expect(users).toHaveLength(1);
      expect(users[0].github_username).toBe('testuser');
      expect(users[0].github_type).toBe('User');

      // Verify session was created
      const { rows: sessions } = await ctx.pool.query(
        'SELECT * FROM sessions WHERE user_id = $1',
        [users[0].id]
      );
      expect(sessions).toHaveLength(1);
    });

    it('updates existing user on re-login', async () => {
      // First login
      await fetch(`${ctx.baseUrl}/auth/github/callback?code=test-code`, {
        redirect: 'manual',
      });

      // Second login
      await fetch(`${ctx.baseUrl}/auth/github/callback?code=test-code-2`, {
        redirect: 'manual',
      });

      // Should still be one user
      const { rows: users } = await ctx.pool.query(
        'SELECT * FROM users WHERE github_id = $1',
        [testGitHubUser.id]
      );
      expect(users).toHaveLength(1);

      // But two sessions
      const { rows: sessions } = await ctx.pool.query(
        'SELECT * FROM sessions WHERE user_id = $1',
        [users[0].id]
      );
      expect(sessions).toHaveLength(2);
    });

    it('stores has_org_scope=true when scope includes read:org', async () => {
      mockAuthState.tokenScope = 'read:org';

      await fetch(`${ctx.baseUrl}/auth/github/callback?code=test-code`, {
        redirect: 'manual',
      });

      const { rows: sessions } = await ctx.pool.query(
        `SELECT s.has_org_scope FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE u.github_id = $1
         ORDER BY s.created_at DESC LIMIT 1`,
        [testGitHubUser.id]
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].has_org_scope).toBe(true);
    });

    it('stores has_org_scope=false when scope lacks read:org', async () => {
      mockAuthState.tokenScope = 'repo';

      await fetch(`${ctx.baseUrl}/auth/github/callback?code=test-code`, {
        redirect: 'manual',
      });

      const { rows: sessions } = await ctx.pool.query(
        `SELECT s.has_org_scope FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE u.github_id = $1
         ORDER BY s.created_at DESC LIMIT 1`,
        [testGitHubUser.id]
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].has_org_scope).toBe(false);
    });

    it('respects returnTo state parameter', async () => {
      // Step 1: Get the OAuth redirect URL with returnTo
      const authRes = await fetch(`${ctx.baseUrl}/auth/github?returnTo=/project/abc123`, {
        redirect: 'manual',
      });
      expect(authRes.status).toBe(302);
      const oauthUrl = authRes.headers.get('location')!;

      // Extract the state parameter from the OAuth URL
      const url = new URL(oauthUrl);
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();

      // Step 2: Call the callback with the extracted state
      const callbackRes = await fetch(
        `${ctx.baseUrl}/auth/github/callback?code=test-code&state=${encodeURIComponent(state!)}`,
        { redirect: 'manual' }
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get('location')).toBe('/project/abc123');
    });
  });

  describe('GET /auth/me', () => {
    it('returns 401 without session cookie', async () => {
      const res = await fetch(`${ctx.baseUrl}/auth/me`);
      expect(res.status).toBe(401);
    });

    it('returns user info with valid session', async () => {
      const user = await createTestUser(ctx.pool, {
        githubId: 99999,
        username: 'autheduser',
      });
      const session = await createTestSession(ctx.pool, user.id);

      const res = await authenticatedFetch(`${ctx.baseUrl}/auth/me`, session.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe(user.id);
      expect(body.username).toBe('autheduser');
      expect(body.githubType).toBe('User');
    });

    it('returns 401 with invalid session', async () => {
      const res = await authenticatedFetch(
        `${ctx.baseUrl}/auth/me`,
        'session=00000000-0000-0000-0000-000000000000'
      );
      expect(res.status).toBe(401);
    });

    it('includes hasOrgScope in response', async () => {
      const user = await createTestUser(ctx.pool, { githubId: 99998, username: 'scopeuser' });
      const session = await createTestSession(ctx.pool, user.id, { hasOrgScope: true });

      const res = await authenticatedFetch(`${ctx.baseUrl}/auth/me`, session.cookie);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.hasOrgScope).toBe(true);
    });

    it('returns 401 for expired session', async () => {
      const user = await createTestUser(ctx.pool, { githubId: 99997, username: 'expireduser' });
      const session = await createTestSession(ctx.pool, user.id);

      // Manually set the session's expires_at to the past
      await ctx.pool.query(
        `UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [session.sessionId]
      );

      const res = await authenticatedFetch(`${ctx.baseUrl}/auth/me`, session.cookie);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears session and cookie', async () => {
      const session = await createTestSession(ctx.pool);

      const res = await authenticatedFetch(`${ctx.baseUrl}/auth/logout`, session.cookie, {
        method: 'POST',
      });
      expect(res.status).toBe(200);

      // Session should be deleted from DB
      const { rows } = await ctx.pool.query(
        'SELECT * FROM sessions WHERE id = $1',
        [session.sessionId]
      );
      expect(rows).toHaveLength(0);

      // Cookie should be cleared
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('session=');
    });

    it('/auth/me returns 401 after logout', async () => {
      const session = await createTestSession(ctx.pool);

      // Logout
      await authenticatedFetch(`${ctx.baseUrl}/auth/logout`, session.cookie, {
        method: 'POST',
      });

      // Check auth
      const res = await authenticatedFetch(`${ctx.baseUrl}/auth/me`, session.cookie);
      expect(res.status).toBe(401);
    });
  });
});
