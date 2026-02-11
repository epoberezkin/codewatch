# prompts.ts -- Prompt Template Loader

Source: [`prompts.ts`](../../src/server/services/prompts.ts)

## Purpose

Loads Markdown prompt templates from disk by name and renders `{{variable}}` placeholders into final prompt strings.

---

## Exported Functions

### `loadPrompt` (lines 6-21)

```ts
export function loadPrompt(name: string): string
```

**Behavior:**

1. **Name validation (line 7):** Rejects any `name` not matching `/^[a-zA-Z0-9_-]+$/`. Throws `Error('Invalid prompt name: ${name}')`.
2. **Primary path (line 10):** Resolves `__dirname/../../../prompts/${name}.md` -- targets the project-root `prompts/` directory relative to the compiled JS output location.
3. **Fallback path (lines 12-14):** If the primary path does not exist (`fs.existsSync`), tries `__dirname/../../prompts/${name}.md` -- covers alternative build output layouts.
4. **Read (lines 16-20):** Reads the resolved file synchronously (`fs.readFileSync`, UTF-8). On any read error, throws `Error('Prompt template not found: ${name}')`.

**File loading strategy:**

The path resolution uses `__dirname` of the compiled JS file (typically `dist/server/services/`). Three `..` hops land at the project root; two `..` hops land at `dist/` as a fallback. This means the canonical location for prompts is `<project-root>/prompts/`.

Currently available templates (from `prompts/` directory):

| File | Resolved name |
|------|---------------|
| `classify.md` | `classify` |
| `component_analysis.md` | `component_analysis` |
| `full.md` | `full` |
| `opportunistic.md` | `opportunistic` |
| `planning.md` | `planning` |
| `synthesize.md` | `synthesize` |
| `system.md` | `system` |
| `thorough.md` | `thorough` |

**Security -- name validation:**

The regex `/^[a-zA-Z0-9_-]+$/` prevents directory traversal (`../`), null bytes, and any special characters. Only alphanumerics, hyphens, and underscores are allowed. This effectively confines file access to `*.md` files inside the prompts directory.

[GAP] The fallback path is checked only via `existsSync` on the primary path. If the primary file exists but is unreadable (permissions), it will still be chosen and the read will throw the generic "not found" error, masking the real cause.

[REC] Log or include the underlying `err.message` in the catch block to aid debugging permission or encoding issues.

---

### `renderPrompt` (lines 24-30)

```ts
export function renderPrompt(template: string, vars: Record<string, string>): string
```

**Behavior:**

1. Iterates over all entries in `vars`.
2. For each key, replaces all occurrences of `{{key}}` in the template string (global regex).
3. Returns the final rendered string.

**Details:**

- Uses `new RegExp('\\{\\{' + key + '\\}\\}', 'g')` -- global replacement so repeated placeholders are all filled.
- Keys not present in `vars` are left as literal `{{key}}` in the output (no error, no stripping).

[GAP] If a `key` contains regex metacharacters (e.g., `foo.bar`), the regex will interpret them literally as patterns rather than literal dots. In practice this is low-risk since keys are typically simple identifiers controlled by the codebase.

[REC] Escape `key` with a regex-escape utility before constructing the `RegExp`, or switch to simple `replaceAll('{{' + key + '}}', value)` which treats the search string literally.

---

## Dependencies

- `fs` -- synchronous file reading and existence checks.
- `path` -- cross-platform path joining.
