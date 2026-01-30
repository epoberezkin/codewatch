// ============================================================
// CodeWatch - Cost Estimation Page (estimate.html)
// Shows cost cards for 3 levels, precise estimate, API key input
// ============================================================

interface EstimateData {
  totalFiles: number;
  totalTokens: number;
  repoBreakdown: Array<{ repoName: string; files: number; tokens: number }>;
  estimates: {
    full: { files: number; tokens: number; costUsd: number };
    thorough: { files: number; tokens: number; costUsd: number };
    opportunistic: { files: number; tokens: number; costUsd: number };
  };
  latestCommits: Array<{ repoId: string; commitSha: string; branch: string }>;
  previousAudit?: { id: string; createdAt: string; level: string; maxSeverity: string };
  isPrecise: boolean;
  cloneErrors?: Array<{ repoName: string; error: string }>;
}

interface ProjectData {
  id: string;
  name: string;
  description: string;
  githubOrg: string;
  category: string;
  createdBy: string | null;
  repos: Array<{ repoName: string; language: string; stars: number }>;
}

document.addEventListener('DOMContentLoaded', async () => {
  const projectId = getParam('projectId');
  if (!projectId) {
    window.location.href = '/';
    return;
  }

  let selectedLevel: string | null = null;
  let estimateData: EstimateData | null = null;
  let useIncremental = false;
  let baseAuditId: string | null = null;

  // Load project info and estimate in parallel
  try {
    const [project, estimate] = await Promise.all([
      apiFetch<ProjectData>(`/api/projects/${projectId}`),
      apiPost<EstimateData>('/api/estimate', { projectId }),
    ]);

    renderProjectHeader(project);
    renderEstimate(estimate);
    estimateData = estimate;

    if (estimate.cloneErrors && estimate.cloneErrors.length > 0) {
      const errList = estimate.cloneErrors
        .map(e => `<li><strong>${escapeHtml(e.repoName)}:</strong> ${escapeHtml(e.error)}</li>`)
        .join('');
      setHtml('clone-errors', `<strong>Some repositories failed to load:</strong><ul>${errList}</ul>`);
      show('clone-errors');
    }

    if (estimate.previousAudit) {
      show('previous-audit-notice');
      baseAuditId = estimate.previousAudit.id;
    }

    // Show non-owner notice if user is not the project creator
    const user = currentUser;
    if (user && project.createdBy && user.id !== project.createdBy) {
      show('non-owner-notice');
    }
  } catch (err) {
    setHtml('header-loading', `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load')}</div>`);
    return;
  }

  function renderProjectHeader(project: ProjectData) {
    hide('header-loading');
    show('header-content');
    setText('project-name', project.name);
    setText('project-description', project.description || `GitHub org: ${project.githubOrg}`);
    const metaHtml = project.repos.map(r =>
      `<span>${escapeHtml(r.repoName)}${r.language ? ` (${escapeHtml(r.language)})` : ''}</span>`
    ).join('');
    setHtml('project-meta', metaHtml);
  }

  function renderEstimate(data: EstimateData) {
    const levels = ['full', 'thorough', 'opportunistic'] as const;
    for (const level of levels) {
      const est = data.estimates[level];
      setHtml(`price-${level}`, `${formatUSD(est.costUsd)} <small>estimated</small>`);
      setHtml(`stats-${level}`, `
        <span>Files: ${formatNumber(est.files)}</span>
        <span>Tokens: ${formatNumber(est.tokens)}</span>
      `);
    }

    setText('estimate-label', data.isPrecise
      ? 'Precise estimate (token count verified)'
      : 'Approximate estimate (\u00B115%)');

    if (data.isPrecise) {
      hide('precise-btn');
    }
  }

  // Level selection
  const cards = document.querySelectorAll<HTMLElement>('.estimate-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      cards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedLevel = card.dataset.level || null;
      updateStartButton();
    });
  });

  // Precise estimate button
  const preciseBtn = $('precise-btn') as HTMLButtonElement | null;
  preciseBtn?.addEventListener('click', async () => {
    if (!projectId) return;
    preciseBtn.disabled = true;
    preciseBtn.textContent = 'Calculating...';
    try {
      const precise = await apiPost<EstimateData>('/api/estimate/precise', { projectId });
      renderEstimate(precise);
      estimateData = precise;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to get precise estimate');
    } finally {
      preciseBtn.disabled = false;
      preciseBtn.textContent = 'Get Precise Estimate';
    }
  });

  // API key input
  const apiKeyInput = $('api-key') as HTMLInputElement | null;
  apiKeyInput?.addEventListener('input', updateStartButton);

  function isValidApiKeyFormat(key: string): boolean {
    return key.startsWith('sk-ant-');
  }

  function updateStartButton() {
    const btn = $('start-audit-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const keyValue = apiKeyInput?.value.trim() || '';
    const hasKey = keyValue.length > 0;
    const validKey = hasKey && isValidApiKeyFormat(keyValue);
    const hasLevel = !!selectedLevel;

    // Show/hide key format error
    if (hasKey && !validKey) {
      show('api-key-error');
    } else {
      hide('api-key-error');
    }

    btn.disabled = !validKey || !hasLevel;
    if (!hasLevel) {
      btn.textContent = 'Select an audit level above';
    } else if (!hasKey) {
      btn.textContent = 'Enter your API key';
    } else if (!validKey) {
      btn.textContent = 'Invalid key format (should start with sk-ant-)';
    } else {
      const est = estimateData?.estimates[selectedLevel as keyof EstimateData['estimates']];
      const prefix = useIncremental ? 'Start incremental ' : 'Start ';
      btn.textContent = `${prefix}${selectedLevel} audit${est ? ` (~${formatUSD(est.costUsd)})` : ''}`;
    }
  }

  // Start audit
  const startBtn = $('start-audit-btn') as HTMLButtonElement | null;
  startBtn?.addEventListener('click', async () => {
    if (!selectedLevel || !apiKeyInput?.value.trim() || !startBtn || !isValidApiKeyFormat(apiKeyInput.value.trim())) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting audit...';

    try {
      const body: Record<string, string> = {
        projectId,
        level: selectedLevel,
        apiKey: apiKeyInput.value.trim(),
      };
      if (useIncremental && baseAuditId) {
        body.baseAuditId = baseAuditId;
      }
      const result = await apiPost<{ auditId: string }>('/api/audit/start', body);
      window.location.href = `/audit.html?auditId=${result.auditId}`;
    } catch (err) {
      startBtn.disabled = false;
      updateStartButton();
      alert(err instanceof Error ? err.message : 'Failed to start audit');
    }
  });

  // Incremental / Fresh buttons
  const incrementalBtn = $('incremental-btn') as HTMLButtonElement | null;
  const freshBtn = $('fresh-btn') as HTMLButtonElement | null;

  incrementalBtn?.addEventListener('click', () => {
    useIncremental = true;
    incrementalBtn.classList.add('btn-primary');
    incrementalBtn.classList.remove('btn-secondary');
    freshBtn?.classList.add('btn-secondary');
    freshBtn?.classList.remove('btn-primary');
    updateStartButton();
  });

  freshBtn?.addEventListener('click', () => {
    useIncremental = false;
    freshBtn.classList.add('btn-primary');
    freshBtn.classList.remove('btn-secondary');
    incrementalBtn?.classList.add('btn-secondary');
    incrementalBtn?.classList.remove('btn-primary');
    updateStartButton();
  });
});
