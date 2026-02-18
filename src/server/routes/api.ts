// Spec: spec/api.md
import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import { requireAuth } from './auth';
import { listOrgRepos, createIssue, getGitHubEntity, listRepoBranches, getRepoDefaultBranch } from '../services/github';
import { cloneOrUpdate, scanCodeFiles, repoLocalPath, getDefaultBranchName } from '../services/git';
import { estimateCosts, roughTokenCount, estimateCostsFromTokenCount, estimateCostsForComponents } from '../services/tokens';
import { runAudit } from '../services/audit';
import { countTokens } from '../services/claude';
import { resolveOwnership } from '../services/ownership';
import { runComponentAnalysis } from '../services/componentAnalysis';
import type { RepoInfo } from '../services/componentAnalysis';
import { config } from '../config';
import type { ScannedFile } from '../services/git';

const router = Router();

// Spec: spec/api.md#escapeILike
// Escape special ILIKE characters in user-provided search terms
function escapeILike(input: string): string {
  return input.replace(/[%_\\]/g, ch => '\\' + ch);
}

// Helper: resolve session info from session cookie
interface SessionInfo {
  userId: string;
  githubToken: string;
  githubUsername: string;
  githubType: string;
  hasOrgScope: boolean;
}

// Spec: spec/api.md#getSessionInfo
async function getSessionInfo(pool: any, sessionId: string | undefined): Promise<SessionInfo | null> {
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username, u.github_type
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId]
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].user_id,
    githubToken: rows[0].github_token,
    githubUsername: rows[0].github_username,
    githubType: rows[0].github_type,
    hasOrgScope: rows[0].has_org_scope,
  };
}

// Helper: resolve access tier for three-tier access control on audit reports/findings
type AccessTier = 'owner' | 'requester' | 'public';

// Spec: spec/api.md#resolveAccessTier
function resolveAccessTier(audit: any, requesterId: string | null, isOwner: boolean): AccessTier {
  const now = new Date();
  const publishableAfter = audit.publishable_after ? new Date(audit.publishable_after) : null;
  const isAutoPublished = publishableAfter && audit.owner_notified && now >= publishableAfter;
  const fullAccessForAll = audit.is_public || isAutoPublished;
  const isRequester = requesterId && requesterId === audit.requester_id;

  if (fullAccessForAll || isOwner) return 'owner';
  if (isRequester) return 'requester';
  return 'public';
}

// Spec: spec/api.md#getRedactedSeverities
function getRedactedSeverities(tier: AccessTier): Set<string> {
  if (tier === 'owner') return new Set();
  if (tier === 'requester') return new Set();
  return new Set(['critical', 'high']);
}

// Spec: spec/api.md#parseThreatModel
function parseThreatModel(raw: string | null): {
  text: string | null;
  parties: Array<{name: string; can: string[]; cannot: string[]}>
} {
  if (!raw) return { text: null, parties: [] };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const text = parsed.evaluation || parsed.generated || null;
      const parties = Array.isArray(parsed.parties) ? parsed.parties : [];
      return { text, parties };
    }
  } catch { /* not JSON — treat as plain text */ }
  return { text: raw, parties: [] };
}

// Spec: spec/api.md#buildThreatModelFileLinks
function buildThreatModelFileLinks(
  threatModelFiles: string[] | null,
  commits: Array<{repo_url: string; repo_name: string; commit_sha: string}>
): Array<{path: string; url: string}> {
  if (!threatModelFiles?.length || !commits.length) return [];
  return threatModelFiles
    .filter(f => f && !f.includes('..') && !f.startsWith('/'))
    .map(filePath => {
      // File paths from Claude are prefixed with repo name: "repo-name/path/to/file"
      const slashIdx = filePath.indexOf('/');
      const repoPrefix = slashIdx > 0 ? filePath.substring(0, slashIdx) : '';
      const fileInRepo = slashIdx > 0 ? filePath.substring(slashIdx + 1) : filePath;
      const commit = commits.find(c => c.repo_name === repoPrefix) || commits[0];
      const url = `${commit.repo_url}/blob/${commit.commit_sha}/${encodeURI(fileInRepo)}`;
      return { path: filePath, url };
    });
}

