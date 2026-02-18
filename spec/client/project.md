# project.ts -- Project Page Module

**Source**: [`project.ts`](../../src/client/project.ts#L1-L304)
**HTML**: `public/project.html`

---

## Overview

Displays a project dashboard with:
- Project info (name, org, license, stats, ownership badge)
- Compact repository rows (with external link icons)
- Components table
- Dependencies (grouped by ecosystem, with "Add as Project")
- Audit timeline (chronological, with severity badges)
- Current security posture (from latest completed audit)
- Delete project (creator only)

---

## [Interface](../../src/client/project.ts#L7-L74)

```ts
interface ProjectDetail {
  id, name, description, githubOrg, category, license,
  involvedParties, threatModel, threatModelParties, threatModelFileLinks, threatModelSource,
  totalFiles, totalTokens, createdBy, creatorUsername,
  ownership: { isOwner, role, needsReauth } | null;
  repos: Array<{ id, repoName, repoUrl, language, stars, description, license, totalFiles, totalTokens, defaultBranch, branch }>;
  components: Array<{
    id, name, description, role, repoName,
    filePatterns, languages, securityProfile, estimatedFiles, estimatedTokens
  }>;
  dependencies: Array<{ id, name, version, ecosystem, sourceRepoUrl, linkedProjectId, repoName }>;
  audits: Array<{
    id, auditLevel, isIncremental, status, maxSeverity,
    createdAt, completedAt, isPublic, severityCounts
  }>;
  createdAt;
}
```

---

## Functions

### [renderProject](../../src/client/project.ts#L100-L165)

| Function | Signature | Description |
|---|---|---|
| `renderProject` | `(project: ProjectDetail) => void` | Renders project header (repo names as title, org as description), ownership badge, new audit button, Change Branches link, classification/threat model, and compact repo rows with external link icons. |

**Classification rendering** (L134-L141):
- Shows category badge
- Delegates to `renderThreatModel('threat-model-summary', project)` from `common.ts` for threat model display (source badge → evaluation text → file links → parties table)
- `involvedParties` (role metadata) is not rendered in the threat model section

**Compact repo rows** (L143-L164):
- Compact repo rows: each row shows repo name (with external link icon), files, tokens, branch. Multi-repo projects show an hr + Total row. Change Branches link navigates to estimate page.

### [renderComponents](../../src/client/project.ts#L168-L188)

| Function | Signature | Description |
|---|---|---|
| `renderComponents` | `(components: ProjectDetail['components']) => void` | Renders component table with name, description, repo, role, files, tokens, security summary. Hidden if no components. |

### [renderDependencies](../../src/client/project.ts#L190-L223)

| Function | Signature | Description |
|---|---|---|
| `renderDependencies` | `(dependencies: ProjectDetail['dependencies']) => void` | Groups dependencies by ecosystem. Renders linked projects as "View Project" links, unlinked as "Add as Project" buttons (authenticated) or "source" links. Uses `attachAddAsProjectHandlers('.add-as-project-btn')`. |

### [renderAudits](../../src/client/project.ts#L225-L282)

| Function | Signature | Description |
|---|---|---|
| `renderAudits` | `(audits: ProjectDetail['audits']) => void` | Renders audit timeline. Each entry shows date, level, incremental/public badges, status badge, severity counts, and "View" link. First item gets `latest` CSS class. |

**View link logic** (L244-L248):
- `completed` -> `/report.html?auditId=`
- `failed` -> `#`
- Other (in-progress) -> `/audit.html?auditId=`

**Current security posture** (L270-L281):
- Derived from latest `completed` audit
- Shows audit level, date, severity count badges

### [renderDeleteButton](../../src/client/project.ts#L284-L303)

| Function | Signature | Description |
|---|---|---|
| `renderDeleteButton` | `(project: ProjectDetail) => void` | Shows `#delete-section` only if `currentUser.id === project.createdBy`. Attaches confirm-delete handler. Redirects to `/projects.html` on success. |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#delete-project-btn` | click | L292-L302 | Confirms deletion, DELETEs project, redirects to projects page |
| `.add-as-project-btn` (each) | click | L222 | Via `attachAddAsProjectHandlers` from common.ts |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/projects/{projectId}` | init | L87 |
| DELETE | `/api/projects/{projectId}` | deleteBtn click | L296 |
| POST | `/api/projects` | attachAddAsProjectHandlers (common.ts) | -- |
| POST | `/api/dependencies/{depId}/link` | attachAddAsProjectHandlers (common.ts) | -- |

---

## DOM Element IDs

| ID | Purpose |
|---|---|
| `project-loading` | Loading placeholder |
| `project-content` | Main content container |
| `project-name` | Project name text |
| `project-description` | Project description text |
| `ownership-badge` | Ownership badge (with re-auth link if needed) |
| `new-audit-btn` | "New Audit" link to estimate page |
| `change-branches-btn` | Change Branches link to estimate page |
| `classification-section` | Classification section |
| `project-category` | Category badge text |
| `threat-model-summary` | Threat model content |
| `repos-list` | Compact repo rows container |
| `components-section` | Components section |
| `components-body` | Components table body |
| `dependencies-section` | Dependencies section |
| `dependencies-list` | Dependencies list container |
| `audit-timeline` | Audit timeline container |
| `no-audits` | "No audits yet" notice |
| `current-posture` | Current posture section |
| `posture-text` | Posture description text |
| `posture-severity` | Posture severity badges |
| `delete-section` | Delete project section |
| `delete-project-btn` | Delete project button |

---

## State Management

- No mutable state after initial render. Single API call loads all data; render functions are pure.
- Auth state from common.ts (`currentUser`) used for delete button visibility and "Add as Project" button display.

---

## [GAP] Ownership Badge Re-Auth URL

L117: Manually constructs a re-auth link (project.ts) with `returnTo` query parameter: `/auth/github?returnTo=...`. This duplicates logic that could be in `renderOwnershipBadge` (common.ts only renders a generic `/auth/github` link).

## [GAP] No Refresh Mechanism

After adding a dependency as a project (via `attachAddAsProjectHandlers`), the dependency list is not refreshed -- the button is replaced inline, but the overall dependency data is stale.

## [GAP] Failed Audit Links to `#`

L246-L247: Failed audits link to `#`, providing no way to view failure details.

## [REC] Unify re-auth URL logic in `renderOwnershipBadge`. Consider linking failed audits to the audit progress page so users can see the error message.
