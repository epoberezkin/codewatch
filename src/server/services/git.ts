// Spec: spec/services/git.md
import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

// Code file extensions to include
const CODE_EXTENSIONS = new Set([
  // Code
  '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.hs', '.ex', '.erl', '.sh', '.bash',
  '.zsh', '.pl', '.lua', '.r', '.m', '.mm', '.sol', '.vy',
  // Config
  '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  // Infra
  '.tf', '.hcl',
  // Web
  '.html', '.css', '.scss', '.sass', '.less', '.svg',
]);

// Directories to skip
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__',
  '.tox', '.venv', 'venv', 'target', '.gradle', 'Pods',
]);

// Dockerfile patterns (no extension)
const INFRA_FILES = new Set([
  'Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml',
  'Makefile', 'Rakefile', 'Gemfile', 'Pipfile', 'Cargo.toml', 'go.mod', 'go.sum',
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export interface ScannedFile {
  relativePath: string; // relative to repo root
  size: number;
  roughTokens: number;
}

export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  isFallback: boolean;
}

// ---------- Clone / Update ----------

// Spec: spec/services/git.md#repoLocalPath
export function repoLocalPath(repoUrl: string): string {
  // e.g. https://github.com/org/repo → repos/github.com/org/repo
  const url = new URL(repoUrl);
  return path.join(config.reposDir, url.hostname, url.pathname.replace(/^\//, '').replace(/\.git$/, ''));
}

// Spec: spec/services/git.md#cloneOrUpdate
export async function cloneOrUpdate(
  repoUrl: string,
  branch?: string,
  shallowSince?: Date,
): Promise<{ localPath: string; headSha: string }> {
  const localPath = repoLocalPath(repoUrl);

  if (fs.existsSync(path.join(localPath, '.git'))) {
    // Update existing
    const git = simpleGit(localPath);
    if (branch) {
      // Ensure the requested branch is tracked (may be a single-branch clone)
      await git.raw(['remote', 'set-branches', '--add', 'origin', branch]);
    }
    if (shallowSince) {
      // Incremental: deepen just enough to include the base commit
      const sinceStr = shallowSince.toISOString().split('T')[0]; // YYYY-MM-DD
      await git.fetch(['origin', `--shallow-since=${sinceStr}`]);
    } else if (branch) {
      await git.fetch(['origin', branch]);
    } else {
      await git.fetch('origin');
    }
    const targetBranch = branch || await getDefaultBranch(git);
    await git.checkout(targetBranch);
    await git.pull('origin', targetBranch);
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) throw new Error(`Repository at ${repoUrl} has no commits`);
    return { localPath, headSha: log.latest.hash };
  } else {
    // Clone fresh — use recursive mkdir (atomic, won't error if dir exists)
    fs.mkdirSync(localPath, { recursive: true });
    const git = simpleGit();
    const cloneArgs = ['--single-branch'];
    if (branch) {
      cloneArgs.push('-b', branch);
    }
    if (shallowSince) {
      const sinceStr = shallowSince.toISOString().split('T')[0];
      cloneArgs.push(`--shallow-since=${sinceStr}`);
    } else {
      cloneArgs.push('--depth', '1');
    }
    try {
      await git.clone(repoUrl, localPath, cloneArgs);
    } catch (cloneErr) {
      // Another process may have cloned concurrently — check if repo now exists
      try {
        fs.accessSync(path.join(localPath, '.git'), fs.constants.F_OK);
        // Repo exists now, fall through to read HEAD
      } catch {
        throw cloneErr; // Genuine clone failure
      }
    }
    const localGit = simpleGit(localPath);
    const log = await localGit.log({ maxCount: 1 });
    if (!log.latest) throw new Error(`Repository at ${repoUrl} has no commits after clone`);
    return { localPath, headSha: log.latest.hash };
  }
}

async function getDefaultBranch(git: SimpleGit): Promise<string> {
  try {
    const remote = await git.remote(['show', 'origin']);
    const match = (remote as string).match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  } catch {
    // fallback
  }
  return 'main';
}

// ---------- File Scanning ----------

// Spec: spec/services/git.md#scanCodeFiles
export function scanCodeFiles(repoRoot: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  walkDir(repoRoot, repoRoot, files);
  return files;
}

function walkDir(dir: string, root: string, files: ScannedFile[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(path.join(dir, entry.name), root, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      const isCode = CODE_EXTENSIONS.has(ext) || INFRA_FILES.has(entry.name);
      if (!isCode) continue;

      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.size > MAX_FILE_SIZE) continue;
      if (stat.size === 0) continue;

      const relativePath = path.relative(root, fullPath);
      files.push({
        relativePath,
        size: stat.size,
        roughTokens: Math.ceil(stat.size / 3.3),
      });
    }
  }
}

// ---------- Diff ----------

// Spec: spec/services/git.md#diffBetweenCommits
export async function diffBetweenCommits(
  repoPath: string,
  baseSha: string,
  headSha: string
): Promise<DiffResult> {
  const git = simpleGit(repoPath);

  const result: DiffResult = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
    isFallback: false,
  };

  // Use raw diff to get status flags
  const raw = await git.raw(['diff', '--name-status', baseSha, headSha]);
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const filePath = parts[1];

    if (status === 'A') {
      result.added.push(filePath);
    } else if (status === 'M') {
      result.modified.push(filePath);
    } else if (status === 'D') {
      result.deleted.push(filePath);
    } else if (status.startsWith('R')) {
      result.renamed.push({ from: filePath, to: parts[2] });
    }
  }

  return result;
}

// ---------- Read File Content ----------

export interface ReadFileResult {
  content: string | null;
  error?: string;
}

// Spec: spec/services/git.md#readFileContent
export function readFileContent(repoPath: string, relativePath: string): ReadFileResult {
  try {
    const fullPath = path.resolve(path.join(repoPath, relativePath));
    // Prevent path traversal outside the repository root
    if (!fullPath.startsWith(path.resolve(repoPath) + path.sep) && fullPath !== path.resolve(repoPath)) {
      return { content: null, error: 'path_traversal' };
    }
    return { content: fs.readFileSync(fullPath, 'utf-8') };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { content: null, error: 'not_found' };
    if (code === 'EACCES') return { content: null, error: 'permission_denied' };
    return { content: null, error: `io_error: ${code || 'unknown'}` };
  }
}

// ---------- Get HEAD SHA ----------

// Spec: spec/services/git.md#getHeadSha
export async function getHeadSha(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  const log = await git.log({ maxCount: 1 });
  if (!log.latest) throw new Error(`Repository at ${repoPath} has no commits`);
  return log.latest.hash;
}

// Spec: spec/services/git.md#getDefaultBranchName
export async function getDefaultBranchName(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  return getDefaultBranch(git);
}
