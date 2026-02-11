// Spec: spec/client/projects.md
// ============================================================
// CodeWatch - Projects Browse Page (projects.html)
// Public browse + My Projects filter
// ============================================================

interface BrowseProject {
  id: string;
  name: string;
  githubOrg: string;
  category: string | null;
  license: string | null;
  publicAuditCount: number;
  latestSeverity?: string | null;
  latestAuditDate: string | null;
  createdAt: string;
  auditCount?: number;
  ownership?: {
    isOwner: boolean;
    role: string | null;
    needsReauth: boolean;
  };
}

interface BrowseResponse {
  projects: BrowseProject[];
  filters: {
    categories: string[];
    severities: string[];
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  // Filter elements — declared before loadProjects() to avoid TDZ
  const searchInput = $('search-input') as HTMLInputElement | null;
  const categoryFilter = $('category-filter') as HTMLSelectElement | null;
  const severityFilter = $('severity-filter') as HTMLSelectElement | null;
  const mineFilter = $('mine-filter') as HTMLInputElement | null;
  const mineLabel = $('mine-filter-label');

  let filtersPopulated = false;

  // Load projects immediately (public browse doesn't require auth)
  loadProjects();

  // Show "My Projects" checkbox once auth resolves (non-blocking)
  waitForAuth().then(() => {
    if (currentUser) {
      show('mine-filter-label');
    }
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  searchInput?.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadProjects, 300);
  });
  categoryFilter?.addEventListener('change', loadProjects);
  severityFilter?.addEventListener('change', loadProjects);

  // "My Projects" filter with visual indicator (Issue #62)
  mineFilter?.addEventListener('change', () => {
    if (mineLabel) {
      mineLabel.classList.toggle('filter-active', mineFilter.checked);
    }
    loadProjects();
  });

  // Spec: spec/client/projects.md#loadProjects
  async function loadProjects() {
    const search = (searchInput?.value || '').trim();
    const category = categoryFilter?.value || 'all';
    const severity = severityFilter?.value || 'all';
    const mine = mineFilter?.checked || false;

    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (category !== 'all') params.set('category', category);
    if (severity !== 'all') params.set('severity', severity);
    if (mine) params.set('mine', 'true');

    const listEl = $('projects-list');
    if (!listEl) return;

    // Show loading
    listEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><span>Loading...</span></div>';
    hide('empty-state');

    try {
      const response = await apiFetch<BrowseResponse>(`/api/projects/browse?${params.toString()}`);

      // Populate filter dropdowns on first successful load
      if (!filtersPopulated) {
        populateFilters(response.filters);
        filtersPopulated = true;
      }

      if (response.projects.length === 0) {
        listEl.innerHTML = '';
        show('empty-state');
        const msgEl = $('empty-message');
        if (msgEl) {
          msgEl.textContent = mine
            ? 'You have no projects yet. Add a project from the home page.'
            : 'No projects match your filters.';
        }
        return;
      }

      hide('empty-state');
      listEl.innerHTML = response.projects.map(p => renderProjectCard(p, mine)).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load projects')}</div>`;
    }
  }

  // Spec: spec/client/projects.md#populateFilters
  function populateFilters(filters: { categories: string[]; severities: string[] }) {
    if (categoryFilter) {
      const current = categoryFilter.value;
      categoryFilter.innerHTML = '<option value="all">All Categories</option>';
      for (const cat of filters.categories) {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat.replace(/_/g, ' ');
        categoryFilter.appendChild(opt);
      }
      categoryFilter.value = current;
    }
    if (severityFilter) {
      const current = severityFilter.value;
      severityFilter.innerHTML = '<option value="all">All Severities</option>';
      for (const sev of filters.severities) {
        const opt = document.createElement('option');
        opt.value = sev;
        opt.textContent = sev.charAt(0).toUpperCase() + sev.slice(1);
        severityFilter.appendChild(opt);
      }
      severityFilter.value = current;
    }
  }

  // Spec: spec/client/projects.md#renderProjectCard
  function renderProjectCard(p: BrowseProject, isMineMode: boolean): string {
    const sev = p.latestSeverity;
    const auditCount = isMineMode ? (p.auditCount || 0) : (p.publicAuditCount || 0);
    const auditLabel = isMineMode ? 'audit' : 'public audit';

    return `
      <a href="/project.html?projectId=${p.id}" class="card mb-1" style="display: block; text-decoration: none; color: inherit;">
        <div class="flex-between">
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <span class="text-sm text-muted"> &middot; ${escapeHtml(p.githubOrg)}</span>
          </div>
          <div class="flex gap-1" style="align-items: center;">
            ${p.ownership ? renderOwnershipBadge(p.ownership) : ''}
            ${sev ? `<span class="severity ${severityClass(sev)}">${escapeHtml(sev)}</span>` : ''}
          </div>
        </div>
        <div class="audit-meta mt-1">
          ${p.category ? `<span>${escapeHtml(p.category.replace(/_/g, ' '))}</span>` : ''}
          ${p.license ? `<span>${escapeHtml(p.license)}</span>` : ''}
          <span>${auditCount} ${auditLabel}${auditCount !== 1 ? 's' : ''}</span>
          ${p.latestAuditDate ? `<span>Latest: ${formatDate(p.latestAuditDate)}</span>` : ''}
        </div>
      </a>
    `;
  }

  // Uses shared renderOwnershipBadge() from common.ts
});
