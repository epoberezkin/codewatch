# common.ts -- Shared Client Utilities

**Source**: [`common.ts`](../../src/client/common.ts#L1-L435)

All exports are global functions/variables (no ES module exports). Loaded by every HTML page.

---

## [Theme Management](../../src/client/common.ts#L7-L32)

| Function | Signature | Description |
|---|---|---|
| `getTheme` | `() => 'light' \| 'dark'` | Reads `localStorage.getItem('theme')`, defaults to `'light'` |
| `applyTheme` | `(theme: 'light' \| 'dark') => void` | Sets `data-theme` attribute on `<html>`, updates toggle button text |
| `initThemeToggle` | `() => void` | Applies saved theme, attaches click handler to `#theme-toggle` |

**DOM IDs**: `theme-toggle`

---

## [Fetch Helpers](../../src/client/common.ts#L34-L97)

### [Interface: `ApiError`](../../src/client/common.ts#L36-L39)
```ts
interface ApiError { error: string; details?: string }
```

| Function | Signature | Description |
|---|---|---|
| `apiFetch<T>` | `(path: string, options?: RequestInit & { timeout?: number }) => Promise<T>` | Core fetch wrapper. Default 60s timeout via `AbortController`. Sets `Content-Type: application/json`. Parses error body on non-OK. Handles 429 with `Retry-After`. Returns `undefined as T` for 204. |
| `apiPost<T>` | `(path: string, body: unknown) => Promise<T>` | Convenience POST wrapper around `apiFetch` |
| `apiPut<T>` | `(path: string, body: unknown) => Promise<T>` | Convenience PUT wrapper around `apiFetch` |

**[GAP]** No `apiDelete` helper -- DELETE calls use `apiFetch` directly with `{ method: 'DELETE' }`.

**[GAP]** No retry logic for transient failures (only 429 produces a user-facing message).

**[REC]** Consider adding `apiDelete` for consistency, and exponential backoff for 5xx errors.

---

## [DOM Helpers](../../src/client/common.ts#L98-L127)

| Function | Signature | Description |
|---|---|---|
| `$` | `(id: string) => HTMLElement \| null` | Alias for `document.getElementById` |
| `show` | `(el: HTMLElement \| string) => void` | Removes `hidden` class. Accepts element or ID string. |
| `hide` | `(el: HTMLElement \| string) => void` | Adds `hidden` class. Accepts element or ID string. |
| `setText` | `(id: string, text: string) => void` | Sets `textContent` by ID |
| `setHtml` | `(id: string, html: string) => void` | Sets `innerHTML` by ID |

---

## [URL / Formatting Helpers](../../src/client/common.ts#L129-L241)

| Function | Signature | Description |
|---|---|---|
| `getParam` | `(name: string) => string \| null` | Reads URL query parameter |
| `formatNumber` | `(n: number) => string` | Formats as `1.2M`, `3.4K`, or plain number |
| `formatUSD` | `(n: number) => string` | Returns `$X.XX` |
| `formatDate` | `(iso: string) => string` | Locale-formatted date (e.g., `Jan 15, 2025`) |
| `formatDateTime` | `(iso: string) => string` | Locale-formatted date + time |
| `formatStatus` | `(status: string) => string` | Maps status codes to display strings (`false_positive` -> `False Positive`, etc.) |

---

## [Styling Helpers](../../src/client/common.ts#L166-L183)

| Function | Signature | Description |
|---|---|---|
| `severityClass` | `(severity: string) => string` | Maps severity to CSS class: `critical` -> `severity-critical`, etc. Returns `''` for unknown. |
| `escapeHtml` | `(text: string) => string` | XSS-safe HTML escaping via `createElement('div').textContent` |

---

## [Badge Rendering](../../src/client/common.ts#L185-L204)

| Function | Signature | Description |
|---|---|---|
| `renderOwnershipBadge` | `(ownership: { isOwner: boolean; role?: string \| null; needsReauth?: boolean } \| null \| undefined) => string` | Returns HTML badge string: `owner` badge, `verify ownership` link (for needsReauth), or empty string |
| `renderAccessTierBadge` | `(tier: 'owner' \| 'requester' \| 'public') => string` | Returns HTML badge: `full access`, `redacted`, or `summary only` |

---

## [Error Handling](../../src/client/common.ts#L206-L227)

| Function | Signature | Description |
|---|---|---|
| `showInlineError` | `(container: HTMLElement, message: string) => void` | Prepends a div with classes `notice notice-error inline-error` to container (clears previous `.inline-error` first) |
| `clearInlineError` | `(container: HTMLElement) => void` | Removes `.inline-error` element from container |
| `showError` | `(message: string) => void` | Calls `showInlineError` on `<main>` element |

---

## [Shared Renderer: renderThreatModel](../../src/client/common.ts#L243-L296)

| Function | Signature | Description |
|---|---|---|
| `renderThreatModel` | `(targetId: string, data: { threatModel?, threatModelParties?, threatModelFileLinks?, threatModelSource? }) => boolean` | Renders threat model display into the element with `targetId`. Returns `true` if content was rendered, `false` if no threat content present. Display order: source badge → evaluation text → source file links (filtered by `url.startsWith('https://')`) → parties table. Used by both `project.ts` and `report.ts`. |

---

## [Shared Handler: attachAddAsProjectHandlers](../../src/client/common.ts#L298-L340)

| Function | Signature | Description |
|---|---|---|
| `attachAddAsProjectHandlers` | `(selector: string) => void` | Attaches click handlers to all buttons matching `selector`. Parses GitHub URL from `data-url`, creates project via `POST /api/projects`, links dependency via `POST /api/dependencies/{depId}/link`. |

**API calls**:
- `POST /api/projects` -- `{ githubOrg, repoNames: [repoName] }`
- `POST /api/dependencies/{depId}/link` -- `{ linkedProjectId }`

**Data attributes read**: `data-dep-id`, `data-name`, `data-url`

---

## [Auth State](../../src/client/common.ts#L341-L407)

### [Interface: `AuthUser`](../../src/client/common.ts#L343-L348)
```ts
interface AuthUser { id: string; username: string; avatarUrl?: string; githubType: string }
```

### [Variables](../../src/client/common.ts#L350-L351)
| Variable | Type | Description |
|---|---|---|
| `currentUser` | `AuthUser \| null` | Populated by `checkAuth()`. Readable by all page modules. |
| `authChecked` | `boolean` | Set to `true` after `checkAuth()` completes (success or failure) |

### Functions

| Function | Signature | Description |
|---|---|---|
| `checkAuth` | `() => Promise<AuthUser \| null>` | Fetches `GET /auth/me`. Sets `currentUser` and `authChecked`. |
| `renderAuthStatus` | `() => void` | Renders user avatar+name+logout link or "Sign in with GitHub" into `#auth-status`. Attaches logout handler (`POST /auth/logout` + reload). |
| `waitForAuth` | `() => Promise<void>` | Polls `authChecked` every 50ms until true. Resolves immediately if already checked. |

**DOM IDs**: `auth-status`, `logout-link`

**API calls**:
- `GET /auth/me`
- `POST /auth/logout`

---

## [Navigation](../../src/client/common.ts#L409-L425)

| Function | Signature | Description |
|---|---|---|
| `initNav` | `() => void` | Shows hamburger button, toggles `.nav-links.open` on click, closes on outside click |

**DOM IDs**: `hamburger-btn`
**DOM selectors**: `.nav-links`

---

## [Init Sequence](../../src/client/common.ts#L427-L435)

```ts
document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle();
  initNav();
  await checkAuth();
  renderAuthStatus();
});
```

Executes on every page load. Auth check is awaited before rendering auth status, but page-specific scripts can use `waitForAuth()` to synchronize.

**[GAP]** No error handling around `checkAuth()` in the init sequence -- if the network is down, `renderAuthStatus()` still runs (renders "Sign in" link), but the user gets no feedback about connectivity issues.

**[REC]** Consider showing a connectivity warning if `checkAuth()` fails due to network error (vs. 401).
