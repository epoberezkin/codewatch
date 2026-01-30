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

// ---------- OAuth ----------

export function getOAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.callbackUrl,
    scope: '', // zero scopes — read-only public access
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
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

  const body = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (body.error) {
    throw new Error(`GitHub OAuth error: ${body.error_description || body.error}`);
  }
  return body.access_token!;
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

// ---------- Ownership Check ----------

export async function isOrgMember(org: string, username: string, token: string): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  return res.status === 204; // 204 = is member, 404 = not member
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