// Spec: spec/api.md#findDuplicateProject
async function findDuplicateProject(
  pool: any, githubOrg: string, userId: string, sortedRepoNames: string
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT p.id FROM projects p
     WHERE p.github_org = $1 AND p.created_by = $2
     AND (SELECT string_agg(r.repo_name, ',' ORDER BY r.repo_name)
          FROM project_repos pr JOIN repositories r ON r.id = pr.repo_id
          WHERE pr.project_id = p.id) = $3`,
    [githubOrg, userId, sortedRepoNames]
  );
  return rows.length > 0 ? rows[0].id : null;
}

// ============================================================
// GitHub Org Repos
// ============================================================

// GET /api/github/orgs/:org/repos
router.get('/github/orgs/:org/repos', async (req: Request, res: Response) => {
  const org = req.params.org as string;
  try {
    // Use session token if available for higher rate limits
    const pool = getPool();
    const session = await getSessionInfo(pool, req.cookies?.session);
    const token = session?.githubToken;

    const repos = await listOrgRepos(org, token);
    res.json(repos.map(r => ({
      name: r.name,
      description: r.description || '',
      language: r.language || '',
      stars: r.stargazers_count,
      forks: r.forks_count,
      defaultBranch: r.default_branch,
      // License from GitHub API: nested object with spdx_id, may be null if repo has no license
      license: r.license?.spdx_id || null,
      url: r.html_url,
      githubId: r.id,
    })));
  } catch (err) {
    console.error('Error listing org repos:', err);
    res.status(500).json({ error: 'Failed to list organization repositories' });
  }
});

// GET /api/github/entity/:name — entity info (user or org)
router.get('/github/entity/:name', async (req: Request, res: Response) => {
  const name = req.params.name as string;
  try {
    // Use session token if available
    const pool = getPool();
    const session = await getSessionInfo(pool, req.cookies?.session);
    const token = session?.githubToken;

    const entity = await getGitHubEntity(name, token);

    let isOwner: boolean | null = null;
    let role: string | null = null;
    let needsReauth = false;
    if (session) {
      try {
        const ownership = await resolveOwnership(
          pool, session.userId, name,
          session.githubUsername, session.githubToken, session.hasOrgScope,
        );
        isOwner = ownership.isOwner;
        role = ownership.role || null;
        needsReauth = ownership.needsReauth || false;
      } catch { /* ignore */ }
    }

    res.json({ ...entity, isOwner, role, needsReauth });
  } catch (err) {
    console.error('Error fetching entity:', err);
    res.status(500).json({ error: 'Failed to fetch GitHub entity' });
  }
});

// GET /api/github/repos/:owner/:repo/branches — list branches
router.get('/github/repos/:owner/:repo/branches', async (req: Request, res: Response) => {
  const owner = req.params.owner as string;
  const repo = req.params.repo as string;
  try {
    // Use session token if available
    const pool = getPool();
    const session = await getSessionInfo(pool, req.cookies?.session);
    const token = session?.githubToken;

    const [allBranches, defaultBranch] = await Promise.all([
      listRepoBranches(owner, repo, token),
      getRepoDefaultBranch(owner, repo, token),
    ]);
    // Put default branch first so the client can use the array as-is
    const branches = [
      ...allBranches.filter(b => b.name === defaultBranch),
      ...allBranches.filter(b => b.name !== defaultBranch),
    ];
    res.json({ defaultBranch, branches });
  } catch (err) {
    console.error('Error listing branches:', err);
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

// ============================================================
// Projects
// ============================================================

// POST /api/projects — create project with repos
// Accepts either { githubOrg, repoNames: string[] } (legacy)
// or { githubOrg, repos: [{name, branch?}] } (new format with branch selection)
router.post('/projects', requireAuth as any, async (req: Request, res: Response) => {
  const { githubOrg } = req.body;
  const userId = (req as any).userId;

  // Normalize input: support both repoNames[] and repos[{name, branch?, defaultBranch?}]
  let repoInputs: Array<{ name: string; branch?: string; defaultBranch?: string }>;
  if (Array.isArray(req.body.repos) && req.body.repos.length > 0) {
    repoInputs = req.body.repos;
  } else if (Array.isArray(req.body.repoNames) && req.body.repoNames.length > 0) {
    repoInputs = req.body.repoNames.map((n: string) => ({ name: n }));
  } else {
    res.status(400).json({ error: 'githubOrg and repos[] (or repoNames[]) are required' });
    return;
  }

  if (!githubOrg) {
    res.status(400).json({ error: 'githubOrg is required' });
    return;
  }

  // Validate githubOrg format (alphanumeric, hyphens, no special chars)
  if (typeof githubOrg !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(githubOrg)) {
    res.status(400).json({ error: 'Invalid GitHub org/user name' });
    return;
  }

  // Validate each repo input
  for (const input of repoInputs) {
    const name = input.name;
    if (typeof name !== 'string' || name.length === 0 || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: `Invalid repository name: ${typeof name === 'string' ? name : '(non-string)'}` });
      return;
    }
    if (input.branch !== undefined && (typeof input.branch !== 'string' || input.branch.length === 0)) {
      res.status(400).json({ error: `Invalid branch for ${name}` });
      return;
    }
  }

  const pool = getPool();

  try {
    // Check for duplicate: same org + same repos (sorted) by the same user
    const sortedNames = repoInputs.map(r => r.name).sort().join(',');
    const existingId = await findDuplicateProject(pool, githubOrg, userId, sortedNames);
    if (existingId) {
      res.status(409).json({ projectId: existingId, existing: true, message: 'Project already exists' });
      return;
    }

    // Create project
    const projectName = githubOrg; // Default name to org name
    const { rows: projectRows } = await pool.query(
      `INSERT INTO projects (name, github_org, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [projectName, githubOrg, userId]
    );
    const projectId = projectRows[0].id;

    // Create/get repos and link to project
    const repos = [];
    for (const input of repoInputs) {
      const repoUrl = `https://github.com/${githubOrg}/${input.name}`;
      const repoPath = repoLocalPath(repoUrl);

      // Upsert repository (include default_branch if provided by client)
      const { rows: repoRows } = await pool.query(
        `INSERT INTO repositories (repo_url, github_org, repo_name, repo_path, default_branch)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'main'))
         ON CONFLICT (repo_url) DO UPDATE SET
           github_org = $2,
           repo_name = $3,
           default_branch = COALESCE($5, repositories.default_branch)
         RETURNING id`,
        [repoUrl, githubOrg, input.name, repoPath, input.defaultBranch || null]
      );
      const repoId = repoRows[0].id;

      // Link to project with optional branch
      await pool.query(
        'INSERT INTO project_repos (project_id, repo_id, branch) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [projectId, repoId, input.branch || null]
      );

      repos.push({ id: repoId, repoName: input.name, repoUrl, branch: input.branch || null });
    }

    // Resolve ownership for creator using session values from requireAuth middleware
    let ownership: { isOwner: boolean; role: string | null; needsReauth: boolean } | null = null;
    try {
      const result = await resolveOwnership(
        pool, userId, githubOrg,
        (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
      );
      ownership = { isOwner: result.isOwner, role: result.role || null, needsReauth: result.needsReauth || false };
    } catch { /* ignore */ }

    res.json({ projectId, repos, ownership });
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Spec: spec/api.md#postProjectsCheck
// POST /api/projects/check — check if a project with the same repos already exists
router.post('/projects/check', requireAuth as any, async (req: Request, res: Response) => {
  const { githubOrg, repos } = req.body;
  const userId = (req as any).userId;

  if (!githubOrg || typeof githubOrg !== 'string') {
    res.status(400).json({ error: 'githubOrg is required' });
    return;
  }

  const repoNames: string[] = Array.isArray(repos)
    ? repos.map((r: any) => typeof r === 'string' ? r : r.name).filter(Boolean)
    : [];
  if (repoNames.length === 0) {
    res.status(400).json({ error: 'repos[] is required' });
    return;
  }

  const sortedNames = repoNames.sort().join(',');
  const pool = getPool();

  try {
    const existingId = await findDuplicateProject(pool, githubOrg, userId, sortedNames);
    res.json({ exists: !!existingId, projectId: existingId || undefined });
  } catch (err) {
    console.error('Error checking for duplicate project:', err);
    res.status(500).json({ error: 'Failed to check for duplicate project' });
  }
});

// GET /api/projects/browse — unified browse with optional "My Projects" subset filter
router.get('/projects/browse', async (req: Request, res: Response) => {
  const pool = getPool();
  const { category, severity, search, mine } = req.query;

  try {
    // Resolve auth (optional — browse works without auth)
    const session = await getSessionInfo(pool, req.cookies?.session);
    const userId = session?.userId ?? null;
    const githubUsername = session?.githubUsername ?? null;
    const githubToken = session?.githubToken ?? null;
    const hasOrgScope = session?.hasOrgScope ?? false;

    if (mine === 'true' && !userId) {
      res.status(401).json({ error: 'Authentication required for My Projects' });
      return;
    }

    // Base visibility:
    // - Not logged in: projects with at least one public audit
    // - Logged in: projects with public audit OR user's own projects
    // "My Projects" is an additional filter (subset), not a separate query
    const baseParams: any[] = [];
    let baseCondition: string;
    if (userId) {
      baseCondition = `(EXISTS (SELECT 1 FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE) OR p.created_by = $1)`;
      baseParams.push(userId);
    } else {
      baseCondition = `EXISTS (SELECT 1 FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE)`;
    }

    // Build additional filter conditions
    const filterClauses: string[] = [];
    const queryParams = [...baseParams];
    let paramIdx = baseParams.length + 1;

    if (mine === 'true' && userId) {
      filterClauses.push(`p.created_by = $${paramIdx}`);
      queryParams.push(userId);
      paramIdx++;
    }
    if (category && category !== 'all') {
      filterClauses.push(`p.category = $${paramIdx}`);
      queryParams.push(category);
      paramIdx++;
    }
    if (severity && severity !== 'all') {
      filterClauses.push(`EXISTS (SELECT 1 FROM audits a2 WHERE a2.project_id = p.id AND a2.status = 'completed' AND a2.max_severity = $${paramIdx})`);
      queryParams.push(severity);
      paramIdx++;
    }
    if (search) {
      filterClauses.push(`(p.name ILIKE $${paramIdx} OR p.github_org ILIKE $${paramIdx})`);
      queryParams.push(`%${escapeILike(String(search))}%`);
      paramIdx++;
    }

    const filterWhere = filterClauses.length > 0 ? ' AND ' + filterClauses.join(' AND ') : '';

    // Main query
    const mainQuery = `
      SELECT p.id, p.name, p.github_org, p.category, p.created_by, p.created_at,
             (SELECT COUNT(*) FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE) as public_audit_count,
             (SELECT COUNT(*) FROM audits a WHERE a.project_id = p.id) as audit_count,
             (SELECT a.max_severity FROM audits a WHERE a.project_id = p.id AND a.status = 'completed'
              ORDER BY a.completed_at DESC LIMIT 1) as latest_severity,
             (SELECT a.completed_at FROM audits a WHERE a.project_id = p.id AND a.status = 'completed'
              ORDER BY a.completed_at DESC LIMIT 1) as latest_audit_date,
             (SELECT string_agg(DISTINCT r.license, ', ') FROM repositories r
              JOIN project_repos pr ON pr.repo_id = r.id
              WHERE pr.project_id = p.id AND r.license IS NOT NULL) as license
      FROM projects p
      WHERE ${baseCondition}${filterWhere}
      ORDER BY p.created_at DESC LIMIT 50`;

    // Filter value queries (from base set, without category/severity/search applied)
    const catQuery = `SELECT DISTINCT p.category FROM projects p WHERE ${baseCondition} AND p.category IS NOT NULL ORDER BY p.category`;
    const sevQuery = `SELECT DISTINCT a.max_severity FROM audits a JOIN projects p ON p.id = a.project_id WHERE ${baseCondition} AND a.status = 'completed' AND a.max_severity IS NOT NULL`;

    const [{ rows: projects }, { rows: catRows }, { rows: sevRows }] = await Promise.all([
      pool.query(mainQuery, queryParams),
      pool.query(catQuery, baseParams),
      pool.query(sevQuery, baseParams),
    ]);

    // Resolve ownership per unique org (deduplicated to minimize GitHub API calls)
    const orgOwnership = new Map<string, { isOwner: boolean; role: string | null; needsReauth: boolean }>();
    if (userId && githubUsername && githubToken) {
      const uniqueOrgs = [...new Set(projects.map(p => p.github_org))];
      await Promise.all(uniqueOrgs.map(async (org) => {
        try {
          const result = await resolveOwnership(pool, userId, org, githubUsername, githubToken, hasOrgScope);
          orgOwnership.set(org, { isOwner: result.isOwner, role: result.role || null, needsReauth: result.needsReauth || false });
        } catch { /* ignore */ }
      }));
    }

    const resolvedProjects = projects.map((p) => {
      const ownership = orgOwnership.get(p.github_org);
      return {
        id: p.id,
        name: p.name,
        githubOrg: p.github_org,
        category: p.category,
        // License from DB aggregate: string_agg of repo licenses, null when no repos have license data
        license: p.license || null,
        publicAuditCount: parseInt(p.public_audit_count),
        auditCount: parseInt(p.audit_count),
        latestSeverity: p.latest_severity || null,
        latestAuditDate: p.latest_audit_date || null,
        createdAt: p.created_at,
        ...(ownership ? { ownership } : {}),
      };
    });

    const severityOrder = ['critical', 'high', 'medium', 'low', 'informational'];
    const severities = sevRows
      .map(r => r.max_severity)
      .sort((a: string, b: string) => severityOrder.indexOf(a) - severityOrder.indexOf(b));

    res.json({
      projects: resolvedProjects,
      filters: {
        categories: catRows.map(r => r.category),
        severities,
      },
    });
  } catch (err) {
    console.error('Error browsing projects:', err);
    res.status(500).json({ error: 'Failed to browse projects' });
  }
});

// GET /api/projects/:id — get project details with license, audits, ownership
router.get('/projects/:id', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const pool = getPool();

  try {
    const { rows: projects } = await pool.query(
      `SELECT p.*, u.github_username as creator_username
       FROM projects p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1`,
      [projectId]
    );

    if (projects.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const project = projects[0];

    // Determine viewer identity + ownership
    const session = await getSessionInfo(pool, req.cookies?.session);
    let viewerId: string | null = null;
    let isOwner = false;
    let ownership: { isOwner: boolean; role: string | null; needsReauth: boolean } | null = null;

    if (session) {
      viewerId = session.userId;
      try {
        const result = await resolveOwnership(
          pool, session.userId, project.github_org,
          session.githubUsername, session.githubToken, session.hasOrgScope,
        );
        isOwner = result.isOwner;
        ownership = { isOwner: result.isOwner, role: result.role || null, needsReauth: result.needsReauth || false };
      } catch { /* ignore */ }
    }

    // Get repos with license + branch
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_name, r.repo_url, r.language, r.stars, r.description,
              r.total_files, r.total_tokens, r.default_branch, r.license, pr.branch
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1
       ORDER BY r.stars DESC NULLS LAST`,
      [projectId]
    );

    // Aggregate license from repos
    const licenses = [...new Set(repos.map(r => r.license).filter(Boolean))];
    const license = licenses.length > 0 ? licenses.join(', ') : null;

    // Get last 10 audits visible to this viewer
    let auditsQuery: string;
    let auditsParams: any[];

    if (isOwner) {
      // Owner sees all audits
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at, a.is_public, a.requester_id
        FROM audits a WHERE a.project_id = $1
        ORDER BY a.created_at DESC LIMIT 10`;
      auditsParams = [projectId];
    } else if (viewerId) {
      // Authenticated non-owner: see public audits + own audits
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at, a.is_public, a.requester_id
        FROM audits a WHERE a.project_id = $1
        AND (a.is_public = TRUE OR a.requester_id = $2)
        ORDER BY a.created_at DESC LIMIT 10`;
      auditsParams = [projectId, viewerId];
    } else {
      // Anonymous: public audits only
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at, a.is_public, a.requester_id
        FROM audits a WHERE a.project_id = $1
        AND a.is_public = TRUE
        ORDER BY a.created_at DESC LIMIT 10`;
      auditsParams = [projectId];
    }

    const { rows: audits } = await pool.query(auditsQuery, auditsParams);

    // Get components (if analyzed)
    const { rows: components } = await pool.query(
      `SELECT c.id, c.name, c.description, c.role, c.file_patterns, c.languages,
              c.security_profile, c.estimated_files, c.estimated_tokens,
              r.repo_name
       FROM components c
       JOIN repositories r ON r.id = c.repo_id
       WHERE c.project_id = $1
       ORDER BY c.name`,
      [projectId]
    );

    // Get dependencies
    const { rows: dependencies } = await pool.query(
      `SELECT pd.id, pd.name, pd.version, pd.ecosystem, pd.source_repo_url,
              pd.linked_project_id, r.repo_name
       FROM project_dependencies pd
       LEFT JOIN repositories r ON r.id = pd.repo_id
       WHERE pd.project_id = $1
       ORDER BY pd.ecosystem, pd.name`,
      [projectId]
    );

    // Get severity counts for each audit
    const auditResults = await Promise.all(audits.map(async (audit) => {
      const { rows: findings } = await pool.query(
        `SELECT severity, COUNT(*) as count FROM audit_findings WHERE audit_id = $1 GROUP BY severity`,
        [audit.id]
      );
      const severityCounts: Record<string, number> = {};
      for (const f of findings) {
        severityCounts[f.severity] = parseInt(f.count);
      }

      return {
        id: audit.id,
        auditLevel: audit.audit_level,
        isIncremental: audit.is_incremental,
        status: audit.status,
        maxSeverity: audit.max_severity,
        createdAt: audit.created_at,
        completedAt: audit.completed_at,
        isPublic: audit.is_public,
        severityCounts,
      };
    }));

    // Parse threat model and build file links
    const tm = parseThreatModel(project.threat_model);
    let classificationCommits: Array<{repo_url: string; repo_name: string; commit_sha: string}> = [];
    if (project.classification_audit_id && project.threat_model_files?.length) {
      const { rows: commitRows } = await pool.query(
        `SELECT r.repo_url, r.repo_name, ac.commit_sha
         FROM audit_commits ac
         JOIN repositories r ON r.id = ac.repo_id
         WHERE ac.audit_id = $1`,
        [project.classification_audit_id]
      );
      classificationCommits = commitRows;
    }
    const threatModelFileLinks = buildThreatModelFileLinks(project.threat_model_files, classificationCommits);

    res.json({
      id: project.id,
      name: project.name,
      description: project.description || '',
      githubOrg: project.github_org,
      category: project.category,
      license,
      involvedParties: project.involved_parties || null,
      threatModel: tm.text,
      threatModelParties: tm.parties,
      threatModelFileLinks,
      threatModelSource: project.threat_model_source || null,
      totalFiles: project.total_files,
      totalTokens: project.total_tokens,
      createdBy: project.created_by,
      creatorUsername: project.creator_username,
      ownership,
      repos: repos.map(r => ({
        id: r.id,
        repoName: r.repo_name,
        repoUrl: r.repo_url,
        language: r.language || '',
        stars: r.stars || 0,
        description: r.description || '',
        totalFiles: r.total_files,
        totalTokens: r.total_tokens,
        defaultBranch: r.default_branch,
        branch: r.branch || null,
        // License from individual repo DB record: may be null if not yet fetched from GitHub
        license: r.license || null,
      })),
      components: components.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        role: c.role,
        repoName: c.repo_name,
        filePatterns: c.file_patterns,
        languages: c.languages,
        securityProfile: c.security_profile,
        estimatedFiles: c.estimated_files,
        estimatedTokens: c.estimated_tokens,
      })),
      dependencies: dependencies.map(d => ({
        id: d.id,
        name: d.name,
        version: d.version,
        ecosystem: d.ecosystem,
        sourceRepoUrl: d.source_repo_url,
        linkedProjectId: d.linked_project_id,
        repoName: d.repo_name,
      })),
      audits: auditResults,
      createdAt: project.created_at,
    });
  } catch (err) {
    console.error('Error fetching project:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// PUT /api/projects/:id/branches — update branch selections for project repos
router.put('/projects/:id/branches', requireAuth as any, async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const userId = (req as any).userId;
  const { repos: repoUpdates } = req.body;

  if (!Array.isArray(repoUpdates) || repoUpdates.length === 0) {
    res.status(400).json({ error: 'repos[] is required' });
    return;
  }

  const pool = getPool();

  try {
    // Verify project exists and user has access (creator or owner)
    const { rows: proj } = await pool.query(
      'SELECT id, created_by, github_org FROM projects WHERE id = $1',
      [projectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const isCreator = proj[0].created_by === userId;
    if (!isCreator) {
      const branchOwnership = await resolveOwnership(
        pool, userId, proj[0].github_org,
        (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
      );
      if (!branchOwnership.isOwner) {
        res.status(403).json({ error: 'Only the project creator or owner can change branches' });
        return;
      }
    }

    // Validate and update each repo's branch
    for (const update of repoUpdates) {
      if (!update.repoId) {
        res.status(400).json({ error: 'Each repo update must have repoId' });
        return;
      }
      if (update.branch !== undefined && update.branch !== null &&
          (typeof update.branch !== 'string' || update.branch.length === 0)) {
        res.status(400).json({ error: `Invalid branch for repo ${update.repoId}` });
        return;
      }

      // Warn if setting a branch that might not exist (non-blocking — branch existence
      // is not validated server-side; clone will fail later if the branch is invalid)
      if (update.branch) {
        console.warn(`Setting branch '${update.branch}' for repo ${update.repoId} in project ${projectId} — branch existence not verified`);
      }

      await pool.query(
        'UPDATE project_repos SET branch = $1 WHERE project_id = $2 AND repo_id = $3',
        [update.branch || null, projectId, update.repoId]
      );
    }

    res.json({ updated: true });
  } catch (err) {
    console.error('Error updating branches:', err);
    res.status(500).json({ error: 'Failed to update branches' });
  }
});

// ============================================================
// Estimation
// ============================================================

// POST /api/estimate — rough estimation
router.post('/estimate', async (req: Request, res: Response) => {
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const pool = getPool();

  try {
    // Get project repos with branch selection
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, r.repo_path, r.default_branch, pr.branch
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1`,
      [projectId]
    );

    if (repos.length === 0) {
      res.status(404).json({ error: 'Project not found or has no repos' });
      return;
    }

    // Clone/update each repo and scan files
    const repoBreakdown: Array<{ repoName: string; files: number; tokens: number; headSha?: string; branch?: string }> = [];
    const cloneErrors: Array<{ repoName: string; error: string }> = [];
    const allFiles: ScannedFile[] = [];

    for (const repo of repos) {
      let files: ScannedFile[];
      let repoHeadSha: string | undefined;
      const repoBranch = repo.branch || repo.default_branch || undefined;
      try {
        const { localPath, headSha } = await cloneOrUpdate(repo.repo_url, repo.branch || undefined);
        repoHeadSha = headSha;
        files = scanCodeFiles(localPath);

        // Detect actual default branch from cloned repo and update DB
        try {
          const detectedDefault = await getDefaultBranchName(localPath);
          if (detectedDefault && detectedDefault !== repo.default_branch) {
            await pool.query(
              'UPDATE repositories SET default_branch = $1 WHERE id = $2',
              [detectedDefault, repo.id]
            );
          }
        } catch { /* ignore — non-critical */ }

        // Namespace file paths with repo name
        files = files.map(f => ({
          ...f,
          relativePath: `${repo.repo_name}/${f.relativePath}`,
        }));

        // Update repo stats
        const totalTokens = roughTokenCount(files);
        await pool.query(
          `UPDATE repositories SET total_files = $1, total_tokens = $2, last_cloned_at = NOW()
           WHERE id = $3`,
          [files.length, totalTokens, repo.id]
        );
      } catch (err) {
        console.error(`Error processing repo ${repo.repo_name}:`, err);
        const errMsg = err instanceof Error ? err.message : 'Clone/scan failed';
        cloneErrors.push({ repoName: repo.repo_name, error: errMsg });
        files = [];
      }

      const tokens = roughTokenCount(files);
      repoBreakdown.push({
        repoName: repo.repo_name,
        files: files.length,
        tokens,
        headSha: repoHeadSha,
        branch: repoBranch,
      });
      allFiles.push(...files);
    }

    // Update project aggregate stats
    const totalFiles = allFiles.length;
    const totalTokens = roughTokenCount(allFiles);
    await pool.query(
      'UPDATE projects SET total_files = $1, total_tokens = $2 WHERE id = $3',
      [totalFiles, totalTokens, projectId]
    );

    // Get cost estimates
    const estimate = await estimateCosts(pool, allFiles);

    // Check for previous audit
    const { rows: prevAudits } = await pool.query(
      `SELECT id, created_at, audit_level, max_severity
       FROM audits
       WHERE project_id = $1 AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId]
    );

    const result: any = {
      totalFiles,
      totalTokens,
      repoBreakdown,
      estimates: estimate.estimates,
      isPrecise: false,
      cloneErrors: cloneErrors.length > 0 ? cloneErrors : undefined,
    };

    if (prevAudits.length > 0) {
      result.previousAudit = {
        id: prevAudits[0].id,
        createdAt: prevAudits[0].created_at,
        level: prevAudits[0].audit_level,
        maxSeverity: prevAudits[0].max_severity,
      };
    }

    res.json(result);
  } catch (err) {
    console.error('Error estimating:', err);
    res.status(500).json({ error: 'Failed to estimate costs' });
  }
});

// POST /api/estimate/precise — precise estimation using count_tokens API
router.post('/estimate/precise', async (req: Request, res: Response) => {
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  if (!config.anthropicServiceKey) {
    res.status(503).json({ error: 'Precise estimation is not configured (missing ANTHROPIC_SERVICE_KEY)' });
    return;
  }

  const pool = getPool();

  try {
    // Get project repos with branch selection
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, r.repo_path, r.default_branch, pr.branch
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1`,
      [projectId]
    );

    if (repos.length === 0) {
      res.status(404).json({ error: 'Project not found or has no repos' });
      return;
    }

    // Scan files from already-cloned repos
    const allFiles: ScannedFile[] = [];
    const repoBreakdown = [];
    const cloneErrors: Array<{ repoName: string; error: string }> = [];
    const repoLocalPaths: Map<string, string> = new Map();
    const fs = await import('fs');
    const path = await import('path');

    for (const repo of repos) {
      let files: ScannedFile[];
      try {
        const { localPath } = await cloneOrUpdate(repo.repo_url, repo.branch || undefined);
        repoLocalPaths.set(repo.repo_name, localPath);
        files = scanCodeFiles(localPath);
        files = files.map(f => ({
          ...f,
          relativePath: `${repo.repo_name}/${f.relativePath}`,
        }));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Clone/scan failed';
        cloneErrors.push({ repoName: repo.repo_name, error: errMsg });
        files = [];
      }
      allFiles.push(...files);
      repoBreakdown.push({ repoName: repo.repo_name, files: files.length, tokens: 0 });
    }

    if (allFiles.length === 0) {
      res.status(400).json({ error: 'No code files found' });
      return;
    }

    // Build the user message the same way the audit would — file contents concatenated
    // Count tokens using dynamic size-based batching to stay under API request limit (~32MB)
    const MAX_BATCH_BYTES = 20_000_000; // 20MB per batch (safe margin below 32MB limit)
    let totalPreciseTokens = 0;
    const systemPrompt = 'You are a security auditor analyzing source code.';

    let batchEntries: string[] = [];
    let batchBytes = 0;

    const flushBatch = async () => {
      if (batchEntries.length === 0) return;
      const userMessage = batchEntries.join('\n\n');
      const tokens = await countTokens(
        config.anthropicServiceKey,
        systemPrompt,
        userMessage,
      );
      totalPreciseTokens += tokens;
      batchEntries = [];
      batchBytes = 0;
    };

    for (const f of allFiles) {
      try {
        const slashIdx = f.relativePath.indexOf('/');
        const repoName = f.relativePath.substring(0, slashIdx);
        const filePath = f.relativePath.substring(slashIdx + 1);
        const localPath = repoLocalPaths.get(repoName);
        if (!localPath) continue;
        const content = fs.readFileSync(path.join(localPath, filePath), 'utf-8');
        const entry = `### File: ${f.relativePath}\n\`\`\`\n${content}\n\`\`\``;
        const entryBytes = Buffer.byteLength(entry, 'utf-8');

        // If adding this entry would exceed the limit, flush current batch first
        if (batchBytes + entryBytes > MAX_BATCH_BYTES && batchEntries.length > 0) {
          await flushBatch();
        }

        batchEntries.push(entry);
        batchBytes += entryBytes;
      } catch {
        continue;
      }
    }
    await flushBatch();

    // Update repo breakdown with precise token proportions
    const roughTotal = roughTokenCount(allFiles);
    for (const rb of repoBreakdown) {
      const repoFiles = allFiles.filter(f => f.relativePath.startsWith(rb.repoName + '/'));
      const repoRoughTokens = roughTokenCount(repoFiles);
      // Scale precise tokens proportionally to each repo's rough share
      rb.tokens = roughTotal > 0
        ? Math.round((repoRoughTokens / roughTotal) * totalPreciseTokens)
        : 0;
    }

    // Compute costs using precise token count
    const estimate = await estimateCostsFromTokenCount(pool, allFiles.length, totalPreciseTokens);

    res.json({
      totalFiles: allFiles.length,
      totalTokens: totalPreciseTokens,
      repoBreakdown,
      estimates: estimate.estimates,
      isPrecise: true,
      cloneErrors: cloneErrors.length > 0 ? cloneErrors : undefined,
    });
  } catch (err) {
    console.error('Error computing precise estimate:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute precise estimate' });
  }
});

