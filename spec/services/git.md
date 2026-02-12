# git.ts Service Specification

Git repository cloning, updating, file scanning, diffing, and content reading.

**Source file:** [`git.ts`](../../src/server/services/git.ts)

---

## Constants

| Name | Type | Value |
|------|------|-------|
| `CODE_EXTENSIONS` | `Set<string>` | `.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.scala`, `.hs`, `.ex`, `.erl`, `.sh`, `.bash`, `.zsh`, `.pl`, `.lua`, `.r`, `.m`, `.mm`, `.sol`, `.vy`, `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.ini`, `.cfg`, `.conf`, `.tf`, `.hcl`, `.html`, `.css`, `.scss`, `.sass`, `.less`, `.svg` |
| `SKIP_DIRS` | `Set<string>` (exported) | `node_modules`, `.git`, `vendor`, `dist`, `build`, `.next`, `__pycache__`, `.tox`, `.venv`, `venv`, `target`, `.gradle`, `Pods` |
| `INFRA_FILES` | `Set<string>` | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.yaml`, `Makefile`, `Rakefile`, `Gemfile`, `Pipfile`, `Cargo.toml`, `go.mod`, `go.sum` |
| `MAX_FILE_SIZE` | `number` | `1048576` (1 MB) |

---

## Types

### `ScannedFile` (exported interface)

```ts
interface ScannedFile {
  relativePath: string; // relative to repo root
  size: number;
  roughTokens: number;
}
```

### `DiffResult` (exported interface)

```ts
interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  isFallback: boolean;
}
```

### `ReadFileResult` (exported interface)

```ts
interface ReadFileResult {
  content: string | null;
  error?: string;
}
```

---

## Exported Functions

### [`repoLocalPath()`](../../src/server/services/git.ts#L52-L56)

```ts
function repoLocalPath(repoUrl: string): string
```

Converts a repository URL to a local filesystem path under `config.reposDir`. Parses the URL, strips leading `/` and trailing `.git`, then joins `config.reposDir / hostname / path`.

- **Side effects:** None (pure function).
- **Error handling:** Throws if `repoUrl` is not a valid URL (`new URL()` will throw `TypeError`). [GAP] No explicit validation or catch for malformed URLs.

---

### [`cloneOrUpdate()`](../../src/server/services/git.ts#L59-L118)

```ts
async function cloneOrUpdate(
  repoUrl: string,
  branch?: string,
  shallowSince?: Date,
): Promise<{ localPath: string; headSha: string }>
```

Clones a repository if it does not exist locally, or fetches and pulls updates if it does.

**Update path** (`.git` directory exists):
1. If `branch` is provided, adds it to tracked remote branches via `git remote set-branches --add`.
2. If `shallowSince` is provided, fetches with `--shallow-since=YYYY-MM-DD`. Otherwise fetches the specified branch, or just `origin`.
3. Checks out the target branch (or the default branch via `getDefaultBranch()`).
4. Pulls from `origin`.
5. Returns `localPath` and the latest commit hash.

**Clone path** (no local repo):
1. Creates the directory recursively (`fs.mkdirSync` with `recursive: true`).
2. Clones with `--single-branch`. Adds `-b branch` if specified. Uses `--shallow-since` or `--depth 1`.
3. On clone failure, checks if `.git` appeared (concurrent clone race); if so, proceeds. Otherwise re-throws.
4. Returns `localPath` and the latest commit hash.

- **Side effects:** Filesystem I/O (`mkdirSync`), shell commands via `simple-git` (`clone`, `fetch`, `checkout`, `pull`, `log`).
- **Error handling:** Throws `Error` if the repository has no commits after clone or update. Handles concurrent-clone race condition by checking for `.git` directory existence.
- [GAP] No timeout on git operations. Long-running clones/fetches could hang indefinitely (depends on `simple-git` defaults).
- [REC] Consider adding a configurable timeout for git operations.

---

### [`scanCodeFiles()`](../../src/server/services/git.ts#L134-L138)

```ts
function scanCodeFiles(repoRoot: string): ScannedFile[]
```

Recursively walks a repository directory and returns all code files matching `CODE_EXTENSIONS` or `INFRA_FILES`, subject to `SKIP_DIRS` and `MAX_FILE_SIZE` filters.

Delegates to the private `walkDir()` helper (L140-L176).

**File inclusion rules (in `walkDir`):**
- Directories in `SKIP_DIRS` are skipped entirely.
- A file is included if its extension is in `CODE_EXTENSIONS` **or** its basename is in `INFRA_FILES`.
- Files larger than `MAX_FILE_SIZE` (1 MB) or with size 0 are excluded.
- `roughTokens` is estimated as `Math.ceil(size / 3.3)`.

- **Side effects:** Filesystem I/O (`readdirSync`, `statSync`).
- **Error handling:** Silently skips directories that cannot be read and files that cannot be `stat`ed (catches and ignores errors).
- [GAP] Symlinks are not explicitly handled. `isFile()` returns false for symlinks unless they resolve to files, and `isDirectory()` returns false for symlinks to directories, so symlinked subtrees are silently skipped.

---

### [`diffBetweenCommits()`](../../src/server/services/git.ts#L181-L216)

```ts
async function diffBetweenCommits(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<DiffResult>
```

Runs `git diff --name-status baseSha headSha` and parses the output into a `DiffResult`.

**Status mapping:** `A` -> `added`, `M` -> `modified`, `D` -> `deleted`, `R*` -> `renamed` (with `from`/`to`).

- **Side effects:** Shell command via `simple-git` (`git diff --name-status`).
- **Error handling:** None explicit; `simple-git` will throw on invalid SHAs or non-repo paths. [GAP] The `isFallback` field is always set to `false` and never toggled to `true`; it appears reserved for future use or is set elsewhere.
- [GAP] Copy status (`C`) and other statuses (`T`, `U`, `X`) are silently ignored.
- [REC] Consider logging or handling unrecognized status codes.

---

### [`readFileContent()`](../../src/server/services/git.ts#L226-L240)

```ts
function readFileContent(repoPath: string, relativePath: string): ReadFileResult
```

Reads a file from within a repository, with path-traversal protection.

1. Resolves the full path and verifies it starts with `repoPath + path.sep` (or equals `repoPath`).
2. Reads the file as UTF-8.

- **Side effects:** Filesystem I/O (`readFileSync`).
- **Error handling:** Returns structured errors: `path_traversal`, `not_found` (ENOENT), `permission_denied` (EACCES), or `io_error: <code>`. Never throws.
- [GAP] No `MAX_FILE_SIZE` check; a caller could read a very large file into memory.
- [REC] Apply `MAX_FILE_SIZE` guard consistent with `scanCodeFiles`.

---

### [`getHeadSha()`](../../src/server/services/git.ts#L245-L250)

```ts
async function getHeadSha(repoPath: string): Promise<string>
```

Returns the SHA hash of the most recent commit (HEAD) in the given repository.

- **Side effects:** Shell command via `simple-git` (`git log -1`).
- **Error handling:** Throws `Error` if the repository has no commits.

---

### [`getDefaultBranchName()`](../../src/server/services/git.ts#L253-L257)

```ts
async function getDefaultBranchName(repoPath: string): Promise<string>
```

Returns the default branch name for the repository at `repoPath`. Delegates to the private `getDefaultBranch()` helper.

- **Side effects:** Shell command via `simple-git` (`git remote show origin`).
- **Error handling:** Falls back to `'main'` if the remote command fails or no HEAD branch line is found (via `getDefaultBranch()` at L120-L129).

---

## Private Functions

### [`getDefaultBranch()`](../../src/server/services/git.ts#L120-L129)

```ts
async function getDefaultBranch(git: SimpleGit): Promise<string>
```

Runs `git remote show origin`, parses `HEAD branch: <name>` from the output. Falls back to `'main'` on any error.

### [`walkDir()`](../../src/server/services/git.ts#L140-L176)

```ts
function walkDir(dir: string, root: string, files: ScannedFile[]): void
```

Recursive directory walker used by `scanCodeFiles`. Mutates the `files` array in place. See `scanCodeFiles` for behavior details.

---

## Dependencies

| Module | Import | Usage |
|--------|--------|-------|
| `simple-git` | `simpleGit`, `SimpleGit` | All git operations (clone, fetch, checkout, pull, log, diff, remote) |
| `fs` | `* as fs` | `existsSync`, `mkdirSync`, `accessSync`, `readdirSync`, `statSync`, `readFileSync`, `constants.F_OK` |
| `path` | `* as path` | `join`, `extname`, `relative`, `resolve`, `sep` |
| `../config` | `{ config }` | `config.reposDir` — base directory for cloned repositories (default `'./repos'`) |
