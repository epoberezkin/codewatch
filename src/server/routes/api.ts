import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import { requireAuth } from './auth';
import { listOrgRepos, createIssue } from '../services/github';
import { cloneOrUpdate, scanCodeFiles, repoLocalPath } from '../services/git';
import { estimateCosts, roughTokenCount, estimateCostsFromTokenCount, estimateCostsForComponents } from '../services/tokens';
import { runAudit } from '../services/audit';
import { countTokens } from '../services/claude';
import { resolveOwnership } from '../services/ownership';
import { runComponentAnalysis } from '../services/componentAnalysis';
import type { RepoInfo } from '../services/componentAnalysis';
import { config } from '../config';
import type { ScannedFile } from '../services/git';

const router = Router();

// Escape special ILIKE characters in user-provided search terms
function escapeILike(input: string): string {
  return input.replace(/[%_\\]/g, ch => '\\' + ch);
}

// ============================================================
// GitHub Org Repos
// ============================================================

// GET /api/github/orgs/:org/repos
router.get('/github/orgs/:org/repos', async (req: Request, res: Response) => {
  const org = req.params.org as string;
  try {
    // Use session token if available for higher rate limits
    const sessionId = req.cookies?.session;
    let token: string | undefined;
    if (sessionId) {
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT s.github_token FROM sessions s WHERE s.id = $1 AND s.expires_at > NOW()',
        [sessionId]
      );
      if (rows.length > 0) token = rows[0].github_token;
    }

    const repos = await listOrgRepos(org, token);
    res.json(repos.map(r => ({
      name: r.name,
      description: r.description || '',
      language: r.language || '',
      stars: r.stargazers_count,
      forks: r.forks_count,
      defaultBranch: r.default_branch,
      license: r.license?.spdx_id || null,
      url: r.html_url,
      githubId: r.id,
    })));
  } catch (err) {
    console.error('Error listing org repos:', err);
    res.status(500).json({ error: 'Failed to list organization repositories' });
  }
});

// ============================================================
// Projects
// ============================================================

