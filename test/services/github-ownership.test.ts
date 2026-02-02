import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock config to prevent env var errors
vi.mock('../../src/server/config', () => ({
  config: {
    github: { clientId: 'test', clientSecret: 'test', callbackUrl: 'http://localhost/callback' },
  },
}));

import { getOrgMembershipRole, checkGitHubOwnership } from '../../src/server/services/github';

describe('getOrgMembershipRole', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns membership and httpStatus on 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'admin', state: 'active' }),
    });

    const result = await getOrgMembershipRole('test-org', 'valid-token');
    expect(result.httpStatus).toBe(200);
    expect(result.membership).toEqual({ role: 'admin', state: 'active' });
  });

  it('returns null membership and 403 on forbidden', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });

    const result = await getOrgMembershipRole('test-org', 'no-scope-token');
    expect(result.httpStatus).toBe(403);
    expect(result.membership).toBeNull();
  });

  it('returns null membership and 404 when not a member', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await getOrgMembershipRole('other-org', 'valid-token');
    expect(result.httpStatus).toBe(404);
    expect(result.membership).toBeNull();
  });
});

// Helper: create a mock that returns different responses for different URLs
function mockFetchSequence(handlers: Array<{ match: string; response: any }>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const h of handlers) {
      if (url.includes(h.match)) {
        return Promise.resolve(h.response);
      }
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

describe('checkGitHubOwnership', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns isOwner=true with role=personal when username matches org', async () => {
    const result = await checkGitHubOwnership('epoberezkin', 'epoberezkin', 'token', true);
    expect(result).toEqual({ isOwner: true, role: 'personal' });
  });

  it('returns isOwner=true with role=personal case-insensitive', async () => {
    const result = await checkGitHubOwnership('EpoBerezkin', 'epoberezkin', 'token', false);
    expect(result).toEqual({ isOwner: true, role: 'personal' });
  });

  it('tries API even when hasOrgScope is false and returns admin role', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'admin', state: 'active' }),
    });

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', false);
    expect(result.isOwner).toBe(true);
    expect(result.role).toBe('admin');
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('returns isOwner=true with role=admin for org admin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'admin', state: 'active' }),
    });

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', true);
    expect(result.isOwner).toBe(true);
    expect(result.role).toBe('admin');
  });

  it('returns isOwner=false for org member (non-admin)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'member', state: 'active' }),
    });

    const result = await checkGitHubOwnership('simplex-chat', 'member-user', 'token', true);
    expect(result.isOwner).toBe(false);
    expect(result.role).toBe('member');
  });

  it('returns isOwner=false for pending admin', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ role: 'admin', state: 'pending' }),
    });

    const result = await checkGitHubOwnership('simplex-chat', 'pending-admin', 'token', true);
    expect(result.isOwner).toBe(false);
    expect(result.role).toBe('admin');
  });

  it('returns isOwner=false without needsReauth on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await checkGitHubOwnership('other-org', 'epoberezkin', 'token', true);
    expect(result).toEqual({ isOwner: false });
  });

  // ---- Fallback via repo permissions (when membership API returns 403) ----

  it('falls back to repo permissions on 403 and detects admin', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/simplex-chat/repos',
        response: {
          ok: true, status: 200,
          json: async () => [{ name: 'simplex-chat', permissions: { admin: true, push: true } }],
        },
      },
    ]);

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', true);
    expect(result.isOwner).toBe(true);
    expect(result.role).toBe('admin');
  });

  it('falls back to repo permissions on 403 — write access is not enough for ownership', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/simplex-chat/repos',
        response: {
          ok: true, status: 200,
          json: async () => [{ name: 'simplex-chat', permissions: { admin: false, push: true } }],
        },
      },
    ]);

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', true);
    expect(result.isOwner).toBe(false);
    expect(result.role).toBeUndefined();
  });

  it('falls back to individual repo fetch when list has no permissions', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/simplex-chat/repos',
        response: {
          ok: true, status: 200,
          json: async () => [{ name: 'simplex-chat' }], // no permissions field
        },
      },
      {
        match: '/repos/simplex-chat/simplex-chat',
        response: {
          ok: true, status: 200,
          json: async () => ({ permissions: { admin: true, push: true } }),
        },
      },
    ]);

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', true);
    expect(result.isOwner).toBe(true);
    expect(result.role).toBe('admin');
  });

  it('returns isOwner=false when 403 and fallback also fails', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/simplex-chat/repos',
        response: { ok: false, status: 403 },
      },
    ]);

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', true);
    expect(result).toEqual({ isOwner: false });
  });

  it('returns isOwner=false when 403 and org has no public repos', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/empty-org/repos',
        response: {
          ok: true, status: 200,
          json: async () => [],
        },
      },
    ]);

    const result = await checkGitHubOwnership('empty-org', 'epoberezkin', 'token', true);
    expect(result).toEqual({ isOwner: false });
  });

  it('falls back correctly when hasOrgScope is false and API returns 403', async () => {
    globalThis.fetch = mockFetchSequence([
      {
        match: '/user/memberships/orgs/',
        response: { ok: false, status: 403 },
      },
      {
        match: '/orgs/simplex-chat/repos',
        response: {
          ok: true, status: 200,
          json: async () => [{ name: 'simplex-chat', permissions: { admin: true, push: true } }],
        },
      },
    ]);

    const result = await checkGitHubOwnership('simplex-chat', 'epoberezkin', 'token', false);
    expect(result.isOwner).toBe(true);
    expect(result.role).toBe('admin');
  });
});
