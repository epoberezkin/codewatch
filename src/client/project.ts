// Spec: spec/client/project.md
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
  license: string | null;
  involvedParties: Record<string, unknown> | null;
  threatModel: string | null;
  threatModelParties: Array<{name: string; can: string[]; cannot: string[]}>;
  threatModelFileLinks: Array<{path: string; url: string}>;
  threatModelSource: string | null;
  totalFiles: number;
  totalTokens: number;
  createdBy: string;
  creatorUsername: string | null;
  ownership: {
    isOwner: boolean;
    role: string | null;
    needsReauth: boolean;
  } | null;
  repos: Array<{
    id: string;
    repoName: string;
    repoUrl: string;
    language: string;
    stars: number;
    description: string;
    license: string | null;
    totalFiles: number;
    totalTokens: number;
    defaultBranch: string;
    branch: string | null;
  }>;
  components: Array<{
    id: string;
    name: string;
    description: string;
    role: string;
    repoName: string;
    filePatterns: string[];
    languages: string[];
    securityProfile: { summary?: string; threat_surface?: string[] } | null;
    estimatedFiles: number;
    estimatedTokens: number;
  }>;
  dependencies: Array<{
    id: string;
    name: string;
    version: string;
    ecosystem: string;
    sourceRepoUrl: string | null;
    linkedProjectId: string | null;
    repoName: string | null;
  }>;
  audits: Array<{
    id: string;
    auditLevel: string;
    isIncremental: boolean;
    status: string;
    maxSeverity: string | null;
    createdAt: string;
    completedAt: string | null;
    isPublic: boolean;
    severityCounts: Record<string, number>;
  }>;
  createdAt: string;
}

