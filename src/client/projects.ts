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
  latestPublicSeverity?: string | null;
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

document.addEventListener('DOMContentLoaded', async () => {
  // Show "My Projects" checkbox if authenticated
  await waitForAuth();
  if (currentUser) {
    show('mine-filter-label');
  }

  // Initial load
  loadProjects();

  // Filter event handlers
  const searchInput = $('search-input') as HTMLInputElement | null;
  const categoryFilter = $('category-filter') as HTMLSelectElement | null;
  const severityFilter = $('severity-filter') as HTMLSelectElement | null;
  const mineFilter = $('mine-filter') as HTMLInputElement | null;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  searchInput?.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadProjects, 300);
  });
  categoryFilter?.addEventListener('change', loadProjects);
  severityFilter?.addEventListener('change', loadProjects);
  mineFilter?.addEventListener('change', loadProjects);

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
    const emptyEl = $('empty-state');
    if (!listEl) return;

    // Show loading
    listEl.innerHTML = '<div class="loading-overlay"><div class="spinner"></div><span>Loading...</span></div>';
    hide('empty-state');

    try {
      const projects = await apiFetch<BrowseProject[]>(`/api/projects/browse?${params.toString()}`);

      if (projects.length === 0) {
        listEl.innerHTML = '';
        show('empty-state');
        const msgEl = $('empty-message');
        if (msgEl) {
          msgEl.textContent = mine
            ? 'You have no projects yet. Add a project from the home page.'
            : 'No projects with public audits match your filters.';
        }
        return;
      }

      hide('empty-state');
      listEl.innerHTML = projects.map(p => renderProjectCard(p, mine)).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="notice notice-error">${escapeHtml(err instanceof Error ? err.message : 'Failed to load projects')}</div>`;
    }
  }

  function renderProjectCard(p: BrowseProject, isMineMode: boolean): string {
    const sev = p.latestPublicSeverity || p.latestSeverity;
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

  function renderOwnershipBadge(ownership: { isOwner: boolean; needsReauth: boolean }): string {
    if (ownership.isOwner) {
      return '<span class="badge badge-completed">owner</span>';
    }
    if (ownership.needsReauth) {
      return '<span class="badge badge-pending">re-auth needed</span>';
    }
    return '';
  }

  // waitForAuth is now defined in common.ts
});
