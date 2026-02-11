# Testing Specification

## Testing Framework

**Vitest** with the following configuration (`vitest.config.ts`, 16 lines):

```ts
test: {
  include: ['test/**/*.test.ts'],
  testTimeout: 30000,    // 30s per test
  hookTimeout: 30000,    // 30s per hook (beforeAll, afterAll, etc.)
  coverage: {
    provider: 'v8',
    include: ['src/server/**/*.ts'],
    exclude: ['src/server/migrate.ts'],
    reporter: ['text', 'html'],
    reportsDirectory: 'coverage',
  },
}
```

- **Test discovery**: All `test/**/*.test.ts` files.
- **Coverage provider**: V8 (native, faster than Istanbul).
- **Coverage scope**: `src/server/**/*.ts`, excluding `src/server/migrate.ts`.
- **Coverage reporters**: terminal text + HTML report in `coverage/`.

---

## Test Infrastructure

### Database Setup (`test/setup.ts`, 91 lines)

Each test run gets a **temporary PostgreSQL database** that is created and destroyed automatically.

| Step | Detail | Source |
|------|--------|--------|
| 1. Name generation | `codewatch_test_<timestamp>_<random>` | `setup.ts:26` |
| 2. Create DB | Admin pool connects to `DATABASE_URL` (default: `postgresql://localhost:5432/postgres`), runs `CREATE DATABASE` | `setup.ts:29-30` |
| 3. Init pool | `initPool(testDbUrl)` from `src/server/db` | `setup.ts:37` |
| 4. Run migrations | `runMigrations(pool)` from `src/server/db` | `setup.ts:38` |
| 5. Per-test cleanup | `truncateAllTables(pool)` truncates all public tables except `_migrations`, then re-seeds `model_pricing` | `setup.ts:71-89` |
| 6. Teardown | Closes server, ends pool, `DROP DATABASE` via admin pool | `setup.ts:58-69` |

**Exported types and functions:**
- `TestContext` -- `{ baseUrl, server, pool, dbName }` (`setup.ts:16-21`)
- `setupTestDatabase()` -- returns `{ pool, dbName }` (`setup.ts:25-41`)
- `startTestServer()` -- sets up DB + Express on random port, returns `TestContext` (`setup.ts:43-56`)
- `teardownTestServer(ctx)` -- closes server, drops DB (`setup.ts:58-69`)
- `truncateAllTables(pool)` -- per-test state reset (`setup.ts:71-90`)
- `TEST_MODEL_PRICING` -- fixture data for opus/sonnet/haiku (`setup.ts:8-12`)

### Server Setup (`test/setup.ts:43-56`)

The test server is a **real Express app** started on an ephemeral port (`app.listen(0)`):

1. `createApp()` from `src/server/app` creates the full Express application.
2. Bound to port 0 (OS-assigned random port).
3. `baseUrl` is `http://localhost:<port>`.
4. Tests make **real HTTP requests** via `fetch()` or `authenticatedFetch()`.

This is an integration test strategy -- no supertest, no request mocking. Tests exercise the full HTTP stack.

### GitHub Mocking Strategy

GitHub API calls are mocked at the **service module level** using `vi.mock()`. There are two patterns:

#### Pattern 1: Shared mock fixtures (`test/mocks/github.ts`, 75 lines)

Provides configurable mock state and default fixtures:

| Export | Purpose | Source |
|--------|---------|--------|
| `setMockUser(user)` | Configure mock user response | `github.ts:14-16` |
| `setMockToken(token)` | Configure mock token | `github.ts:18-20` |
| `setMockOrgRepos(repos)` | Configure mock org repos | `github.ts:22-24` |
| `setMockIsMember(bool)` | Configure membership check | `github.ts:26-28` |
| `resetMocks()` | Reset all mock state to defaults | `github.ts:30-35` |
| `getMockUser()` | Read current mock user | `github.ts:37` |
| `getMockToken()` | Read current mock token | `github.ts:38` |
| `getMockOrgRepos()` | Read current mock repos | `github.ts:39` |
| `getMockIsMember()` | Read current membership | `github.ts:40` |
| `testGitHubUser` | Default fixture: `{ id: 12345, login: 'testuser', ... }` | `github.ts:43-48` |
| `testOrgRepos` | Default fixtures: `repo-alpha` (TS/MIT) and `repo-beta` (Python/Apache-2.0) | `github.ts:50-75` |

