# Client Architecture Overview

## Build System

- **Config**: [`tsconfig.client.json`](../../tsconfig.client.json)
  - Extends root `tsconfig.json`
  - `rootDir`: `./src/client`
  - `outDir`: `./public/js`
  - `module`: ES2022 (native ES modules, no bundler output)
  - `target`: ES2022
  - `lib`: ES2022, DOM, DOM.Iterable
  - Source maps enabled; no declaration files

- **Build**: `tsc -p tsconfig.client.json` compiles each `.ts` file into a corresponding `.js` file under `public/js/`.

## Module Pattern

- **ES Modules without a bundler.** Each HTML page loads `common.js` first, then its page-specific script, both via `<script>` tags (not `type="module"` imports).
- All files share a single global scope -- functions declared in `common.ts` are available to all page scripts without import statements.
- No framework; vanilla TypeScript + direct DOM manipulation.

## Shared Utilities

[`common.ts`](../../src/client/common.ts#L1-L381) provides:
- Theme toggle (localStorage-backed dark/light)
- Fetch helpers with timeout, error parsing, rate-limit handling
- DOM shorthand (`$`, `show`, `hide`, `setText`, `setHtml`)
- URL/formatting helpers
- Badge rendering (ownership, access tier)
- Error display
- Auth state management (check, render, wait)
- Mobile navigation
- DOMContentLoaded init sequence

See [common.md](./common.md) for full export details.

## HTML to TypeScript File Mapping

| HTML file | TypeScript source | Description |
|---|---|---|
| `public/index.html` | `src/client/home.ts` | Landing page -- URL input, repo selection, project creation |
| `public/estimate.html` | `src/client/estimate.ts` | Cost estimation -- stats, components, level selection, start audit |
| `public/audit.html` | `src/client/audit.ts` | Audit progress -- polling, file list, completion |
| `public/report.html` | `src/client/report.ts` | Report view -- findings, filters, comments, publish |
| `public/project.html` | `src/client/project.ts` | Project dashboard -- repos, components, audit timeline |
| `public/projects.html` | `src/client/projects.ts` | Projects browser -- search, filter, card listing |
| `public/gate.html` | *(no dedicated TS)* | Auth gate / static page |

All HTML pages also load `common.js` for shared utilities and auth.

## State Management

- No global store. Each page module uses local `let` variables inside a `DOMContentLoaded` closure.
- Auth state (`currentUser`, `authChecked`) is the only cross-module mutable state, managed in `common.ts`.
- DOM is the implicit state store: `show`/`hide`/`setText`/`setHtml` mutate the page directly.

## [GAP] No TypeScript Import/Export

All files rely on global scope sharing rather than ES module `import`/`export`. This means:
- No tree-shaking or dead code elimination
- No compile-time dependency graph
- Type interfaces declared in one file are invisible to others (each file redeclares types)

## [REC] Consider Module Boundaries

If the codebase grows, consider switching to `type="module"` script tags with explicit imports, or introducing a bundler (esbuild/vite) to enable proper module isolation and shared type definitions.
