# Gate Page

![Gate page](../screenshots/gate.png)

## Purpose

Password-protect the entire site during pre-launch testing. When the `GATE_PASSWORD` environment variable is set, all routes are gated behind a password prompt. Without it, the gate is completely disabled and this page is never shown.

## Route

`GET /gate.html` (static file served by Express static middleware)

## What the User Sees

- **Header**: Branded nav bar with shield logo and "CodeWatch" text, plus a theme toggle button (light/dark).
- **Hero section**: Heading "Access Required" with explanation: "This site is in pre-launch testing. Enter the access password to continue."
- **Card**: Centered form (max-width 400px) containing:
  - Label "Password" with a password input field (`autocomplete="off"`)
  - Hidden error message area (red text)
  - Full-width "Enter" button (primary style)

## User Interaction

1. User navigates to any protected page.
2. `gateMiddleware` checks for a valid signed cookie. If absent, responds with `302` redirect to `/gate.html`.
3. User enters password and clicks "Enter" (or presses Enter -- no keyboard shortcut is wired, but default form submit applies).
4. Client sends `POST /gate` with JSON body `{ "password": "<input>" }`.
5. **Success** (`200 OK`): Server sets signed, httpOnly cookie `gate` (HMAC-SHA256 of password keyed by `COOKIE_SECRET`), max-age 30 days, SameSite=lax. Client redirects to `/` (home page).
6. **Wrong password** (`401`): Error message "Wrong password" displayed inline below the input.
7. **Network error** (fetch throws): Error message "Network error" displayed inline.

## What It Protects

The gate middleware runs **before** `express.static`, so all requests pass through the gate first:

- **Protected**: All HTML pages (including `/`, `/index.html`, etc.), all API routes (`/api/*` except `/api/health`), auth routes (`/auth/*`), and any server-rendered responses.
- **Unprotected**: Static assets (CSS, JS, images, fonts) are bypassed via extension check so the gate page can render. `POST /gate` itself is also unprotected (mounted before the middleware).
- **Explicitly bypassed**: `GET /api/health` (health check for uptime monitors), `GET /gate.html` (the gate page itself).

## Cookie Details

| Property   | Value                                                       |
|------------|-------------------------------------------------------------|
| Name       | `gate`                                                      |
| Value      | HMAC-SHA256 of password, keyed by `COOKIE_SECRET`           |
| Signed     | Yes (Express `signed: true`)                                |
| HttpOnly   | Yes                                                         |
| Max-Age    | 30 days (2,592,000,000 ms)                                  |
| SameSite   | Lax                                                         |
| Secure     | Not explicitly set (inherits Express default based on trust) |

[GAP] The `secure` flag is not explicitly set on the gate cookie. In production over HTTPS this could allow the cookie to be sent over HTTP if the proxy configuration is incorrect.

[REC] Explicitly set `secure: true` in production (or conditionally based on `NODE_ENV`).

## When It Appears

- **Shown**: Only when `GATE_PASSWORD` is configured and the user lacks a valid gate cookie.
- **Not shown**: When `GATE_PASSWORD` is unset/empty (gate is fully disabled; middleware calls `next()` immediately) or when the user already has a valid cookie.

## Edge Cases

- **`GATE_PASSWORD` not set**: `gateHandler` on `POST /gate` redirects to `/` instead of validating. Middleware passes through.
- **Cookie tampered/expired**: User is redirected back to `/gate.html` on next protected request.
- **Empty password submission**: HTML `required` attribute on the input prevents submission. Server also rejects falsy passwords with `401`.
- **No CSRF protection on `POST /gate`**: The endpoint accepts any POST with the correct password.

[GAP] There is no rate limiting on `POST /gate`, so the password could be brute-forced.

[REC] Add rate limiting (e.g., express-rate-limit) to `POST /gate` to prevent brute-force attacks on the gate password.

**Related spec:** [auth.md](../../spec/auth.md), [config.md](../../spec/config.md)

## Source Files

- `/code/codewatch/public/gate.html` -- client-side page
- `/code/codewatch/src/server/middleware/gate.ts` -- server middleware and POST handler
- `/code/codewatch/src/server/app.ts` -- middleware mounting order
