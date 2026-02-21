// Spec: spec/client/estimate.md
// ============================================================
// CodeWatch - Cost Estimation Page (estimate.html)
// Step-based flow: Stats → Component Analysis → Mode Selection → Start
// ============================================================

interface EstimateData {
  totalFiles: number;
  totalTokens: number;
  repoBreakdown: Array<{ repoName: string; files: number; tokens: number; headSha?: string; branch?: string }>;
  estimates: {
    full: { files: number; tokens: number; costUsd: number };
    thorough: { files: number; tokens: number; costUsd: number };
    opportunistic: { files: number; tokens: number; costUsd: number };
  };
  previousAudit?: { id: string; createdAt: string; level: string; maxSeverity: string };
  isPrecise: boolean;
  cloneErrors?: Array<{ repoName: string; error: string }>;
  analysisCostHint?: { costUsd: number; isEmpirical: boolean };
}

interface ProjectData {
  id: string;
  name: string;
  description: string;
  githubOrg: string;
  githubEntityType: string | null;
  category: string;
  createdBy: string | null;
  ownership: { isOwner: boolean; role: string | null; needsReauth: boolean } | null;
  repos: Array<{
    id: string;
    repoName: string;
    language: string;
    stars: number;
    defaultBranch: string;
    branch: string | null;
  }>;
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
  let projectTotalTokens = 0;
  let useIncremental = false;
  let baseAuditId: string | null = null;
  const selectedComponentIds = new Set<string>();
  let components: ComponentItem[] = [];
  let projectData: ProjectData | null = null;

