# CodeWatch

## Overview
Security audit website for open-source projects (one or more git repos) using Claude Opus 4.5 with BYOK (Bring Your Own Key). Users define a project by selecting repos from a GitHub org, the system classifies the software, constructs/validates a threat model, and runs a comprehensive security audit. Supports fresh and incremental audits with per-finding tracking and responsible disclosure controls.

## Prerequisites

- Node.js 22+
- PostgreSQL 15+
- Git
- A GitHub OAuth app (for user authentication)

## Database Setup

Create a dedicated `codewatch` PostgreSQL user and database. Do not use the default `postgres` superuser for the application.

### 1. Create the user and database

Connect to PostgreSQL as a superuser (e.g. `postgres`) and run:

```sql
CREATE USER codewatch WITH PASSWORD 'your-secure-password-here';
CREATE DATABASE codewatch OWNER codewatch;
\c codewatch
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

The `pgcrypto` extension must be created by a superuser (or a user with `CREATE` privilege on the database) because it is a trusted extension. The `codewatch` user does not need superuser privileges.

### 2. Grant permissions

No additional grants are needed — the `codewatch` user owns the database and has full control over its schema and data.

### 3. Configure the connection

Set the `DATABASE_URL` environment variable:

```bash
export DATABASE_URL="postgresql://codewatch:your-secure-password-here@localhost:5432/codewatch"
```

Or create a `.env` file in the project root (git-ignored):

```
DATABASE_URL=postgresql://codewatch:your-secure-password-here@localhost:5432/codewatch
```

### 4. Run migrations

```bash
npm run build
npm run migrate
```

This applies all SQL migrations from `sql/` to create the schema (tables, indexes, seed data).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (see above) |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth app client secret |
| `GITHUB_CALLBACK_URL` | No | OAuth callback URL (default: `http://localhost:3000/auth/github/callback`) |
| `ANTHROPIC_SERVICE_KEY` | No | Anthropic API key for free `count_tokens` endpoint (precise estimates) |
| `COOKIE_SECRET` | Yes (prod) | Secret for signing session cookies (see below) |
| `NODE_ENV` | Yes (prod) | Set to `production` in production to enable secure (HTTPS-only) cookies |
| `GATE_PASSWORD` | No | Password to gate access during pre-launch testing. If not set, gate is disabled (open access). |
| `REPOS_DIR` | No | Directory for cloned repos (default: `./repos`) |
| `PORT` | No | Server port (default: `3000`) |

### Generating `COOKIE_SECRET`

The `COOKIE_SECRET` is used to sign session cookies and the development gate cookie. In development a default value is used, but in production you must set a strong random secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the output to your `.env` file:

```
COOKIE_SECRET=<generated-hex-string>
```

### Development Gate

Set `GATE_PASSWORD` to require a password before accessing the site. This is useful for pre-launch testing. When set, all pages and API routes are gated behind a password prompt at `/gate`. Static assets (CSS, JS, images) are not gated.

```
GATE_PASSWORD=your-testing-password
```

To disable the gate, remove `GATE_PASSWORD` from your environment or leave it empty.

## Getting Started

```bash
npm install
npm run build
npm run migrate
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Testing

Tests use a real PostgreSQL instance. They create a temporary database per test suite, run migrations, and drop it after.

```bash
npm test
npm run test:watch
```

The test runner connects using `DATABASE_URL` and needs a PostgreSQL user with `CREATEDB` permission:

```sql
ALTER USER codewatch CREATEDB;
```

This allows the test harness to create/drop ephemeral test databases. You can revoke this after testing if desired.
