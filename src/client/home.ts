// ============================================================
// CodeWatch - Landing Page (index.html)
// Repo URL input → org detection → repo selector → create project
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const repoUrlInput = $('repo-url') as HTMLInputElement | null;
  const detectBtn = $('detect-org-btn') as HTMLButtonElement | null;
  const repoUrlError = $('repo-url-error');
  const step2 = $('step-2');
  const step3 = $('step-3');
  const orgNameEl = $('org-name');
  const repoList = $('repo-list');
  const selectAllCheckbox = $('select-all') as HTMLInputElement | null;
  const createBtn = $('create-project-btn') as HTMLButtonElement | null;
  const authRequired = $('auth-required');
  const loading = $('loading');

  let detectedOrg = '';
  let repos: Array<{ name: string; description: string; language: string; stars: number }> = [];
  let selectedRepos: Set<string> = new Set();

  // Parse GitHub URL to extract org
  function parseGitHubUrl(url: string): { org: string; repo: string } | null {
    try {
      const u = new URL(url);
      if (u.hostname !== 'github.com') return null;
      const parts = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
      if (parts.length < 2) return null;
      return { org: parts[0], repo: parts[1].replace(/\.git$/, '') };
    } catch {
      return null;
    }
  }

  // Step 1: Detect org from URL
  detectBtn?.addEventListener('click', async () => {
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

    detectedOrg = parsed.org;
    detectBtn.disabled = true;
    detectBtn.textContent = 'Loading...';

    try {
      repos = await apiFetch<typeof repos>(`/api/github/orgs/${encodeURIComponent(detectedOrg)}/repos`);
      renderRepoList(parsed.repo);
    } catch (err) {
      if (repoUrlError) {
        setText('repo-url-error', err instanceof Error ? err.message : 'Failed to fetch repos');
        show(repoUrlError);
      }
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = 'Detect Org';
    }
  });

  // Allow Enter key in URL input
  repoUrlInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      detectBtn?.click();
    }
  });

  function renderRepoList(preselectedRepo?: string) {
    if (!repoList || !orgNameEl || !step2 || !step3) return;

    setText('org-name', detectedOrg);
    repoList.innerHTML = '';

    repos.forEach((repo) => {
      const li = document.createElement('li');
      li.className = 'repo-item';
      const checked = repo.name === preselectedRepo;
      if (checked) selectedRepos.add(repo.name);

      li.innerHTML = `
        <input type="checkbox" value="${escapeHtml(repo.name)}" ${checked ? 'checked' : ''}>
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
          selectedRepos.add(repo.name);
        } else {
          selectedRepos.delete(repo.name);
        }
        updateStep3();
      });

      // Click anywhere on the row to toggle
      li.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
      });

      repoList.appendChild(li);
    });

    show(step2);
    show(step3);
    updateStep3();
  }

  // Select all
  selectAllCheckbox?.addEventListener('change', () => {
    const checked = selectAllCheckbox.checked;
    const checkboxes = repoList?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    checkboxes?.forEach((cb) => {
      cb.checked = checked;
      if (checked) {
        selectedRepos.add(cb.value);
      } else {
        selectedRepos.delete(cb.value);
      }
    });
    updateStep3();
  });

  function updateStep3() {
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

  // Step 3: Create project
  createBtn?.addEventListener('click', async () => {
    if (selectedRepos.size === 0 || !createBtn) return;

    createBtn.disabled = true;
    if (loading) show(loading);
    if (step3) hide(step3);

    try {
      const result = await apiPost<{ projectId: string }>('/api/projects', {
        githubOrg: detectedOrg,
        repoNames: Array.from(selectedRepos),
      });
      // Redirect to estimate page
      window.location.href = `/estimate.html?projectId=${result.projectId}`;
    } catch (err) {
      if (loading) hide(loading);
      if (step3) show(step3);
      createBtn.disabled = false;
      alert(err instanceof Error ? err.message : 'Failed to create project');
    }
  });
});
