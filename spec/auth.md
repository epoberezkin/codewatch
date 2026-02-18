# Authentication & Gate Specification

## Module Purpose

- **auth.ts** — Implements GitHub OAuth login, session management, and the `requireAuth` middleware that protects API routes.
- **gate.ts** — Pre-launch password wall that blocks all requests until a shared password is provided.

## Source Files

- [`auth.ts`](../src/server/routes/auth.ts)
- [`gate.ts`](../src/server/middleware/gate.ts)

---

## Authentication (`auth.ts`)

### State Management

| Function | Lines | Description |
|---|---|---|
| `signState(payload)` | 18–23 | HMAC-SHA256 signs `payload` using `config.cookieSecret`. Returns `base64url(payload).hmac`. |
| `verifyState(state)` | 26–37 | Splits on `.`, decodes base64url payload, recomputes HMAC, and uses `crypto.timingSafeEqual` for comparison. Returns the original payload string or `null`. |

### OAuth Flow

#### `GET /auth/github` (line 40–50)

1. Reads optional `returnTo` query parameter.
2. Validates `returnTo` is a relative path (`/...` but not `//...`) to prevent open-redirect.
3. Signs `returnTo` into a `state` parameter via `signState`.
4. Redirects to `getOAuthUrl(state)` (GitHub authorize URL).

#### `GET /auth/github/callback` (lines 53–117)

1. Requires `code` query parameter; returns 400 if missing.
2. Exchanges code for `{ accessToken, scope }` via `exchangeCodeForToken`.
3. Fetches GitHub user profile via `getAuthenticatedUser(accessToken)`.
4. Detects `read:org` in comma-separated scope string (line 66).
5. **User UPSERT** (lines 69–79):
   ```sql
   INSERT INTO users (github_id, github_username, github_type, avatar_url, last_seen_at)
   VALUES ($1, $2, $3, $4, NOW())
   ON CONFLICT (github_id) DO UPDATE SET ...
   RETURNING id
   ```
6. **Session INSERT** (lines 83–88):
   ```sql
   INSERT INTO sessions (user_id, github_token, has_org_scope, expires_at)
   VALUES ($1, $2, $3, NOW() + INTERVAL '14 days')
   RETURNING id
   ```
7. Invalidates ownership cache for the user (line 92).
8. Sets session cookie (lines 95–100).
9. Verifies `state` parameter and redirects to `returnTo` or `/` (lines 103–112).
10. On error: logs and returns 500 `"Authentication failed"`.

### Session / Cookie Config

| Property | Value |
|---|---|
| Cookie name | `session` |
| `httpOnly` | `true` |
| `secure` | `true` in production (`NODE_ENV === 'production'`) |
| `sameSite` | `lax` |
| `maxAge` | 14 days (`config.sessionMaxAgeDays * 24 * 60 * 60 * 1000`) |
| DB expiry | `NOW() + INTERVAL '14 days'` (matches cookie) |

### User Info: `GET /auth/me` (lines 120–153)

1. Reads `session` cookie; returns 401 if absent.
2. JOINs `sessions` and `users` where `expires_at > NOW()`.
3. Returns JSON: `{ id, username, avatarUrl, githubType, hasOrgScope }`.
4. Returns 401 if session not found/expired; 500 on internal error.

### Logout: `POST /auth/logout` (lines 156–168)

1. Reads `session` cookie.
2. Deletes DB session row: `DELETE FROM sessions WHERE id = $1`.
3. Clears the `session` cookie.
4. Returns `{ ok: true }`.

### `requireAuth` Middleware (lines 174–209)

1. Reads `session` cookie; returns 401 `"Authentication required"` if missing.
2. SELECTs session + user via JOIN where `expires_at > NOW()`.
3. Returns 401 `"Session expired"` if no rows.
4. Augments `req` with: `userId`, `githubToken`, `githubUsername`, `githubType`, `hasOrgScope`.
5. Calls `next()`.

### Security Measures

- **returnTo validation**: must start with `/` and must not start with `//` (checked both at redirect initiation, line 45, and at callback consumption, line 107).
- **Signed state parameter**: HMAC-SHA256 with `config.cookieSecret`; verified with `crypto.timingSafeEqual`.
- **No token exposure**: `githubToken` is stored in DB, never sent to the client.

### DB Operations Summary

