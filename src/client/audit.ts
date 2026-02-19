// Spec: spec/client/audit.md
// ============================================================
// CodeWatch - Audit Progress Page (audit.html)
// Polls audit status, shows per-file progress
// ============================================================

// ---- progress_detail discriminated union ----

interface FileProgress {
  file: string;
  status: string;       // 'pending' | 'done' | 'error'
  findingsCount: number;
}

interface ProgressBase {
  warnings: string[];
}

interface ProgressCloning extends ProgressBase {
  type: 'cloning';
  current: number;
  total: number;
  repoName: string;
}

interface ProgressPlanning extends ProgressBase {
  type: 'planning';
}

interface ProgressAnalyzing extends ProgressBase {
  type: 'analyzing';
  files: FileProgress[];
}

interface ProgressDone extends ProgressBase {
  type: 'done';
  files: FileProgress[];
}

type ProgressDetail = ProgressCloning | ProgressPlanning | ProgressAnalyzing | ProgressDone;

// ---- Audit status from API ----

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
  progressDetail: ProgressDetail | null;
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

  // Spec: spec/client/audit.md#poll
  async function poll() {
    try {
      const data = await apiFetch<AuditStatus>(`/api/audit/${auditId}`);
      consecutiveErrors = 0; // Reset on success

      // Terminal check FIRST — must execute even if rendering throws
      const isTerminal = data.status === 'completed'
        || data.status === 'completed_with_warnings'
        || data.status === 'failed';

      try {
        renderStatus(data);
      } catch (renderErr) {
        console.error('Render error:', renderErr);
      }

      if (isTerminal && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
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

  // Spec: spec/client/audit.md#renderStatus
  function renderStatus(data: AuditStatus) {
    const detail = data.progressDetail;

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

    // Enhanced status labels using progressDetail type discrimination
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
    if (data.status === 'cloning' && detail?.type === 'cloning') {
      statusLabels['cloning'] = `Cloning repositories (${detail.current}/${detail.total}: ${detail.repoName})...`;
    }
    setText('progress-text', statusLabels[data.status] || data.status);
    setText('progress-count', `${done} / ${total} files`);

    const fill = $('progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;

    // File list — extract files via type discrimination (resilient to unknown types)
    const files = (detail?.type === 'analyzing' || detail?.type === 'done') ? detail.files : null;
    if (files && files.length > 0) {
      renderFileList(files);
    } else if (data.status === 'failed' || data.status === 'completed' || data.status === 'completed_with_warnings') {
      const list = $('file-list');
      if (list) list.innerHTML = '';
    }

    // Findings summary
    const totalFindings = files?.reduce((sum, f) => sum + (f.findingsCount || 0), 0) || 0;
    if (totalFindings > 0) {
      setText('findings-summary', `${totalFindings} finding${totalFindings !== 1 ? 's' : ''}`);
    }

    // Warnings
    if (detail?.warnings && detail.warnings.length > 0) {
      show('warnings-notice');
      const warnList = $('warnings-list');
      if (warnList) {
        warnList.innerHTML = detail.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
      }
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

  // Spec: spec/client/audit.md#renderFileList
  function renderFileList(files: FileProgress[]) {
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
