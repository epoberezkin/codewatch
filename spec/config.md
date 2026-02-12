# Configuration

Central configuration object that reads environment variables at startup and exposes typed defaults for the server, database, GitHub OAuth, and session management.

Source: [`config.ts`](../src/server/config.ts)

---

## Exported values

### [`config`](../src/server/config.ts#L3-L16)

Single named export. Type: object literal (inferred).

| Key | Type | Default | Env var |
|-----|------|---------|---------|
| `port` | `number` | `3000` | `PORT` |
| `databaseUrl` | `string` | `postgresql://localhost:5432/codewatch` | `DATABASE_URL` |
| `reposDir` | `string` | `./repos` | `REPOS_DIR` |
| `github.clientId` | `string` | `""` | `GITHUB_CLIENT_ID` |
| `github.clientSecret` | `string` | `""` | `GITHUB_CLIENT_SECRET` |
| `github.callbackUrl` | `string` | `http://localhost:3000/auth/github/callback` | `GITHUB_CALLBACK_URL` |
| `anthropicServiceKey` | `string` | `""` | `ANTHROPIC_SERVICE_KEY` |
| `cookieSecret` | `string` | `dev-secret-change-in-production` | `COOKIE_SECRET` |
| `gatePassword` | `string` | `""` | `GATE_PASSWORD` |
| `sessionMaxAgeDays` | `number` (hardcoded) | `14` | -- |

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP listen port. Parsed as base-10 integer. |
| `DATABASE_URL` | Yes (prod) | PostgreSQL connection string. |
| `REPOS_DIR` | No | Directory where cloned repositories are stored. Mapped to `/app/repos` inside Docker. |
| `GITHUB_CLIENT_ID` | Yes | OAuth app client ID for GitHub login. |
| `GITHUB_CLIENT_SECRET` | Yes | OAuth app client secret for GitHub login. |
| `GITHUB_CALLBACK_URL` | No | OAuth redirect URI. Must match the GitHub OAuth app settings. |
| `ANTHROPIC_SERVICE_KEY` | No | API key for Anthropic services. |
| `COOKIE_SECRET` | Yes (prod) | HMAC key for signing cookies and auth state tokens. **The hardcoded default is insecure; must be overridden in production.** |
| `GATE_PASSWORD` | No | When set, enables a simple password gate middleware that protects all routes. When empty, the gate is disabled. |
| `POSTGRES_PASSWORD` | No (Docker only) | Used in `docker-compose.yml` to set the PostgreSQL password; not read by `config.ts` directly. Default: `codewatch`. |

---

## Docker / deployment config

Source: [`docker-compose.yml`](../docker-compose.yml)

### Services

#### `db` (PostgreSQL)

| Property | Value |
|----------|-------|
| Image | `docker.io/postgres:18` |
| Exposed port | `127.0.0.1:5432` (host-local only) |
| Database | `codewatch` |
| User | `codewatch` |
| Volume (data) | `./db` -> `/var/lib/postgresql` |
| Init script | [`docker/init-db.sql`](../docker/init-db.sql) -- enables `pgcrypto` extension |
| Healthcheck | `pg_isready -U codewatch -d codewatch` (5 s interval, 5 retries) |

#### `app`

| Property | Value |
|----------|-------|
| Build | `.` ([`Dockerfile`](../Dockerfile): `node:24-alpine`, installs `git curl`) |
| Exposed port | `${PORT:-3000}:3000` |
| Volume | `./repos` -> `/app/repos` |
| Startup command | `node dist/server/migrate.js && node dist/server/index.js` |
| Depends on | `db` (healthy) |

Environment variables passed through to the container:

| Variable | Compose value |
|----------|---------------|
| `DATABASE_URL` | `postgresql://codewatch:${POSTGRES_PASSWORD:-codewatch}@db:5432/codewatch` |
| `GITHUB_CLIENT_ID` | `${GITHUB_CLIENT_ID}` |
| `GITHUB_CLIENT_SECRET` | `${GITHUB_CLIENT_SECRET}` |
| `GITHUB_CALLBACK_URL` | `${GITHUB_CALLBACK_URL:-http://localhost:3000/auth/github/callback}` |
| `ANTHROPIC_SERVICE_KEY` | `${ANTHROPIC_SERVICE_KEY:-}` |
| `COOKIE_SECRET` | `${COOKIE_SECRET}` |
| `REPOS_DIR` | `/app/repos` (hardcoded) |
| `PORT` | `3000` (hardcoded inside container) |

---

## Gaps and recommendations

- [GAP] `sessionMaxAgeDays` is hardcoded to `14` with no environment variable override.
  - [REC] Add `SESSION_MAX_AGE_DAYS` env var for production tuning.
- [GAP] `config` is not exported with a declared TypeScript interface or `as const`.
  - [REC] Add an explicit `Config` interface or `as const` assertion for type safety and IDE autocompletion.
- [GAP] No `.env.example` file exists in the repository.
  - [REC] Add one listing all variables with placeholder values to simplify onboarding.
- [GAP] `GATE_PASSWORD` is not passed through in `docker-compose.yml`.
  - [REC] Add `GATE_PASSWORD: ${GATE_PASSWORD:-}` to the `app` service environment block.
