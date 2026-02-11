# componentAnalysis.ts

Agentic service that uses Claude to explore repository file structures via tools, identify architectural components with security profiles, and detect third-party dependencies.

**Source:** [`componentAnalysis.ts`](../../src/server/services/componentAnalysis.ts)

---

## Constants (L11-19)

| Name | Value | Purpose |
|------|-------|---------|
| `ANALYSIS_MODEL` | `claude-opus-4-5-20251101` | Model used for analysis |
| `ANALYSIS_INPUT_PRICE` | `5` ($/Mtok) | Input cost for USD estimation |
| `ANALYSIS_OUTPUT_PRICE` | `25` ($/Mtok) | Output cost for USD estimation |
| `MAX_TURNS` | `40` | Maximum agentic loop iterations |
| `MAX_RETRIES` | `5` | Maximum retries per API call |
| `MAX_READ_LINES` | `500` | File truncation threshold |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Consecutive tool-error limit before abort |

---

## Types (L22-55)

### `RepoInfo` (L23-28, exported)

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Database ID of the repo |
| `name` | `string` | Repository name (used by tools) |
| `localPath` | `string` | Absolute filesystem path |
| `files` | `ScannedFile[]` | Pre-scanned file list (paths relative to repo root) |

### `ComponentData` (L30-42, internal)

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Component name |
| `description` | `string` | What the component does |
| `role` | `string` | Architectural role |
| `repo` | `string` | Owning repository name |
| `file_patterns` | `string[]` | Glob patterns that select files belonging to this component |
| `languages` | `string[]` | Programming languages used |
| `security_profile?` | `{ summary, sensitive_areas: Array<{path, reason}>, threat_surface: string[] }` | Optional security metadata |

### `DependencyData` (L44-50, internal)

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Package/library name |
| `version?` | `string` | Version string if detected |
| `ecosystem` | `string` | e.g. `npm`, `pip`, `maven` |
| `repo` | `string` | Repository where detected |
| `source_repo_url?` | `string` | Upstream source URL |

### `ComponentAnalysisResult` (L52-55, internal)

| Field | Type | Notes |
|-------|------|-------|
| `components` | `ComponentData[]` | Identified components |
| `dependencies?` | `DependencyData[]` | Detected third-party dependencies |

---

## Tool Definitions (L59-96)

Three Anthropic tool definitions exposed to the Claude model during the agentic loop.

### `list_directory`

- **Description:** List files and directories at a path. Returns entry names with sizes for files and trailing `/` for directories.
- **Input schema:**
  - `repo_name` (string, required) -- repository name
  - `path` (string, required) -- relative path within the repo (`""` or `"."` for root)

### `read_file`

- **Description:** Read file contents. Files longer than 500 lines are truncated.
- **Input schema:**
  - `repo_name` (string, required) -- repository name
  - `path` (string, required) -- relative file path

### `search_files`

- **Description:** Search code files matching a glob pattern. Only searches indexed files (skips `node_modules`, `.git`, etc. via `SKIP_DIRS`).
- **Input schema:**
  - `repo_name` (string, required) -- repository name
  - `pattern` (string, required) -- glob pattern (e.g. `"src/**/*.ts"`)

---

## Retry Helpers (L98-157)

### `sleep(ms)` (L100-102)

Simple promise-based delay.

### `getRetryAfterSeconds(err)` (L104-116)

Extracts the `retry-after` header from an error object. Falls back to `60` seconds if the header is missing or unparsable. Handles both `headers.get()` (fetch-style) and plain-object headers.

### `createMessageWithRetry(client, system, tools, messages)` (L118-157)

Calls `client.messages.create()` with retry logic.

- **Parameters:**
  - `client` -- Anthropic SDK instance (constructed with `maxRetries: 0` so SDK does not retry itself)
  - `system` -- system prompt string
  - `tools` -- array of tool definitions
  - `messages` -- conversation history
- **Model config:** `model = ANALYSIS_MODEL`, `max_tokens = 16384`
- **Retry strategy (up to `MAX_RETRIES` = 5 attempts):**
  - **429 (rate limit):** waits `retry-after + 5` seconds
  - **5xx (server error):** exponential backoff `min(10 * 2^attempt, 120)` seconds
  - All other errors propagate immediately
- **Returns:** `Anthropic.Message`

---

## Main Function: `runComponentAnalysis()` (L161-335, exported)

```
runComponentAnalysis(pool, projectId, apiKey, repoData, existingAnalysisId?) -> Promise<string>
```

Returns the `analysisId` on success.

### 1. DB Record Creation (L168-179)

