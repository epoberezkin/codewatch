// ============================================================
// CodeWatch - Cost Estimation Page (estimate.html)
// Step-based flow: Stats → Component Analysis → Mode Selection → Start
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

interface ComponentItem {
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
}

interface AnalysisStatus {
  id: string;
  status: string;
  turnsUsed: number;
  maxTurns: number;
  costUsd: number;
  errorMessage: string | null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const projectId = getParam('projectId');
  if (!projectId) {
    window.location.href = '/';
    return;
  }

  // Wait for auth check to complete before reading currentUser
  await waitForAuth();

  let selectedLevel: string | null = null;
  let estimateData: EstimateData | null = null;
  let useIncremental = false;
  let baseAuditId: string | null = null;
  let selectedComponentIds: string[] = [];
  let components: ComponentItem[] = [];

  // Load project info and estimate in parallel
  try {
    const [project, estimate] = await Promise.all([
      apiFetch<ProjectData>(`/api/projects/${projectId}`),
      apiPost<EstimateData>('/api/estimate', { projectId }),
    ]);

    renderProjectHeader(project);
    renderProjectStats(estimate);
    renderEstimateCards(estimate);
    updatePrecisionLabel(estimate);
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

    // Check for existing components — if found, skip to step 2
    if (user) {
      await loadExistingComponents();
    }
  } catch (err) {
    setHtml('header-loading', `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load')}</div>`);
    return;
  }

  // ---- Rendering ----

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

  function renderProjectStats(data: EstimateData) {
    setText('stat-files', `${formatNumber(data.totalFiles)} files`);
    setText('stat-tokens', `${formatNumber(data.totalTokens)} tokens`);

    // Repo breakdown
    if (data.repoBreakdown && data.repoBreakdown.length > 0) {
      const breakdownHtml = data.repoBreakdown.map(r =>
        `<span>${escapeHtml(r.repoName)}: ${formatNumber(r.files)} files, ${formatNumber(r.tokens)} tokens</span>`
      ).join('<br>');
      setHtml('repo-breakdown', breakdownHtml);
    }
  }

  function updatePrecisionLabel(data: EstimateData) {
    setText('estimate-precision', data.isPrecise
      ? 'Precise estimate (token count verified)'
      : 'Approximate estimate (\u00B115%)');

    if (data.isPrecise) {
      hide('precise-btn');
    }
  }

  function renderEstimateCards(data: EstimateData) {
    const levels = ['full', 'thorough', 'opportunistic'] as const;
    for (const level of levels) {
      const est = data.estimates[level];
      setHtml(`price-${level}`, `${formatUSD(est.costUsd)} <small>estimated</small>`);
    }
  }

  // ---- Component Loading ----

  async function loadExistingComponents() {
    try {
      const comps = await apiFetch<ComponentItem[]>(`/api/projects/${projectId}/components`);
      if (comps.length > 0) {
        components = comps;
        selectedComponentIds = comps.map(c => c.id);
        showStep2(comps);
      }
    } catch {
      // No components yet, that's fine
    }
  }

  function showStep2(comps: ComponentItem[]) {
    hide('analyze-section');
    renderComponentTable(comps);
    show('step-2');
    // Enable audit level cards (remove disabled state)
    enableCards();
    // Render mode cards with costs from scoped estimate (all components selected by default)
    updateScopedEstimate();
  }

  function enableCards() {
    document.querySelectorAll<HTMLElement>('.estimate-card').forEach(card => {
      card.classList.remove('disabled');
    });
    const hint = $('cards-hint');
    if (hint) hint.style.display = 'none';
  }

