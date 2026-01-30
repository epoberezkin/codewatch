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
  auditLevel: string;
  isIncremental: boolean;
  isOwner: boolean;
  isPublic: boolean;
  publishableAfter: string | null;
  maxSeverity: string | null;
  commits: Array<{ repoName: string; commitSha: string }>;
  reportSummary: {
    executiveSummary: string;
    securityPosture: string;
    responsibleDisclosure: Record<string, string>;
  } | null;
  severityCounts: Record<string, number>;
  findings: Finding[];
  redactedSeverities: string[];
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

  let reportData: ReportData | null = null;

  try {
    reportData = await apiFetch<ReportData>(`/api/audit/${auditId}/report`);
    renderReport(reportData);
  } catch (err) {
    setHtml('executive-summary',
      `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load report')}</div>`);
    return;
  }

  function renderReport(data: ReportData) {
    // Header
    setText('report-title', `Audit Report: ${data.projectName}`);
    setHtml('report-meta', `
      <span><a href="/project.html?projectId=${data.projectId}">${escapeHtml(data.projectName)}</a></span>
      <span>${formatDate(data.completedAt || data.createdAt)}</span>
      <span>${data.auditLevel}${data.isIncremental ? ' (incremental)' : ''}</span>
      ${data.commits.map(c => `<span class="text-mono">${escapeHtml(c.repoName)}@${c.commitSha.substring(0, 7)}</span>`).join('')}
    `);

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
      }
    }

    // Executive summary
    if (data.reportSummary) {
      setHtml('executive-summary', `<p>${escapeHtml(data.reportSummary.executiveSummary)}</p>`);

      // Security posture
      show('posture-section');
      setHtml('security-posture', `<p>${escapeHtml(data.reportSummary.securityPosture)}</p>`);

      // Responsible disclosure
      if (data.reportSummary.responsibleDisclosure && Object.keys(data.reportSummary.responsibleDisclosure).length > 0) {
        show('disclosure-section');
        const discHtml = Object.entries(data.reportSummary.responsibleDisclosure)
          .map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`)
          .join('');
        setHtml('disclosure-content', discHtml);
      }
    } else {
      setHtml('executive-summary', '<p class="text-muted">No summary available.</p>');
    }

    // Redacted notice
    if (data.redactedSeverities && data.redactedSeverities.length > 0) {
      show('redacted-notice');
    }

    // Findings
    renderFindings(data.findings, data.isOwner);

    // Comments — visible to all, form only for owner
    show('comments-section');
    loadComments(auditId!);
    if (data.isOwner) {
      show('comment-form');
    }
  }

  function renderFindings(findings: Finding[], isOwner: boolean) {
    if (findings.length === 0) {
      setHtml('findings-list', '<div class="empty-state"><h3>No findings</h3><p>No vulnerabilities were identified.</p></div>');
      return;
    }

    show('findings-header');
    renderFindingsList(findings);

    // Filters
    const sevFilter = $('severity-filter') as HTMLSelectElement | null;
    const statusFilter = $('status-filter') as HTMLSelectElement | null;

    function applyFilters() {
      const sev = sevFilter?.value || 'all';
      const status = statusFilter?.value || 'all';
      const filtered = findings.filter(f =>
        (sev === 'all' || f.severity === sev) &&
        (status === 'all' || f.status === status)
      );
      renderFindingsList(filtered);
    }

    sevFilter?.addEventListener('change', applyFilters);
    statusFilter?.addEventListener('change', applyFilters);
  }

  function renderFindingsList(findings: Finding[]) {
    const list = $('findings-list');
    if (!list) return;

    if (findings.length === 0) {
      list.innerHTML = '<p class="text-muted text-center mt-2">No findings match the selected filters.</p>';
      return;
    }

    const isOwner = reportData?.isOwner || false;
    list.innerHTML = findings.map(f => `
      <div class="finding-card finding-${f.severity}">
        <div class="finding-header">
          <span class="finding-title">${escapeHtml(f.title)}</span>
          <div class="finding-header-right">
            <span class="badge badge-${f.status === 'open' ? 'pending' : f.status === 'fixed' ? 'completed' : 'running'}">${f.status.replace('_', ' ')}</span>
            <span class="severity ${severityClass(f.severity)}">${f.severity}</span>
          </div>
        </div>
        <div class="finding-location">
          ${escapeHtml(f.repoName)}/${escapeHtml(f.filePath)}:${f.lineStart}${f.lineEnd ? '-' + f.lineEnd : ''}
          ${f.cweId ? ` &middot; ${escapeHtml(f.cweId)}` : ''}
          ${f.cvssScore ? ` &middot; CVSS ${f.cvssScore}` : ''}
        </div>
        <div class="finding-body">
          <p>${escapeHtml(f.description)}</p>
          ${f.exploitation ? `<h4>Exploitation</h4><p>${escapeHtml(f.exploitation)}</p>` : ''}
          ${f.recommendation ? `<h4>Recommendation</h4><p>${escapeHtml(f.recommendation)}</p>` : ''}
          ${f.codeSnippet ? `<h4>Code</h4><pre class="code-block">${escapeHtml(f.codeSnippet)}</pre>` : ''}
        </div>
        ${isOwner ? `
        <div class="finding-actions">
          <select class="finding-status-select" data-finding-id="${f.id}">
            <option value="open"${f.status === 'open' ? ' selected' : ''}>Open</option>
            <option value="fixed"${f.status === 'fixed' ? ' selected' : ''}>Fixed</option>
            <option value="false_positive"${f.status === 'false_positive' ? ' selected' : ''}>False Positive</option>
            <option value="accepted"${f.status === 'accepted' ? ' selected' : ''}>Accepted</option>
            <option value="wont_fix"${f.status === 'wont_fix' ? ' selected' : ''}>Won't Fix</option>
          </select>
        </div>
        ` : ''}
      </div>
    `).join('');

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
              badge.textContent = el.value.replace('_', ' ');
            }
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to update status');
            // Revert
            const finding = findings.find(ff => ff.id === findingId);
            if (finding) el.value = finding.status;
          }
        });
      });
    }
  }

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
    if (!input?.value.trim() || !auditId) return;

    try {
      await apiPost(`/api/audit/${auditId}/comments`, { content: input.value.trim() });
      input.value = '';
      loadComments(auditId);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to post comment');
    }
  });

  // Publish button
  const publishBtn = $('publish-btn');
  publishBtn?.addEventListener('click', async () => {
    if (!auditId || !confirm('Make this report public? This cannot be undone.')) return;
    try {
      await apiPost(`/api/audit/${auditId}/publish`, {});
      window.location.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish');
    }
  });
});
