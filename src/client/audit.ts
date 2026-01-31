// ============================================================
// CodeWatch - Audit Progress Page (audit.html)
// Polls audit status, shows per-file progress
// ============================================================

interface AuditStatus {
  id: string;
  projectId: string;
  status: string;
  auditLevel: string;
  isIncremental: boolean;
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

  async function poll() {
    try {
      const data = await apiFetch<AuditStatus>(`/api/audit/${auditId}`);
      renderStatus(data);

      if (data.status === 'completed' || data.status === 'failed') {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      }
    } catch (err) {
      // Don't stop polling on transient errors
      console.error('Poll error:', err);
    }
  }

  function renderStatus(data: AuditStatus) {
    // Status badge
    const statusMap: Record<string, string> = {
      pending: 'badge-pending',
      cloning: 'badge-running',
      classifying: 'badge-running',
      estimating: 'badge-running',
      analyzing: 'badge-running',
      synthesizing: 'badge-running',
      completed: 'badge-completed',
      failed: 'badge-failed',
    };
    setHtml('audit-status-badge', `<span class="badge ${statusMap[data.status] || ''}">${escapeHtml(data.status)}</span>`);
    setText('audit-level', data.auditLevel);

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
      estimating: 'Estimating scope...',
      analyzing: `Analyzing code (${done}/${total} files)`,
      synthesizing: 'Generating report...',
      completed: 'Audit complete',
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

    // Completion card
    if (data.status === 'completed') {
      show('completion-card');
      const link = $('view-report-link') as HTMLAnchorElement | null;
      if (link) link.href = `/report.html?auditId=${data.id}`;
      setText('completion-summary',
        `Found ${totalFindings} finding${totalFindings !== 1 ? 's' : ''}.` +
        (data.maxSeverity ? ` Max severity: ${data.maxSeverity}.` : '')
      );
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

  // Start polling
  poll();
  pollInterval = setInterval(poll, 3000);
});