// POST /api/estimate/components — scoped cost estimates for selected components
router.post('/estimate/components', async (req: Request, res: Response) => {
  const { projectId, componentIds, totalTokens: clientTotalTokens } = req.body;

  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  if (!Array.isArray(componentIds)) {
    res.status(400).json({ error: 'componentIds must be an array' });
    return;
  }
  if (typeof clientTotalTokens !== 'number' || clientTotalTokens < 0) {
    res.status(400).json({ error: 'totalTokens is required and must be a non-negative number' });
    return;
  }

  const pool = getPool();

  try {
    // Verify project exists
    const { rows: proj } = await pool.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Verify all component IDs belong to this project
    if (componentIds.length > 0) {
      const { rows: validComponents } = await pool.query(
        'SELECT id FROM components WHERE id = ANY($1) AND project_id = $2',
        [componentIds, projectId]
      );
      if (validComponents.length !== componentIds.length) {
        res.status(400).json({ error: 'One or more component IDs are invalid for this project' });
        return;
      }
    }

    const estimate = await estimateCostsForComponents(pool, componentIds, clientTotalTokens);

    res.json({
      totalFiles: estimate.totalFiles,
      totalTokens: estimate.totalTokens,
      estimates: estimate.estimates,
      isPrecise: false,
    });
  } catch (err) {
    console.error('Error computing component estimate:', err);
    res.status(500).json({ error: 'Failed to compute component estimate' });
  }
});