| Table | Operation | Location |
|---|---|---|
| `users` | `INSERT ... ON CONFLICT DO UPDATE` (UPSERT) | lines 69–79 |
| `sessions` | `INSERT ... RETURNING id` | lines 83–88 |
| `sessions` + `users` | `SELECT ... JOIN` (auth/me) | lines 129–135 |
| `sessions` + `users` | `SELECT ... JOIN` (requireAuth) | lines 184–191 |
| `sessions` | `DELETE` (logout) | line 161 |

---

## Gate Middleware (`gate.ts`)

### Purpose

Pre-launch password protection that blocks all requests (except health check, gate page, and static assets) until a shared password cookie is present.

### Constants (lines 6–8)

| Name | Value |
|---|---|
| `GATE_COOKIE` | `"gate"` |
| `GATE_MAX_AGE` | 30 days (`30 * 24 * 60 * 60 * 1000`) |
| `STATIC_ASSET_EXT` | Regex matching `.css`, `.js`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.map`, `.webp`, `.avif` |

### `hmacGateValue(password)` (lines 11–16)

HMAC-SHA256 of `password` using `config.cookieSecret`. Returns hex digest. Used both when setting and when verifying the gate cookie.

### `gateMiddleware(req, res, next)` (lines 19–41)

1. **Disabled** if `config.gatePassword` is falsy (empty string) — calls `next()` immediately (lines 21–24).
2. **Bypasses** `/api/health`, `/gate.html`, and static asset extensions (`STATIC_ASSET_EXT`) — calls `next()` (lines 27–30).
3. Reads `req.signedCookies[GATE_COOKIE]` and compares to `hmacGateValue(config.gatePassword)` (line 34).
4. If cookie matches, calls `next()`.
5. Otherwise redirects 302 to `/gate.html`.

Gate middleware is mounted **before** `express.static` in `app.ts`, so it intercepts all requests including HTML pages. Static assets are allowed through via the `STATIC_ASSET_EXT` extension check.

### `gateHandler(req, res)` (lines 44–65)

1. If gate disabled (`!config.gatePassword`), redirects to `/` (lines 45–48).
2. Reads `password` from `req.body`.
3. Compares plaintext `password !== config.gatePassword`; returns 401 `"Wrong password"` on mismatch (lines 51–53).
4. Sets signed cookie (lines 56–61):
   - Name: `gate`
   - Value: `hmacGateValue(config.gatePassword)`
   - `signed: true`, `httpOnly: true`, `sameSite: 'lax'`
   - `secure: process.env.NODE_ENV === 'production'`
   - `maxAge`: 30 days
5. Returns `{ ok: true }` (line 63).

### Bypass Rules

| Condition | Behaviour |
|---|---|
| `config.gatePassword` is empty | Gate entirely disabled |
| `req.path === '/api/health'` | Passes through |
| `req.path === '/gate.html'` | Passes through (gate page must be accessible) |
| `STATIC_ASSET_EXT.test(req.path)` | Passes through (CSS, JS, images, fonts) |

---

## Gaps & Recommendations

| ID | Type | Location | Detail |
|---|---|---|---|
| 1 | ~~[GAP]~~ | `gate.ts` lines 56–62 | ~~Gate cookie does not set `secure: true`.~~ **RESOLVED**: Now sets `secure: process.env.NODE_ENV === 'production'`, matching auth cookie. |
| 2 | ~~[REC]~~ | `gate.ts` lines 56–62 | ~~Add `secure` flag.~~ **RESOLVED**. |
| 3 | [GAP] | `auth.ts` lines 199–203 | `req` is cast via `(req as any)` to attach user fields. No typed interface extends Express `Request`. |
| 4 | [REC] | `auth.ts` lines 199–203 | Declare a module augmentation for `express.Request` (or a custom `AuthenticatedRequest` type) to get compile-time safety on `userId`, `githubToken`, etc. |
| 5 | [GAP] | `auth.ts` line 85–86 | Session expiry interval is interpolated as a template literal (`INTERVAL '${config.sessionMaxAgeDays} days'`), not parameterized. Value comes from hard-coded config (`14`), so no injection risk today, but fragile. |
| 6 | [REC] | `auth.ts` line 85–86 | Use `NOW() + make_interval(days => $4)` or a parameterized `INTERVAL` to avoid SQL string interpolation. |
| 7 | [GAP] | `gate.ts` line 51 | Password comparison is plaintext (`!==`), not constant-time. Timing side-channel risk is low for a pre-launch gate, but inconsistent with the HMAC-based approach used everywhere else. |
| 8 | [REC] | `gate.ts` line 51 | Use `crypto.timingSafeEqual(Buffer.from(password), Buffer.from(config.gatePassword))` for consistency. |
