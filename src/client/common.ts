// Spec: spec/client/common.md
// ============================================================
// CodeWatch - Common Client Utilities
// Theme toggle, fetch helpers, DOM utils, auth status
// ============================================================

// ---------- Theme ----------

// Spec: spec/client/common.md#getTheme
function getTheme(): 'light' | 'dark' {
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
}

// Spec: spec/client/common.md#applyTheme
function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
}

// Spec: spec/client/common.md#initThemeToggle
function initThemeToggle() {
  applyTheme(getTheme());
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = getTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      applyTheme(next);
    });
  }
}

// ---------- Fetch Helpers ----------

interface ApiError {
  error: string;
  details?: string;
}

// Spec: spec/client/common.md#ApiResponseError
class ApiResponseError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Spec: spec/client/common.md#apiFetch
async function apiFetch<T>(path: string, options: RequestInit & { timeout?: number } = {}): Promise<T> {
  const timeout = options.timeout ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      let body: any = {};
      try {
        body = await res.json();
        msg = body.error || body.message || msg;
      } catch {
        // ignore parse errors
      }
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        msg = retryAfter
          ? `Rate limited. Please wait ${retryAfter} seconds and try again.`
          : 'Rate limited. Please wait a moment and try again.';
      }
      throw new ApiResponseError(msg, res.status, body);
    }

    // Handle 204 No Content
    if (res.status === 204) return undefined as unknown as T;

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Spec: spec/client/common.md#apiPost
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Spec: spec/client/common.md#apiPut
async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ---------- DOM Helpers ----------

// Spec: spec/client/common.md#$
function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// Spec: spec/client/common.md#show
function show(el: HTMLElement | string) {
  const node = typeof el === 'string' ? $(el) : el;
  node?.classList.remove('hidden');
}

// Spec: spec/client/common.md#hide
function hide(el: HTMLElement | string) {
  const node = typeof el === 'string' ? $(el) : el;
  node?.classList.add('hidden');
}

// Spec: spec/client/common.md#setText
function setText(id: string, text: string) {
  const el = $(id);
  if (el) el.textContent = text;
}

// Spec: spec/client/common.md#setHtml
function setHtml(id: string, html: string) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

// Spec: spec/client/common.md#getParam
function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

// Spec: spec/client/common.md#formatNumber
function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// Spec: spec/client/common.md#formatUSD
function formatUSD(n: number): string {
  return '$' + n.toFixed(2);
}

// Spec: spec/client/common.md#formatDate
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Spec: spec/client/common.md#formatDateTime
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Spec: spec/client/common.md#severityClass
function severityClass(severity: string): string {
  switch (severity) {
    case 'critical': return 'severity-critical';
    case 'high': return 'severity-high';
    case 'medium': return 'severity-medium';
    case 'low': return 'severity-low';
    case 'informational': return 'severity-info';
    default: return '';
  }
}

// Spec: spec/client/common.md#escapeHtml
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------- Ownership & Access Tier Badges ----------

// Spec: spec/client/common.md#renderOwnershipBadge
function renderOwnershipBadge(ownership: { isOwner: boolean; role?: string | null; needsReauth?: boolean } | null | undefined): string {
  if (!ownership) return '';
  if (ownership.isOwner) {
    return '<span class="badge badge-completed">owner</span>';
  }
  if (ownership.needsReauth) {
    return '<a href="/auth/github" class="badge badge-pending" title="Click to re-authenticate and verify ownership">verify ownership</a>';
  }
  return '';
}

// Spec: spec/client/common.md#renderAccessTierBadge
function renderAccessTierBadge(tier: 'owner' | 'requester' | 'public'): string {
  if (tier === 'owner') return '<span class="badge badge-completed">full access</span>';
  if (tier === 'requester') return '<span class="badge badge-pending">redacted</span>';
  return '<span class="badge badge-type">summary only</span>';
}

// ---------- Error Helpers ----------

// Spec: spec/client/common.md#showInlineError
function showInlineError(container: HTMLElement, message: string): void {
  clearInlineError(container);
  const notice = document.createElement('div');
  notice.className = 'notice notice-error inline-error';
  notice.textContent = message;
  container.prepend(notice);
}

// Spec: spec/client/common.md#clearInlineError
function clearInlineError(container: HTMLElement): void {
  container.querySelector('.inline-error')?.remove();
}

// Spec: spec/client/common.md#showError
function showError(message: string): void {
  const main = document.querySelector('main');
  if (main) showInlineError(main, message);
}

// ---------- Format Helpers ----------