// ============================================================
// Audit History
// ============================================================

// GET /api/project/:id/audits — list audits for a project (visibility-filtered)
router.get('/project/:id/audits', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const pool = getPool();

  try {
    // Determine viewer identity + ownership for visibility filtering
    const session = await getSessionInfo(pool, req.cookies?.session);
    let viewerId: string | null = null;
    let isOwner = false;

    if (session) {
      viewerId = session.userId;
      const { rows: projRows } = await pool.query(
        'SELECT github_org FROM projects WHERE id = $1',
        [projectId]
      );
      if (projRows.length > 0) {
        try {
          const ownership = await resolveOwnership(
            pool, session.userId, projRows[0].github_org,
            session.githubUsername, session.githubToken, session.hasOrgScope,
          );
          isOwner = ownership.isOwner;
        } catch { /* ignore ownership check failures */ }
      }
    }

    // Filter audits by visibility: owner sees all, auth user sees public + own, anonymous sees public
    let auditsQuery: string;
    let auditsParams: any[];

    if (isOwner) {
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at
        FROM audits a WHERE a.project_id = $1
        ORDER BY a.created_at DESC`;
      auditsParams = [projectId];
    } else if (viewerId) {
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at
        FROM audits a WHERE a.project_id = $1
        AND (a.is_public = TRUE OR a.requester_id = $2)
        ORDER BY a.created_at DESC`;
      auditsParams = [projectId, viewerId];
    } else {
      auditsQuery = `
        SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
               a.created_at, a.completed_at
        FROM audits a WHERE a.project_id = $1
        AND a.is_public = TRUE
        ORDER BY a.created_at DESC`;
      auditsParams = [projectId];
    }

    const { rows: audits } = await pool.query(auditsQuery, auditsParams);

    // Get severity counts and commits for each audit
    const results = await Promise.all(audits.map(async (audit) => {
      const { rows: findings } = await pool.query(
        `SELECT severity, COUNT(*) as count
         FROM audit_findings
         WHERE audit_id = $1
         GROUP BY severity`,
        [audit.id]
      );

      const severityCounts: Record<string, number> = {};
      for (const f of findings) {
        severityCounts[f.severity] = parseInt(f.count);
      }

      const { rows: commits } = await pool.query(
        `SELECT r.repo_name, ac.commit_sha
         FROM audit_commits ac
         JOIN repositories r ON r.id = ac.repo_id
         WHERE ac.audit_id = $1`,
        [audit.id]
      );

      return {
        id: audit.id,
        auditLevel: audit.audit_level,
        isIncremental: audit.is_incremental,
        status: audit.status,
        maxSeverity: audit.max_severity,
        createdAt: audit.created_at,
        completedAt: audit.completed_at,
        severityCounts,
        commits: commits.map(c => ({
          repoName: c.repo_name,
          commitSha: c.commit_sha,
        })),
      };
    }));

    res.json(results);
  } catch (err) {
    console.error('Error listing audits:', err);
    res.status(500).json({ error: 'Failed to list audits' });
  }
});

