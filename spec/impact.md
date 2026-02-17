# Change Impact Graph

> Maps every source file to the user-visible behaviors it affects.
> Derived from [architecture.md](architecture.md) (dependency graph), [product/README.md](../product/README.md) (capability map), and source-level import analysis.
> Verified against commit `51a1dc8`.

Product concepts referenced below are drawn from the [Capability Map](../product/README.md#capability-map):

| ID | Product Concept |
|----|----------------|
| PC1 | Project Creation |
| PC2 | Project Browsing |
| PC3 | Project Dashboard |
| PC4 | Project Deletion |
| PC5 | Cost Estimation |
| PC6 | Component Analysis |
| PC7 | Audit Levels (full/thorough/opportunistic) |
| PC8 | Incremental Audits |
| PC9 | Real-Time Progress |
| PC10 | Three-Tier Access (owner/requester/public) |
| PC11 | Findings Management |
| PC12 | Report Sections (executive summary, threat model, etc.) |
| PC13 | Comments |
| PC14 | Owner Notification / Responsible Disclosure |
| PC15 | Time-Gated & Manual Publication |
| PC16 | GitHub OAuth |
| PC17 | Ownership Verification |
| PC18 | Pre-Launch Gate |
| PC19 | Dependency Detection & Project Linking |

---

## Section 1: Server Source Impact

| Source File | Product Concepts Affected | Risk Level | Notes |
|-------------|--------------------------|------------|-------|
| `index.ts` | ALL (startup) | **High** | Entry point -- if it fails, entire server is down; initialises DB pool and runs migrations |
| `app.ts` | ALL (routing) | **High** | Assembles middleware and mounts all route modules; misconfiguration breaks every endpoint |
| `config.ts` | ALL (startup) | **Low** | Static env-var reader -- changes only affect deployment; no runtime logic |
| `db.ts` | ALL (data access) | **High** | Singleton `pg.Pool` + `runMigrations()`; pool failure = total outage; migration bugs corrupt schema |
| `migrate.ts` | ALL (schema) | **Medium** | Standalone migration runner; only used at deploy time, but errors block startup |
| `middleware/gate.ts` | PC18 Pre-Launch Gate | **Medium** | Password gate protecting all routes (bypasses health check, gate page, static asset extensions); bug could lock out all users or expose pre-launch site |
| `routes/api.ts` | PC1-PC15, PC17, PC19 | **High** | ALL `/api/*` endpoints; largest file, highest blast radius; every product feature except OAuth and gate passes through here |
| `routes/auth.ts` | PC16 GitHub OAuth, PC17 Ownership Verification | **High** | OAuth flow + `requireAuth` middleware; breakage locks out all authenticated features |
| `services/audit.ts` | PC7 Audit Levels, PC8 Incremental Audits, PC9 Real-Time Progress, PC11 Findings Management, PC12 Report Sections | **High** | Core audit engine -- orchestrates classification, batching, analysis, synthesis; changes affect all audit outputs |
| `services/componentAnalysis.ts` | PC6 Component Analysis, PC19 Dependency Detection | **High** | Agentic AI exploration with tool-use loop; drives component/dependency data shown on project dashboard and estimates |
| `services/github.ts` | PC1 Project Creation, PC2 Project Browsing, PC14 Owner Notification, PC16 GitHub OAuth, PC17 Ownership Verification | **High** | All GitHub API interactions (REST + GraphQL); breakage affects project creation, auth, ownership checks, and disclosure issues |
| `services/planning.ts` | PC7 Audit Levels, PC8 Incremental Audits | **Medium** | AI-driven planning phase that selects files/batches; incorrect plans degrade audit coverage but don't crash the system |
| `services/tokens.ts` | PC5 Cost Estimation, PC7 Audit Levels | **Low** | Token counting and cost math; display-only -- affects cost numbers shown to user, not audit execution |
| `services/claude.ts` | PC6 Component Analysis, PC7 Audit Levels, PC8 Incremental Audits, PC12 Report Sections | **High** | Anthropic API wrapper with retry logic; used by audit, planning, and component analysis; failure = all AI features broken |
| `services/ownership.ts` | PC10 Three-Tier Access, PC17 Ownership Verification | **High** | Security boundary -- incorrect ownership resolution = wrong access tier; affects report visibility, finding redaction, publish controls |
| `services/git.ts` | PC1 Project Creation, PC5 Cost Estimation, PC6 Component Analysis, PC7 Audit Levels, PC8 Incremental Audits | **High** | Clone, scan, diff, read operations on local filesystem; used by audit, component analysis, and estimation; failure blocks all repo-dependent features |
| `services/prompts.ts` | PC6 Component Analysis, PC7 Audit Levels, PC12 Report Sections | **Low** | Template loader with variable substitution; simple I/O -- only breaks if prompt files are missing or template syntax changes |

## Section 2: Client Source Impact

| Source File | Product Views Affected | Risk Level | Notes |
|-------------|----------------------|------------|-------|
| `common.ts` | ALL views | **High** | Shared utilities: `apiFetch()`, auth status, DOM helpers, theme toggle, formatting; breakage cascades to every page |
| `home.ts` | Home / Project Creation (`index.html`) | **Medium** | Three-step wizard: URL input, entity info, repo/branch selection, project creation; affects PC1, PC17 |
| `estimate.ts` | Estimate page (`estimate.html`) | **Medium** | Cost estimation display, component analysis trigger, audit level selection, audit start; affects PC5, PC6, PC7 |
| `audit.ts` | Audit Progress page (`audit.html`) | **Low** | Polling-based progress display; read-only view of audit status; affects PC9 |
| `report.ts` | Report page (`report.html`) | **High** | Three-tier rendering, finding filters, status changes, publish/unpublish, comments, disclosure; affects PC10, PC11, PC12, PC13, PC14, PC15 |
| `project.ts` | Project Dashboard (`project.html`) | **Medium** | Project metadata, repos, components, dependencies, audit history, deletion; affects PC3, PC4, PC19 |
| `projects.ts` | Projects Browser (`projects.html`) | **Low** | Search, filter, pagination of project list; read-only browse view; affects PC2 |

## Section 3: Non-Source Impact

| File Type | Files | Affects | Risk |
|-----------|-------|---------|------|
| SQL migrations | `sql/001_initial.sql`, `sql/002_ownership_and_components.sql`, `sql/003_branch_selection.sql`, `sql/004_schema_fixes.sql`, `sql/005_threat_model_files.sql` | Database schema -- ALL features depend on correct table structure, constraints, and indexes | **High** |
| Prompt templates | `prompts/system.md`, `prompts/classify.md`, `prompts/full.md`, `prompts/thorough.md`, `prompts/opportunistic.md`, `prompts/synthesize.md`, `prompts/planning.md`, `prompts/component_analysis.md` | Audit quality, classification accuracy, planning quality, component analysis depth -- prompts are the "instructions" to Claude | **Medium** |
| CSS | `public/css/style.css` | All views -- visual rendering, layout, theming | **Low** |
| HTML | `public/index.html` | Home view -- structure/layout | **Low** |
| HTML | `public/gate.html` | Gate view -- structure/layout | **Low** |
| HTML | `public/estimate.html` | Estimate view -- structure/layout | **Low** |
| HTML | `public/audit.html` | Audit progress view -- structure/layout | **Low** |
| HTML | `public/report.html` | Report view -- structure/layout | **Low** |
| HTML | `public/project.html` | Project dashboard view -- structure/layout | **Low** |
| HTML | `public/projects.html` | Projects browser view -- structure/layout | **Low** |
