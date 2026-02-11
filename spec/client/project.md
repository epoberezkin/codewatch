# project.ts -- Project Page Module

**Source**: [`project.ts`](../../src/client/project.ts) (L1-L322)
**HTML**: `public/project.html`

---

## Overview

Displays a project dashboard with:
- Project info (name, org, license, stats, ownership badge)
- Repository cards (with external GitHub links)
- Components table
- Dependencies (grouped by ecosystem, with "Add as Project")
- Audit timeline (chronological, with severity badges)
- Current security posture (from latest completed audit)
- Delete project (creator only)

---

## Interface (L6-L67)

```ts
interface ProjectDetail {
  id, name, description, githubOrg, category, license,
  involvedParties, threatModel, threatModelSource,
  totalFiles, totalTokens, createdBy, creatorUsername,
  ownership: { isOwner, role, needsReauth } | null;
  repos: Array<{ id, repoName, repoUrl, language, stars, description, license }>;
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

### renderProject (L92-L187)

| Function | Signature | Description |
|---|---|---|
| `renderProject` | `(project: ProjectDetail) => void` | Renders project header, ownership badge (with returnTo re-auth link), new audit button, meta info, classification/threat model, and repo cards. |

**Classification rendering** (L125-L170):
- Shows category badge
- Threat model: renders involved parties table (party/can/cannot) with source badge, or plain text threat model (truncated to 2000 chars)

**Repo cards** (L173-L186):
- Each repo as a card with name (linked to GitHub with `target="_blank" rel="noopener"`), language, license, stars, description

### renderComponents (L189-L209)

| Function | Signature | Description |
|---|---|---|
| `renderComponents` | `(components: ProjectDetail['components']) => void` | Renders component table with name, description, repo, role, files, tokens, security summary. Hidden if no components. |

### renderDependencies (L211-L243)

| Function | Signature | Description |
|---|---|---|
| `renderDependencies` | `(dependencies: ProjectDetail['dependencies']) => void` | Groups dependencies by ecosystem. Renders linked projects as "View Project" links, unlinked as "Add as Project" buttons (authenticated) or "source" links. Uses `attachAddAsProjectHandlers('.add-as-project-btn')`. |

### renderAudits (L245-L301)

| Function | Signature | Description |
|---|---|---|
| `renderAudits` | `(audits: ProjectDetail['audits']) => void` | Renders audit timeline. Each entry shows date, level, incremental/public badges, status badge, severity counts, and "View" link. First item gets `latest` CSS class. |

**View link logic** (L263-L267):
- `completed` -> `/report.html?auditId=`
- `failed` -> `#`
- Other (in-progress) -> `/audit.html?auditId=`

**Current security posture** (L290-L300):
- Derived from latest `completed` audit
- Shows audit level, date, severity count badges

### renderDeleteButton (L303-L321)

| Function | Signature | Description |
|---|---|---|
| `renderDeleteButton` | `(project: ProjectDetail) => void` | Shows `#delete-section` only if `currentUser.id === project.createdBy`. Attaches confirm-delete handler. Redirects to `/projects.html` on success. |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#delete-project-btn` | click | L310-L319 | Confirms deletion, DELETEs project, redirects to projects page |
| `.add-as-project-btn` (each) | click | L242 | Via `attachAddAsProjectHandlers` from common.ts |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/projects/{projectId}` | init | L80 |
| DELETE | `/api/projects/{projectId}` | deleteBtn click | L314 |
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
| `project-meta` | Org, license, repo count, files, tokens |
| `classification-section` | Classification section |
| `project-category` | Category badge text |
| `threat-model-summary` | Threat model content |
| `repos-list` | Repo cards container |
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

L104: Manually constructs a re-auth link with `returnTo` query parameter: `/auth/github?returnTo=...`. This duplicates logic that could be in `renderOwnershipBadge` (common.ts only renders a generic `/auth/github` link).

## [GAP] No Refresh Mechanism

After adding a dependency as a project (via `attachAddAsProjectHandlers`), the dependency list is not refreshed -- the button is replaced inline, but the overall dependency data is stale.

## [GAP] Failed Audit Links to `#`

L265-L266: Failed audits link to `#`, providing no way to view failure details.

## [REC] Unify re-auth URL logic in `renderOwnershipBadge`. Consider linking failed audits to the audit progress page so users can see the error message.
