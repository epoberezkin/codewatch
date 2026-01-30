// ============================================================
// CodeWatch - Project Dashboard Page (project.html)
// Project metadata, repos, audit history timeline, security posture
// ============================================================

interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  githubOrg: string;
  category: string;
  involvedParties: Record<string, unknown> | null;
  threatModel: string | null;
  threatModelSource: string | null;
  totalFiles: number;
  totalTokens: number;
  repos: Array<{
    id: string;
    repoName: string;
    repoUrl: string;
    language: string;
    stars: number;
    description: string;
  }>;
  createdAt: string;
}

interface AuditSummary {
  id: string;
  auditLevel: string;
  isIncremental: boolean;
  status: string;
  maxSeverity: string | null;
  createdAt: string;
  completedAt: string | null;
  severityCounts: Record<string, number>;
  commits: Array<{ repoName: string; commitSha: string }>;
}

document.addEventListener('DOMContentLoaded', async () => {
  const projectId = getParam('projectId');
  if (!projectId) {
    window.location.href = '/';
    return;
  }

  try {
    const [project, audits] = await Promise.all([
      apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
      apiFetch<AuditSummary[]>(`/api/project/${projectId}/audits`),
    ]);
    renderProject(project);
    renderAudits(audits, projectId);
  } catch (err) {
    setHtml('project-loading',
      `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load project')}</div>`);
    return;
  }

  function renderProject(project: ProjectDetail) {
    hide('project-loading');
    show('project-content');

    setText('project-name', project.name);
    setText('project-description', project.description || `GitHub org: ${project.githubOrg}`);

    const newAuditBtn = $('new-audit-btn') as HTMLAnchorElement | null;
    if (newAuditBtn) newAuditBtn.href = `/estimate.html?projectId=${project.id}`;

    // Meta
    const metaParts = [
      `<span>Org: ${escapeHtml(project.githubOrg)}</span>`,
      `<span>${project.repos.length} repo${project.repos.length !== 1 ? 's' : ''}</span>`,
      project.totalFiles ? `<span>${formatNumber(project.totalFiles)} files</span>` : '',
      project.totalTokens ? `<span>${formatNumber(project.totalTokens)} tokens</span>` : '',
    ].filter(Boolean);
    setHtml('project-meta', metaParts.join(''));

    // Classification
    if (project.category) {
      show('classification-section');
      setText('project-category', project.category.replace(/_/g, ' '));

      if (project.threatModel) {
        setHtml('threat-model-summary', `
          <p class="text-muted mb-1">Source: ${project.threatModelSource || 'unknown'}</p>
          <pre class="code-block">${escapeHtml(project.threatModel.substring(0, 2000))}</pre>
        `);
      }
    }

    // Repos
    const reposHtml = project.repos.map(r => `
      <div class="card" style="margin-bottom: 0.5rem;">
        <div class="flex-between">
          <div>
            <strong>${escapeHtml(r.repoName)}</strong>
            ${r.language ? `<span class="text-sm text-muted"> &middot; ${escapeHtml(r.language)}</span>` : ''}
          </div>
          <span class="text-sm text-muted">${r.stars.toLocaleString()} stars</span>
        </div>
        ${r.description ? `<p class="text-sm text-muted mt-1">${escapeHtml(r.description)}</p>` : ''}
      </div>
    `).join('');
    setHtml('repos-list', reposHtml);
  }

  function renderAudits(audits: AuditSummary[], projectId: string) {
    const timeline = $('audit-timeline');
    const noAudits = $('no-audits');

    if (audits.length === 0) {
      if (noAudits) show(noAudits);
      return;
    }

    if (!timeline) return;

    timeline.innerHTML = audits.map((audit, i) => {
      const sevOrder = ['critical', 'high', 'medium', 'low', 'informational'];
      const sevBadges = sevOrder
        .filter(s => (audit.severityCounts?.[s] || 0) > 0)
        .map(s => `<span class="severity ${severityClass(s)}">${audit.severityCounts[s]} ${s}</span>`)
        .join(' ');

      const commitText = audit.commits?.map(c =>
        `${c.repoName}@${c.commitSha.substring(0, 7)}`
      ).join(', ') || '';

      const link = audit.status === 'completed'
        ? `/report.html?auditId=${audit.id}`
        : audit.status === 'failed'
          ? '#'
          : `/audit.html?auditId=${audit.id}`;

      return `
        <div class="timeline-item ${i === 0 ? 'latest' : ''}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-date">${formatDate(audit.createdAt)}</div>
            <div class="flex-between">
              <div>
                <strong>${audit.auditLevel}</strong>
                ${audit.isIncremental ? '<span class="badge badge-running">incremental</span>' : ''}
                <span class="badge badge-${audit.status === 'completed' ? 'completed' : audit.status === 'failed' ? 'failed' : 'running'}">${audit.status}</span>
              </div>
              <a href="${link}" class="btn btn-sm btn-secondary">View</a>
            </div>
            ${commitText ? `<div class="text-sm text-mono text-muted mt-1">${escapeHtml(commitText)}</div>` : ''}
            ${sevBadges ? `<div class="severity-summary mt-1">${sevBadges}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Current posture from latest completed audit
    const latest = audits.find(a => a.status === 'completed');
    if (latest) {
      show('current-posture');
      setText('posture-text', `Based on ${latest.auditLevel} audit from ${formatDate(latest.createdAt)}`);
      const sevOrder = ['critical', 'high', 'medium', 'low', 'informational'];
      const postureSev = sevOrder
        .filter(s => (latest.severityCounts?.[s] || 0) > 0)
        .map(s => `<div class="severity-count"><span class="severity ${severityClass(s)}">${s}</span> ${latest.severityCounts[s]}</div>`)
        .join('');
      setHtml('posture-severity', postureSev);
    }
  }
});
