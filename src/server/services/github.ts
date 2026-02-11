// Spec: spec/services/github.md
import { config } from '../config';

// ---------- Types ----------

export interface GitHubUser {
  id: number;
  login: string;
  type: string; // 'User' or 'Organization'
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  default_branch: string;
  license: { spdx_id: string } | null;
  html_url: string;
}

export interface GitHubEntity {
  login: string;
  type: 'User' | 'Organization';
  avatarUrl: string;
}

export interface GitHubBranch {
  name: string;
}

// ---------- Types (Ownership) ----------

export interface OrgMembership {
  role: 'admin' | 'member';
  state: 'active' | 'pending';
}

export interface OwnershipCheck {
  isOwner: boolean;
  role?: string;
  needsReauth?: boolean;
}

// ---------- OAuth ----------

// Spec: spec/services/github.md#getOAuthUrl
export function getOAuthUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.callbackUrl,
    scope: 'read:org',
  });
  if (state) {
    params.set('state', state);
  }
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// Spec: spec/services/github.md#exchangeCodeForToken
export async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; scope: string }> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
    }),
  });

  const body = await res.json() as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (body.error) {
    throw new Error(`GitHub OAuth error: ${body.error_description || body.error}`);
  }
  return { accessToken: body.access_token!, scope: body.scope || '' };
}

// ---------- User Info ----------

// Spec: spec/services/github.md#getAuthenticatedUser
export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<GitHubUser>;
}

// ---------- Org Repos ----------

// Spec: spec/services/github.md#listOrgRepos
export async function listOrgRepos(org: string, token?: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}&type=public&sort=stars&direction=desc`,
      { headers }
    );

    if (!res.ok) {
      // Try as a user if org endpoint fails
      if (res.status === 404 && page === 1) {
        console.warn(`[GitHub] Org endpoint returned 404 for "${org}", falling back to user repos`);
        return listUserRepos(org, token);
      }
      throw new Error(`GitHub API error: ${res.status}`);
    }

    const batch = await res.json() as GitHubRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return repos;
}

// Spec: spec/services/github.md#listUserRepos
async function listUserRepos(username: string, token?: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&type=public&sort=stars&direction=desc`,
      { headers }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

    const batch = await res.json() as GitHubRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return repos;
}

// ---------- Org Membership Role ----------

// Spec: spec/services/github.md#getOrgMembershipRole
export async function getOrgMembershipRole(
  org: string, token: string,
): Promise<{ membership: OrgMembership | null; httpStatus: number }> {
  const res = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );

  if (!res.ok) return { membership: null, httpStatus: res.status };

  const body = await res.json() as { role: string; state: string };
  return {
    membership: {
      role: body.role as 'admin' | 'member',
      state: body.state as 'active' | 'pending',
    },
    httpStatus: res.status,
  };
}

// ---------- Repo Permission Fallback ----------

/**
 * Fallback ownership check via repo permissions.
 * When the org membership API returns 403 (e.g. org has third-party app
 * restrictions), we check if the user has admin permission on the org's
 * repos instead. Public repo endpoints work even with org restrictions.
 */
async function checkOrgRoleViaRepoPermissions(
  org: string, token: string,
): Promise<'admin' | 'write' | 'read' | null> {
  try {
    const res = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=1&type=public&sort=pushed`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!res.ok) return null;
    const repos = await res.json() as Array<{ name: string; permissions?: { admin?: boolean; push?: boolean } }>;
    if (repos.length === 0) return null;

    // The list endpoint may include permissions for the authenticated user
    const perms = repos[0].permissions;
    if (perms) {
      if (perms.admin) return 'admin';
      if (perms.push) return 'write';
      return 'read';
    }

    // If not included in list, fetch the specific repo
    const repoRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repos[0].name)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!repoRes.ok) return null;
    const repo = await repoRes.json() as { permissions?: { admin?: boolean; push?: boolean } };
    if (!repo.permissions) return null;
    if (repo.permissions.admin) return 'admin';
    if (repo.permissions.push) return 'write';
    return 'read';
  } catch {
    return null;
  }
}

// ---------- Ownership Verification ----------

// Spec: spec/services/github.md#checkGitHubOwnership
export async function checkGitHubOwnership(
  githubOrg: string,
  githubUsername: string,
  githubToken: string,
  hasOrgScope: boolean,
): Promise<OwnershipCheck> {
  // Personal account: owner when username matches org
  if (githubOrg.toLowerCase() === githubUsername.toLowerCase()) {
    return { isOwner: true, role: 'personal' };
  }

  // Primary: try the membership API (works when app is approved for org)
  const { membership, httpStatus } = await getOrgMembershipRole(githubOrg, githubToken);
  if (membership) {
    const isOwner = membership.role === 'admin' && membership.state === 'active';
    return { isOwner, role: membership.role };
  }

  // Fallback on 403: org likely has third-party app restrictions.
  // Check repo permissions instead — public repo endpoints still work.
  if (httpStatus === 403) {
    const repoRole = await checkOrgRoleViaRepoPermissions(githubOrg, githubToken);
    if (repoRole === 'admin') {
      return { isOwner: true, role: 'admin' };
    }
    // write/read on public repos is not a reliable signal —
    // any authenticated user gets pull access to public repos.
    // Can't verify ownership.
    return { isOwner: false };
  }

  // 404 = not a member, other errors → not owner
  return { isOwner: false };
}

// ---------- Entity Info ----------

// Spec: spec/services/github.md#getGitHubEntity
export async function getGitHubEntity(name: string, token?: string): Promise<GitHubEntity> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(name)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const body = await res.json() as { login: string; type: string; avatar_url: string };
  return {
    login: body.login,
    type: body.type as 'User' | 'Organization',
    avatarUrl: body.avatar_url,
  };
}

// ---------- Repo Info ----------

// Spec: spec/services/github.md#getRepoDefaultBranch
export async function getRepoDefaultBranch(
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const body = await res.json() as { default_branch: string };
  return body.default_branch;
}

// ---------- Repo Branches ----------

// Spec: spec/services/github.md#listRepoBranches
export async function listRepoBranches(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubBranch[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
          nodes {
            name
            target { ... on Commit { committedDate } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

  const all: Array<{ name: string; date: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { owner, repo, cursor } }),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL error: ${res.status}`);

    const body = await res.json() as {
      data?: { repository?: { refs?: {
        nodes: Array<{ name: string; target?: { committedDate?: string } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${body.errors[0].message}`);
    }

    const refs = body.data?.repository?.refs;
    if (!refs) break;

    for (const n of refs.nodes) {
      all.push({ name: n.name, date: n.target?.committedDate || '' });
    }

    if (!refs.pageInfo.hasNextPage) break;
    cursor = refs.pageInfo.endCursor;
  }

  all.sort((a, b) => b.date.localeCompare(a.date));
  return all.map(b => ({ name: b.name }));
}

// ---------- Commit Date (for shallow-since) ----------

// Spec: spec/services/github.md#getCommitDate
export async function getCommitDate(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<Date> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub API error fetching commit date: ${res.status}`);
  const body = await res.json() as { commit: { author: { date: string }; committer: { date: string } } };
  return new Date(body.commit.author.date);
}

// ---------- Issue Creation (for owner notification) ----------

// Spec: spec/services/github.md#createIssue
export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<{ html_url: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body }),
    }
  );
  if (!res.ok) throw new Error(`GitHub API error creating issue: ${res.status}`);
  return res.json() as Promise<{ html_url: string }>;
}