#### Pattern 2: Per-file inline `vi.mock()` (dominant pattern)

Most test files define their own inline mocks at the top of the file, mocking `../../src/server/services/github` directly. The standard mock surface covers:

- `getOAuthUrl`, `exchangeCodeForToken`, `getAuthenticatedUser`
- `listOrgRepos`, `getOrgMembershipRole`, `checkGitHubOwnership`
- `createIssue`, `getGitHubEntity`, `listRepoBranches`, `getRepoDefaultBranch`, `getCommitDate`

Tests that need **dynamic mock behavior** use `vi.hoisted()` to create mutable state objects that the mock factory closures read from. This allows per-test configuration. Examples:
- `auth.test.ts:7-9` -- `mockAuthState.tokenScope` controls OAuth scope per test.
- `ownership.test.ts:6-9` -- `mockGitHubState.ownershipResult` toggles owner/non-owner.
- `delete.test.ts:6-8` -- `mockOwnershipState.ownerUserIds` controls who is an owner.

[GAP] The `test/mocks/github.ts` shared mock module provides `setMock*`/`getMock*` helpers, but no test file appears to import the setter functions. The per-file inline `vi.mock()` pattern is used universally instead.

[REC] Consider either (a) removing the unused setter/getter functions from `test/mocks/github.ts`, or (b) refactoring test files to use the shared mock module to reduce ~30 lines of duplicated mock boilerplate per test file.

#### Additional mocked services

Several test files also mock:
- `../../src/server/services/git` -- `cloneOrUpdate`, `scanCodeFiles` (e.g., `projects.test.ts:26`, `component-selection.test.ts:26`)
- `../../src/server/services/claude` -- `callClaude` (e.g., `estimate.test.ts:19`)
- `../../src/server/services/ownership` -- `resolveOwnership`, `invalidateOwnershipCache` (e.g., `auth.test.ts:34-37`)
- `@anthropic-ai/sdk` -- Full Anthropic SDK mock with `MockAnthropic` class (e.g., `componentAnalysis.test.ts:22`)
- `../../src/server/config` -- Config mock for unit tests (e.g., `github-ownership.test.ts:4-8`)

---

## Test Patterns

### API Test Structure

Every API test file follows the same lifecycle pattern:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TestContext, startTestServer, teardownTestServer, truncateAllTables } from '../setup';
import { createTestSession, authenticatedFetch } from '../helpers';

// vi.mock() calls at module top level
// vi.hoisted() for mutable mock state (optional)

