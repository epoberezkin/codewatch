# projects.ts -- Projects Browser Module

**Source**: [`projects.ts`](../../src/client/projects.ts) (L1-L169)
**HTML**: `public/projects.html`

---

## Overview

Browse and filter all projects (public view) or user-owned projects ("My Projects" toggle). Features debounced search, category/severity dropdowns, and card-based project listing.

---

## Interfaces (L6-L30)

```ts
interface BrowseProject {
  id, name, githubOrg, category, license,
  publicAuditCount, latestSeverity?, latestAuditDate,
  createdAt, auditCount?,
  ownership?: { isOwner, role, needsReauth };
}

interface BrowseResponse {
  projects: BrowseProject[];
  filters: { categories: string[]; severities: string[] };
}
```

---

## State Variables (L34-L52)

| Variable | Type | Description |
|---|---|---|
| `filtersPopulated` | `boolean` | Whether filter dropdowns have been populated from first API response |
| `debounceTimer` | `ReturnType<typeof setTimeout> \| null` | Debounce timer for search input |

---

## Functions

### loadProjects (L69-L113)

| Function | Signature | Description |
|---|---|---|
| `loadProjects` | `() => Promise<void>` | Builds query params from filter state, fetches browse API, populates filters on first load, renders cards or empty state. Shows loading spinner during fetch. |

**Query parameters built**:
- `search` -- from search input
- `category` -- from category dropdown (omitted if `'all'`)
- `severity` -- from severity dropdown (omitted if `'all'`)
- `mine` -- `'true'` if My Projects checkbox checked

### populateFilters (L116-L139)

| Function | Signature | Description |
|---|---|---|
| `populateFilters` | `(filters: { categories: string[]; severities: string[] }) => void` | Populates `#category-filter` and `#severity-filter` dropdowns from API response. Preserves current selection. Only called once (`filtersPopulated` guard). |

### renderProjectCard (L141-L166)

| Function | Signature | Description |
|---|---|---|
| `renderProjectCard` | `(p: BrowseProject, isMineMode: boolean) => string` | Returns HTML for a project card. Links to `/project.html?projectId=`. Shows ownership badge, severity badge, category, license, audit count (public or total depending on mode), latest audit date. |

---

## Event Handlers

| Element | Event | Line | Description |
|---|---|---|---|
| `#search-input` | input | L54-L57 | Debounced `loadProjects()` with 300ms delay |
| `#category-filter` | change | L58 | Immediate `loadProjects()` |
| `#severity-filter` | change | L59 | Immediate `loadProjects()` |
| `#mine-filter` (checkbox) | change | L62-L67 | Toggles `filter-active` class on label, calls `loadProjects()` |

---

## API Calls

| Method | Endpoint | Called from | Line |
|---|---|---|---|
| GET | `/api/projects/browse?{params}` | loadProjects | L89 |

---

## DOM Element IDs

| ID | Purpose |
|---|---|
| `search-input` | Text search input |
| `category-filter` | Category dropdown |
| `severity-filter` | Severity dropdown |
| `mine-filter` | "My Projects" checkbox |
| `mine-filter-label` | Label for mine checkbox (shown after auth) |
| `projects-list` | Project cards container |
| `empty-state` | Empty state container |
| `empty-message` | Empty state message text |

---

## State Management

- Filter state lives in DOM elements (input values, checkbox state).
- `filtersPopulated` boolean prevents re-populating dropdowns on subsequent loads.
- `debounceTimer` prevents excessive API calls during typing.
- No client-side caching of project data; every filter change triggers a fresh API call.
- Auth-dependent UI: "My Projects" checkbox shown only after `waitForAuth()` resolves with a logged-in user.

---

## Empty State Messages

| Condition | Message |
|---|---|
| "My Projects" active, no results | "You have no projects yet. Add a project from the home page." |
| General filter, no results | "No projects match your filters." |

---

## [GAP] No Pagination

All matching projects are returned in a single response. For large datasets, this could be slow.

## [GAP] No URL State Sync

Filter state is not reflected in the URL (no query parameter sync). Refreshing the page or sharing a link loses filter state.

## [GAP] Search Debounce but No Loading Indicator During Debounce

The 300ms debounce suppresses the search, but the loading spinner only appears once the API call starts (after debounce fires), not during the typing pause.

## [REC] Add pagination or infinite scroll. Sync filter state to URL query parameters for shareable/bookmarkable filtered views.