  // Load project info and estimate in parallel
  try {
    const [project, estimate] = await Promise.all([
      apiFetch<ProjectData>(`/api/projects/${projectId}`),
      apiPost<EstimateData>('/api/estimate', { projectId }),
    ]);

    projectData = project;
    renderProjectHeader(project);
    renderProjectStats(estimate, project.githubOrg);
    const branchBtn = document.getElementById('change-branches-btn');
    if (branchBtn) branchBtn.textContent = project.repos.length === 1 ? 'Change Branch' : 'Change Branches';
    renderEstimateCards(estimate);
    updatePrecisionLabel(estimate);
    updateAnalysisCostHint(estimate);
    estimateData = estimate;
    projectTotalTokens = estimate.totalTokens;

    if (estimate.cloneErrors && estimate.cloneErrors.length > 0) {
      const errList = estimate.cloneErrors
        .map(e => `<li><strong>${escapeHtml(e.repoName)}:</strong> ${escapeHtml(e.error)}</li>`)
        .join('');
      setHtml('clone-errors', `<strong>Some repositories failed to load:</strong><ul>${errList}</ul>`);
      show('clone-errors');
    }

    if (estimate.previousAudit && project.ownership?.isOwner) {
      show('previous-audit-notice');
      baseAuditId = estimate.previousAudit.id;
    }

    // Show ownership badge and access tier preview
    const user = currentUser;
    if (project.ownership) {
      setHtml('ownership-badge', renderOwnershipBadge(project.ownership));
    }
    if (project.ownership?.isOwner) {
      setHtml('access-tier-preview',
        '<strong>Full access</strong> — you\'ll see complete findings as the project owner.');
      show('access-tier-preview');
    } else if (project.ownership?.needsReauth) {
      setHtml('access-tier-preview',
        '<strong>Ownership unverified</strong> — <a href="/auth/github">re-authenticate with GitHub</a> to verify org ownership and get full access.');
      show('access-tier-preview');
    } else if (user) {
      setHtml('access-tier-preview',
        '<strong>Redacted access</strong> — medium and above findings will be shown as severity counts only. ' +
        'Full details become available after a responsible disclosure period (3 months for medium/high, 6 months for critical) ' +
        'or when the owner publishes the report. The project owner will be able to access all findings.');
      show('access-tier-preview');
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

  // Spec: spec/client/estimate.md#renderProjectHeader
  function renderProjectHeader(project: ProjectData) {
    hide('header-loading');
    show('header-content');
    // Project name = repo names joined
    const repoNames = project.repos.map(r => r.repoName);
    const projectTitle = repoNames.length <= 3
      ? repoNames.join(' + ')
      : `${repoNames.slice(0, 2).join(' + ')} + ${repoNames.length - 2} more`;
    setText('project-name', projectTitle || project.name);
    const entityLabel = project.githubEntityType === 'User' ? 'GitHub user' : 'GitHub org';
    setText('project-description', `${entityLabel}: ${project.githubOrg}`);
  }

  // Spec: spec/client/estimate.md#renderProjectStats
  function renderProjectStats(data: EstimateData, githubOrg: string) {
    // Compact repo rows: name ↗ · files · tokens · branch @ sha
    const externalIcon = '<svg class="icon-external" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 1.5h7v7M10.5 1.5L4 8"/></svg>';
    const rows = data.repoBreakdown.map(r => {
      const repoUrl = `https://github.com/${encodeURIComponent(githubOrg)}/${encodeURIComponent(r.repoName)}`;
      const nameHtml = `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener" class="repo-link">${escapeHtml(r.repoName)}${externalIcon}</a>`;
      const parts: string[] = [nameHtml];
      if (r.files) parts.push(`${formatNumber(r.files)} files`);
      if (r.tokens) parts.push(`${formatNumber(r.tokens)} tokens`);
      const branch = r.branch || '';
      const sha = r.headSha ? r.headSha.substring(0, 7) : '';
      if (branch && sha) parts.push(`${escapeHtml(branch)} @ ${sha}`);
      else if (branch) parts.push(escapeHtml(branch));
      else if (sha) parts.push(`@ ${sha}`);
      return `<div class="repo-row">${parts.join(' &middot; ')}</div>`;
    });

    if (data.repoBreakdown.length > 1) {
      rows.push(`<hr style="margin: 0.5rem 0">`);
      rows.push(`<div class="repo-row"><strong>Total &middot; ${formatNumber(data.totalFiles)} files &middot; ${formatNumber(data.totalTokens)} tokens</strong></div>`);
    }
    setHtml('repo-breakdown', rows.join(''));
  }

  // Spec: spec/client/estimate.md#updatePrecisionLabel
  function updatePrecisionLabel(data: EstimateData) {
    setText('estimate-precision', data.isPrecise
      ? 'Precise estimate (token count verified)'
      : 'Approximate estimate (\u00B115%)');

    if (data.isPrecise) {
      hide('precise-btn');
    }
  }

  // Spec: spec/client/estimate.md#renderEstimateCards
  function renderEstimateCards(data: EstimateData) {
    const levels = ['full', 'thorough', 'opportunistic'] as const;
    for (const level of levels) {
      const est = data.estimates[level];
      setHtml(`price-${level}`, `${formatUSD(est.costUsd)} <small>estimated</small>`);
    }
  }

  // Spec: spec/client/estimate.md#updateAnalysisCostHint
  function updateAnalysisCostHint(data: EstimateData) {
    if (data.analysisCostHint) {
      const label = data.analysisCostHint.isEmpirical
        ? 'based on empirical data'
        : 'rough estimate, no empirical data';
      setText('analysis-cost-hint', `~${formatUSD(data.analysisCostHint.costUsd)} for analysis (${label})`);
    } else {
      // Fallback: $0.25 per 100k tokens
      const cost = (data.totalTokens / 100_000) * 0.25;
      setText('analysis-cost-hint', `~${formatUSD(cost)} for analysis (rough estimate, no empirical data)`);
    }
  }

  // ---- Component Loading ----

  // Spec: spec/client/estimate.md#loadExistingComponents
  async function loadExistingComponents() {
    try {
      const comps = await apiFetch<ComponentItem[]>(`/api/projects/${projectId}/components`);
      if (comps.length > 0) {
        components = comps;
        selectedComponentIds.clear();
        comps.forEach(c => selectedComponentIds.add(c.id));
        showStep2(comps);
      }
    } catch {
      // No components yet, that's fine
    }
  }

  // Spec: spec/client/estimate.md#showStep2
  function showStep2(comps: ComponentItem[]) {
    hide('analyze-section');
    renderComponentTable(comps);
    show('step-2');
    show('reanalyze-section');
    // Enable audit level cards (remove disabled state)
    enableCards();
    // Render mode cards with costs from scoped estimate (all components selected by default)
    updateScopedEstimate();
  }

  // Spec: spec/client/estimate.md#enableCards
  function enableCards() {
    const cards = document.querySelectorAll<HTMLElement>('.estimate-card');
    cards.forEach(card => {
      card.classList.remove('disabled');
    });
    const hint = $('cards-hint');
    if (hint) hint.style.display = 'none';

    // Pre-select thorough if no level selected yet
    if (!selectedLevel) {
      const thorough = document.querySelector<HTMLElement>('.estimate-card[data-level="thorough"]');
      if (thorough) {
        cards.forEach(c => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
        thorough.classList.add('selected');
        thorough.setAttribute('aria-pressed', 'true');
        selectedLevel = 'thorough';
        show('step-3');
        updateStartButton();
      }
    }
  }

  // Spec: spec/client/estimate.md#renderComponentTable
  function renderComponentTable(comps: ComponentItem[]) {
    const tbody = $('component-table-body');
    if (!tbody) return;

    tbody.innerHTML = comps.map(c => `
      <tr>
        <td><input type="checkbox" class="component-checkbox" data-id="${c.id}" ${selectedComponentIds.has(c.id) ? 'checked' : ''}></td>
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

  // Spec: spec/client/estimate.md#onComponentSelectionChange
  async function onComponentSelectionChange() {
    const checkboxes = document.querySelectorAll<HTMLInputElement>('.component-checkbox');
    selectedComponentIds.clear();
    checkboxes.forEach(cb => {
      if (cb.checked) selectedComponentIds.add(cb.dataset.id!);
    });
    await updateScopedEstimate();
    updateStartButton();
  }

  // Spec: spec/client/estimate.md#updateScopedEstimate
  async function updateScopedEstimate() {
    if (selectedComponentIds.size === 0) {
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
        componentIds: Array.from(selectedComponentIds),
        totalTokens: projectTotalTokens,
      });
      renderEstimateCards(scoped);
      estimateData = scoped;
      setText('scoped-estimate-label',
        `${selectedComponentIds.size} of ${components.length} components selected ` +
        `(${formatNumber(scoped.totalFiles)} files, ${formatNumber(scoped.totalTokens)} tokens)`);
    } catch {
      setText('scoped-estimate-label', 'Failed to update estimate');
    }
  }

  // ---- Re-analyze ----

  const reanalyzeBtn = $('reanalyze-btn') as HTMLAnchorElement | null;
  reanalyzeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    show('analyze-section');
    hide('reanalyze-section');
    updateAnalyzeButton();
  });

  // ---- API Key ----

  const apiKeyInput = $('api-key') as HTMLInputElement | null;

  // Spec: spec/client/estimate.md#isValidApiKeyFormat
  function isValidApiKeyFormat(key: string): boolean {
    return key.startsWith('sk-ant-');
  }

  // Real-time API key format validation hint (Issue #63)
  apiKeyInput?.addEventListener('input', () => {
    updateStartButton();
    updateAnalyzeButton();
    const value = apiKeyInput.value.trim();
    const hintEl = $('api-key-hint');
    if (value.length > 0 && !value.startsWith('sk-ant-')) {
      if (!hintEl) {
        const hint = document.createElement('div');
        hint.id = 'api-key-hint';
        hint.className = 'text-sm text-muted';
        hint.textContent = 'Anthropic API keys start with "sk-ant-"';
        apiKeyInput.parentElement?.appendChild(hint);
      }
    } else if (hintEl) {
      hintEl.remove();
    }
  });

  // ---- Component Analysis ----

  const analyzeBtn = $('analyze-components-btn') as HTMLButtonElement | null;

  // Spec: spec/client/estimate.md#updateAnalyzeButton
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

      // Poll for completion with max retries (Issue #9)
      const MAX_POLL_RETRIES = 150; // ~5 min at 2s intervals
      let pollCount = 0;

      const poll = async () => {
        pollCount++;
        if (pollCount > MAX_POLL_RETRIES) {
          hide('component-analyzing');
          show('component-not-analyzed');
          showError('Component analysis timed out after 5 minutes. Please try again.');
          updateAnalyzeButton();
          return;
        }

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
            selectedComponentIds.clear();
            comps.forEach(c => selectedComponentIds.add(c.id));
            showStep2(comps);
          }
        } else if (status.status === 'failed') {
          hide('component-analyzing');
          show('component-not-analyzed');
          showError('Component analysis failed: ' + (status.errorMessage || 'Unknown error'));
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
      showError(err instanceof Error ? err.message : 'Failed to start analysis');
    }
  });

  // ---- Level Selection (cards) ----

  const cards = document.querySelectorAll<HTMLElement>('.estimate-card');
  cards.forEach(card => {
    // Keyboard accessibility (Issue #24)
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-pressed', 'false');

    const activateCard = () => {
      if (card.classList.contains('disabled')) return;
      cards.forEach(c => {
        c.classList.remove('selected');
        c.setAttribute('aria-pressed', 'false');
      });
      card.classList.add('selected');
      card.setAttribute('aria-pressed', 'true');
      selectedLevel = card.dataset.level || null;
      // Show step 3 when a level is selected
      show('step-3');
      updateStartButton();
    };

    card.addEventListener('click', activateCard);
    card.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateCard();
      }
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
      updateAnalysisCostHint(precise);
      estimateData = precise;
      projectTotalTokens = precise.totalTokens;
      updateStartButton();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to get precise estimate');
    } finally {
      preciseBtn.disabled = false;
      preciseBtn.textContent = 'Get Precise Estimate';
    }
  });

  // ---- Start Button (Step 3) ----

  // Spec: spec/client/estimate.md#updateStartButton
  function updateStartButton() {
    const btn = $('start-audit-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const keyValue = apiKeyInput?.value.trim() || '';
    const hasKey = keyValue.length > 0;
    const validKey = hasKey && isValidApiKeyFormat(keyValue);
    const hasLevel = !!selectedLevel;
    const hasComponents = selectedComponentIds.size > 0;

    // Show/hide key format error
    if (hasKey && !validKey) {
      show('api-key-error');
    } else {
      hide('api-key-error');
    }

    btn.disabled = !validKey || !hasLevel || !hasComponents;
    if (!hasComponents) {
      btn.textContent = 'Select at least one component above';
    } else if (!hasKey) {
      btn.textContent = 'Enter your API key above';
    } else if (!validKey) {
      btn.textContent = 'Invalid key format (should start with sk-ant-)';
    } else {
      const est = estimateData?.estimates[selectedLevel as keyof EstimateData['estimates']];
      const prefix = useIncremental ? 'Start incremental ' : 'Start ';
      const compLabel = selectedComponentIds.size < components.length
        ? ` (${selectedComponentIds.size} components)` : '';
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
      if (selectedComponentIds.size > 0 && selectedComponentIds.size < components.length) {
        body.componentIds = Array.from(selectedComponentIds);
      }
      const result = await apiPost<{ auditId: string }>('/api/audit/start', body);
      window.location.href = `/audit.html?auditId=${result.auditId}`;
    } catch (err) {
      startBtn.disabled = false;
      updateStartButton();
      showError(err instanceof Error ? err.message : 'Failed to start audit');
    }
  });

  // ---- Incremental / Fresh buttons ----

  const incrementalBtn = $('incremental-btn') as HTMLButtonElement | null;
  const freshBtn = $('fresh-btn') as HTMLButtonElement | null;

  // Tooltip/help text for audit modes (Issue #64)
  const modeHelpEl = $('mode-help');
  if (!modeHelpEl && incrementalBtn?.parentElement) {
    const helpText = document.createElement('p');
    helpText.id = 'mode-help';
    helpText.className = 'text-sm text-muted mt-1';
    helpText.textContent = 'Incremental: only re-analyzes files changed since the last audit, saving time and cost. Fresh: performs a full analysis of all files from scratch.';
    incrementalBtn.parentElement.appendChild(helpText);
  }

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

  // ---- Branch Editor ----

  const changeBranchesBtn = $('change-branches-btn') as HTMLButtonElement | null;
  const branchEditor = $('branch-editor');
  const branchEditorRepos = $('branch-editor-repos');
  const applyBranchesBtn = $('apply-branches-btn') as HTMLButtonElement | null;
  const cancelBranchesBtn = $('cancel-branches-btn') as HTMLButtonElement | null;

  changeBranchesBtn?.addEventListener('click', async () => {
    if (!branchEditor || !branchEditorRepos || !projectData) return;

    branchEditorRepos.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><span>Loading branches...</span></div>';
    show(branchEditor);
    changeBranchesBtn.disabled = true;

    try {
      // Load branches for all repos in parallel
      const branchResults = await Promise.all(
        projectData.repos.map(async (repo) => {
          const repoName = repo.repoName;
          const result = await apiFetch<{ defaultBranch: string; branches: Array<{ name: string }> }>(
            `/api/github/repos/${encodeURIComponent(projectData!.githubOrg)}/${encodeURIComponent(repoName)}/branches`
          );
          return {
            repoId: repo.id,
            repoName,
            defaultBranch: result.defaultBranch,
            currentBranch: repo.branch || result.defaultBranch,
            branches: result.branches.map(b => b.name),
          };
        })
      );

      // Render branch editor rows
      branchEditorRepos.innerHTML = branchResults.map(r => {
        const options = r.branches.map(b => {
          const isDefault = b === r.defaultBranch;
          const selected = b === r.currentBranch ? ' selected' : '';
          return `<option value="${escapeHtml(b)}"${selected}>${escapeHtml(b)}${isDefault ? ' (default)' : ''}</option>`;
        }).join('');

        return `
          <div class="branch-editor-row">
            <span class="branch-editor-repo">${escapeHtml(r.repoName)}</span>
            <select class="branch-editor-select" data-repo-id="${r.repoId}" data-default="${escapeHtml(r.defaultBranch)}">
              ${options}
            </select>
          </div>
        `;
      }).join('');
    } catch (err) {
      // Hide spinner before showing error (Issue #25)
      branchEditorRepos.innerHTML = `<div class="notice notice-error">Failed to load branches: ${escapeHtml(err instanceof Error ? err.message : 'Unknown error')}</div>`;
    }
  });

  cancelBranchesBtn?.addEventListener('click', () => {
    if (branchEditor) hide(branchEditor);
    if (changeBranchesBtn) changeBranchesBtn.disabled = false;
  });

  applyBranchesBtn?.addEventListener('click', async () => {
    if (!applyBranchesBtn || !branchEditor) return;

    applyBranchesBtn.disabled = true;
    applyBranchesBtn.textContent = 'Applying...';

    try {
      // Collect branch selections
      const selects = branchEditorRepos?.querySelectorAll<HTMLSelectElement>('.branch-editor-select');
      const repos: Array<{ repoId: string; branch: string | null }> = [];
      selects?.forEach(sel => {
        const repoId = sel.dataset.repoId!;
        const defaultBranch = sel.dataset.default || '';
        const selected = sel.value;
        repos.push({ repoId, branch: selected === defaultBranch ? null : selected });
      });

      // Update branches
      await apiPut(`/api/projects/${projectId}/branches`, { repos });

      // Re-run estimate to rescan at new branches
      const [project, estimate] = await Promise.all([
        apiFetch<ProjectData>(`/api/projects/${projectId}`),
        apiPost<EstimateData>('/api/estimate', { projectId }),
      ]);

      projectData = project;
      renderProjectHeader(project);
      renderProjectStats(estimate, project.githubOrg);
      renderEstimateCards(estimate);
      updatePrecisionLabel(estimate);
      estimateData = estimate;

      hide(branchEditor);
      if (changeBranchesBtn) changeBranchesBtn.disabled = false;
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to update branches');
    } finally {
      applyBranchesBtn.disabled = false;
      applyBranchesBtn.textContent = 'Apply';
    }
  });
});