// Spec: spec/client/common.md#formatStatus
function formatStatus(status: string): string {
  const map: Record<string, string> = {
    'false_positive': 'False Positive',
    'wont_fix': "Won't Fix",
    'in_progress': 'In Progress',
    'resolved': 'Resolved',
    'accepted': 'Accepted',
    'open': 'Open',
  };
  return map[status] || status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- Shared: renderThreatModel ----------

// Spec: spec/client/common.md#renderThreatModel
function renderThreatModel(
  targetId: string,
  data: {
    threatModel?: string | null;
    threatModelParties?: Array<{name: string; can: string[]; cannot: string[]}>;
    threatModelFileLinks?: Array<{path: string; url: string}>;
    threatModelSource?: string | null;
  }
): boolean {
  const hasContent = data.threatModel || data.threatModelParties?.length || data.threatModelFileLinks?.length;
  if (!hasContent) return false;

  const sourceLabel = data.threatModelSource === 'repo'
    ? 'From Repository'
    : data.threatModelSource === 'generated'
      ? 'Generated by CodeWatch'
      : data.threatModelSource || 'unknown';

  let html = `<span class="badge badge-${data.threatModelSource === 'repo' ? 'completed' : 'running'} mb-1">${escapeHtml(sourceLabel)}</span>`;

  if (data.threatModel) {
    html += `<p class="mt-1">${escapeHtml(data.threatModel)}</p>`;
  }

  if (data.threatModelFileLinks?.length) {
    const links = data.threatModelFileLinks
      .filter(f => f.url.startsWith('https://'))
      .map(f => `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.path)}</a>`)
      .join(', ');
    if (links) html += `<p class="text-sm mt-1">Source: ${links}</p>`;
  }

  if (data.threatModelParties?.length) {
    const partyRows = data.threatModelParties.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${escapeHtml(p.can.join('; '))}</td>
        <td>${escapeHtml(p.cannot.join('; '))}</td>
      </tr>
    `).join('');
    html += `
      <table class="table mt-1">
        <thead><tr><th>Party</th><th>Can</th><th>Cannot</th></tr></thead>
        <tbody>${partyRows}</tbody>
      </table>`;
  }

  setHtml(targetId, html);
  return true;
}

// ---------- Shared: renderInvolvedParties ----------

// Spec: spec/client/common.md#renderInvolvedParties
function renderInvolvedParties(
  targetId: string,
  parties: Record<string, unknown> | null
): boolean {
  if (!parties) return false;
  const labels: Record<string, string> = {
    vendor: 'Vendor', operators: 'Operators', end_users: 'End Users', networks: 'Networks',
  };
  const items: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const val = parties[key];
    if (!val) continue;
    const text = Array.isArray(val) ? val.join(', ') : String(val);
    if (text) items.push(`<strong>${label}:</strong> ${escapeHtml(text)}`);
  }
  if (items.length === 0) return false;
  setHtml(targetId, items.join(' &middot; '));
  show(targetId);
  return true;
}

// ---------- Shared: attachAddAsProjectHandlers ----------

// Spec: spec/client/common.md#attachAddAsProjectHandlers
function attachAddAsProjectHandlers(selector: string): void {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach(btn => {
    btn.addEventListener('click', async () => {
      const depId = btn.dataset.depId!;
      const depName = btn.dataset.name!;
      const sourceUrl = btn.dataset.url || '';

      if (!sourceUrl) {
        showError('No source repository URL available for this dependency.');
        return;
      }

      const match = sourceUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) {
        showError('Source URL is not a recognized GitHub repository.');
        return;
      }

      const githubOrg = match[1];
      const repoName = match[2].replace(/\.git$/, '');

      if (!confirm(`Add "${depName}" (https://github.com/${githubOrg}/${repoName}) as a new CodeWatch project?`)) return;

      btn.disabled = true;
      btn.textContent = 'Adding...';
      try {
        const newProject = await apiPost<{ projectId: string }>('/api/projects', {
          githubOrg,
          repoNames: [repoName],
        });
        await apiPost(`/api/dependencies/${depId}/link`, { linkedProjectId: newProject.projectId });
        btn.outerHTML = `<a href="/project.html?projectId=${newProject.projectId}" class="btn btn-sm btn-secondary">View Project</a>`;
      } catch (err) {
        if (err instanceof ApiResponseError && err.status === 409 && err.body?.projectId) {
          await apiPost(`/api/dependencies/${depId}/link`, { linkedProjectId: err.body.projectId });
          btn.outerHTML = `<a href="/project.html?projectId=${escapeHtml(err.body.projectId)}" class="btn btn-sm btn-secondary">View Project</a>`;
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Add as Project';
        showError(err instanceof Error ? err.message : 'Failed to add as project');
      }
    });
  });
}

// ---------- Auth Status ----------

interface AuthUser {
  id: string;
  username: string;
  avatarUrl?: string;
  githubType: string;
}

let currentUser: AuthUser | null = null;
let authChecked = false;

// Spec: spec/client/common.md#checkAuth
async function checkAuth(): Promise<AuthUser | null> {
  try {
    currentUser = await apiFetch<AuthUser>('/auth/me');
    return currentUser;
  } catch {
    currentUser = null;
    return null;
  } finally {
    authChecked = true;
  }
}

// Spec: spec/client/common.md#renderAuthStatus
function renderAuthStatus() {
  const el = $('auth-status');
  if (!el) return;

  if (currentUser) {
    el.innerHTML = `<div class="auth-user">
      ${currentUser.avatarUrl ? `<img src="${escapeHtml(currentUser.avatarUrl)}" alt="">` : ''}
      <span>${escapeHtml(currentUser.username)}</span>
      <a href="#" id="logout-link">Logout</a>
    </div>`;
    const logoutLink = document.getElementById('logout-link');
    logoutLink?.addEventListener('click', async (e) => {
      e.preventDefault();
      await apiPost('/auth/logout', {});
      window.location.reload();
    });
  } else {
    el.innerHTML = `<a href="/auth/github">Sign in with GitHub</a>`;
  }
}

// ---------- Wait for Auth ----------

// Spec: spec/client/common.md#waitForAuth
function waitForAuth(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (authChecked) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    // If already checked, resolve immediately
    if (authChecked) {
      resolve();
    } else {
      setTimeout(check, 50);
    }
  });
}

// ---------- Mobile Navigation ----------

// Spec: spec/client/common.md#initNav
function initNav(): void {
  const hamburger = document.getElementById('hamburger-btn');
  const navLinks = document.querySelector('.nav-links');
  if (!hamburger || !navLinks) return;
  hamburger.classList.remove('hidden');
  hamburger.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!hamburger.contains(e.target as Node) && !navLinks.contains(e.target as Node)) {
      navLinks.classList.remove('open');
    }
  });
}

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle();
  initNav();
  await checkAuth();
  renderAuthStatus();
});
