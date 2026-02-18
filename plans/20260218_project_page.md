# Plan: Unify Top Two Sections Across Estimate & Project Pages

## Context

The estimate page and project page both display project info and repositories, but with inconsistent layouts:
- **Estimate page**: Org name as h1, description, repo@branch meta row, then "Project Overview" card with total files/tokens + per-repo breakdown + Change Branches button
- **Project page**: Org name as h1, description, meta with Org/License/repos/files/tokens, then "Repositories" card with rich cards (link, 0 stars, empty fields)

Both pages should show the same top two sections with a unified compact layout. The project identity is the repo set, not the org name.

## Solution

Client-only changes to `estimate.ts`, `estimate.html`, `project.ts`, `project.html`. No backend/API changes — the project detail API already returns `totalFiles`, `totalTokens`, `defaultBranch`, `branch` per repo.

### Target layout (both pages)

**Section 1 — Project Header:**
```
simplexmq                                [Owner] [New Audit]
GitHub org: simplex-chat
```
(Estimate page: no "New Audit" button since user is already there to start an audit)

**Section 2 — Repositories (single-repo):**
```
Repositories                                    [Change Branch]
  simplexmq ↗ · 303 files · 1.2M tokens · master
```

**Section 2 — Repositories (multi-repo):**
```
Repositories                                   [Change Branches]
  simplexmq ↗ · 303 files · 1.2M tokens · master
  simplex-chat ↗ · 902 files · 3.6M tokens · main
  ──────────────────────────────────────────────
  Total · 1,205 files · 4.8M tokens
```

Key decisions:
- Project name = repo names joined. 1–3: `a + b + c`. 4+: `a + b + N more`
- `↗` is a small box-arrow icon (SVG inline or CSS) linking to GitHub repo — subtle, not a full anchor
- Estimate page additionally shows `@ <sha7>` per repo (from `EstimateData.repoBreakdown[].headSha`)
- Project page shows branch only (no SHA available without cloning)
- Total row only for multi-repo
- `#project-meta` row removed from both pages
- `stat-files` / `stat-tokens` removed from estimate page

## Implementation

### Step 1: Add missing fields to `ProjectDetail.repos` interface — `src/client/project.ts` L28-36

The API already returns these but the interface omits them:
```ts
repos: Array<{
  id: string;
  repoName: string;
  repoUrl: string;
  language: string;
  stars: number;
  description: string;
  license: string | null;
  totalFiles: number;      // ADD
  totalTokens: number;     // ADD
  defaultBranch: string;   // ADD
  branch: string | null;   // ADD
}>;
```

### Step 2: Update `renderProject()` in `project.ts` — L96-152

**L100 — Project name**: Derive from repo names:
```ts
const repoNames = project.repos.map(r => r.repoName);
const name = repoNames.length <= 3
  ? repoNames.join(' + ')
  : `${repoNames.slice(0, 2).join(' + ')} + ${repoNames.length - 2} more`;
setText('project-name', name || project.name);
```

**L101 — Description**: Always `GitHub org: ${project.githubOrg}`

**L118-126 — Remove meta row**: Delete the `metaParts` block. `#project-meta` div removed from HTML.

**L137-151 — Repos rendering**: Replace rich cards with compact rows:
```ts
const reposHtml = project.repos.map(r => {
  const parts: string[] = [];
  // Name with external link icon
  const nameHtml = r.repoUrl
    ? `<a href="${escapeHtml(r.repoUrl)}" target="_blank" rel="noopener" class="repo-link">${escapeHtml(r.repoName)}<svg class="icon-external" ...></svg></a>`
    : escapeHtml(r.repoName);
  parts.push(nameHtml);
  if (r.totalFiles) parts.push(`${formatNumber(r.totalFiles)} files`);
  if (r.totalTokens) parts.push(`${formatNumber(r.totalTokens)} tokens`);
  const branch = r.branch || r.defaultBranch || '';
  if (branch) parts.push(escapeHtml(branch));
  return `<div class="repo-row">${parts.join(' &middot; ')}</div>`;
}).join('');

// Total row (multi-repo only)
let totalHtml = '';
if (project.repos.length > 1) {
  const totalFiles = project.repos.reduce((s, r) => s + (r.totalFiles || 0), 0);
  const totalTokens = project.repos.reduce((s, r) => s + (r.totalTokens || 0), 0);
  totalHtml = `<hr style="margin: 0.5rem 0"><div class="repo-row"><strong>Total &middot; ${formatNumber(totalFiles)} files &middot; ${formatNumber(totalTokens)} tokens</strong></div>`;
}
setHtml('repos-list', reposHtml + totalHtml);
```