- If `existingAnalysisId` is provided, reuses it.
- Otherwise, inserts a new row into `component_analyses` with `status = 'pending'`.
- Immediately updates status to `'running'` (L182-184).

### 2. System Prompt Construction (L187-199)

1. Loads a prompt template via `loadPrompt('component_analysis')`.
2. For each repo, calls `safeReaddir()` on the repo root, filters out `SKIP_DIRS`, builds a top-level listing.
3. Renders the template with `renderPrompt(promptTemplate, { repo_list })`.

### 3. Conversation Initialization (L201-209)

- Starts with a single user message instructing the model to explore repos, identify components with security profiles, and output JSON.
- Instantiates Anthropic client with `maxRetries: 0` (retries handled by `createMessageWithRetry`).
- Initializes counters: `turnsUsed`, `inputTokensUsed`, `outputTokensUsed`, `consecutiveErrors`.

### 4. Agentic Loop (L217-322, max 40 turns)

Each iteration:

1. **Send message** via `createMessageWithRetry()` (L218).
2. **Track tokens** -- accumulates `input_tokens` and `output_tokens` from response usage (L221-224).
3. **Progress update** -- writes `turns_used`, `input_tokens_used`, `output_tokens_used`, `cost_usd` to DB every 3 turns or on `end_turn` (L227-234).
4. **Log** -- prints turn number, token counts, stop reason (L236-240).

#### Stop reason handling:

- **`end_turn`** (L242-272):
  1. Extracts text content blocks and joins them.
  2. Parses JSON via `parseJsonResponse<ComponentAnalysisResult>()`.
  3. Calls `storeResults()` to persist components and dependencies.
  4. Computes final cost, updates `component_analyses` to `status = 'completed'`, sets `completed_at = NOW()`.
  5. Updates `projects.component_analysis_id` and `components_analyzed_at`.
  6. Returns `analysisId`.

- **`tool_use`** (L274-315):
  1. Pushes assistant response content into messages.
  2. Iterates over `tool_use` blocks, calls `executeTool()` for each.
  3. On tool error, sets `is_error: true` on the tool result.
  4. **Consecutive error tracking** (L303-311): increments `consecutiveErrors` if any tool errored; resets to 0 if all succeeded. Throws if `consecutiveErrors >= MAX_CONSECUTIVE_ERRORS` (5).
  5. Pushes tool results as user message, continues loop.

- **Other** (L317-321): logs warning and breaks (falls through to max-turns error).

### 5. Post-Loop (L325)

If the loop exits without returning (max turns or unexpected stop), throws `"Component analysis did not complete within ${MAX_TURNS} turns"`.

### 6. Error Handling (L327-334)

Catch block updates `component_analyses` to `status = 'failed'` with `error_message`, then re-throws.

---

## Tool Execution (L339-420)

### `executeTool(name, input, repoData)` (L339-359)

Dispatcher. Looks up repo by `input.repo_name`. Returns error string if repo not found or tool name unknown. Delegates to specific executor.

### `executeListDirectory(repo, dirPath)` (L361-387)

1. Resolves `dirPath` relative to `repo.localPath` (empty string / `"."` maps to repo root).
2. **Path traversal guard** (L364): checks `path.resolve(resolved).startsWith(path.resolve(repo.localPath))`.
3. Reads directory with `fs.readdirSync(..., { withFileTypes: true })`.
4. Filters out `SKIP_DIRS`, formats entries:
   - Directories: `name/`
   - Files: `name (size)` via `formatSize()`
5. Returns sorted entries joined by newline, or `"(empty directory)"`.
6. On filesystem error, returns an error string.

### `executeReadFile(repo, filePath)` (L389-407)

1. **Path traversal guard** (L391-393): resolves absolute path, checks it starts with repo root.
2. Delegates to `readFileContent(repo.localPath, filePath)` (imported from `./git`).
3. On `path_traversal` error code, returns traversal error message.
4. On null content, returns not-found error.
5. **Truncation** (L402-404): if content exceeds `MAX_READ_LINES` (500), keeps first 500 lines and appends truncation notice with remaining line count.

### `executeSearchFiles(repo, pattern)` (L409-420)

1. Filters `repo.files` using `minimatch(f.relativePath, pattern)`.
2. Returns sorted matches joined by newline.
3. **Size limit** (L416-418): if more than 100 matches, truncates to first 100 with count of remaining.
4. Returns `"No files matching..."` if zero matches.

---

## Store Results: `storeResults()` (L424-520)

```
storeResults(pool, projectId, analysisId, result, repoData) -> Promise<void>
```