// ============================================================
// Audit
// ============================================================

// POST /api/audit/start — start a new audit
router.post('/audit/start', requireAuth as any, async (req: Request, res: Response) => {
  const { projectId, level, apiKey, baseAuditId, componentIds } = req.body;
  const userId = (req as any).userId;

  if (!projectId || !level || !apiKey) {
    res.status(400).json({ error: 'projectId, level, and apiKey are required' });
    return;
  }

  if (!['full', 'thorough', 'opportunistic'].includes(level)) {
    res.status(400).json({ error: 'level must be full, thorough, or opportunistic' });
    return;
  }

  if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
    res.status(400).json({ error: 'Invalid API key format. Key should start with sk-ant-' });
    return;
  }

  const pool = getPool();

  try {
    // Check project existence and resolve ownership
    const { rows: proj } = await pool.query(
      'SELECT created_by, github_org FROM projects WHERE id = $1',
      [projectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const ownership = await resolveOwnership(
      pool, userId, proj[0].github_org,
      (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
    );
    const isOwner = ownership.isOwner;

    // Validate componentIds if provided
    const validComponentIds: string[] | undefined = Array.isArray(componentIds) && componentIds.length > 0
      ? componentIds : undefined;
    if (validComponentIds) {
      const { rows: validComps } = await pool.query(
        'SELECT id FROM components WHERE id = ANY($1) AND project_id = $2',
        [validComponentIds, projectId]
      );
      if (validComps.length !== validComponentIds.length) {
        res.status(400).json({ error: 'One or more component IDs are invalid for this project' });
        return;
      }
    }

    // Create audit record
    const { rows: auditRows } = await pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, is_owner, base_audit_id, is_incremental, selected_component_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [projectId, userId, level, isOwner, baseAuditId || null, !!baseAuditId, validComponentIds || null]
    );
    const auditId = auditRows[0].id;

    // Start audit asynchronously (don't await)
    runAudit(pool, { auditId, projectId, level, apiKey, baseAuditId, componentIds: validComponentIds }).catch(err => {
      console.error('Audit run error:', err);
    });

    res.json({ auditId });
  } catch (err) {
    console.error('Error starting audit:', err);
    res.status(500).json({ error: 'Failed to start audit' });
  }
});

// GET /api/audit/:id — audit status and progress
router.get('/audit/:id', async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.*, p.name as project_name, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    const audit = rows[0];

    // Determine access level: requester or owner get full details, others get basic status
    let isOwner = false;
    let isRequester = false;
    const session = await getSessionInfo(pool, req.cookies?.session);
    if (session) {
      if (session.userId === audit.requester_id) {
        isRequester = true;
      }
      try {
        const ownership = await resolveOwnership(
          pool, session.userId, audit.github_org,
          session.githubUsername, session.githubToken, session.hasOrgScope,
        );
        if (ownership.isOwner) isOwner = true;
      } catch { /* not owner */ }
    }
    const isPrivileged = isOwner || isRequester;

    // Get commits
    const { rows: commits } = await pool.query(
      `SELECT r.repo_name, ac.commit_sha, ac.branch
       FROM audit_commits ac
       JOIN repositories r ON r.id = ac.repo_id
       WHERE ac.audit_id = $1`,
      [auditId]
    );

    res.json({
      id: audit.id,
      projectId: audit.project_id,
      projectName: audit.project_name,
      githubOrg: audit.github_org,
      status: audit.status,
      auditLevel: audit.audit_level,
      isIncremental: audit.is_incremental,
      isOwner,
      isRequester,
      totalFiles: audit.total_files,
      filesToAnalyze: audit.files_to_analyze,
      filesAnalyzed: audit.files_analyzed,
      progressDetail: isPrivileged ? (audit.progress_detail || []) : [],
      maxSeverity: audit.max_severity,
      errorMessage: isPrivileged ? audit.error_message : null,
      createdAt: audit.created_at,
      startedAt: audit.started_at,
      completedAt: audit.completed_at,
      commits: commits.map(c => ({
        repoName: c.repo_name,
        commitSha: c.commit_sha,
        branch: c.branch,
      })),
    });
  } catch (err) {
    console.error('Error fetching audit:', err);
    res.status(500).json({ error: 'Failed to fetch audit' });
  }
});

