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

export async function getOrgMembershipRole(org: string, token: string): Promise<OrgMembership | null> {
  const res = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );

  if (!res.ok) return null; // 404 = not a member, 403 = no scope

  const body = await res.json() as { role: string; state: string };
  return {
    role: body.role as 'admin' | 'member',
    state: body.state as 'active' | 'pending',
  };
}

// ---------- Ownership Verification ----------

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

  // Org account without read:org scope — can't verify
  if (!hasOrgScope) {
    return { isOwner: false, needsReauth: true };
  }

  // Org account with scope — check membership role
  const membership = await getOrgMembershipRole(githubOrg, githubToken);
  if (!membership) {
    return { isOwner: false };
  }

  const isOwner = membership.role === 'admin' && membership.state === 'active';
  return { isOwner, role: membership.role };
}

// ---------- Entity Info ----------

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

export async function listRepoBranches(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubBranch[]> {
  const branches: GitHubBranch[] = [];
  let page = 1;

  while (true) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

    const batch = await res.json() as Array<{ name: string }>;
    branches.push(...batch.map(b => ({ name: b.name })));
    if (batch.length < 100) break;
    page++;
  }

  return branches;
}

// ---------- Commit Date (for shallow-since) ----------

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
  const body = await res.json() as { commit: { committer: { date: string } } };
  return new Date(body.commit.committer.date);
}

// ---------- Issue Creation (for owner notification) ----------

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
