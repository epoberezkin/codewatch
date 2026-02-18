// Spec: spec/client/home.md
// ============================================================
// CodeWatch - Landing Page (index.html)
// Repo URL input → entity info → repo/branch config → create project
// ============================================================

interface EntityInfo {
  login: string;
  type: 'User' | 'Organization';
  avatarUrl: string;
  isOwner: boolean | null;
  role: string | null;
  needsReauth: boolean;
}

interface RepoInfo {
  name: string;
  description: string;
  language: string;
  stars: number;
  defaultBranch: string;
}

document.addEventListener('DOMContentLoaded', () => {
  const repoUrlInput = $('repo-url') as HTMLInputElement | null;
  const addProjectBtn = $('add-project-btn') as HTMLButtonElement | null;
  const repoUrlError = $('repo-url-error');
  const step2 = $('step-2');
  const step3 = $('step-3');
  const createBtn = $('create-project-btn') as HTMLButtonElement | null;
  const authRequired = $('auth-required');
  const loading = $('loading');
  const addReposBtn = $('add-repos-btn') as HTMLButtonElement | null;
  const selectAllCheckbox = $('select-all') as HTMLInputElement | null;

  let entityInfo: EntityInfo | null = null;
  let parsedOwner = '';
  let allRepos: RepoInfo[] = [];
  // key = repo name, value = { name, branch (null = default), defaultBranch }
  let selectedRepos: Map<string, { name: string; branch: string | null; defaultBranch: string }> = new Map();
  // Cache of loaded branches per repo name
  let branchCache: Map<string, string[]> = new Map();

  // Spec: spec/client/home.md#parseGitHubUrl
  function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    try {
      const u = new URL(url);
      if (u.hostname !== 'github.com') return null;
      const parts = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
      if (parts.length < 2) return null;
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    } catch {
      return null;
    }
  }

  // Step 1: Add Project
  addProjectBtn?.addEventListener('click', async () => {
    if (!repoUrlInput) return;
    const url = repoUrlInput.value.trim();
    if (!url) return;

    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      if (repoUrlError) {
        setText('repo-url-error', 'Enter a valid GitHub URL (e.g. https://github.com/org/repo)');
        show(repoUrlError);
      }
      return;
    }
    if (repoUrlError) hide(repoUrlError);

    parsedOwner = parsed.owner;
    addProjectBtn.disabled = true;
    addProjectBtn.textContent = 'Loading...';

    try {
      // Fetch entity info and repos in parallel
      const [entity, repos] = await Promise.all([
        apiFetch<EntityInfo>(`/api/github/entity/${encodeURIComponent(parsed.owner)}`),
        apiFetch<RepoInfo[]>(`/api/github/orgs/${encodeURIComponent(parsed.owner)}/repos`),
      ]);

      entityInfo = entity;
      allRepos = repos;

      // Render entity card
      renderEntityCard(entity);

      // Find the entered repo in the list to get its default branch
      const enteredRepo = repos.find(r => r.name.toLowerCase() === parsed.repo.toLowerCase());
      const defaultBranch = enteredRepo?.defaultBranch || 'main';

      // Pre-select the entered repo
      selectedRepos.clear();
      branchCache.clear();
      selectedRepos.set(parsed.repo, {
        name: parsed.repo,
        branch: null,
        defaultBranch,
      });

      renderSelectedRepos();
      if (step2) show(step2);
      if (step3) show(step3);
      updateStep3();
    } catch (err) {
      if (repoUrlError) {
        setText('repo-url-error', err instanceof Error ? err.message : 'Failed to fetch project info');
        show(repoUrlError);
      }
    } finally {
      addProjectBtn.disabled = false;
      addProjectBtn.textContent = 'Add Project';
    }
  });

  // Allow Enter key in URL input
  repoUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProjectBtn?.click();
    }
  });

  // ---- Entity Card ----

  // Spec: spec/client/home.md#renderEntityCard
  function renderEntityCard(entity: EntityInfo) {
    const avatar = $('entity-avatar') as HTMLImageElement | null;
    if (avatar) {
      avatar.src = entity.avatarUrl;
      avatar.alt = entity.login;
    }
    setText('entity-name', entity.login);

    const typeBadge = $('entity-type-badge');
    if (typeBadge) typeBadge.textContent = entity.type;

    const ownerBadge = $('owner-badge');
    const memberBadge = $('member-badge');
    const reauthBadge = $('reauth-badge');

    if (ownerBadge && memberBadge) {
      hide(ownerBadge);
      hide(memberBadge);
      if (reauthBadge) hide(reauthBadge);
      if (entity.isOwner === true) {
        show(ownerBadge);
      } else if (entity.role === 'member') {
        show(memberBadge);
      } else if (entity.needsReauth && reauthBadge) {
        show(reauthBadge);
      }
    }
  }

  // ---- Selected Repos ----

  // Spec: spec/client/home.md#renderSelectedRepos
  function renderSelectedRepos() {
    const list = $('selected-repos');
    if (!list) return;
    list.innerHTML = '';

    selectedRepos.forEach((repo, repoName) => {
      const li = document.createElement('li');
      li.className = 'repo-item';
      li.dataset.repo = repoName;

      const info = allRepos.find(r => r.name === repoName);

      li.innerHTML = `
        <button class="repo-remove-btn" data-repo="${escapeHtml(repoName)}" title="Remove">&times;</button>
        <div class="repo-item-info">
          <div class="repo-item-name">${escapeHtml(repoName)}</div>
          <div class="repo-item-meta">
            ${info?.language ? `<span>${escapeHtml(info.language)}</span>` : ''}
            ${info ? `<span>${info.stars.toLocaleString()} stars</span>` : ''}
          </div>
        </div>
        ${currentUser ? `<div class="branch-selector" data-repo="${escapeHtml(repoName)}">
          <button class="btn btn-sm btn-secondary branch-trigger" data-repo="${escapeHtml(repoName)}">
            ${escapeHtml(repo.branch || repo.defaultBranch)}
          </button>
        </div>` : ''}
      `;

      // Remove button
      const removeBtn = li.querySelector('.repo-remove-btn') as HTMLButtonElement;
      removeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedRepos.delete(repoName);
        renderSelectedRepos();
        updateStep3();
      });

      // Branch trigger
      const branchTrigger = li.querySelector('.branch-trigger') as HTMLButtonElement;
      branchTrigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        openBranchDropdown(repoName, branchTrigger);
      });

      list.appendChild(li);
    });
  }

  // ---- Branch Dropdown ----

  // Spec: spec/client/home.md#openBranchDropdown
  async function openBranchDropdown(repoName: string, trigger: HTMLButtonElement) {
    const container = trigger.parentElement;
    if (!container) return;

    // If dropdown already open, close it
    const existing = container.querySelector('select');
    if (existing) {
      closeBranchDropdown(container, repoName);
      return;
    }

    // Create select element
    const select = document.createElement('select');
    select.className = 'branch-select';

    // Add loading option
    const loadingOpt = document.createElement('option');
    loadingOpt.textContent = 'Loading...';
    loadingOpt.disabled = true;
    select.appendChild(loadingOpt);

    // Replace trigger with select
    trigger.style.display = 'none';
    container.appendChild(select);

    try {
      let branches: string[];
      if (branchCache.has(repoName)) {
        branches = branchCache.get(repoName)!;
      } else {
        const result = await apiFetch<{ defaultBranch: string; branches: Array<{ name: string }> }>(
          `/api/github/repos/${encodeURIComponent(parsedOwner)}/${encodeURIComponent(repoName)}/branches`
        );
        branches = result.branches.map(b => b.name);
        branchCache.set(repoName, branches);

        // Update default branch if we got it from the API
        const repo = selectedRepos.get(repoName);
        if (repo) {
          repo.defaultBranch = result.defaultBranch;
        }
      }

      // Rebuild select with actual branches
      select.innerHTML = '';
      const repo = selectedRepos.get(repoName);
      const currentBranch = repo?.branch || repo?.defaultBranch || '';

      for (const branch of branches) {
        const opt = document.createElement('option');
        opt.value = branch;
        const isDefault = branch === repo?.defaultBranch;
        opt.textContent = isDefault ? `${branch} (default)` : branch;
        if (branch === currentBranch) opt.selected = true;
        select.appendChild(opt);
      }

      select.addEventListener('change', () => {
        const repo = selectedRepos.get(repoName);
        if (repo) {
          repo.branch = select.value === repo.defaultBranch ? null : select.value;
        }
        closeBranchDropdown(container, repoName);
      });

      // Close on blur
      select.addEventListener('blur', () => {
        setTimeout(() => closeBranchDropdown(container, repoName), 150);
      });

      select.focus();
    } catch {
      // On error, restore trigger
      trigger.style.display = '';
      select.remove();
    }
  }

  // Spec: spec/client/home.md#closeBranchDropdown
  function closeBranchDropdown(container: HTMLElement, repoName: string) {
    const select = container.querySelector('select');
    const trigger = container.querySelector('.branch-trigger') as HTMLButtonElement;
    if (select) select.remove();
    if (trigger) {
      const repo = selectedRepos.get(repoName);
      trigger.textContent = repo?.branch || repo?.defaultBranch || 'main';
      trigger.style.display = '';
    }
  }

  // ---- Add Other Repositories ----

  addReposBtn?.addEventListener('click', () => {
    const section = $('all-repos-section');
    if (!section) return;

    if (section.classList.contains('hidden')) {
      renderAllReposList();
      show(section);
      if (addReposBtn) addReposBtn.textContent = 'Hide other repositories';
      // Focus search input
      const searchInput = $('repo-search') as HTMLInputElement | null;
      searchInput?.focus();
    } else {
      hide(section);
      if (addReposBtn) addReposBtn.textContent = 'Add other repositories';
    }
  });

  // Repo search filter
  const repoSearchInput = $('repo-search') as HTMLInputElement | null;
  repoSearchInput?.addEventListener('input', () => {
    const query = repoSearchInput.value.trim().toLowerCase();
    const items = $('all-repos-list')?.querySelectorAll<HTMLLIElement>('.repo-item');
    items?.forEach(li => {
      const name = li.querySelector('.repo-item-name')?.textContent?.toLowerCase() || '';
      const desc = li.querySelector('.repo-item-meta')?.textContent?.toLowerCase() || '';
      li.style.display = (name.includes(query) || desc.includes(query)) ? '' : 'none';
    });
  });

  // Spec: spec/client/home.md#renderAllReposList
  function renderAllReposList() {
    const list = $('all-repos-list');
    if (!list) return;
    list.innerHTML = '';

    // Filter out already-selected repos
    const available = allRepos.filter(r => !selectedRepos.has(r.name));

    if (available.length === 0) {
      list.innerHTML = '<li class="repo-item text-muted text-sm" style="justify-content:center;">All repositories are selected</li>';
      return;
    }

    available.forEach((repo) => {
      const li = document.createElement('li');
      li.className = 'repo-item';

      li.innerHTML = `
        <input type="checkbox" value="${escapeHtml(repo.name)}">
        <div class="repo-item-info">
          <div class="repo-item-name">${escapeHtml(repo.name)}</div>
          <div class="repo-item-meta">
            ${repo.language ? `<span>${escapeHtml(repo.language)}</span>` : ''}
            <span>${repo.stars.toLocaleString()} stars</span>
            ${repo.description ? `<span>${escapeHtml(repo.description.substring(0, 80))}</span>` : ''}
          </div>
        </div>
      `;

      const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedRepos.set(repo.name, {
            name: repo.name,
            branch: null,
            defaultBranch: repo.defaultBranch,
          });
        } else {
          selectedRepos.delete(repo.name);
        }
        renderSelectedRepos();
        updateStep3();
      });

      // Click row to toggle
      li.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
      });

      list.appendChild(li);
    });
  }

  // Select all
  selectAllCheckbox?.addEventListener('change', () => {
    const checked = selectAllCheckbox.checked;
    const checkboxes = $('all-repos-list')?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes?.forEach((cb) => {
      if (cb.checked !== checked) {
        cb.checked = checked;
        cb.dispatchEvent(new Event('change'));
      }
    });
  });

  // ---- Step 3: Auth + Create ----

  // Spec: spec/client/home.md#updateStep3
  async function updateStep3() {
    await waitForAuth();
    const hasSelection = selectedRepos.size > 0;
    const isLoggedIn = !!currentUser;

    if (authRequired) {
      if (isLoggedIn) hide(authRequired);
      else show(authRequired);
    }

    if (createBtn) {
      createBtn.disabled = !hasSelection || !isLoggedIn;
      createBtn.textContent = hasSelection
        ? `Create Project (${selectedRepos.size} repo${selectedRepos.size > 1 ? 's' : ''})`
        : 'Select at least one repository';
    }
  }

  createBtn?.addEventListener('click', async () => {
    if (selectedRepos.size === 0 || !createBtn) return;

    createBtn.disabled = true;
    if (loading) show(loading);
    if (step3) hide(step3);

    try {
      const repos = Array.from(selectedRepos.values()).map(r => ({
        name: r.name,
        branch: r.branch || undefined,
        defaultBranch: r.defaultBranch,
      }));

      const result = await apiPost<{ projectId: string }>('/api/projects', {
        githubOrg: parsedOwner,
        repos,
      });
      window.location.href = `/estimate.html?projectId=${result.projectId}`;
    } catch (err) {
      if (loading) hide(loading);
      if (step3) show(step3);
      createBtn.disabled = false;
      showError(err instanceof Error ? err.message : 'Failed to create project');
    }
  });
});