// GET /api/audit/:id/report — full report
router.get('/audit/:id/report', async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.*, p.name as project_name, p.created_by as project_owner_id,
              p.category as project_category, p.description as project_description,
              p.involved_parties, p.threat_model, p.threat_model_source,
              p.threat_model_files, p.classification_audit_id
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    const audit = rows[0];

    // Determine if requester is owner via GitHub ownership
    const session = await getSessionInfo(pool, req.cookies?.session);
    let requesterId: string | null = null;
    let isOwner = false;
    if (session) {
      requesterId = session.userId;
      const { rows: projRows } = await pool.query(
        'SELECT github_org FROM projects WHERE id = $1',
        [audit.project_id]
      );
      if (projRows.length > 0) {
        try {
          const ownership = await resolveOwnership(
            pool, session.userId, projRows[0].github_org,
            session.githubUsername, session.githubToken, session.hasOrgScope,
          );
          isOwner = ownership.isOwner;
        } catch {
          // Ownership check failed (e.g. GitHub API down) — default to not owner
        }
      }
    }

    // Get commits
    const { rows: commits } = await pool.query(
      `SELECT r.repo_name, ac.commit_sha
       FROM audit_commits ac
       JOIN repositories r ON r.id = ac.repo_id
       WHERE ac.audit_id = $1`,
      [auditId]
    );

    // Get findings
    const { rows: findings } = await pool.query(
      `SELECT f.*, r.repo_name
       FROM audit_findings f
       LEFT JOIN repositories r ON r.id = f.repo_id
       WHERE f.audit_id = $1
       ORDER BY
         CASE f.severity
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
           WHEN 'informational' THEN 5
         END`,
      [auditId]
    );

    // Severity counts
    const severityCounts: Record<string, number> = {};
    for (const f of findings) {
      severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
    }

    // Three-tier access control
    const isRequester = requesterId === audit.requester_id;
    const accessTier = resolveAccessTier(audit, requesterId, isOwner);

    let visibleFindings: any[];
    let redactedSeverities: string[] = [];
    let redactionNotice: string | null = null;

    if (accessTier === 'owner') {
      // Tier 1: Full report
      visibleFindings = findings.map(f => ({
        id: f.id,
        severity: f.severity,
        cweId: f.cwe_id,
        cvssScore: f.cvss_score ? parseFloat(f.cvss_score) : null,
        title: f.title,
        description: f.description,
        exploitation: f.exploitation,
        recommendation: f.recommendation,
        codeSnippet: f.code_snippet,
        filePath: f.file_path,
        lineStart: f.line_start,
        lineEnd: f.line_end,
        repoName: f.repo_name || '',
        status: f.status,
      }));
    } else if (accessTier === 'requester') {
      // Tier 2: Low/informational shown in full; medium+ redacted to severity, category, component only
      const redactedSevs = new Set(['medium', 'high', 'critical']);
      visibleFindings = findings.map(f => {
        if (redactedSevs.has(f.severity)) {
          return {
            id: f.id,
            severity: f.severity,
            cweId: f.cwe_id,
            cvssScore: null,
            title: null,
            description: null,
            exploitation: null,
            recommendation: null,
            codeSnippet: null,
            filePath: null,
            lineStart: null,
            lineEnd: null,
            repoName: f.repo_name || '',
            status: f.status,
          };
        }
        // Low/informational: full access
        return {
          id: f.id,
          severity: f.severity,
          cweId: f.cwe_id,
          cvssScore: f.cvss_score ? parseFloat(f.cvss_score) : null,
          title: f.title,
          description: f.description,
          exploitation: f.exploitation,
          recommendation: f.recommendation,
          codeSnippet: f.code_snippet,
          filePath: f.file_path,
          lineStart: f.line_start,
          lineEnd: f.line_end,
          repoName: f.repo_name || '',
          status: f.status,
        };
      });
      redactedSeverities = ['medium', 'high', 'critical'];
      redactionNotice = 'Some finding details are redacted. By requesting this audit you are supporting the security of this project. Full findings will be available after the responsible disclosure period, or when the owner publishes the report.';
    } else {
      // Tier 3: Summary only — no individual findings
      visibleFindings = [];
      redactedSeverities = ['medium', 'high', 'critical', 'low', 'informational'];
      redactionNotice = 'Only project owners can see the full report. Finding count and severity summary are shown below.';
    }

    // Component breakdown (from audit_components)
    const { rows: componentBreakdown } = await pool.query(
      `SELECT ac.component_id, c.name, c.role, ac.tokens_analyzed, ac.findings_count
       FROM audit_components ac
       JOIN components c ON c.id = ac.component_id
       WHERE ac.audit_id = $1
       ORDER BY ac.findings_count DESC NULLS LAST`,
      [auditId]
    );

    // Project dependencies
    const { rows: dependencies } = await pool.query(
      `SELECT pd.id, pd.name, pd.version, pd.ecosystem, pd.source_repo_url,
              pd.linked_project_id, r.repo_name
       FROM project_dependencies pd
       LEFT JOIN repositories r ON r.id = pd.repo_id
       WHERE pd.project_id = $1
       ORDER BY pd.ecosystem, pd.name`,
      [audit.project_id]
    );

    // Parse threat model and build file links for classification audit
    const reportTm = parseThreatModel(audit.threat_model);
    let reportClassCommits: Array<{repo_url: string; repo_name: string; commit_sha: string}> = [];
    if (audit.classification_audit_id && audit.threat_model_files?.length) {
      const { rows: ccRows } = await pool.query(
        `SELECT r.repo_url, r.repo_name, ac.commit_sha
         FROM audit_commits ac
         JOIN repositories r ON r.id = ac.repo_id
         WHERE ac.audit_id = $1`,
        [audit.classification_audit_id]
      );
      reportClassCommits = ccRows;
    }
    const reportThreatModelFileLinks = buildThreatModelFileLinks(audit.threat_model_files, reportClassCommits);

    res.json({
      id: audit.id,
      projectId: audit.project_id,
      projectName: audit.project_name,
      auditLevel: audit.audit_level,
      isIncremental: audit.is_incremental,
      isOwner,
      isRequester,
      isPublic: audit.is_public,
      publishableAfter: audit.publishable_after,
      ownerNotified: audit.owner_notified || false,
      ownerNotifiedAt: audit.owner_notified_at || null,
      maxSeverity: audit.max_severity,
      // Classification & threat model from project
      category: audit.project_category || null,
      projectDescription: audit.project_description || null,
      involvedParties: audit.involved_parties || null,
      threatModel: reportTm.text,
      threatModelParties: reportTm.parties,
      threatModelFileLinks: reportThreatModelFileLinks,
      threatModelSource: audit.threat_model_source || null,
      commits: commits.map(c => ({ repoName: c.repo_name, commitSha: c.commit_sha })),
      reportSummary: audit.report_summary,
      severityCounts,
      findings: visibleFindings,
      redactedSeverities,
      redactionNotice,
      accessTier,
      componentBreakdown: componentBreakdown.map(cb => ({
        componentId: cb.component_id,
        name: cb.name,
        role: cb.role,
        tokensAnalyzed: cb.tokens_analyzed,
        findingsCount: cb.findings_count,
      })),
      dependencies: dependencies.map(d => ({
        id: d.id,
        name: d.name,
        version: d.version,
        ecosystem: d.ecosystem,
        sourceRepoUrl: d.source_repo_url,
        linkedProjectId: d.linked_project_id,
        repoName: d.repo_name,
      })),
      createdAt: audit.created_at,
      completedAt: audit.completed_at,
    });
  } catch (err) {
    console.error('Error fetching report:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// GET /api/audit/:id/findings — list findings (with three-tier access control)
router.get('/audit/:id/findings', async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const pool = getPool();

  try {
    // Get audit info for access control
    const { rows: auditRows } = await pool.query(
      `SELECT a.id, a.is_public, a.requester_id, a.publishable_after, a.owner_notified, a.project_id
       FROM audits a WHERE a.id = $1`,
      [auditId]
    );

    if (auditRows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    const audit = auditRows[0];

    // Determine viewer identity + ownership
    const session = await getSessionInfo(pool, req.cookies?.session);
    let viewerId: string | null = null;
    let isOwner = false;

    if (session) {
      viewerId = session.userId;
      const { rows: projRows } = await pool.query(
        'SELECT github_org FROM projects WHERE id = $1',
        [audit.project_id]
      );
      if (projRows.length > 0) {
        try {
          const ownership = await resolveOwnership(
            pool, session.userId, projRows[0].github_org,
            session.githubUsername, session.githubToken, session.hasOrgScope,
          );
          isOwner = ownership.isOwner;
        } catch {
          // Ownership check failed — default to not owner
        }
      }
    }

    // Three-tier access control (same logic as report endpoint)
    const accessTier = resolveAccessTier(audit, viewerId, isOwner);

    // Public tier: no individual findings
    if (accessTier === 'public') {
      res.json([]);
      return;
    }

    const { rows } = await pool.query(
      `SELECT f.*, r.repo_name
       FROM audit_findings f
       LEFT JOIN repositories r ON r.id = f.repo_id
       WHERE f.audit_id = $1
       ORDER BY
         CASE f.severity
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
           WHEN 'informational' THEN 5
         END`,
      [auditId]
    );

    const redactedSevs = new Set(['medium', 'high', 'critical']);

    res.json(rows.map(f => {
      if (accessTier === 'requester' && redactedSevs.has(f.severity)) {
        return {
          id: f.id,
          severity: f.severity,
          cweId: f.cwe_id,
          cvssScore: null,
          title: null,
          description: null,
          exploitation: null,
          recommendation: null,
          codeSnippet: null,
          filePath: null,
          lineStart: null,
          lineEnd: null,
          repoName: f.repo_name || '',
          status: f.status,
        };
      }
      return {
        id: f.id,
        severity: f.severity,
        cweId: f.cwe_id,
        cvssScore: f.cvss_score ? parseFloat(f.cvss_score) : null,
        title: f.title,
        description: f.description,
        exploitation: f.exploitation,
        recommendation: f.recommendation,
        codeSnippet: f.code_snippet,
        filePath: f.file_path,
        lineStart: f.line_start,
        lineEnd: f.line_end,
        repoName: f.repo_name || '',
        status: f.status,
      };
    }));
  } catch (err) {
    console.error('Error fetching findings:', err);
    res.status(500).json({ error: 'Failed to fetch findings' });
  }
});

// PATCH /api/findings/:id/status — update finding status (owner only)
router.patch('/findings/:id/status', requireAuth as any, async (req: Request, res: Response) => {
  const findingId = req.params.id;
  const userId = (req as any).userId;
  const { status } = req.body;

  const validStatuses = ['open', 'fixed', 'false_positive', 'accepted', 'wont_fix'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const pool = getPool();

  try {
    // Verify ownership through finding → audit → project via GitHub ownership
    const { rows: findings } = await pool.query(
      `SELECT f.id, f.audit_id, p.github_org
       FROM audit_findings f
       JOIN audits a ON a.id = f.audit_id
       JOIN projects p ON p.id = a.project_id
       WHERE f.id = $1`,
      [findingId]
    );

    if (findings.length === 0) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }

    const findingOwnership = await resolveOwnership(
      pool, userId, findings[0].github_org,
      (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
    );
    if (findingOwnership.needsReauth) {
      res.status(403).json({ error: 'Re-authentication required to verify ownership', needsReauth: true });
      return;
    }
    if (!findingOwnership.isOwner) {
      res.status(403).json({ error: 'Only the project owner can update finding status' });
      return;
    }

    await pool.query(
      'UPDATE audit_findings SET status = $1 WHERE id = $2',
      [status, findingId]
    );

    console.log(`Finding ${findingId} status changed to ${status} by user ${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating finding status:', err);
    res.status(500).json({ error: 'Failed to update finding status' });
  }
});

// POST /api/audit/:id/comments — add comment
router.post('/audit/:id/comments', requireAuth as any, async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const userId = (req as any).userId;
  const { content, findingId } = req.body;

  if (!content || !content.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  if (content.trim().length > 10000) {
    res.status(400).json({ error: 'Comment too long (max 10000 characters)' });
    return;
  }

  const pool = getPool();

  try {
    // Verify user has access to this audit (owner, requester, or public)
    const { rows: auditRows } = await pool.query(
      `SELECT a.id, a.requester_id, a.is_public, p.github_org
       FROM audits a JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );
    if (auditRows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }
    const audit = auditRows[0];
    if (!audit.is_public && audit.requester_id !== userId) {
      // Check ownership
      try {
        const ownership = await resolveOwnership(
          pool, userId, audit.github_org,
          (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
        );
        if (!ownership.isOwner) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO audit_comments (audit_id, finding_id, user_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [auditId, findingId || null, userId, content.trim()]
    );

    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// GET /api/audit/:id/comments — list comments
router.get('/audit/:id/comments', async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const pool = getPool();

  try {
    // Verify audit exists and check access
    const { rows: auditRows } = await pool.query(
      `SELECT a.id, a.requester_id, a.is_public, p.github_org
       FROM audits a JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );
    if (auditRows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }
    const audit = auditRows[0];

    // Check access: public audits are readable by anyone; private need owner/requester
    if (!audit.is_public) {
      const session = await getSessionInfo(pool, req.cookies?.session);
      let hasAccess = false;
      if (session) {
        if (session.userId === audit.requester_id) {
          hasAccess = true;
        } else {
          try {
            const ownership = await resolveOwnership(
              pool, session.userId, audit.github_org,
              session.githubUsername, session.githubToken, session.hasOrgScope,
            );
            if (ownership.isOwner) hasAccess = true;
          } catch { /* not owner */ }
        }
      }
      if (!hasAccess) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    const { rows } = await pool.query(
      `SELECT c.*, u.github_username
       FROM audit_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.audit_id = $1
       ORDER BY c.created_at ASC`,
      [auditId]
    );

    res.json(rows.map(c => ({
      id: c.id,
      userId: c.user_id,
      username: c.github_username,
      findingId: c.finding_id,
      content: c.content,
      createdAt: c.created_at,
    })));
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST /api/audit/:id/publish — make report public
router.post('/audit/:id/publish', requireAuth as any, async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const userId = (req as any).userId;
  const pool = getPool();

  try {
    // Verify ownership via GitHub
    const { rows } = await pool.query(
      `SELECT a.id, a.project_id, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    // Validate that the audit belongs to a valid project
    if (!rows[0].project_id) {
      res.status(400).json({ error: 'Audit is not associated with a project' });
      return;
    }

    const publishOwnership = await resolveOwnership(
      pool, userId, rows[0].github_org,
      (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
    );
    if (publishOwnership.needsReauth) {
      res.status(403).json({ error: 'Re-authentication required to verify ownership', needsReauth: true });
      return;
    }
    if (!publishOwnership.isOwner) {
      res.status(403).json({ error: 'Only the project owner can publish' });
      return;
    }

    await pool.query(
      'UPDATE audits SET is_public = TRUE WHERE id = $1',
      [auditId]
    );

    console.log(`Audit ${auditId} published by user ${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error publishing:', err);
    res.status(500).json({ error: 'Failed to publish' });
  }
});

// POST /api/audit/:id/unpublish — make report private again
router.post('/audit/:id/unpublish', requireAuth as any, async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const userId = (req as any).userId;
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.project_id, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    // Validate that the audit belongs to a valid project
    if (!rows[0].project_id) {
      res.status(400).json({ error: 'Audit is not associated with a project' });
      return;
    }

    const unpubOwnership = await resolveOwnership(
      pool, userId, rows[0].github_org,
      (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
    );
    if (unpubOwnership.needsReauth) {
      res.status(403).json({ error: 'Re-authentication required to verify ownership', needsReauth: true });
      return;
    }
    if (!unpubOwnership.isOwner) {
      res.status(403).json({ error: 'Only the project owner can unpublish' });
      return;
    }

    await pool.query(
      'UPDATE audits SET is_public = FALSE, publishable_after = NULL WHERE id = $1',
      [auditId]
    );

    console.log(`Audit ${auditId} unpublished by user ${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error unpublishing:', err);
    res.status(500).json({ error: 'Failed to unpublish' });
  }
});

// POST /api/audit/:id/notify-owner — user-initiated responsible disclosure notification
router.post('/audit/:id/notify-owner', requireAuth as any, async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const userId = (req as any).userId;
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.status, a.requester_id, a.is_owner, a.owner_notified, a.max_severity,
              p.github_org, p.name as project_name
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    const audit = rows[0];

    // Audit must be completed before notification
    if (audit.status !== 'completed') {
      res.status(400).json({ error: 'Audit must be completed before notifying the owner' });
      return;
    }

    // Only the audit requester can trigger notification
    if (audit.requester_id !== userId) {
      res.status(403).json({ error: 'Only the audit requester can notify the owner' });
      return;
    }

    // Idempotent: if already notified, return success with existing data
    if (audit.owner_notified) {
      const { rows: existing } = await pool.query(
        'SELECT publishable_after, owner_notified_at FROM audits WHERE id = $1',
        [auditId]
      );
      res.json({ ok: true, publishableAfter: existing[0].publishable_after, alreadyNotified: true });
      return;
    }

    // Create GitHub issue on the main repo (use current session token from requireAuth)
    const githubToken = (req as any).githubToken;
    if (githubToken) {
      const { rows: repoRows } = await pool.query(
        `SELECT r.repo_name FROM repositories r
         JOIN project_repos pr ON pr.repo_id = r.id
         JOIN audits a ON a.project_id = pr.project_id
         WHERE a.id = $1
         ORDER BY r.stars DESC NULLS LAST
         LIMIT 1`,
        [auditId]
      );

      if (repoRows.length > 0) {
        const repoName = repoRows[0].repo_name;
        const findingCount = await pool.query(
          'SELECT COUNT(*) as count FROM audit_findings WHERE audit_id = $1',
          [auditId]
        );
        const count = parseInt(findingCount.rows[0]?.count ?? 0);
        const maxSev = audit.max_severity || 'none';

        const title = `[CodeWatch] Security audit completed - ${count} finding${count !== 1 ? 's' : ''} (max: ${maxSev})`;
        const body = `A community member has run a security audit on **${audit.project_name}** using [CodeWatch](https://codewatch.dev).

**Results:**
- Total findings: ${count}
- Maximum severity: ${maxSev}
- Audit ID: \`${auditId}\`

As the project owner, you have full access to all findings. Visit CodeWatch to view the complete report, add comments, and publish the report when ready.

---
*This issue was created by CodeWatch at the request of the audit sponsor to support responsible disclosure.*`;

        try {
          await createIssue(githubToken, audit.github_org, repoName, title, body);
        } catch (issueErr) {
          console.error('Failed to create GitHub issue:', issueErr);
          // Continue — notification is recorded even if issue creation fails
        }
      }
    }

    // Compute publishable_after based on max severity
    const maxSev = audit.max_severity || 'none';
    let publishableAfter: Date | null;
    if (maxSev === 'critical') {
      publishableAfter = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000); // 6 months
    } else if (maxSev === 'high' || maxSev === 'medium') {
      publishableAfter = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000); // 3 months
    } else {
      // low/informational/none: no time-gate needed
      publishableAfter = null;
    }

    await pool.query(
      `UPDATE audits SET owner_notified = TRUE, owner_notified_at = NOW(), publishable_after = $1
       WHERE id = $2`,
      [publishableAfter, auditId]
    );

    res.json({ ok: true, publishableAfter: publishableAfter });
  } catch (err) {
    console.error('Error notifying owner:', err);
    res.status(500).json({ error: 'Failed to notify owner' });
  }
});

// DELETE /api/audit/:id — delete own audit
router.delete('/audit/:id', requireAuth as any, async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const userId = (req as any).userId;
  const pool = getPool();

  // Use a single transaction with SELECT FOR UPDATE to prevent race conditions
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, requester_id FROM audits WHERE id = $1 FOR UPDATE',
      [auditId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    if (rows[0].requester_id !== userId) {
      await client.query('ROLLBACK');
      res.status(403).json({ error: 'Only the audit requester can delete' });
      return;
    }

    // Cascade delete within the same transaction
    await client.query('DELETE FROM audit_comments WHERE audit_id = $1', [auditId]);
    await client.query('DELETE FROM audit_findings WHERE audit_id = $1', [auditId]);
    await client.query('DELETE FROM audit_commits WHERE audit_id = $1', [auditId]);
    await client.query('DELETE FROM audit_components WHERE audit_id = $1', [auditId]);
    await client.query('DELETE FROM audits WHERE id = $1', [auditId]);
    await client.query('COMMIT');

    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting audit:', err);
    res.status(500).json({ error: 'Failed to delete audit' });
  } finally {
    client.release();
  }
});

// DELETE /api/projects/:id — delete own project
router.delete('/projects/:id', requireAuth as any, async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const userId = (req as any).userId;
  const pool = getPool();

  try {
    const { rows: proj } = await pool.query(
      'SELECT id, created_by, github_org FROM projects WHERE id = $1',
      [projectId]
    );

    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Allow deletion by creator OR verified GitHub owner
    const isCreator = proj[0].created_by === userId;
    if (!isCreator) {
      const delOwnership = await resolveOwnership(
        pool, userId, proj[0].github_org,
        (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
      );
      if (!delOwnership.isOwner) {
        res.status(403).json({ error: 'Only the project creator or owner can delete' });
        return;
      }
    }

    // Guard: reject if other users have audits on this project
    const { rows: foreignAudits } = await pool.query(
      'SELECT id FROM audits WHERE project_id = $1 AND requester_id != $2 LIMIT 1',
      [projectId, userId]
    );

    if (foreignAudits.length > 0) {
      res.status(409).json({ error: 'Cannot delete project with audits by other users' });
      return;
    }

    // Cascade delete in transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete own audits and their relations
      const { rows: ownAudits } = await client.query(
        'SELECT id FROM audits WHERE project_id = $1',
        [projectId]
      );
      for (const audit of ownAudits) {
        await client.query('DELETE FROM audit_comments WHERE audit_id = $1', [audit.id]);
        await client.query('DELETE FROM audit_findings WHERE audit_id = $1', [audit.id]);
        await client.query('DELETE FROM audit_commits WHERE audit_id = $1', [audit.id]);
        await client.query('DELETE FROM audit_components WHERE audit_id = $1', [audit.id]);
        await client.query('DELETE FROM audits WHERE id = $1', [audit.id]);
      }

      // Delete project relations
      await client.query('DELETE FROM project_dependencies WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM components WHERE project_id = $1', [projectId]);
      await client.query('UPDATE projects SET component_analysis_id = NULL WHERE id = $1', [projectId]);
      await client.query('DELETE FROM component_analyses WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM project_repos WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM projects WHERE id = $1', [projectId]);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.status(204).end();
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// ============================================================
// Component Analysis
// ============================================================

// POST /api/projects/:id/analyze-components — start agentic component analysis
router.post('/projects/:id/analyze-components', requireAuth as any, async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const apiKey = req.body.apiKey as string;

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
    res.status(400).json({ error: 'Valid API key is required (starts with sk-ant-)' });
    return;
  }

  const pool = getPool();

  const userId = (req as any).userId;

  try {
    // Verify project exists and check ownership
    const { rows: proj } = await pool.query(
      'SELECT id, created_by, github_org FROM projects WHERE id = $1',
      [projectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const isCreator = proj[0].created_by === userId;
    if (!isCreator) {
      const compOwnership = await resolveOwnership(
        pool, userId, proj[0].github_org,
        (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
      );
      if (!compOwnership.isOwner) {
        res.status(403).json({ error: 'Only the project creator or owner can analyze components' });
        return;
      }
    }

    // Get repos with branch selection
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, pr.branch
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1`,
      [projectId]
    );

    if (repos.length === 0) {
      res.status(400).json({ error: 'Project has no repositories' });
      return;
    }

    // Clone/update repos and scan files
    const repoData: RepoInfo[] = [];
    for (const repo of repos) {
      const { localPath } = await cloneOrUpdate(repo.repo_url, repo.branch || undefined);
      const files = scanCodeFiles(localPath);
      repoData.push({
        id: repo.id,
        name: repo.repo_name,
        localPath,
        files,
      });
    }

    // Create analysis record first (synchronous), then run analysis in background
    const { rows: analysisRows } = await pool.query(
      `INSERT INTO component_analyses (project_id, status)
       VALUES ($1, 'pending') RETURNING id`,
      [projectId]
    );
    const analysisId = analysisRows[0].id;

    // Start analysis asynchronously — pass the pre-created analysisId
    runComponentAnalysis(pool, projectId, apiKey, repoData, analysisId).catch(err => {
      console.error(`[ComponentAnalysis] Background analysis failed for project ${projectId}:`, err);
    });

    res.json({ analysisId });
  } catch (err) {
    console.error('Error starting component analysis:', err);
    res.status(500).json({ error: 'Failed to start component analysis' });
  }
});

// GET /api/projects/:id/component-analysis/:analysisId — poll analysis status
router.get('/projects/:id/component-analysis/:analysisId', async (req: Request, res: Response) => {
  const { id: projectId, analysisId } = req.params;
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT id, project_id, status, turns_used, max_turns,
              input_tokens_used, output_tokens_used, cost_usd,
              error_message, created_at, completed_at
       FROM component_analyses WHERE id = $1 AND project_id = $2`,
      [analysisId, projectId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }

    const analysis = rows[0];
    res.json({
      id: analysis.id,
      projectId: analysis.project_id,
      status: analysis.status,
      turnsUsed: analysis.turns_used,
      maxTurns: analysis.max_turns,
      inputTokensUsed: analysis.input_tokens_used,
      outputTokensUsed: analysis.output_tokens_used,
      costUsd: analysis.cost_usd != null ? parseFloat(analysis.cost_usd) : 0,
      errorMessage: analysis.error_message,
      createdAt: analysis.created_at,
      completedAt: analysis.completed_at,
    });
  } catch (err) {
    console.error('Error fetching component analysis:', err);
    res.status(500).json({ error: 'Failed to fetch analysis status' });
  }
});

// GET /api/projects/:id/components — list project components
router.get('/projects/:id/components', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const pool = getPool();

  try {
    const { rows: components } = await pool.query(
      `SELECT c.id, c.name, c.description, c.role, c.file_patterns, c.languages,
              c.security_profile, c.estimated_files, c.estimated_tokens,
              r.repo_name, c.created_at
       FROM components c
       JOIN repositories r ON r.id = c.repo_id
       WHERE c.project_id = $1
       ORDER BY c.estimated_tokens DESC NULLS LAST`,
      [projectId]
    );

    res.json(components.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      role: c.role,
      repoName: c.repo_name,
      filePatterns: c.file_patterns,
      languages: c.languages,
      securityProfile: c.security_profile,
      estimatedFiles: c.estimated_files,
      estimatedTokens: c.estimated_tokens,
      createdAt: c.created_at,
    })));
  } catch (err) {
    console.error('Error listing components:', err);
    res.status(500).json({ error: 'Failed to list components' });
  }
});

// ============================================================
// Dependencies
// ============================================================

// POST /api/dependencies/:id/link — link a dependency to an existing project
router.post('/dependencies/:id/link', requireAuth as any, async (req: Request, res: Response) => {
  const depId = req.params.id;
  const { linkedProjectId } = req.body;

  if (!linkedProjectId) {
    res.status(400).json({ error: 'linkedProjectId is required' });
    return;
  }

  const pool = getPool();

  try {
    // Verify dependency exists
    const { rows: deps } = await pool.query(
      `SELECT pd.id, pd.project_id, p.github_org, p.created_by
       FROM project_dependencies pd
       JOIN projects p ON p.id = pd.project_id
       WHERE pd.id = $1`,
      [depId]
    );
    if (deps.length === 0) {
      res.status(404).json({ error: 'Dependency not found' });
      return;
    }

    // Verify user owns the project or created it
    const dep = deps[0];
    const userId = (req as any).userId;
    if (dep.created_by !== userId) {
      try {
        const ownership = await resolveOwnership(
          pool, userId, dep.github_org,
          (req as any).githubUsername, (req as any).githubToken, (req as any).hasOrgScope,
        );
        if (!ownership.isOwner) {
          res.status(403).json({ error: 'Only the project owner can link dependencies' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Only the project owner can link dependencies' });
        return;
      }
    }

    // Verify linked project exists
    const { rows: proj } = await pool.query(
      'SELECT id FROM projects WHERE id = $1',
      [linkedProjectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Linked project not found' });
      return;
    }

    // Update the dependency
    await pool.query(
      'UPDATE project_dependencies SET linked_project_id = $1 WHERE id = $2',
      [linkedProjectId, depId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error linking dependency:', err);
    res.status(500).json({ error: 'Failed to link dependency' });
  }
});

// GET /api/reports — list public reports
router.get('/reports', async (_req: Request, res: Response) => {
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.audit_level, a.max_severity, a.completed_at,
              p.name as project_name, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.is_public = TRUE AND a.status = 'completed'
       ORDER BY a.completed_at DESC
       LIMIT 50`
    );

    res.json(rows.map(r => ({
      id: r.id,
      auditLevel: r.audit_level,
      maxSeverity: r.max_severity,
      completedAt: r.completed_at,
      projectName: r.project_name,
      githubOrg: r.github_org,
    })));
  } catch (err) {
    console.error('Error listing reports:', err);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

export default router;