  function renderComponentTable(comps: ComponentItem[]) {
    const tbody = $('component-table-body');
    if (!tbody) return;

    tbody.innerHTML = comps.map(c => `
      <tr>
        <td><input type="checkbox" class="component-checkbox" data-id="${c.id}" checked></td>
        <td><strong>${escapeHtml(c.name)}</strong><br><small class="text-muted">${escapeHtml(c.description.substring(0, 80))}</small></td>
        <td>${escapeHtml(c.repoName)}</td>
        <td>${escapeHtml(c.role || '--')}</td>
        <td>${formatNumber(c.estimatedFiles)}</td>
        <td>${formatNumber(c.estimatedTokens)}</td>
        <td>${c.securityProfile?.summary ? `<small>${escapeHtml(c.securityProfile.summary.substring(0, 60))}</small>` : '--'}</td>
      </tr>
    `).join('');

    // Attach checkbox listeners
    document.querySelectorAll<HTMLInputElement>('.component-checkbox').forEach(cb => {
      cb.addEventListener('change', onComponentSelectionChange);
    });

    // Replace select-all element to remove any accumulated listeners from prior renders
    const oldSelectAll = $('select-all-components') as HTMLInputElement | null;
    if (oldSelectAll) {
      const selectAll = oldSelectAll.cloneNode(true) as HTMLInputElement;
      oldSelectAll.replaceWith(selectAll);
      selectAll.addEventListener('change', () => {
        const checked = selectAll.checked;
        document.querySelectorAll<HTMLInputElement>('.component-checkbox').forEach(cb => {
          cb.checked = checked;
        });
        onComponentSelectionChange();
      });
    }
  }

  async function onComponentSelectionChange() {
    const checkboxes = document.querySelectorAll<HTMLInputElement>('.component-checkbox');
    selectedComponentIds = [];
    checkboxes.forEach(cb => {
      if (cb.checked) selectedComponentIds.push(cb.dataset.id!);
    });
    await updateScopedEstimate();
    updateStartButton();
  }

  async function updateScopedEstimate() {
    if (selectedComponentIds.length === 0) {
      setText('scoped-estimate-label', 'No components selected');
      // Clear mode card prices
      setHtml('price-full', '--');
      setHtml('price-thorough', '--');
      setHtml('price-opportunistic', '--');
      return;
    }

    try {
      const scoped = await apiPost<EstimateData>('/api/estimate/components', {
        projectId,
        componentIds: selectedComponentIds,
      });
      renderEstimateCards(scoped);
      estimateData = scoped;
      setText('scoped-estimate-label',
        `${selectedComponentIds.length} of ${components.length} components selected ` +
        `(${formatNumber(scoped.totalFiles)} files, ${formatNumber(scoped.totalTokens)} tokens)`);
    } catch {
      setText('scoped-estimate-label', 'Failed to update estimate');
    }
  }

  // ---- API Key ----

  const apiKeyInput = $('api-key') as HTMLInputElement | null;

  function isValidApiKeyFormat(key: string): boolean {
    return key.startsWith('sk-ant-');
  }

  apiKeyInput?.addEventListener('input', () => {
    updateStartButton();
    updateAnalyzeButton();
  });

  // ---- Component Analysis ----

  const analyzeBtn = $('analyze-components-btn') as HTMLButtonElement | null;

  function updateAnalyzeButton() {
    if (!analyzeBtn) return;
    const keyValue = apiKeyInput?.value.trim() || '';
    analyzeBtn.disabled = !isValidApiKeyFormat(keyValue);
  }

  analyzeBtn?.addEventListener('click', async () => {
    const apiKey = apiKeyInput?.value.trim();
    if (!apiKey || !isValidApiKeyFormat(apiKey)) return;

    analyzeBtn.disabled = true;
    hide('component-not-analyzed');
    show('component-analyzing');

    try {
      const { analysisId } = await apiPost<{ analysisId: string }>(
        `/api/projects/${projectId}/analyze-components`,
        { apiKey }
      );

      // Poll for completion
      const poll = async () => {
        const status = await apiFetch<AnalysisStatus>(
          `/api/projects/${projectId}/component-analysis/${analysisId}`
        );
        setText('analysis-progress',
          `Analyzing... Turn ${status.turnsUsed}/${status.maxTurns} (~${formatUSD(status.costUsd)})`);

        if (status.status === 'completed') {
          hide('component-analyzing');
          const comps = await apiFetch<ComponentItem[]>(`/api/projects/${projectId}/components`);
          if (comps.length > 0) {
            components = comps;
            selectedComponentIds = comps.map(c => c.id);
            showStep2(comps);
          }
        } else if (status.status === 'failed') {
          hide('component-analyzing');
          show('component-not-analyzed');
          alert('Component analysis failed: ' + (status.errorMessage || 'Unknown error'));
          updateAnalyzeButton();
        } else {
          setTimeout(poll, 2000);
        }
      };
      setTimeout(poll, 2000);
    } catch (err) {
      hide('component-analyzing');
      show('component-not-analyzed');
      updateAnalyzeButton();
      alert(err instanceof Error ? err.message : 'Failed to start analysis');
    }
  });

