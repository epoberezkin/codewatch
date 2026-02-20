// Spec: spec/client/report.md
// ============================================================
// CodeWatch - Report View Page (report.html)
// Full owner view, redacted non-owner view, comments, publish
// ============================================================

interface Finding {
  id: string;
  severity: string;
  cweId: string;
  cvssScore: number;
  title: string;
  description: string;
  exploitation: string;
  recommendation: string;
  codeSnippet: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  repoName: string;
  status: string;
}

interface ReportData {
  id: string;
  projectId: string;
  projectName: string;
  githubOrg: string;
  githubEntityType: string | null;
  auditLevel: string;
  isIncremental: boolean;
  isOwner: boolean;
  isRequester: boolean;
  isPublic: boolean;
  publishableAfter: string | null;
  ownerNotified: boolean;
  ownerNotifiedAt: string | null;
  maxSeverity: string | null;
  // Classification & threat model
  category: string | null;
  projectDescription: string | null;
  involvedParties: Record<string, unknown> | null;
  threatModel: string | null;
  threatModelParties: Array<{name: string; can: string[]; cannot: string[]}>;
  threatModelFileLinks: Array<{path: string; url: string}>;
  threatModelSource: string | null;
  commits: Array<{ repoName: string; commitSha: string }>;
  reportSummary: {
    executive_summary: string;
    security_posture: string;
    responsible_disclosure: Record<string, string>;
  } | null;
  severityCounts: Record<string, number>;
  findings: Finding[];
  redactedSeverities: string[];
  redactionNotice: string | null;
  componentBreakdown: Array<{
    componentId: string;
    name: string;
    role: string;
    tokensAnalyzed: number;
    findingsCount: number;
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
  accessTier: 'owner' | 'requester' | 'public';
  createdAt: string;
  completedAt: string;
}

interface Comment {
  id: string;
  userId: string;
  username: string;
  content: string;
  findingId: string | null;
  createdAt: string;
}

document.addEventListener('DOMContentLoaded', async () => {
  const auditId = getParam('auditId');
  if (!auditId) {
    window.location.href = '/';
    return;
  }

  // Wait for auth check to complete before reading currentUser
  await waitForAuth();

  let reportData: ReportData | null = null;

  try {
    reportData = await apiFetch<ReportData>(`/api/audit/${auditId}/report`);
    renderReport(reportData);
  } catch (err) {
    setHtml('executive-summary',
      `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load report')}</div>`);
    return;
  }

  // Spec: spec/client/report.md#renderReport
  function renderReport(data: ReportData) {
    // Header: project name as linked title, org/user + audit meta below
    setHtml('report-title',
      `<a href="/project.html?projectId=${data.projectId}">${escapeHtml(data.projectName)}</a>`);
    const isSingleRepo = data.commits.length === 1;
    const commitsHtml = data.commits.map(c => {
      // For single-repo, omit repo name (it's already in the title)
      const label = isSingleRepo ? `@${c.commitSha.substring(0, 7)}` : `${c.repoName}@${c.commitSha.substring(0, 7)}`;
      return `<span class="text-mono">${escapeHtml(label)}</span>`;
    }).join('');
    const entityLabel = data.githubEntityType === 'User' ? 'GitHub user' : 'GitHub org';
    setHtml('report-meta', `
      <span>${escapeHtml(entityLabel)}: ${escapeHtml(data.githubOrg)}</span>
      <span>${formatDate(data.completedAt || data.createdAt)}</span>
      <span>${escapeHtml(data.auditLevel)}${data.isIncremental ? ' (incremental)' : ''}</span>
      ${commitsHtml}
    `);

    // "Back to Project" link (Issue #28)
    const backLink = $('back-to-project-link') as HTMLAnchorElement | null;
    if (backLink) {
      backLink.href = `/project.html?projectId=${data.projectId}`;
    }

    // Access tier badge
    setHtml('access-tier-badge', renderAccessTierBadge(data.accessTier));

    // Severity summary
    const sevOrder = ['critical', 'high', 'medium', 'low', 'informational'];
    const sevHtml = sevOrder
      .filter(s => (data.severityCounts[s] || 0) > 0)
      .map(s => `<div class="severity-count"><span class="severity ${severityClass(s)}">${s}</span> ${data.severityCounts[s]}</div>`)
      .join('');
    setHtml('severity-summary', sevHtml);

    // Owner controls
    if (data.isOwner) {
      show('owner-controls');
      const newAuditLink = $('new-audit-link') as HTMLAnchorElement | null;
      if (newAuditLink) newAuditLink.href = `/estimate.html?projectId=${data.projectId}`;

      if (data.isPublic) {
        hide('publish-btn');
        show('unpublish-btn');
      }
    }

    // Requester controls: "Notify Owner" button
    if (data.isRequester && !data.isOwner && !data.ownerNotified) {
      show('requester-controls');
    }

    // Show notification status if owner was notified
    if (data.ownerNotified && data.publishableAfter) {
      show('notification-status');
      const statusEl = $('notification-status');
      if (statusEl) {
        statusEl.innerHTML = `<p>Owner notified${data.ownerNotifiedAt ? ` on ${formatDate(data.ownerNotifiedAt)}` : ''}. Full report will be available after ${formatDate(data.publishableAfter)}.</p>`;
      }
    }

    // Executive summary
    if (data.reportSummary) {
      setHtml('executive-summary', `<p>${escapeHtml(data.reportSummary.executive_summary)}</p>`);

      // Security posture
      show('posture-section');
      setHtml('security-posture', `<p>${escapeHtml(data.reportSummary.security_posture)}</p>`);

      // Responsible disclosure
      if (data.reportSummary.responsible_disclosure && Object.keys(data.reportSummary.responsible_disclosure).length > 0) {
        show('disclosure-section');
        const discHtml = Object.entries(data.reportSummary.responsible_disclosure)
          .map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`)
          .join('');
        setHtml('disclosure-content', discHtml);
      }
    } else {
      setHtml('executive-summary', '<p class="text-muted">No summary available.</p>');
    }

    // Classification section
    if (data.category) {
      show('classification-section');
      const classHtml: string[] = [];
      classHtml.push(`<span class="badge badge-running">${escapeHtml(data.category.replace(/_/g, ' '))}</span>`);
      if (data.projectDescription) {
        classHtml.push(`<p class="mt-1">${escapeHtml(data.projectDescription)}</p>`);
      }
      setHtml('classification-content', classHtml.join(''));
    }

    // Threat model section: evaluation text → source file links → parties table
    if (renderThreatModel('threat-model-content', data)) {
      show('threat-model-section');
    }

    // Component breakdown
    if (data.componentBreakdown && data.componentBreakdown.length > 0) {
      show('component-breakdown-section');
      const tbody = $('component-breakdown-body');
      if (tbody) {
        tbody.innerHTML = data.componentBreakdown.map(cb => `
          <tr>
            <td><strong>${escapeHtml(cb.name)}</strong></td>
            <td>${escapeHtml(cb.role || '--')}</td>
            <td>${cb.findingsCount}</td>
            <td>${formatNumber(cb.tokensAnalyzed)}</td>
          </tr>
        `).join('');
      }
    }

    // Dependencies
    if (data.dependencies && data.dependencies.length > 0) {
      show('dependencies-section');
      const grouped: Record<string, typeof data.dependencies> = {};
      for (const dep of data.dependencies) {
        const eco = dep.ecosystem || 'other';
        if (!grouped[eco]) grouped[eco] = [];
        grouped[eco].push(dep);
      }
      let depsHtml = '';
      for (const [ecosystem, deps] of Object.entries(grouped)) {
        depsHtml += `<h4 class="mt-1">${escapeHtml(ecosystem)}</h4><ul>`;
        for (const dep of deps) {
          const version = dep.version ? ` <span class="text-muted">${escapeHtml(dep.version)}</span>` : '';
          let action = '';
          if (dep.linkedProjectId) {
            action = ` <a href="/project.html?projectId=${dep.linkedProjectId}" class="btn btn-sm btn-secondary">View Project</a>`;
          } else if (currentUser) {
            action = ` <button class="btn btn-sm btn-secondary add-dep-project-btn" data-dep-id="${dep.id}" data-name="${escapeHtml(dep.name)}" data-url="${dep.sourceRepoUrl ? escapeHtml(dep.sourceRepoUrl) : ''}">Add as Project</button>`;
          } else if (dep.sourceRepoUrl) {
            action = ` <a href="${escapeHtml(dep.sourceRepoUrl)}" target="_blank" class="text-sm">source</a>`;
          }
          depsHtml += `<li>${escapeHtml(dep.name)}${version}${action}</li>`;
        }
        depsHtml += '</ul>';
      }
      setHtml('dependencies-content', depsHtml);

      // Attach "Add as Project" handlers using shared helper
      attachAddAsProjectHandlers('.add-dep-project-btn');
    }

    // Redacted notice
    if (data.redactionNotice) {
      show('redacted-notice');
      const noticeEl = $('redacted-notice');
      if (noticeEl) {
        noticeEl.innerHTML = `<p>${escapeHtml(data.redactionNotice)}</p>`;
      }
    }

    // Findings
    renderFindings(data.findings, data.isOwner);

    // Comments — visible to all, form only for participants (owner or requester)
    show('comments-section');
    loadComments(auditId!);
    if (currentUser && (data.isOwner || data.isRequester)) {
      show('comment-form');
    }
  }

  // Spec: spec/client/report.md#renderFindings
  function renderFindings(findings: Finding[], isOwner: boolean) {
    if (findings.length === 0) {
      setHtml('findings-list', '<div class="empty-state"><h3>No findings</h3><p>No vulnerabilities were identified.</p></div>');
      return;
    }

    show('findings-header');
    renderFindingsList(findings);

    // Filters — constrain dropdowns to only values present in findings
    const sevFilter = $('severity-filter') as HTMLSelectElement | null;
    const statusFilter = $('status-filter') as HTMLSelectElement | null;

    if (sevFilter) {
      const presentSeverities = new Set(findings.map(f => f.severity));
      const sevOrder = ['critical', 'high', 'medium', 'low', 'informational'];
      sevFilter.innerHTML = '<option value="all">All Severities</option>' +
        sevOrder.filter(s => presentSeverities.has(s))
          .map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`)
          .join('');
    }

    if (statusFilter) {
      const presentStatuses = new Set(findings.map(f => f.status));
      statusFilter.innerHTML = '<option value="all">All Statuses</option>' +
        Array.from(presentStatuses)
          .map(k => `<option value="${k}">${formatStatus(k)}</option>`)
          .join('');
    }

    // Filter count badge (Issue #70)
    function updateFilterCount() {
      const sev = sevFilter?.value || 'all';
      const status = statusFilter?.value || 'all';
      let activeCount = 0;
      if (sev !== 'all') activeCount++;
      if (status !== 'all') activeCount++;
      const badge = $('filter-count-badge');
      if (badge) {
        badge.textContent = activeCount > 0 ? `${activeCount} active` : '';
        badge.style.display = activeCount > 0 ? 'inline' : 'none';
      } else if (activeCount > 0) {
        // Create badge if not present in HTML
        const filtersHeader = sevFilter?.parentElement;
        if (filtersHeader) {
          const span = document.createElement('span');
          span.id = 'filter-count-badge';
          span.className = 'badge badge-running';
          span.textContent = `${activeCount} active`;
          filtersHeader.appendChild(span);
        }
      }
    }

    function applyFilters() {
      const sev = sevFilter?.value || 'all';
      const status = statusFilter?.value || 'all';
      const filtered = findings.filter(f =>
        (sev === 'all' || f.severity === sev) &&
        (status === 'all' || f.status === status)
      );
      renderFindingsList(filtered);
      updateFilterCount();
    }

    sevFilter?.addEventListener('change', applyFilters);
    statusFilter?.addEventListener('change', applyFilters);
  }

  // Spec: spec/client/report.md#renderFindingsList
  function renderFindingsList(findings: Finding[]) {
    const list = $('findings-list');
    if (!list) return;

    if (findings.length === 0) {
      list.innerHTML = '<p class="text-muted text-center mt-2">No findings match the selected filters.</p>';
      return;
    }

    const isOwner = reportData?.isOwner || false;
    list.innerHTML = findings.map(f => {
      const isRedacted = !f.title && !f.description;
      return `
      <div class="finding-card finding-${escapeHtml(f.severity)}">
        <div class="finding-header">
          <span class="finding-title">${isRedacted ? '<em>[Redacted]</em>' : escapeHtml(f.title)}</span>
          <div class="finding-header-right">
            <span class="badge badge-${f.status === 'open' ? 'pending' : f.status === 'fixed' ? 'completed' : 'running'}">${escapeHtml(formatStatus(f.status))}</span>
            <span class="severity ${severityClass(f.severity)}">${escapeHtml(f.severity)}</span>
          </div>
        </div>
        ${f.filePath ? `<div class="finding-location">
          ${escapeHtml(f.repoName || '')}/${escapeHtml(f.filePath)}:${f.lineStart}${f.lineEnd ? '-' + f.lineEnd : ''}
          ${f.cweId ? ` &middot; ${escapeHtml(f.cweId)}` : ''}
          ${f.cvssScore ? ` &middot; CVSS ${f.cvssScore}` : ''}
        </div>` : (f.cweId ? `<div class="finding-location">${escapeHtml(f.cweId)}</div>` : '')}
        <div class="finding-body">
          ${f.description ? `<p>${escapeHtml(f.description)}</p>` : (isRedacted ? '<p class="text-muted">Finding details redacted during responsible disclosure period.</p>' : '')}
          ${f.exploitation ? `<h4>Exploitation</h4><p>${escapeHtml(f.exploitation)}</p>` : ''}
          ${f.recommendation ? `<h4>Recommendation</h4><p>${escapeHtml(f.recommendation)}</p>` : ''}
          ${f.codeSnippet ? `<h4>Code</h4><pre class="code-block">${escapeHtml(f.codeSnippet)}</pre>` : ''}
        </div>
        ${isOwner ? `
        <div class="finding-actions">
          <select class="finding-status-select" data-finding-id="${f.id}">
            <option value="open"${f.status === 'open' ? ' selected' : ''}>${formatStatus('open')}</option>
            <option value="fixed"${f.status === 'fixed' ? ' selected' : ''}>${formatStatus('fixed')}</option>
            <option value="false_positive"${f.status === 'false_positive' ? ' selected' : ''}>${formatStatus('false_positive')}</option>
            <option value="accepted"${f.status === 'accepted' ? ' selected' : ''}>${formatStatus('accepted')}</option>
            <option value="wont_fix"${f.status === 'wont_fix' ? ' selected' : ''}>${formatStatus('wont_fix')}</option>
          </select>
        </div>
        ` : ''}
      </div>
    `; }).join('');

    // Attach status change handlers for owner
    if (isOwner) {
      list.querySelectorAll('.finding-status-select').forEach((select) => {
        (select as HTMLSelectElement).addEventListener('change', async (e) => {
          const el = e.target as HTMLSelectElement;
          const findingId = el.dataset.findingId;
          if (!findingId) return;
          try {
            await apiFetch(`/api/findings/${findingId}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: el.value }),
            });
            // Update badge
            const card = el.closest('.finding-card');
            const badge = card?.querySelector('.finding-header-right .badge');
            if (badge) {
              badge.className = `badge badge-${el.value === 'open' ? 'pending' : el.value === 'fixed' ? 'completed' : 'running'}`;
              badge.textContent = formatStatus(el.value);
            }
            // Update in-memory finding state on success
            const masterFinding = reportData?.findings.find(ff => ff.id === findingId);
            if (masterFinding) masterFinding.status = el.value;
          } catch (err) {
            showError(err instanceof Error ? err.message : 'Failed to update status');
            // Revert to last known state
            const finding = reportData?.findings.find(ff => ff.id === findingId);
            if (finding) el.value = finding.status;
          }
        });
      });
    }
  }

  // Spec: spec/client/report.md#loadComments
  async function loadComments(auditId: string) {
    try {
      const comments = await apiFetch<Comment[]>(`/api/audit/${auditId}/comments`);
      const list = $('comments-list');
      if (!list) return;

      if (comments.length === 0) {
        list.innerHTML = '<p class="text-muted text-sm">No comments yet.</p>';
      } else {
        list.innerHTML = comments.map(c => `
          <div class="comment">
            <div class="comment-header">
              <span>${escapeHtml(c.username)}</span>
              <span>${formatDateTime(c.createdAt)}</span>
            </div>
            <div class="comment-body">${escapeHtml(c.content)}</div>
          </div>
        `).join('');
      }
    } catch {
      // Non-critical, ignore
    }
  }

  // Submit comment
  const submitCommentBtn = $('submit-comment-btn');
  submitCommentBtn?.addEventListener('click', async () => {
    const input = $('comment-input') as HTMLTextAreaElement | null;
    if (!input?.value.trim()) return;

    // Null check for auditId (Issue #8)
    if (!auditId) {
      showError('Cannot submit comment: audit ID is missing');
      return;
    }

    try {
      await apiPost(`/api/audit/${auditId}/comments`, { content: input.value.trim() });
      input.value = '';
      loadComments(auditId);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to post comment');
    }
  });

  // Publish button
  const publishBtn = $('publish-btn');
  publishBtn?.addEventListener('click', async () => {
    if (!auditId || !confirm('Make this report public?')) return;
    try {
      await apiPost(`/api/audit/${auditId}/publish`, {});
      window.location.reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to publish');
    }
  });

  // Unpublish button
  const unpublishBtn = $('unpublish-btn');
  unpublishBtn?.addEventListener('click', async () => {
    if (!auditId || !confirm('Make this report private again?')) return;
    try {
      await apiPost(`/api/audit/${auditId}/unpublish`, {});
      window.location.reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to unpublish');
    }
  });

  // Notify Owner button
  const notifyBtn = $('notify-owner-btn');
  notifyBtn?.addEventListener('click', async () => {
    if (!auditId || !confirm('Notify the project owner about this audit via a GitHub issue? This starts the responsible disclosure timer.')) return;
    try {
      const result = await apiPost<{ ok: boolean; publishableAfter: string | null }>(`/api/audit/${auditId}/notify-owner`, {});
      if (result.publishableAfter) {
        showError(`Owner notified. Full report will be available after ${new Date(result.publishableAfter).toLocaleDateString()}.`);
      } else {
        showError('Owner notified. Report has no time-gated findings.');
      }
      window.location.reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to notify owner');
    }
  });
});