Add "Change Branch(es)" button text:
```ts
const branchBtn = $('change-branches-btn');
if (branchBtn) branchBtn.textContent = project.repos.length === 1 ? 'Change Branch' : 'Change Branches';
```

### Step 3: Update `project.html` — L33-68

**Section 1 (L33-49)**: Remove `#project-meta` div (L47).

**Section 2 (L60-68)**: Replace repos section:
```html
<div class="card mb-2" id="repos-section">
    <div class="flex-between">
        <h2>Repositories</h2>
        <a class="btn btn-sm btn-secondary" id="change-branches-btn" href="#">Change Branches</a>
    </div>
    <div id="repos-list" class="mt-1"></div>
</div>
```

The "Change Branches" link navigates to the estimate page (href set by JS: `/estimate.html?projectId=X`).

### Step 4: Update `renderProjectHeader()` in `estimate.ts` — L141-151

**L144 — Project name**: Same repo-name-based logic as project.ts:
```ts
const repoNames = project.repos.map(r => r.repoName);
const name = repoNames.length <= 3
  ? repoNames.join(' + ')
  : `${repoNames.slice(0, 2).join(' + ')} + ${repoNames.length - 2} more`;
setText('project-name', name || project.name);
```

**L145 — Description**: Always `GitHub org: ${project.githubOrg}`

**L146-150 — Remove meta row**: Delete `project-meta` HTML generation.

### Step 5: Update `renderProjectStats()` in `estimate.ts` — L154-166

Replace with unified compact rows (same as project.ts but with SHA from `EstimateData`):
```ts
function renderProjectStats(data: EstimateData) {
  const rows = data.repoBreakdown.map(r => {
    const parts: string[] = [escapeHtml(r.repoName)];
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
```

After calling renderProjectStats, set button text:
```ts
const branchBtn = document.getElementById('change-branches-btn');
if (branchBtn) branchBtn.textContent = project.repos.length === 1 ? 'Change Branch' : 'Change Branches';
```

### Step 6: Update `estimate.html` — L33-71

**Section 1 (L38-42)**: Remove `#project-meta` div (L41).

**Section 2 (L62-71)**: Replace project-stats card:
```html
<div class="card mb-2" id="project-stats">
    <div class="flex-between">
        <h3>Repositories</h3>
        <button class="btn btn-sm btn-secondary" id="change-branches-btn">Change Branches</button>
    </div>
    <div id="repo-breakdown" class="mt-1"></div>
    <!-- Branch editor (hidden) -->
```

Remove `stat-files`, `stat-tokens` spans and `stats-content` wrapper.

### Step 7: External link icon CSS — `public/css/style.css`

Add minimal inline SVG icon style for the repo external link:
```css
.icon-external {
  width: 0.75em;
  height: 0.75em;
  margin-left: 0.2em;
  vertical-align: baseline;
  opacity: 0.5;
}
.icon-external:hover { opacity: 0.8; }
```

### Step 8: Update docs

- `spec/client/estimate.md`: Update `renderProjectHeader` (repo-name title, no meta), `renderProjectStats` (compact rows, conditional total), remove `stat-files`/`stat-tokens`/`project-meta` from DOM table
- `spec/client/project.md`: Update `ProjectDetail.repos` interface, `renderProject` description (repo-name title, no meta, compact repo rows, total row), remove old repo card rendering description, add `change-branches-btn` to DOM table
- `product/views/estimate.md`: Update Section 1 (name from repos, no meta) and Section 4 (Repositories with compact rows)
- `product/views/project.md`: Update Section 1 (name from repos, no meta) and repos section (compact rows + Change Branches link)

## Verification

1. `npx tsc --noEmit` — no new type errors
2. **Estimate page**: single-repo shows repo name as h1, org as description, one compact row with SHA, no total row
3. **Estimate page**: multi-repo shows joined names, per-repo rows with SHA, hr + total row
4. **Project page**: same layout but without SHA, "Change Branches" links to estimate page
5. **Both pages**: "Change Branch" singular for 1 repo, "Change Branches" plural for multi
6. External link icon (↗) renders small and subtle next to repo names on project page
7. Branch editor on estimate page still functions (open/apply/cancel)
8. Edge cases: 0 files/tokens (shows just name + branch), 4+ repos (name truncated), no repoUrl (no link icon)