### Component Upsert (L431-479)

1. **DELETE old components** (L432-438): removes components for the project that are NOT referenced by `audit_components` or `audit_findings` (preserves components with audit history).
2. **INSERT new components** (L447-479): for each `ComponentData`:
   - Skips if `comp.repo` does not match any `RepoInfo`.
   - Matches `comp.file_patterns` against `repo.files` using `minimatch` to compute `estimatedFiles` and `estimatedTokens` (sum of `roughTokens`).
   - Inserts into `components` table with fields: `project_id`, `repo_id`, `name`, `description`, `role`, `file_patterns`, `languages`, `security_profile` (JSON-stringified), `estimated_files`, `estimated_tokens`.

### Dependency Management (L481-519)

1. **DELETE all dependencies** (L441-444): unconditionally deletes all `project_dependencies` for the project.
2. **INSERT dependencies** (L482-519): for each `DependencyData`:
   - Looks up `repo.id` by name; may be `null` if repo not found.
   - **With `repo_id`** (L488-496): uses `INSERT ... ON CONFLICT (project_id, repo_id, name, ecosystem) DO UPDATE` for upsert.
   - **Without `repo_id`** (L497-516): NULL defeats the UNIQUE constraint, so manually checks for existing row via SELECT, then UPDATEs or INSERTs accordingly.

[GAP] The dependency upsert for rows without `repo_id` (L497-516) is reachable after the bulk DELETE on L441-444, meaning the SELECT will always find zero rows and the UPDATE branch is dead code. This logic would only matter if the DELETE were removed or made conditional.

[REC] Consider wrapping the component DELETE + INSERT and the dependency DELETE + INSERT in a database transaction to avoid partial state on failure.

[REC] The `executeTool` return type is `string` for both success and error cases. A structured return (e.g., `{ ok: boolean; content: string }`) would allow the caller to set `is_error` without needing a try/catch, and would prevent the model from misinterpreting an error message as valid content.

---

## Helpers (L522-536)

### `safeReaddir(dirPath)` (L524-530)

Returns `fs.readdirSync(dirPath, { withFileTypes: true })` or an empty array on error. Used only during system prompt construction (L190).

### `formatSize(bytes)` (L532-536)

Formats byte counts as human-readable strings: `B`, `KB` (1 decimal), or `MB` (1 decimal).

---

## Database Operations Summary

| Operation | Table | SQL | Line |
|-----------|-------|-----|------|
| Insert analysis record | `component_analyses` | `INSERT ... status='pending' RETURNING id` | L173-176 |
| Set running | `component_analyses` | `UPDATE ... status='running'` | L182-184 |
| Progress update | `component_analyses` | `UPDATE ... turns_used, tokens, cost` | L228-234 |
| Mark completed | `component_analyses` | `UPDATE ... status='completed', completed_at` | L257-262 |
| Update project ref | `projects` | `UPDATE ... component_analysis_id, components_analyzed_at` | L265-269 |
| Mark failed | `component_analyses` | `UPDATE ... status='failed', error_message` | L329-332 |
| Delete old components | `components` | `DELETE ... WHERE NOT IN audit_components/audit_findings` | L432-438 |
| Delete old dependencies | `project_dependencies` | `DELETE ... WHERE project_id` | L441-444 |
| Insert component | `components` | `INSERT ... 10 columns` | L461-478 |
| Insert dependency (with repo) | `project_dependencies` | `INSERT ... ON CONFLICT DO UPDATE` | L489-496 |
| Check existing dependency (no repo) | `project_dependencies` | `SELECT id WHERE repo_id IS NULL` | L499-502 |
| Update dependency (no repo) | `project_dependencies` | `UPDATE ... version, source_repo_url` | L505-507 |
| Insert dependency (no repo) | `project_dependencies` | `INSERT ... repo_id=NULL` | L509-515 |

---

## Imports

| Import | Source | Used For |
|--------|--------|----------|
| `Anthropic` | `@anthropic-ai/sdk` | SDK client + types |
| `Pool` | `pg` | Database connection |
| `fs` | `node:fs` | Filesystem reads |
| `path` | `node:path` | Path resolution and traversal guards |
| `minimatch` | `minimatch` | Glob matching for search and token estimation |
| `parseJsonResponse` | `./claude` | Extract JSON from model text output |
| `readFileContent`, `SKIP_DIRS` | `./git` | File reading + directory exclusion set |
| `ScannedFile` (type) | `./git` | Type for pre-scanned file metadata |
| `loadPrompt`, `renderPrompt` | `./prompts` | Template loading and rendering |
