// ============================================================
// CodeWatch - Audit Progress Page (audit.html)
// Polls audit status, shows per-file progress
// ============================================================

interface AuditStatus {
  id: string;
  projectId: string;
  projectName: string;
  githubOrg: string;
  status: string;
  auditLevel: string;
  isIncremental: boolean;
  isOwner: boolean;
  isRequester: boolean;
  totalFiles: number;
  filesToAnalyze: number;
  filesAnalyzed: number;
  progressDetail: Array<{
    file: string;
    status: string; // pending | analyzing | done | error
    findingsCount: number;
  }>;
  commits: Array<{ repoName: string; commitSha: string; branch: string }>;
  maxSeverity: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

document.addEventListener('DOMContentLoaded', () => {
  const auditId = getParam('auditId');
  if (!auditId) {
    window.location.href = '/';
    return;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  async function poll() {
    try {
      const data = await apiFetch<AuditStatus>(`/api/audit/${auditId}`);
      consecutiveErrors = 0; // Reset on success
      renderStatus(data);

      if (data.status === 'completed' || data.status === 'completed_with_warnings' || data.status === 'failed') {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      }
    } catch (err) {
      consecutiveErrors++;
      console.error('Poll error:', err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        showError(`Lost connection to audit status after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Please refresh the page.`);
      }
    }
  }

  function renderStatus(data: AuditStatus) {
    // Status badge
    const statusMap: Record<string, string> = {
      pending: 'badge-pending',
      cloning: 'badge-running',
      classifying: 'badge-running',
      planning: 'badge-running',
      estimating: 'badge-running',
      analyzing: 'badge-running',
      synthesizing: 'badge-running',
      completed: 'badge-completed',
      completed_with_warnings: 'badge-completed',
      failed: 'badge-failed',
    };
    setHtml('audit-status-badge', `<span class="badge ${statusMap[data.status] || ''}">${escapeHtml(data.status)}</span>`);
    setText('audit-level', data.auditLevel);

    // Ownership badge
    if (data.isOwner) {
      setHtml('audit-owner-badge', renderOwnershipBadge({ isOwner: true }));
    }

    // Commit info
    if (data.commits.length > 0) {
      const commitText = data.commits.map(c =>
        `${c.repoName}@${c.commitSha.substring(0, 7)}`
      ).join(', ');
      setText('audit-commit', commitText);
    }

    if (data.isIncremental) {
      setHtml('audit-type', '<span class="badge badge-running">incremental</span>');
    }

    // Progress
    const total = data.filesToAnalyze || data.totalFiles || 0;
    const done = data.filesAnalyzed || 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const statusLabels: Record<string, string> = {
      pending: 'Waiting to start...',
      cloning: 'Cloning repositories...',
      classifying: 'Classifying software...',
      planning: 'Planning analysis...',
      estimating: 'Estimating scope...',
      analyzing: `Analyzing code (${done}/${total} files)`,
      synthesizing: 'Generating report...',
      completed: 'Audit complete',
      completed_with_warnings: 'Audit complete (with warnings)',
      failed: 'Audit failed',
    };
    setText('progress-text', statusLabels[data.status] || data.status);
    setText('progress-count', `${done} / ${total} files`);

    const fill = $('progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;

    // File list
    if (data.progressDetail && data.progressDetail.length > 0) {
      renderFileList(data.progressDetail);
    }

    // Findings summary
    const totalFindings = data.progressDetail?.reduce((sum, f) => sum + f.findingsCount, 0) || 0;
    if (totalFindings > 0) {
      setText('findings-summary', `${totalFindings} finding${totalFindings !== 1 ? 's' : ''}`);
    }

    // Completion card — handle both completed and completed_with_warnings
    if (data.status === 'completed' || data.status === 'completed_with_warnings') {
      show('completion-card');
      const link = $('view-report-link') as HTMLAnchorElement | null;
      if (link) link.href = `/report.html?auditId=${data.id}`;
      let summaryText = `Found ${totalFindings} finding${totalFindings !== 1 ? 's' : ''}.` +
        (data.maxSeverity ? ` Max severity: ${data.maxSeverity}.` : '');
      if (data.status === 'completed_with_warnings') {
        summaryText += ' Some warnings were generated during the audit.';
      }
      setText('completion-summary', summaryText);
    }

    // Error
    if (data.status === 'failed' && data.errorMessage) {
      show('error-notice');
      setText('error-message', data.errorMessage);
    }
  }

  function renderFileList(files: AuditStatus['progressDetail']) {
    const list = $('file-list');
    if (!list) return;

    const statusIcons: Record<string, string> = {
      pending: '\u00B7',
      analyzing: '\u25CB',
      done: '\u2713',
      error: '\u2717',
    };

    list.innerHTML = files.map(f => `
      <li class="file-item">
        <span class="file-status file-status-${escapeHtml(f.status)}">${statusIcons[f.status] || ''}</span>
        <span class="file-name">${escapeHtml(f.file)}</span>
        ${f.findingsCount > 0 ? `<span class="file-findings">${f.findingsCount} finding${f.findingsCount !== 1 ? 's' : ''}</span>` : ''}
      </li>
    `).join('');
  }

  // Pause/resume polling on visibility change (Issue #26)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } else {
      if (!pollInterval) {
        pollInterval = setInterval(poll, 3000);
        poll(); // immediate poll on return
      }
    }
  });

  // Start polling
  poll();
  pollInterval = setInterval(poll, 3000);
});