describe('Feature Name', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();    // Create temp DB + start server
  });

  afterAll(async () => {
    await teardownTestServer(ctx);    // Drop DB + close server
  });

  beforeEach(async () => {
    await truncateAllTables(ctx.pool); // Reset state between tests
  });

  describe('VERB /api/endpoint', () => {
    it('description of behavior', async () => {
      // 1. Arrange: create user/session via helpers, set mock state
      // 2. Act: make HTTP request via fetch() or authenticatedFetch()
      // 3. Assert: check status, body, DB state
    });
  });
});
```

Key aspects:
- **One server per `describe` suite** (created in `beforeAll`, torn down in `afterAll`).
- **Full table truncation before each test** (in `beforeEach`).
- **Nested `describe` blocks** group tests by endpoint or feature.
- **Direct DB assertions** via `ctx.pool.query()` to verify side effects.

### Helper Functions (`test/helpers.ts`, 71 lines)

| Function | Signature | Purpose | Source |
|----------|-----------|---------|--------|
| `createTestUser` | `(pool, overrides?) => Promise<TestUser>` | Inserts a user into `users` table with random `github_id` and username. Overrides: `githubId`, `username`, `githubType`. | `helpers.ts:16-33` |
| `createTestSession` | `(pool, userId?, options?) => Promise<TestSession>` | Creates a session in the `sessions` table. Auto-creates a user if `userId` not provided. Options: `{ hasOrgScope }`. Returns `{ sessionId, userId, cookie }`. | `helpers.ts:35-57` |
| `authenticatedFetch` | `(url, sessionCookie, options?) => Promise<Response>` | Wrapper around `fetch()` that injects the `Cookie` header. | `helpers.ts:59-71` |

**Exported types:**
- `TestUser` -- `{ id, githubId, username }` (`helpers.ts:4-8`)
- `TestSession` -- `{ sessionId, userId, cookie }` (`helpers.ts:10-14`)

### Service Test Pattern

Service tests (`test/services/`) differ from API tests:
- **`git.test.ts`**: Uses a local fixture directory (`test/fixtures/sample-project`), creates a temporary git repo in `beforeAll`, cleans up `.git` in `afterAll`. No server or DB.
- **`git-shallow.test.ts`**: Mocks `simple-git` and `fs` via `vi.mock()`. Tests `cloneOrUpdate` and `getCommitDate` in isolation.
- **`github-ownership.test.ts`**: Mocks `globalThis.fetch` directly to test `getOrgMembershipRole` and `checkGitHubOwnership` at the function level.
- **`planning.test.ts`** and **`componentAnalysis.test.ts`**: Full integration pattern (DB + server) with mocked Anthropic SDK. Use `vi.hoisted()` for mock state including Claude responses and filesystem state.

---

## Test File Inventory

### API Tests (`test/api/`)

| File | Lines | Tests |
|------|------:|-------|
| `smoke.test.ts` | 61 | Health check (`GET /`, `GET /api/health`), DB table existence, model_pricing seed data |
| `auth.test.ts` | 290 | OAuth flow (`GET /auth/github`, callback), session creation, `GET /auth/me`, `POST /auth/logout`, org scope handling |
| `projects.test.ts` | 262 | `GET /api/github/orgs/:org/repos`, `POST /api/projects` (create), `GET /api/projects/:id` |
| `project-pages.test.ts` | 625 | `GET /api/projects/browse` (pagination, filtering, search), `GET /api/projects/:id` (detail view), ownership badges |
| `audit.test.ts` | 1121 | `POST /api/audit/start`, full audit flow, `GET /api/audit/:id`, report generation, findings, comments, publish, `GET /api/reports`, project audits list, incremental audits, `PATCH /api/findings/:id/status`, API key security |
| `estimate.test.ts` | 194 | `POST /api/estimate` -- cost estimation with Claude mock |
| `gate.test.ts` | 113 | Development gate (password protection via config) |
| `journey.test.ts` | 311 | End-to-end: create project -> classify -> audit -> publish -> browse -> verify |
| `ownership.test.ts` | 567 | Ownership resolution, caching, ownership-gated endpoints, `isOwner`/`isRequester` flags, report access tiers |
| `delete.test.ts` | 330 | `DELETE /api/audit/:id`, `DELETE /api/projects/:id`, ownership checks |
| `disclosure.test.ts` | 519 | `POST /api/audit/:id/notify-owner`, three-tier report access (owner/requester/public), response fields |
| `unpublish.test.ts` | 153 | Unpublish audit endpoint, ownership checks |
| `schema.test.ts` | 149 | `project_dependencies` self-reference check constraint, `audit_commits` NOT NULL constraints |
| `component-selection.test.ts` | 682 | `POST /api/estimate/components`, component-scoped audits, supply chain, report component breakdown and dependencies |

### Service Tests (`test/services/`)

| File | Lines | Tests |
|------|------:|-------|
| `git.test.ts` | 74 | `scanCodeFiles` on fixture directory |
| `git-shallow.test.ts` | 213 | Shallow clones (`cloneOrUpdate`), clone progress tracking, `getCommitDate` |
| `github-ownership.test.ts` | 265 | `getOrgMembershipRole` (200/404/403/network error), `checkGitHubOwnership` (org admin/member/non-member, personal repos) |
| `planning.test.ts` | 565 | Local security greps, Claude planning call, token-budget file selection, combined planning phase (`runPlanningPhase`) |
| `componentAnalysis.test.ts` | 1167 | Agentic component analysis (multi-turn Claude tool use), component analysis API endpoints |

### Infrastructure Files

| File | Lines | Purpose |
|------|------:|---------|
| `setup.ts` | 91 | Database lifecycle, server lifecycle, table truncation |
| `helpers.ts` | 71 | Test user/session creation, authenticated fetch |
| `mocks/github.ts` | 75 | Shared GitHub mock state and fixtures |

**Total**: 7,897 lines across 22 files (19 test + 3 infrastructure).

---

## Coverage Configuration

From `vitest.config.ts:8-14`:

| Setting | Value |
|---------|-------|
| Provider | `v8` |
| Included | `src/server/**/*.ts` |
| Excluded | `src/server/migrate.ts` |
| Reporters | `text` (terminal), `html` (browseable) |
| Output directory | `coverage/` |

[GAP] No coverage thresholds are configured (no `branches`, `functions`, `lines`, or `statements` minimums).

[REC] Add coverage thresholds to prevent regression. Example:
```ts
coverage: {
  // ...existing config
  thresholds: { lines: 80, functions: 80, branches: 70 },
}
```

---

## Gaps and Recommendations

| # | Type | Description |
|---|------|-------------|
| 1 | [GAP] | `test/mocks/github.ts` setter/getter functions (`setMockUser`, `getMockUser`, etc.) appear unused -- all test files use inline `vi.mock()` instead. |
| 2 | [REC] | Consolidate GitHub mocking: either delete unused `setMock*`/`getMock*` or refactor tests to use them, eliminating ~30 lines of duplicated mock boilerplate per file. |
| 3 | [GAP] | No coverage thresholds configured in `vitest.config.ts`. |
| 4 | [REC] | Add `thresholds` to coverage config to enforce minimum coverage. |
| 5 | [GAP] | No `globalSetup`/`globalTeardown` in vitest config. Each test file creates/destroys its own database, meaning N concurrent test files create N databases. |
| 6 | [REC] | If test parallelism causes DB connection exhaustion, consider a global setup that creates a single test DB and uses transaction rollback isolation instead. |
| 7 | [GAP] | No shared helper for creating projects, audits, or findings. Each test file manually inserts via raw SQL or API calls. |
| 8 | [REC] | Add `createTestProject()`, `createTestAudit()`, and `createTestFinding()` helpers to `test/helpers.ts` to reduce setup boilerplate in `audit.test.ts`, `delete.test.ts`, `disclosure.test.ts`, etc. |
| 9 | [GAP] | `test/mocks/` only contains `github.ts`. Claude, git, and ownership mocks are duplicated inline across multiple test files. |
| 10 | [REC] | Create `test/mocks/claude.ts`, `test/mocks/git.ts`, and `test/mocks/ownership.ts` shared mock modules for the commonly-mocked services. |

---

## Source References

| File | Key Lines |
|------|-----------|
| `vitest.config.ts` | L1-16: Full config |
| `test/setup.ts` | L8-12: `TEST_MODEL_PRICING`; L16-21: `TestContext`; L25-41: `setupTestDatabase`; L43-56: `startTestServer`; L58-69: `teardownTestServer`; L71-90: `truncateAllTables` |
| `test/helpers.ts` | L4-8: `TestUser`; L10-14: `TestSession`; L16-33: `createTestUser`; L35-57: `createTestSession`; L59-71: `authenticatedFetch` |
| `test/mocks/github.ts` | L14-28: Setter functions; L30-35: `resetMocks`; L37-40: Getter functions; L43-48: `testGitHubUser` fixture; L50-75: `testOrgRepos` fixture |
| `test/api/smoke.test.ts` | L4-61: Canonical minimal test pattern |
| `test/api/auth.test.ts` | L7-9: `vi.hoisted` pattern; L12-32: Inline `vi.mock` for GitHub; L34-37: Ownership mock; L39-53: Standard lifecycle hooks |
