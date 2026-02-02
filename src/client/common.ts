// ============================================================
// CodeWatch - Common Client Utilities
// Theme toggle, fetch helpers, DOM utils, auth status
// ============================================================

// ---------- Theme ----------

function getTheme(): 'light' | 'dark' {
  return (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
}

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
      try {
        const body: ApiError = await res.json();
        msg = body.error || msg;
      } catch {
        // ignore parse errors
      }
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        msg = retryAfter
          ? `Rate limited. Please wait ${retryAfter} seconds and try again.`
          : 'Rate limited. Please wait a moment and try again.';
      }
      throw new Error(msg);
    }

    // Handle 204 No Content
    if (res.status === 204) return undefined as unknown as T;

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ---------- DOM Helpers ----------

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function show(el: HTMLElement | string) {
  const node = typeof el === 'string' ? $(el) : el;
  node?.classList.remove('hidden');
}

function hide(el: HTMLElement | string) {
  const node = typeof el === 'string' ? $(el) : el;
  node?.classList.add('hidden');
}

function setText(id: string, text: string) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHtml(id: string, html: string) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatUSD(n: number): string {
  return '$' + n.toFixed(2);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------- Ownership & Access Tier Badges ----------

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

function renderAccessTierBadge(tier: 'owner' | 'requester' | 'public'): string {
  if (tier === 'owner') return '<span class="badge badge-completed">full access</span>';
  if (tier === 'requester') return '<span class="badge badge-pending">redacted</span>';
  return '<span class="badge badge-type">summary only</span>';
}

// ---------- Error Helpers ----------

function showInlineError(container: HTMLElement, message: string): void {
  clearInlineError(container);
  const notice = document.createElement('div');
  notice.className = 'notice notice-error inline-error';
  notice.textContent = message;
  container.prepend(notice);
}

function clearInlineError(container: HTMLElement): void {
  container.querySelector('.inline-error')?.remove();
}

function showError(message: string): void {
  const main = document.querySelector('main');
  if (main) showInlineError(main, message);
}

// ---------- Format Helpers ----------

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

// ---------- Shared: attachAddAsProjectHandlers ----------

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