  // ---- Level Selection (cards) ----

  const cards = document.querySelectorAll<HTMLElement>('.estimate-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      cards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedLevel = card.dataset.level || null;
      // Show step 3 when a level is selected
      show('step-3');
      updateStartButton();
    });
  });

  // ---- Precise Estimate (Step 1) ----

  const preciseBtn = $('precise-btn') as HTMLButtonElement | null;
  preciseBtn?.addEventListener('click', async () => {
    if (!projectId) return;
    preciseBtn.disabled = true;
    preciseBtn.textContent = 'Calculating...';
    try {
      const precise = await apiPost<EstimateData>('/api/estimate/precise', { projectId });
      renderEstimateCards(precise);
      updatePrecisionLabel(precise);
      estimateData = precise;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to get precise estimate');
    } finally {
      preciseBtn.disabled = false;
      preciseBtn.textContent = 'Get Precise Estimate';
    }
  });

  // ---- Start Button (Step 3) ----

  function updateStartButton() {
    const btn = $('start-audit-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const keyValue = apiKeyInput?.value.trim() || '';
    const hasKey = keyValue.length > 0;
    const validKey = hasKey && isValidApiKeyFormat(keyValue);
    const hasLevel = !!selectedLevel;
    const hasComponents = selectedComponentIds.length > 0;

    // Show/hide key format error
    if (hasKey && !validKey) {
      show('api-key-error');
    } else {
      hide('api-key-error');
    }

    btn.disabled = !validKey || !hasLevel || !hasComponents;
    if (!hasComponents) {
      btn.textContent = 'Select at least one component above';
    } else if (!hasLevel) {
      btn.textContent = 'Select an audit level above';
    } else if (!hasKey) {
      btn.textContent = 'Enter your API key above';
    } else if (!validKey) {
      btn.textContent = 'Invalid key format (should start with sk-ant-)';
    } else {
      const est = estimateData?.estimates[selectedLevel as keyof EstimateData['estimates']];
      const prefix = useIncremental ? 'Start incremental ' : 'Start ';
      const compLabel = selectedComponentIds.length < components.length
        ? ` (${selectedComponentIds.length} components)` : '';
      btn.textContent = `${prefix}${selectedLevel} audit${compLabel}${est ? ` (~${formatUSD(est.costUsd)})` : ''}`;
    }
  }

  const startBtn = $('start-audit-btn') as HTMLButtonElement | null;
  startBtn?.addEventListener('click', async () => {
    if (!selectedLevel || !apiKeyInput?.value.trim() || !startBtn || !isValidApiKeyFormat(apiKeyInput.value.trim())) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting audit...';

    try {
      const body: Record<string, any> = {
        projectId,
        level: selectedLevel,
        apiKey: apiKeyInput.value.trim(),
      };
      if (useIncremental && baseAuditId) {
        body.baseAuditId = baseAuditId;
      }
      if (selectedComponentIds.length > 0 && selectedComponentIds.length < components.length) {
        body.componentIds = selectedComponentIds;
      }
      const result = await apiPost<{ auditId: string }>('/api/audit/start', body);
      window.location.href = `/audit.html?auditId=${result.auditId}`;
    } catch (err) {
      startBtn.disabled = false;
      updateStartButton();
      alert(err instanceof Error ? err.message : 'Failed to start audit');
    }
  });

  // ---- Incremental / Fresh buttons ----

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