document.addEventListener('DOMContentLoaded', async () => {
  const projectId = getParam('projectId');
  if (!projectId) {
    window.location.href = '/';
    return;
  }

  // Wait for auth check to complete before reading currentUser
  await waitForAuth();

  try {
    const project = await apiFetch<ProjectDetail>(`/api/projects/${projectId}`);
    renderProject(project);
    renderComponents(project.components);
    renderDependencies(project.dependencies);
    renderAudits(project.audits);
    renderDeleteButton(project);
  } catch (err) {
    setHtml('project-loading',
      `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load project')}</div>`);
    return;
  }

  // Spec: spec/client/project.md#renderProject
  function renderProject(project: ProjectDetail) {
    hide('project-loading');
    show('project-content');

    // Project name = repo names joined
    const repoNames = project.repos.map(r => r.repoName);
    const projectTitle = repoNames.length <= 3
      ? repoNames.join(' + ')
      : `${repoNames.slice(0, 2).join(' + ')} + ${repoNames.length - 2} more`;
    setText('project-name', projectTitle || project.name);
    setText('project-description', `GitHub org: ${project.githubOrg}`);

    // Ownership badge
    if (project.ownership) {
      const badgeEl = $('ownership-badge');
      if (badgeEl) {
        if (project.ownership.needsReauth && !project.ownership.isOwner) {
          badgeEl.innerHTML = `<a href="/auth/github?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}" class="badge badge-pending" style="text-decoration: none;">re-auth needed</a>`;
        } else {
          badgeEl.innerHTML = renderOwnershipBadge(project.ownership);
        }
      }
    }

    const newAuditBtn = $('new-audit-btn') as HTMLAnchorElement | null;
    if (newAuditBtn) newAuditBtn.href = `/estimate.html?projectId=${project.id}`;

    // Change Branches link → estimate page
    const branchBtn = $('change-branches-btn') as HTMLAnchorElement | null;
    if (branchBtn) {
      branchBtn.href = `/estimate.html?projectId=${project.id}`;
      branchBtn.textContent = project.repos.length === 1 ? 'Change Branch' : 'Change Branches';
    }

    // Classification
    if (project.category) {
      show('classification-section');
      setText('project-category', project.category.replace(/_/g, ' '));

      // Threat model display: evaluation text → source file links → parties table
      renderThreatModel('threat-model-summary', project);
    }

    // Repos — compact rows: name ↗ · files · tokens · branch
    const externalIcon = '<svg class="icon-external" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 1.5h7v7M10.5 1.5L4 8"/></svg>';
    const reposHtml = project.repos.map(r => {
      const parts: string[] = [];
      const nameHtml = r.repoUrl
        ? `<a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener" class="repo-link">${escapeHtml(r.repoName)}${externalIcon}</a>`
        : escapeHtml(r.repoName);
      parts.push(nameHtml);
      if (r.totalFiles) parts.push(`${formatNumber(r.totalFiles)} files`);
      if (r.totalTokens) parts.push(`${formatNumber(r.totalTokens)} tokens`);
      const branch = r.branch || r.defaultBranch || '';
      if (branch) parts.push(escapeHtml(branch));
      return `<div class="repo-row">${parts.join(' &middot; ')}</div>`;
    }).join('');

    let totalHtml = '';
    if (project.repos.length > 1) {
      const totalFiles = project.repos.reduce((s, r) => s + (r.totalFiles || 0), 0);
      const totalTokens = project.repos.reduce((s, r) => s + (r.totalTokens || 0), 0);
      totalHtml = `<hr style="margin: 0.5rem 0"><div class="repo-row"><strong>Total &middot; ${formatNumber(totalFiles)} files &middot; ${formatNumber(totalTokens)} tokens</strong></div>`;
    }
    setHtml('repos-list', reposHtml + totalHtml);
  }

  // Spec: spec/client/project.md#renderComponents
  function renderComponents(components: ProjectDetail['components']) {
    if (components.length === 0) return;
    show('components-section');

    const tbody = $('components-body');
    if (!tbody) return;

    tbody.innerHTML = components.map(c => `
      <tr>
        <td>
          <strong>${escapeHtml(c.name)}</strong>
          <br><small class="text-muted">${escapeHtml(c.description.substring(0, 80))}</small>
        </td>
        <td>${escapeHtml(c.repoName)}</td>
        <td>${escapeHtml(c.role || '--')}</td>
        <td>${formatNumber(c.estimatedFiles)}</td>
        <td>${formatNumber(c.estimatedTokens)}</td>
        <td>${c.securityProfile?.summary ? `<small>${escapeHtml(c.securityProfile.summary.substring(0, 60))}</small>` : '--'}</td>
      </tr>
    `).join('');
  }

  // Spec: spec/client/project.md#renderDependencies
  function renderDependencies(dependencies: ProjectDetail['dependencies']) {
    if (dependencies.length === 0) return;
    show('dependencies-section');

    const grouped: Record<string, typeof dependencies> = {};
    for (const dep of dependencies) {
      const eco = dep.ecosystem || 'other';
      if (!grouped[eco]) grouped[eco] = [];
      grouped[eco].push(dep);
    }

    let html = '';
    for (const [ecosystem, deps] of Object.entries(grouped)) {
      html += `<h4 class="mt-1">${escapeHtml(ecosystem)}</h4><ul>`;
      for (const dep of deps) {
        const version = dep.version ? ` <span class="text-muted">${escapeHtml(dep.version)}</span>` : '';
        let action = '';
        if (dep.linkedProjectId) {
          action = ` <a href="/project.html?projectId=${dep.linkedProjectId}" class="btn btn-sm btn-secondary">View Project</a>`;
        } else if (currentUser) {
          action = ` <button class="btn btn-sm btn-secondary add-as-project-btn" data-dep-id="${dep.id}" data-name="${escapeHtml(dep.name)}" data-url="${dep.sourceRepoUrl ? escapeHtml(dep.sourceRepoUrl) : ''}">Add as Project</button>`;
        } else if (dep.sourceRepoUrl) {
          action = ` <a href="${escapeHtml(dep.sourceRepoUrl)}" target="_blank" rel="noopener" class="text-sm">source</a>`;
        }
        html += `<li>${escapeHtml(dep.name)}${version}${action}</li>`;
      }
      html += '</ul>';
    }
    setHtml('dependencies-list', html);

    // Attach "Add as Project" click handlers using shared helper
    attachAddAsProjectHandlers('.add-as-project-btn');
  }

  // Spec: spec/client/project.md#renderAudits
  function renderAudits(audits: ProjectDetail['audits']) {
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
                <strong>${escapeHtml(audit.auditLevel)}</strong>
                ${audit.isIncremental ? '<span class="badge badge-running">incremental</span>' : ''}
                <span class="badge badge-${audit.status === 'completed' ? 'completed' : audit.status === 'failed' ? 'failed' : 'running'}">${escapeHtml(audit.status)}</span>
                ${audit.isPublic ? '<span class="badge badge-completed">public</span>' : ''}
              </div>
              <a href="${link}" class="btn btn-sm btn-secondary">View</a>
            </div>
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

  // Spec: spec/client/project.md#renderDeleteButton
  function renderDeleteButton(project: ProjectDetail) {
    const deleteBtn = $('delete-project-btn');
    if (!deleteBtn) return;

    // Show delete button only if current user is the creator
    if (currentUser && currentUser.id === project.createdBy) {
      show('delete-section');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete this project? This cannot be undone.')) return;

        try {
          await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' });
          window.location.href = '/projects.html';
        } catch (err) {
          showError(err instanceof Error ? err.message : 'Failed to delete project');
        }
      });
    }
  }
});
