# estimate.ts -- Estimate Page Module

**Source**: [`estimate.ts`](../../src/client/estimate.ts#L1-L706)
**HTML**: `public/estimate.html`

---

## Overview

Multi-step flow for configuring and starting a security audit:
1. **Project stats display** -- file/token counts, repo breakdown
2. **Component analysis** -- run AI analysis or load existing components
3. **Component scoping** -- select/deselect components, re-estimate cost
4. **Level card selection** -- full / thorough / opportunistic (thorough pre-selected)
5. **Start audit** -- API key validation, incremental/fresh toggle, launch

---

## [Interfaces](../../src/client/estimate.ts#L7-L60)

```ts
interface EstimateData {
  totalFiles: number; totalTokens: number;
  repoBreakdown: Array<{ repoName, files, tokens, headSha?, branch? }>;
  estimates: { full, thorough, opportunistic: { files, tokens, costUsd } };
  previousAudit?: { id, createdAt, level, maxSeverity };
  isPrecise: boolean;
  cloneErrors?: Array<{ repoName, error }>;
  analysisCostHint?: { costUsd, isEmpirical };
}

interface ProjectData {
  id, name, description, githubOrg, category, createdBy;
  ownership: { isOwner, role, needsReauth } | null;
  repos: Array<{ id, repoName, language, stars, defaultBranch, branch }>;
}

interface ComponentItem {
  id, name, description, role, repoName;
  filePatterns: string[]; languages: string[];
  securityProfile: { summary?, threat_surface? } | null;
  estimatedFiles, estimatedTokens;
}

interface AnalysisStatus {
  id, status, turnsUsed, maxTurns, costUsd, errorMessage;
}
```

---

## [State Variables](../../src/client/estimate.ts#L72-L79)

| Variable | Type | Description |
|---|---|---|
| `selectedLevel` | `string \| null` | Currently selected audit level |
| `estimateData` | `EstimateData \| null` | Latest estimate response |
| `projectTotalTokens` | `number` | Total project tokens (for scoped re-estimation) |
| `useIncremental` | `boolean` | Incremental vs fresh audit toggle |
| `baseAuditId` | `string \| null` | Previous audit ID for incremental mode |
| `selectedComponentIds` | `Set<string>` | IDs of selected components |
| `components` | `ComponentItem[]` | All discovered components |
| `projectData` | `ProjectData \| null` | Loaded project metadata |

---

## Functions

### [Rendering](../../src/client/estimate.ts#L142-L215)

| Function | Signature | Line | Description |
|---|---|---|---|
| `renderProjectHeader` | `(project: ProjectData) => void` | L145 | Hides loading, shows header with repo-name-based title (1-3 joined with +, 4+ shows first 2 + "N more"), org as description |
| `renderProjectStats` | `(data: EstimateData, githubOrg: string) => void` | L158 | Renders compact repo rows (name with link icon · files · tokens · branch @ sha). Multi-repo adds hr + Total row. |
| `updatePrecisionLabel` | `(data: EstimateData) => void` | L183 | Shows precise vs approximate label, hides precise button if already precise |
| `renderEstimateCards` | `(data: EstimateData) => void` | L194 | Sets price text in each level card |
| `updateAnalysisCostHint` | `(data: EstimateData) => void` | L203 | Uses server-provided `analysisCostHint` (empirical or fallback $0.25/100k tokens) |

### [Component Loading](../../src/client/estimate.ts#L216-L303)

| Function | Signature | Line | Description |
|---|---|---|---|
| `loadExistingComponents` | `() => Promise<void>` | L219 | Fetches existing components; if found, skips to step 2 |
| `showStep2` | `(comps: ComponentItem[]) => void` | L234 | Hides analyze section, renders component table, enables level cards, triggers scoped estimate |
| `enableCards` | `() => void` | L246 | Removes `disabled` class from `.estimate-card` elements, hides hint. Pre-selects "thorough" level if none selected, showing step 3. |
| `renderComponentTable` | `(comps: ComponentItem[]) => void` | L269 | Renders component rows with checkboxes into `#component-table-body`. Attaches change listeners. Replaces `#select-all-components` to avoid listener accumulation. |

### [Component Selection](../../src/client/estimate.ts#L305-L341)

| Function | Signature | Line | Description |
|---|---|---|---|
| `onComponentSelectionChange` | `() => Promise<void>` | L306 | Rebuilds `selectedComponentIds` from checkboxes, calls `updateScopedEstimate`, `updateStartButton` |
| `updateScopedEstimate` | `() => Promise<void>` | L317 | Posts to `/api/estimate/components` with selected component IDs. Updates level card prices. Shows selection summary label. |

### [Start Button](../../src/client/estimate.ts#L510-L541)

| Function | Signature | Line | Description |
|---|---|---|---|
| `updateStartButton` | `() => void` | L511 | Validates: has components and valid API key. Sets button text with cost estimate. Shows/hides key format error. |

### [Analyze Button](../../src/client/estimate.ts#L385-L390)

| Function | Signature | Line | Description |
|---|---|---|---|
| `updateAnalyzeButton` | `() => void` | L386 | Enables/disables analyze button based on API key format |

### [API Key Validation](../../src/client/estimate.ts#L358-L360)

| Function | Signature | Description |
|---|---|---|
| `isValidApiKeyFormat` | `(key: string) => boolean` | Returns `key.startsWith('sk-ant-')` |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `.estimate-card` (each) | click, keydown (Enter/Space) | L455-L483 | Selects level card, shows step 3, updates start button. Cards have `role="button"`, `tabindex="0"`, `aria-pressed`. |
| `#api-key` (input) | input | L363-L379 | Updates start/analyze buttons. Shows/removes format hint if key doesn't start with `sk-ant-`. |
| `#analyze-components-btn` | click | L392-L451 | Posts to analyze endpoint, polls status every 2s (max 150 retries / ~5 min). On completion, loads components and shows step 2. |
| `#precise-btn` | click | L488-L506 | Posts to precise estimate endpoint, updates cards and labels |
| `#start-audit-btn` | click | L544-L568 | Builds audit body (level, apiKey, optional baseAuditId, optional componentIds), posts to `/api/audit/start`, redirects to `/audit.html?auditId=` |
| `#incremental-btn` | click | L585-L592 | Sets `useIncremental = true`, toggles button styles |
| `#fresh-btn` | click | L594-L601 | Sets `useIncremental = false`, toggles button styles |
| `#reanalyze-btn` | click | L346-L351 | Shows analyze section, hides reanalyze section |
| `#change-branches-btn` | click | L611-L657 | Loads branches for all repos in parallel, renders branch editor dropdowns |
| `#cancel-branches-btn` | click | L659-L662 | Hides branch editor, re-enables change button |
| `#apply-branches-btn` | click | L664-L705 | Collects branch selections, PUTs to update, re-fetches project+estimate |
| `#select-all-components` (checkbox) | change | L291-L302 | Toggles all `.component-checkbox` elements |
| `.component-checkbox` (each) | change | L286-L288 | Calls `onComponentSelectionChange` |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/projects/{projectId}` | init | L84 |
| POST | `/api/estimate` | init | L85 |
| GET | `/api/projects/{projectId}/components` | loadExistingComponents, poll completion | L221, L428 |
| POST | `/api/projects/{projectId}/analyze-components` | analyzeBtn click | L401-L403 |
| GET | `/api/projects/{projectId}/component-analysis/{analysisId}` | poll | L420-L421 |
| POST | `/api/estimate/components` | updateScopedEstimate | L328 |
| POST | `/api/estimate/precise` | preciseBtn click | L493 |
| POST | `/api/audit/start` | startBtn click | L561 |
| PUT | `/api/projects/{projectId}/branches` | applyBranchesBtn click | L682 |
| GET | `/api/github/repos/{org}/{repo}/branches` | changeBranchesBtn click | L623-L624 |

---

## DOM Element IDs

| ID | Purpose |
|---|---|
| `header-loading` | Loading placeholder |
| `header-content` | Project header content |
| `project-name` | Project name text |
| `project-description` | Project description text |
| `repo-breakdown` | Compact repo rows container (files, tokens, branch @ sha per repo) |
| `estimate-precision` | Precision label |
| `precise-btn` | Get precise estimate button |
| `clone-errors` | Clone error list |
| `previous-audit-notice` | Previous audit info |
| `ownership-badge` | Ownership badge |
| `access-tier-preview` | Access tier explanation (covers owner, unverified, and non-owner states) |
| `price-full` | Full level price |
| `price-thorough` | Thorough level price |
| `price-opportunistic` | Opportunistic level price |
| `analyze-section` | Component analysis section |
| `reanalyze-section` | Re-analyze trigger |
| `reanalyze-btn` | Re-analyze button |
| `step-2` | Component selection step |
| `step-3` | Start audit step |
| `component-table-body` | Component table body |
| `select-all-components` | Select all components checkbox |
| `component-not-analyzed` | "Not yet analyzed" notice |
| `component-analyzing` | "Analyzing..." notice |
| `analysis-progress` | Analysis progress text |
| `analysis-cost-hint` | Analysis cost hint |
| `scoped-estimate-label` | Scoped estimate summary |
| `cards-hint` | "Analyze components first" hint |
| `api-key` | API key input |
| `api-key-error` | Key format error |
| `api-key-hint` | Key format hint (dynamically created) |
| `start-audit-btn` | Start audit button |
| `incremental-btn` | Incremental mode button |
| `fresh-btn` | Fresh mode button |
| `mode-help` | Mode help text (dynamically created if missing) |
| `change-branches-btn` | Open branch editor |
| `branch-editor` | Branch editor panel |
| `branch-editor-repos` | Branch editor rows container |
| `apply-branches-btn` | Apply branch changes |
| `cancel-branches-btn` | Cancel branch editing |

---

## State Management

- Closure-scoped variables inside `DOMContentLoaded`.
- `selectedComponentIds` Set drives component scoping.
- `selectedLevel` drives audit level.
- `estimateData` is refreshed on scoped re-estimation and branch changes.
- Component analysis uses polling (2s interval, max 150 retries).

---

## [GAP] No Component Analysis Cancellation

Once component analysis starts, there is no way to cancel it from the UI.

## [GAP] No Validation of Component Selection Minimum

The start button disables when no components are selected, but there is no minimum component count guidance.

## [GAP] Branch Editor Loading State

The `changeBranchesBtn` is disabled during branch loading but not re-enabled on error (only on cancel or successful apply).

## [REC] Add a cancel button or link for in-progress component analysis. Consider re-enabling `changeBranchesBtn` in the error path at L653-L656.
