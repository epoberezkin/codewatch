import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import { requireAuth } from './auth';
import { listOrgRepos } from '../services/github';
import { cloneOrUpdate, scanCodeFiles, repoLocalPath } from '../services/git';
import { estimateCosts, roughTokenCount, estimateCostsFromTokenCount } from '../services/tokens';
import { runAudit } from '../services/audit';
import { countTokens } from '../services/claude';
import { config } from '../config';
import type { ScannedFile } from '../services/git';

const router = Router();

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

    res.json({ projectId, repos });
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// GET /api/projects/:id — get project details
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

    // Get repos
    const { rows: repos } = await pool.query(
      `SELECT r.id, r.repo_name, r.repo_url, r.language, r.stars, r.description,
              r.total_files, r.total_tokens, r.default_branch
       FROM repositories r
       JOIN project_repos pr ON pr.repo_id = r.id
       WHERE pr.project_id = $1
       ORDER BY r.stars DESC NULLS LAST`,
      [projectId]
    );

    res.json({
      id: project.id,
      name: project.name,
      description: project.description || '',
      githubOrg: project.github_org,
      category: project.category,
      involvedParties: project.involved_parties,
      threatModel: project.threat_model,
      threatModelSource: project.threat_model_source,
      totalFiles: project.total_files,
      totalTokens: project.total_tokens,
      createdBy: project.created_by,
      creatorUsername: project.creator_username,
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
      })),
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
router.post('/estimate', async (req: Request, res: Response) => {
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

// ============================================================
// Audit History
// ============================================================

// GET /api/project/:id/audits — list audits for a project
router.get('/project/:id/audits', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const pool = getPool();

  try {
    const { rows: audits } = await pool.query(
      `SELECT a.id, a.audit_level, a.is_incremental, a.status, a.max_severity,
              a.created_at, a.completed_at
       FROM audits a
       WHERE a.project_id = $1
       ORDER BY a.created_at DESC`,
      [projectId]
    );

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
  const { projectId, level, apiKey, baseAuditId } = req.body;
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
    // Check project ownership
    const { rows: proj } = await pool.query(
      'SELECT created_by, github_org FROM projects WHERE id = $1',
      [projectId]
    );
    if (proj.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const isOwner = proj[0].created_by === userId;

    // Create audit record
    const { rows: auditRows } = await pool.query(
      `INSERT INTO audits (project_id, requester_id, audit_level, is_owner, base_audit_id, is_incremental)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, userId, level, isOwner, baseAuditId || null, !!baseAuditId]
    );
    const auditId = auditRows[0].id;

    // Start audit asynchronously (don't await)
    runAudit(pool, { auditId, projectId, level, apiKey, baseAuditId }).catch(err => {
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
      `SELECT a.*, p.name as project_name
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
      progressDetail: audit.progress_detail || [],
      maxSeverity: audit.max_severity,
      errorMessage: audit.error_message,
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
      `SELECT a.*, p.name as project_name, p.created_by as project_owner_id
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

    // Determine if requester is owner
    const sessionId = req.cookies?.session;
    let requesterId: string | null = null;
    if (sessionId) {
      const { rows: sessionRows } = await pool.query(
        'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > NOW()',
        [sessionId]
      );
      if (sessionRows.length > 0) requesterId = sessionRows[0].user_id;
    }
    const isOwner = requesterId === audit.project_owner_id;

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

    // Redaction for non-owners
    const redactedSeverities: string[] = [];
    let visibleFindings = findings;
    if (!isOwner && !audit.is_public) {
      const now = new Date();
      const publishableAfter = audit.publishable_after ? new Date(audit.publishable_after) : null;

      if (publishableAfter && now < publishableAfter) {
        // Redact medium+ findings
        redactedSeverities.push('medium', 'high', 'critical');
        visibleFindings = findings.filter(
          f => f.severity === 'low' || f.severity === 'informational'
        );
      }
    }

    res.json({
      id: audit.id,
      projectId: audit.project_id,
      projectName: audit.project_name,
      auditLevel: audit.audit_level,
      isIncremental: audit.is_incremental,
      isOwner,
      isPublic: audit.is_public,
      publishableAfter: audit.publishable_after,
      maxSeverity: audit.max_severity,
      commits: commits.map(c => ({ repoName: c.repo_name, commitSha: c.commit_sha })),
      reportSummary: audit.report_summary,
      severityCounts,
      findings: visibleFindings.map(f => ({
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
      })),
      redactedSeverities,
      createdAt: audit.created_at,
      completedAt: audit.completed_at,
    });
  } catch (err) {
    console.error('Error fetching report:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// GET /api/audit/:id/findings — list findings
router.get('/audit/:id/findings', async (req: Request, res: Response) => {
  const auditId = req.params.id;
  const pool = getPool();

  try {
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

    res.json(rows.map(f => ({
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
    })));
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
    // Verify ownership through finding → audit → project
    const { rows: findings } = await pool.query(
      `SELECT f.id, f.audit_id, p.created_by
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

    if (findings[0].created_by !== userId) {
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

  const pool = getPool();

  try {
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
    // Verify ownership
    const { rows } = await pool.query(
      `SELECT a.id, p.created_by
       FROM audits a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [auditId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    if (rows[0].created_by !== userId) {
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
