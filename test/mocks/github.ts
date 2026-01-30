// ============================================================
// GitHub API Mock
// Intercepts github.ts service functions for testing
// ============================================================

import type { GitHubUser, GitHubRepo } from '../../src/server/services/github';

// Store mock configurations
let mockUser: GitHubUser | null = null;
let mockToken: string | null = null;
let mockOrgRepos: GitHubRepo[] = [];
let mockIsMember: boolean = false;

export function setMockUser(user: GitHubUser) {
  mockUser = user;
}

export function setMockToken(token: string) {
  mockToken = token;
}

export function setMockOrgRepos(repos: GitHubRepo[]) {
  mockOrgRepos = repos;
}

export function setMockIsMember(isMember: boolean) {
  mockIsMember = isMember;
}

export function resetMocks() {
  mockUser = null;
  mockToken = null;
  mockOrgRepos = [];
  mockIsMember = false;
}

export function getMockUser() { return mockUser; }
export function getMockToken() { return mockToken; }
export function getMockOrgRepos() { return mockOrgRepos; }
export function getMockIsMember() { return mockIsMember; }

// Default test fixtures
export const testGitHubUser: GitHubUser = {
  id: 12345,
  login: 'testuser',
  type: 'User',
  avatar_url: 'https://avatars.githubusercontent.com/u/12345',
};

export const testOrgRepos: GitHubRepo[] = [
  {
    id: 1001,
    name: 'repo-alpha',
    full_name: 'test-org/repo-alpha',
    description: 'Main repository',
    language: 'TypeScript',
    stargazers_count: 500,
    forks_count: 50,
    default_branch: 'main',
    license: { spdx_id: 'MIT' },
    html_url: 'https://github.com/test-org/repo-alpha',
  },
  {
    id: 1002,
    name: 'repo-beta',
    full_name: 'test-org/repo-beta',
    description: 'Secondary repository',
    language: 'Python',
    stargazers_count: 100,
    forks_count: 10,
    default_branch: 'main',
    license: { spdx_id: 'Apache-2.0' },
    html_url: 'https://github.com/test-org/repo-beta',
  },
];