// POST /api/projects — create project with repos
router.post('/projects', requireAuth as any, async (req: Request, res: Response) => {
  const { githubOrg, repoNames } = req.body;
  const userId = (req as any).userId;

  if (!githubOrg || !Array.isArray(repoNames) || repoNames.length === 0) {
    res.status(400).json({ error: 'githubOrg and repoNames[] are required' });
    return;
  }

  // Validate githubOrg format (alphanumeric, hyphens, no special chars)
  if (typeof githubOrg !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(githubOrg)) {
    res.status(400).json({ error: 'Invalid GitHub org/user name' });
    return;
  }

  // Validate each repo name is a non-empty string with valid characters
  for (const name of repoNames) {
    if (typeof name !== 'string' || name.length === 0 || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: `Invalid repository name: ${typeof name === 'string' ? name : '(non-string)'}` });
      return;
    }
  }

  const pool = getPool();

  try {
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
    for (const repoName of repoNames) {
      const repoUrl = `https://github.com/${githubOrg}/${repoName}`;
      const repoPath = repoLocalPath(repoUrl);

      // Upsert repository
      const { rows: repoRows } = await pool.query(
        `INSERT INTO repositories (repo_url, github_org, repo_name, repo_path)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (repo_url) DO UPDATE SET
           github_org = $2,
           repo_name = $3
         RETURNING id`,
        [repoUrl, githubOrg, repoName, repoPath]
      );
      const repoId = repoRows[0].id;

      // Link to project
      await pool.query(
        'INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [projectId, repoId]
      );

      repos.push({ id: repoId, repoName, repoUrl });
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

// GET /api/projects/browse — public browse or "My Projects" listing
router.get('/projects/browse', async (req: Request, res: Response) => {
  const pool = getPool();
  const { category, severity, search, mine } = req.query;

  try {
    // If mine=true, require auth
    let userId: string | null = null;
    let githubUsername: string | null = null;
    let githubToken: string | null = null;
    let hasOrgScope = false;

    const sessionId = req.cookies?.session;
    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        userId = sessionRows[0].user_id;
        githubUsername = sessionRows[0].github_username;
        githubToken = sessionRows[0].github_token;
        hasOrgScope = sessionRows[0].has_org_scope;
      }
    }

    if (mine === 'true') {
      if (!userId) {
        res.status(401).json({ error: 'Authentication required for My Projects' });
        return;
      }

      // My Projects: all projects created by user
      let myQuery = `
        SELECT p.id, p.name, p.github_org, p.category, p.created_at,
               (SELECT COUNT(*) FROM audits a WHERE a.project_id = p.id) as audit_count,
               (SELECT COUNT(*) FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE) as public_audit_count,
               (SELECT a.max_severity FROM audits a WHERE a.project_id = p.id AND a.status = 'completed'
                ORDER BY a.completed_at DESC LIMIT 1) as latest_severity,
               (SELECT a.completed_at FROM audits a WHERE a.project_id = p.id AND a.status = 'completed'
                ORDER BY a.completed_at DESC LIMIT 1) as latest_audit_date,
               (SELECT string_agg(DISTINCT r.license, ', ') FROM repositories r
                JOIN project_repos pr ON pr.repo_id = r.id
                WHERE pr.project_id = p.id AND r.license IS NOT NULL) as license
        FROM projects p
        WHERE p.created_by = $1`;
      const params: any[] = [userId];
      let paramIdx = 2;

      if (category && category !== 'all') {
        myQuery += ` AND p.category = $${paramIdx}`;
        params.push(category);
        paramIdx++;
      }
      if (search) {
        myQuery += ` AND (p.name ILIKE $${paramIdx} OR p.github_org ILIKE $${paramIdx})`;
        params.push(`%${escapeILike(String(search))}%`);
        paramIdx++;
      }

      myQuery += ' ORDER BY p.created_at DESC LIMIT 50';

      const { rows: projects } = await pool.query(myQuery, params);

      // Resolve ownership for each project
      const results = await Promise.all(projects.map(async (p) => {
        let ownership = { isOwner: false, role: null as string | null, needsReauth: false };
        if (githubUsername && githubToken) {
          try {
            const result = await resolveOwnership(pool, userId!, p.github_org, githubUsername, githubToken, hasOrgScope);
            ownership = { isOwner: result.isOwner, role: result.role || null, needsReauth: result.needsReauth || false };
          } catch { /* ignore ownership check failures */ }
        }

        return {
          id: p.id,
          name: p.name,
          githubOrg: p.github_org,
          category: p.category,
          license: p.license || null,
          auditCount: parseInt(p.audit_count),
          publicAuditCount: parseInt(p.public_audit_count),
          latestSeverity: p.latest_severity || null,
          latestAuditDate: p.latest_audit_date || null,
          createdAt: p.created_at,
          ownership,
        };
      }));

      res.json(results);
      return;
    }

    // Public browse: projects with at least one public audit
    let browseQuery = `
      SELECT p.id, p.name, p.github_org, p.category, p.created_at,
             (SELECT COUNT(*) FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE) as public_audit_count,
             (SELECT a.max_severity FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE AND a.status = 'completed'
              ORDER BY a.completed_at DESC LIMIT 1) as latest_public_severity,
             (SELECT a.completed_at FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE AND a.status = 'completed'
              ORDER BY a.completed_at DESC LIMIT 1) as latest_audit_date,
             (SELECT string_agg(DISTINCT r.license, ', ') FROM repositories r
              JOIN project_repos pr ON pr.repo_id = r.id
              WHERE pr.project_id = p.id AND r.license IS NOT NULL) as license
      FROM projects p
      WHERE EXISTS (SELECT 1 FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE)`;
    const params: any[] = [];
    let paramIdx = 1;

    if (category && category !== 'all') {
      browseQuery += ` AND p.category = $${paramIdx}`;
      params.push(category);
      paramIdx++;
    }
    if (severity && severity !== 'all') {
      browseQuery += ` AND EXISTS (SELECT 1 FROM audits a WHERE a.project_id = p.id AND a.is_public = TRUE AND a.max_severity = $${paramIdx})`;
      params.push(severity);
      paramIdx++;
    }
    if (search) {
      browseQuery += ` AND (p.name ILIKE $${paramIdx} OR p.github_org ILIKE $${paramIdx})`;
      params.push(`%${escapeILike(String(search))}%`);
      paramIdx++;
    }

    browseQuery += ' ORDER BY p.created_at DESC LIMIT 50';

    const { rows: projects } = await pool.query(browseQuery, params);

    res.json(projects.map(p => ({
      id: p.id,
      name: p.name,
      githubOrg: p.github_org,
      category: p.category,
      license: p.license || null,
      publicAuditCount: parseInt(p.public_audit_count),
      latestPublicSeverity: p.latest_public_severity || null,
      latestAuditDate: p.latest_audit_date || null,
      createdAt: p.created_at,
    })));
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
    const sessionId = req.cookies?.session;
    let viewerId: string | null = null;
    let isOwner = false;
    let ownership: { isOwner: boolean; role: string | null; needsReauth: boolean } | null = null;

    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        viewerId = sessionRows[0].user_id;
        try {
          const result = await resolveOwnership(
            pool, viewerId!, project.github_org,
            sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
          );
          isOwner = result.isOwner;
          ownership = { isOwner: result.isOwner, role: result.role || null, needsReauth: result.needsReauth || false };
        } catch { /* ignore */ }
      }
    }

    // Get repos with license
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_name, r.repo_url, r.language, r.stars, r.description,
              r.total_files, r.total_tokens, r.default_branch, r.license
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

    res.json({
      id: project.id,
      name: project.name,
      description: project.description || '',
      githubOrg: project.github_org,
      category: project.category,
      license,
      involvedParties: project.involved_parties,
      threatModel: project.threat_model,
      threatModelSource: project.threat_model_source,
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

// ============================================================
// Estimation
// ============================================================

// POST /api/estimate — rough estimation
router.post('/estimate', requireAuth as any, async (req: Request, res: Response) => {
  const { projectId } = req.body;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const pool = getPool();

  try {
    // Get project repos
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, r.repo_path, r.default_branch
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
    const repoBreakdown = [];
    const cloneErrors: Array<{ repoName: string; error: string }> = [];
    const allFiles: ScannedFile[] = [];

    for (const repo of repos) {
      let files: ScannedFile[];
      try {
        const { localPath, headSha } = await cloneOrUpdate(repo.repo_url);
        files = scanCodeFiles(localPath);

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
router.post('/estimate/precise', requireAuth as any, async (req: Request, res: Response) => {
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
    // Get project repos
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name, r.repo_path, r.default_branch
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
    const repoLocalPaths: Map<string, string> = new Map();
    const fs = await import('fs');
    const path = await import('path');

    for (const repo of repos) {
      let files: ScannedFile[];
      try {
        const { localPath } = await cloneOrUpdate(repo.repo_url);
        repoLocalPaths.set(repo.repo_name, localPath);
        files = scanCodeFiles(localPath);
        files = files.map(f => ({
          ...f,
          relativePath: `${repo.repo_name}/${f.relativePath}`,
        }));
      } catch {
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
    // Count tokens in batches to stay within context limits
    const BATCH_SIZE = 100;
    let totalPreciseTokens = 0;
    const systemPrompt = 'You are a security auditor analyzing source code.';

    for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
      const batch = allFiles.slice(i, i + BATCH_SIZE);
      const userMessage = batch.map(f => {
        try {
          // Resolve absolute path: repoLocalPath + path within repo
          const slashIdx = f.relativePath.indexOf('/');
          const repoName = f.relativePath.substring(0, slashIdx);
          const filePath = f.relativePath.substring(slashIdx + 1);
          const localPath = repoLocalPaths.get(repoName);
          if (!localPath) return '';
          const content = fs.readFileSync(path.join(localPath, filePath), 'utf-8');
          return `### File: ${f.relativePath}\n\`\`\`\n${content}\n\`\`\``;
        } catch {
          return '';
        }
      }).filter(Boolean).join('\n\n');

      if (userMessage.length === 0) continue;

      const tokens = await countTokens(
        config.anthropicServiceKey,
        systemPrompt,
        userMessage,
      );
      totalPreciseTokens += tokens;
    }

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
    });
  } catch (err) {
    console.error('Error computing precise estimate:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute precise estimate' });
  }
});

// POST /api/estimate/components — scoped cost estimates for selected components
router.post('/estimate/components', requireAuth as any, async (req: Request, res: Response) => {
  const { projectId, componentIds } = req.body;

  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  if (!Array.isArray(componentIds)) {
    res.status(400).json({ error: 'componentIds must be an array' });
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

    const estimate = await estimateCostsForComponents(pool, componentIds);

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
    const sessionId = req.cookies?.session;
    let viewerId: string | null = null;
    let isOwner = false;

    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        viewerId = sessionRows[0].user_id;
        const { rows: projRows } = await pool.query(
          'SELECT github_org FROM projects WHERE id = $1',
          [projectId]
        );
        if (projRows.length > 0) {
          try {
            const ownership = await resolveOwnership(
              pool, viewerId!, projRows[0].github_org,
              sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
            );
            isOwner = ownership.isOwner;
          } catch { /* ignore ownership check failures */ }
        }
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
    let isPrivileged = false;
    const sessionId = req.cookies?.session;
    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        const userId = sessionRows[0].user_id;
        if (userId === audit.requester_id) {
          isPrivileged = true;
        } else {
          try {
            const ownership = await resolveOwnership(
              pool, userId, audit.github_org,
              sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
            );
            if (ownership.isOwner) isPrivileged = true;
          } catch { /* not owner */ }
        }
      }
    }

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
      status: audit.status,
      auditLevel: audit.audit_level,
      isIncremental: audit.is_incremental,
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
              p.involved_parties, p.threat_model, p.threat_model_source
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
    const sessionId = req.cookies?.session;
    let requesterId: string | null = null;
    let isOwner = false;
    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        requesterId = sessionRows[0].user_id;
        const { rows: projRows } = await pool.query(
          'SELECT github_org FROM projects WHERE id = $1',
          [audit.project_id]
        );
        if (projRows.length > 0) {
          try {
            const ownership = await resolveOwnership(
              pool, requesterId!, projRows[0].github_org,
              sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
            );
            isOwner = ownership.isOwner;
          } catch {
            // Ownership check failed (e.g. GitHub API down) — default to not owner
          }
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
    const now = new Date();
    const publishableAfter = audit.publishable_after ? new Date(audit.publishable_after) : null;

    // Check if report should have full access for everyone
    // Auto-publish requires that the owner was actually notified (responsible disclosure)
    const isAutoPublished = publishableAfter && audit.owner_notified && now >= publishableAfter;
    const fullAccessForAll = audit.is_public || isAutoPublished;

    // Determine access tier
    let accessTier: 'owner' | 'requester' | 'public';
    if (fullAccessForAll || isOwner) {
      accessTier = 'owner'; // Full access
    } else if (isRequester) {
      accessTier = 'requester'; // Redacted findings list
    } else {
      accessTier = 'public'; // Summary only
    }

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
      threatModel: audit.threat_model || null,
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
    const sessionId = req.cookies?.session;
    let viewerId: string | null = null;
    let isOwner = false;

    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length > 0) {
        viewerId = sessionRows[0].user_id;
        const { rows: projRows } = await pool.query(
          'SELECT github_org FROM projects WHERE id = $1',
          [audit.project_id]
        );
        if (projRows.length > 0) {
          try {
            const ownership = await resolveOwnership(
              pool, viewerId!, projRows[0].github_org,
              sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
            );
            isOwner = ownership.isOwner;
          } catch {
            // Ownership check failed — default to not owner
          }
        }
      }
    }

    // Three-tier access control (same logic as report endpoint)
    const isRequester = viewerId === audit.requester_id;
    const now = new Date();
    const publishableAfter = audit.publishable_after ? new Date(audit.publishable_after) : null;
    const isAutoPublished = publishableAfter && audit.owner_notified && now >= publishableAfter;
    const fullAccessForAll = audit.is_public || isAutoPublished;

    let accessTier: 'owner' | 'requester' | 'public';
    if (fullAccessForAll || isOwner) {
      accessTier = 'owner';
    } else if (isRequester) {
      accessTier = 'requester';
    } else {
      accessTier = 'public';
    }

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
      const sessionId = req.cookies?.session;
      let hasAccess = false;
      if (sessionId) {
        const { rows: sessionRows } = await pool.query(
          `SELECT s.user_id, s.github_token, s.has_org_scope, u.github_username
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.expires_at > NOW()`,
          [sessionId]
        );
        if (sessionRows.length > 0) {
          const userId = sessionRows[0].user_id;
          if (userId === audit.requester_id) {
            hasAccess = true;
          } else {
            try {
              const ownership = await resolveOwnership(
                pool, userId, audit.github_org,
                sessionRows[0].github_username, sessionRows[0].github_token, sessionRows[0].has_org_scope,
              );
              if (ownership.isOwner) hasAccess = true;
            } catch { /* not owner */ }
          }
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
      `SELECT a.id, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
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
      `SELECT a.id, p.github_org
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
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
        const count = parseInt(findingCount.rows[0].count);
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
    let publishableAfter: Date;
    if (maxSev === 'critical') {
      publishableAfter = new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000); // 6 months
    } else if (maxSev === 'high' || maxSev === 'medium') {
      publishableAfter = new Date(Date.now() + 3 * 30 * 24 * 60 * 60 * 1000); // 3 months
    } else {
      // low/informational/none: immediate auto-publish
      publishableAfter = new Date();
    }

    await pool.query(
      `UPDATE audits SET owner_notified = TRUE, owner_notified_at = NOW(), publishable_after = $1
       WHERE id = $2`,
      [publishableAfter, auditId]
    );

    res.json({ ok: true, publishableAfter });
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

  try {
    const { rows } = await pool.query(
      'SELECT id, requester_id FROM audits WHERE id = $1',
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    if (rows[0].requester_id !== userId) {
      res.status(403).json({ error: 'Only the audit requester can delete' });
      return;
    }

    // Cascade delete in transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM audit_comments WHERE audit_id = $1', [auditId]);
      await client.query('DELETE FROM audit_findings WHERE audit_id = $1', [auditId]);
      await client.query('DELETE FROM audit_commits WHERE audit_id = $1', [auditId]);
      await client.query('DELETE FROM audit_components WHERE audit_id = $1', [auditId]);
      await client.query('DELETE FROM audits WHERE id = $1', [auditId]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.status(204).end();
  } catch (err) {
    console.error('Error deleting audit:', err);
    res.status(500).json({ error: 'Failed to delete audit' });
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

  try {
    // Verify project exists
    const { rows: proj } = await pool.query(
      'SELECT id FROM projects WHERE id = $1',
      [projectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Get repos
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_url, r.repo_name
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
      const { localPath } = await cloneOrUpdate(repo.repo_url);
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
