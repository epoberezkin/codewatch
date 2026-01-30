# CodeWatch MVP - Implementation Plan

## Overview
Security audit website for open-source **projects** (one or more git repos) using Claude Opus 4.5 with BYOK (Bring Your Own Key). Users define a project by selecting repos from a GitHub org, the system classifies the software, constructs/validates a threat model, and runs a comprehensive security audit. Supports fresh and incremental audits with per-finding tracking and responsible disclosure controls.

### Key Concepts
- **Project** = logical software product (e.g., "SimpleX Chat"). Groups one or more repositories.
- **Repository** = a git repo belonging to a project. Cloned once, reused across audits.
- **Audit** = point-in-time security analysis of a project at specific commit(s). Can be fresh or incremental.
- **Classification** = software category + involved parties + threat model. Determined by Claude as audit step 1.

---

## Architecture

```
codewatch/
├── package.json
├── tsconfig.json                    # Base TS config
├── tsconfig.server.json             # Server: CommonJS, Node target
├── tsconfig.client.json             # Client: ES modules, DOM target, outDir → public/js/
├── src/
│   ├── server/
│   │   ├── index.ts                 # Express app, static serving, route mounting
│   │   ├── config.ts                # Env vars (DATABASE_URL, GITHUB_*, ANTHROPIC_SERVICE_KEY, REPOS_DIR)
│   │   ├── db.ts                    # pg Pool, migration runner
│   │   ├── migrate.ts               # CLI migration entry point
│   │   ├── routes/
│   │   │   ├── api.ts               # /api/projects, /api/estimate, /api/audit/*, /api/reports/*
│   │   │   └── auth.ts              # /auth/github, /auth/github/callback, /auth/me, /auth/logout
│   │   └── services/
│   │       ├── git.ts               # Clone/update repos, list code files, diff between commits
│   │       ├── tokens.ts            # Count tokens per file, estimate costs using pricing config
│   │       ├── audit.ts             # Orchestrate: classify → threat model → batch → analyze → synthesize
│   │       ├── claude.ts            # Claude API wrapper (takes key as param, never stores)
│   │       └── github.ts            # Org repo listing, ownership verification, issue creation
│   └── client/
│       ├── common.ts                # Theme toggle, fetch helpers, DOM utils
│       ├── home.ts                  # Landing: repo URL input, org repo selector, auth
│       ├── estimate.ts              # Cost estimates, level selection, API key input
│       ├── audit.ts                 # Progress polling, per-file status display
│       ├── report.ts               # Report view, findings, comments, publish controls
│       └── project.ts              # Project dashboard, audit history timeline
├── public/
│   ├── index.html                   # Landing page
│   ├── estimate.html                # Cost estimation
│   ├── audit.html                   # Audit progress
│   ├── report.html                  # Report viewer
│   ├── project.html                 # Project dashboard + audit history
│   ├── css/
│   │   └── style.css                # All styles, CSS custom properties for dark/light
│   └── js/                          # tsc output from src/client/
├── sql/
│   └── 001_initial.sql              # Database schema
├── prompts/
│   ├── system.md                    # Shared system prompt
│   ├── classify.md                  # Step 1: classify software, identify parties, find/generate threat model
│   ├── full.md                      # Full analysis instructions
│   ├── thorough.md                  # Thorough analysis instructions
│   └── opportunistic.md             # Opportunistic analysis instructions
└── test/
    ├── setup.ts                     # DB creation, migration, Express boot, teardown
    ├── helpers.ts                   # HTTP client wrapper, session factory, mock helpers
    ├── api/
    │   ├── projects.test.ts         # Project creation, org repo listing
    │   ├── estimate.test.ts         # Cost estimation (rough + precise)
    │   ├── audit.test.ts            # Audit start, progress polling, report
    │   └── auth.test.ts             # OAuth flow (mocked GitHub), session, /auth/me
    ├── services/
    │   └── git.test.ts              # Clone, scan, diff against fixture repos
    ├── mocks/
    │   └── github.ts                # GitHub API mock (org repos, user info, ownership)
    └── fixtures/
        └── sample-project/          # Tiny multi-file project (JS + Python + config)
            ├── src/
            │   ├── index.js         # Simple Express app with intentional vulns
            │   ├── auth.js          # Auth module
            │   └── utils.py         # Python utility
            ├── config.json          # Sample config
            ├── package.json
            └── README.md
```

---

## Database Schema (PostgreSQL)

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Users & Sessions
-- ============================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id INTEGER NOT NULL UNIQUE,       -- GitHub numeric ID (stable, survives renames)
    github_username TEXT NOT NULL,            -- display name (can change)
    github_type TEXT NOT NULL DEFAULT 'User', -- 'User' or 'Organization'
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    github_token TEXT NOT NULL,              -- encrypted at rest, used for GitHub API calls
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days'
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ============================================================
-- Projects (logical software products, can span multiple repos)
-- ============================================================

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                      -- e.g. "SimpleX Chat"
    github_org TEXT NOT NULL,                -- e.g. "simplex-chat"
    created_by UUID REFERENCES users(id),
    -- classification (populated by Claude as audit step 1)
    category TEXT CHECK (category IN (
        'library', 'cli_tool', 'build_dependency', 'gui_client',
        'client_server', 'decentralized_serverless', 'decentralized_client_server'
    )),
    description TEXT,                        -- Claude-generated project description
    involved_parties JSONB,                  -- {vendor, operators[], end_users[], networks[]}
    threat_model TEXT,                       -- found or Claude-generated threat model (party→can/cannot)
    threat_model_source TEXT CHECK (threat_model_source IN ('repo', 'generated', 'none')),
    classification_audit_id UUID,            -- audit that produced this classification
    -- aggregate stats (refreshed on estimation)
    total_files INTEGER,
    total_tokens INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_org ON projects(github_org);
CREATE INDEX idx_projects_creator ON projects(created_by);
-- uniqueness: same user can't create two projects with identical repo sets
-- (enforced in application logic, not DB constraint, since repo sets are in a join table)

-- ============================================================
-- Repositories (git repos belonging to projects)
-- ============================================================

CREATE TABLE repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_url TEXT NOT NULL UNIQUE,           -- https://github.com/owner/repo
    github_org TEXT NOT NULL,                -- e.g. "simplex-chat"
    repo_name TEXT NOT NULL,                 -- e.g. "simplexmq"
    default_branch TEXT NOT NULL DEFAULT 'main',
    repo_path TEXT NOT NULL,                 -- local: repos/github.com/owner/repo
    -- file stats
    total_files INTEGER,
    total_tokens INTEGER,
    -- GitHub metadata
    github_id INTEGER,
    description TEXT,
    language TEXT,
    stars INTEGER DEFAULT 0,
    forks INTEGER DEFAULT 0,
    license TEXT,
    metadata_updated_at TIMESTAMPTZ,
    last_cloned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_repos_org ON repositories(github_org);

-- ============================================================
-- Project ↔ Repository (many-to-many: repos shared across projects)
-- ============================================================

CREATE TABLE project_repos (
    project_id UUID NOT NULL REFERENCES projects(id),
    repo_id UUID NOT NULL REFERENCES repositories(id),
    PRIMARY KEY (project_id, repo_id)
);

-- ============================================================
-- Audits (each is a point-in-time analysis of a project across all its repos)
-- ============================================================

CREATE TABLE audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    requester_id UUID REFERENCES users(id),
    -- what was analyzed
    audit_level TEXT NOT NULL CHECK (audit_level IN ('full', 'thorough', 'opportunistic')),
    -- incremental audit support
    base_audit_id UUID REFERENCES audits(id),-- previous audit this builds on (NULL = fresh)
    is_incremental BOOLEAN NOT NULL DEFAULT FALSE,
    diff_files_added INTEGER DEFAULT 0,
    diff_files_modified INTEGER DEFAULT 0,
    diff_files_deleted INTEGER DEFAULT 0,
    -- execution
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'cloning', 'classifying', 'estimating', 'analyzing', 'synthesizing', 'completed', 'failed')),
    is_owner BOOLEAN NOT NULL DEFAULT FALSE,
    -- estimation
    total_files INTEGER,
    total_tokens INTEGER,
    files_to_analyze INTEGER,
    tokens_to_analyze INTEGER,
    estimated_cost_usd NUMERIC(10,4),
    actual_cost_usd NUMERIC(10,4),           -- tracked from actual API usage
    -- progress
    files_analyzed INTEGER DEFAULT 0,
    progress_detail JSONB DEFAULT '[]',      -- [{file, status, findings_count}]
    -- results (summary only; per-finding detail in audit_findings)
    report_summary JSONB,                    -- executive summary, security posture, disclosure info
    max_severity TEXT CHECK (max_severity IN ('none', 'informational', 'low', 'medium', 'high', 'critical')),
    -- privacy / disclosure
    is_public BOOLEAN DEFAULT FALSE,
    publishable_after TIMESTAMPTZ,           -- NULL = publishable now
    owner_notified BOOLEAN DEFAULT FALSE,
    -- metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

CREATE INDEX idx_audits_project ON audits(project_id);
CREATE INDEX idx_audits_requester ON audits(requester_id);
CREATE INDEX idx_audits_status ON audits(status);
CREATE INDEX idx_audits_base ON audits(base_audit_id);

-- ============================================================
-- Audit commits (which commit of each repo was analyzed in an audit)
-- ============================================================

CREATE TABLE audit_commits (
    audit_id UUID NOT NULL REFERENCES audits(id),
    repo_id UUID NOT NULL REFERENCES repositories(id),
    commit_sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    PRIMARY KEY (audit_id, repo_id)
);

-- ============================================================
-- Findings (individual vulnerabilities, tracked across audits)
-- ============================================================

CREATE TABLE audit_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES audits(id),
    repo_id UUID REFERENCES repositories(id),   -- which repo this finding is in
    -- finding identity (for tracking across incremental audits)
    file_path TEXT NOT NULL,                     -- relative to repo root
    line_start INTEGER,
    line_end INTEGER,
    fingerprint TEXT,                        -- hash of file_path + title + code context for dedup
    -- classification
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
    cwe_id TEXT,
    cvss_score NUMERIC(3,1),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    exploitation TEXT,
    recommendation TEXT,
    code_snippet TEXT,
    -- lifecycle
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'fixed', 'false_positive', 'accepted', 'wont_fix')),
    resolved_in_audit_id UUID REFERENCES audits(id),  -- audit where this was confirmed fixed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_findings_audit ON audit_findings(audit_id);
CREATE INDEX idx_findings_severity ON audit_findings(severity);
CREATE INDEX idx_findings_fingerprint ON audit_findings(fingerprint);
CREATE INDEX idx_findings_status ON audit_findings(status);

-- ============================================================
-- Owner comments on findings or reports (fix notes, context)
-- ============================================================

CREATE TABLE audit_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES audits(id),
    finding_id UUID REFERENCES audit_findings(id),   -- NULL = comment on whole report
    user_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comments_audit ON audit_comments(audit_id);
CREATE INDEX idx_comments_finding ON audit_comments(finding_id);

-- ============================================================
-- Project watches (schema-ready, implementation post-MVP)
-- ============================================================

CREATE TABLE project_watches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    user_id UUID NOT NULL REFERENCES users(id),
    watch_type TEXT NOT NULL CHECK (watch_type IN ('branch', 'releases', 'prs')),
    target_branch TEXT,                      -- for branch watching; NULL for releases/prs
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, user_id, watch_type, target_branch)
);

CREATE INDEX idx_watches_project ON project_watches(project_id);
CREATE INDEX idx_watches_user ON project_watches(user_id);

-- ============================================================
-- Model pricing (configurable, no free Anthropic API for this)
-- ============================================================

CREATE TABLE model_pricing (
    model_id TEXT PRIMARY KEY,               -- e.g. 'claude-opus-4-5-20251101'
    display_name TEXT NOT NULL,
    input_cost_per_mtok NUMERIC(10,4) NOT NULL,  -- USD per million input tokens
    output_cost_per_mtok NUMERIC(10,4) NOT NULL, -- USD per million output tokens
    context_window INTEGER NOT NULL,
    max_output INTEGER NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with current prices
INSERT INTO model_pricing VALUES
    ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 5.00, 25.00, 200000, 64000, NOW()),
    ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 3.00, 15.00, 200000, 64000, NOW()),
    ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 1.00, 5.00, 200000, 64000, NOW());
```

---

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/github` | Redirect to GitHub OAuth (zero scopes) |
| GET | `/auth/github/callback` | Handle OAuth callback, create/update user, create session, set cookie |
| GET | `/auth/me` | Return `{ id, username, avatarUrl, githubType }` or 401 |
| POST | `/auth/logout` | Clear session cookie |

### Projects
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects` | `{ githubOrg, repoNames[] }` → create project, clone/update all repos, return `{ projectId, repos[] }` |
| GET | `/api/projects/:id` | Get project details including repos, classification, audit history |
| GET | `/api/github/orgs/:org/repos` | List repos in a GitHub org (for repo selector UI) |

### Estimation
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/estimate` | `{ projectId }` → scan all project repos, fetch metadata, return rough estimates `{ totalFiles, totalTokens, repoBreakdown[], estimates: { full, thorough, opportunistic }, latestCommits, previousAudit?, isPrecise: false }` |
| POST | `/api/estimate/precise` | `{ projectId }` → uses `ANTHROPIC_SERVICE_KEY` to call free `count_tokens` API for accurate token counts. Returns same shape with `isPrecise: true`. |

### Audit
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/audit/start` | `{ projectId, level, apiKey, baseAuditId? }` → if baseAuditId provided, runs incremental (diff only). API key in-memory only. Returns `{ auditId }`. |
| GET | `/api/audit/:id` | Audit status + progress: `{ status, filesAnalyzed, filesToAnalyze, progressDetail, commitSha, isIncremental }` |
| GET | `/api/audit/:id/report` | Full report for owners. Redacted report for non-owners (see visibility rules below). |
| GET | `/api/project/:id/audits` | List all audits for a project (history), newest first. |
| POST | `/api/audit/:id/publish` | Make report public (enforces severity timing rules). Owner only. |

### Findings & Comments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audit/:id/findings` | List findings. Non-owners: full detail for low/info, counts-only for medium+. |
| POST | `/api/audit/:id/comments` | Add comment to report. Owner only. `{ content, findingId? }` |
| GET | `/api/audit/:id/comments` | List comments on report/findings. |

### Reports (public)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports` | List public reports (paginated) |

---

## Report Visibility Rules

### Non-owner view (before time-gate expires):
- **Executive summary**: always visible (sanitized - no specific vuln details)
- **Informational + Low findings**: full detail shown
- **Medium+ findings**: only severity counts per category (e.g. "3 High, 1 Critical")
- **Time-gates**: medium/high → full detail after 3 months; critical → after 6 months
- **Clear upfront warning**: before starting audit, non-owners are told they won't see full details for serious findings, and are effectively sponsoring the project's security

### Owner view:
- Full report always, all findings, all detail
- Can publish report at any time (overrides time-gates)
- Can add comments explaining fixes
- Can generate new audit (previous preserved in history)
- Can mark findings as false_positive / accepted / wont_fix

### Incremental audit building:
- If a public audit exists, any user can run an incremental audit building on it
- If no public audit exists, user must pay for a full audit
- Incremental audits inherit all non-resolved findings from base audit and only analyze the diff

---

## Frontend Pages

### `index.html` - Landing
- Hero: "CodeWatch - AI Security Audits for Open Source"
- Step 1: Enter a GitHub repo URL (e.g. `https://github.com/simplex-chat/simplex-chat`)
- System detects the org (`simplex-chat`), fetches org repos via GitHub API
- Step 2: Checkbox list of org repos — user selects which ones form the project
- GitHub auth prompt (required for all users)
- Step 3: "Create Project & Estimate Cost" → POST /api/projects → POST /api/estimate → redirect to estimate.html
- Footer: "Developed by SimpleX Chat using Claude Code"
- Theme toggle (sun/moon icon)

### `estimate.html` - Cost Estimation
- Project header: name, description, stars, language (from GitHub metadata)
- If previous audits exist: show audit history with option to "Run Incremental" vs "Run Fresh"
- Three cards for Full / Thorough / Opportunistic:
  - Files to analyze (for incremental: only changed files), tokens, estimated USD cost
  - Description of what each level covers
  - Rough estimate shown immediately (labeled "approximate, ±15%")
  - "Get precise estimate" button → calls server → server uses `ANTHROPIC_SERVICE_KEY` to call free `count_tokens` API → updates estimates in-place
- **Non-owner notice**: clear explanation that medium+ findings will be redacted; user is sponsoring project security
- API key input field (type=password)
- "Start Audit" button → POST /api/audit/start → redirect to audit.html

### `audit.html` - Audit Progress
- Audit ID from URL param
- Shows: commit SHA being analyzed, audit level, incremental vs fresh
- Polls GET /api/audit/:id every 3 seconds
- Progress bar: files analyzed / total files
- File list with status indicators (pending / analyzing / done / error)
- When completed → link to report

### `report.html` - Report View
- Audit header: project, commit SHA, date, level, incremental badge
- Executive summary + security posture
- **Owner view**: full findings table, sortable/filterable by severity
- **Non-owner view**: full detail for low/info, severity counts for medium+, explanation of time-gate
- Responsible disclosure info
- Owner controls: "Make Public" button, "New Audit" button
- Audit history sidebar: list of previous audits with links
- Finding-level comments (owner can annotate fixes)

### `project.html` - Project Dashboard (NEW)
- Project metadata: name, stars, language, owner type
- Audit history timeline: each audit with commit, date, max severity, level
- Current security posture (from latest audit)
- Watch controls (post-MVP, but page structure ready)

---

## Audit Engine Design

### Repo Management
- Each project gets a permanent directory under a configurable `REPOS_DIR` (e.g. `./repos/github.com/owner/repo/`)
- First time: `git clone --single-branch` (default branch only; keep enough history for diffs)
- Subsequent audits: `git fetch origin`
- Record HEAD commit SHA of each repo in `audit_commits` at audit start
- No cleanup logic for MVP - storage is cheap

### File Scanning
1. Clone/update repo in permanent directory via `simple-git`
2. Walk directory tree, filter by code extensions:
   - Code: `.ts .js .tsx .jsx .py .rs .go .java .c .cpp .h .hpp .cs .rb .php .swift .kt .scala .hs .ex .erl .sh .bash .zsh .pl .lua .r .m .mm .sol .vy`
   - Config: `.json .yaml .yml .toml .xml .ini .cfg .conf`
   - Infra: `Dockerfile .dockerignore docker-compose.yml .tf .hcl`
   - Web: `.html .css .scss .sass .less .svg`
3. Skip: `node_modules/`, `.git/`, `vendor/`, `dist/`, `build/`, binary files, files > 1MB
4. Rough token estimate per file: `Math.ceil(fileContent.length / 3.3)` (code averages ~3.0-3.5 chars/token; 3.3 is conservative)

### Incremental Audit: Diff Detection
When `base_audit_id` is provided:
1. For each repo: get base audit's commit from `audit_commits` table
2. For each repo: run `git diff --name-status <base_sha> <current_sha>` to get:
   - Added files (A) → analyze fully
   - Modified files (M) → analyze fully (with context of previous findings)
   - Deleted files (D) → mark previous findings in those files as resolved
   - Renamed files (R) → update file paths in inherited findings
3. Token count is based only on added + modified files (not entire repo)
4. Cost estimation reflects only the diff, not the whole codebase
5. All open findings from base audit are inherited; only diff is re-analyzed

### Cost Estimation (Two-Stage)

Pricing loaded from `model_pricing` DB table (not hardcoded). No free Anthropic pricing API exists.

**Stage 1: Rough estimate (immediate, no API key needed)**
Uses `chars / 3.3` heuristic. Code averages ~3.0-3.5 chars/token; 3.3 is conservative (slightly overestimates, safer for budgeting). Shown immediately on estimate page with "approximate" label.

**Stage 2: Precise estimate (on-demand, uses CodeWatch service key)**
Anthropic's `POST /v1/messages/count_tokens` endpoint is **free** (zero cost) but requires an API key. CodeWatch maintains its own service API key with $0 spend limit (can only call free endpoints). User clicks "Get precise estimate" button → server calls `count_tokens` for each batch of files → updates estimate in-place. Rate limit: 100+ RPM depending on tier.

Config: `ANTHROPIC_SERVICE_KEY` env var (separate from user's audit key). Only used for `count_tokens`. $0 spend limit prevents accidental completion calls.

```
pricing = SELECT input_cost_per_mtok, output_cost_per_mtok FROM model_pricing WHERE model_id = chosen_model

For fresh audit:
  code_tokens = total_tokens_across_all_repos × percentage (1.0 / 0.33 / 0.10)

For incremental audit:
  code_tokens = diff_tokens (added + modified files across all repos)

Common:
  classify_tokens ≈ 5000 (file listings + READMEs)  -- step 0, only for first audit
  system_prompt_tokens ≈ 3000 (includes classification context)
  num_batches = ceil(code_tokens / 150000)
  input_cost = (system_prompt_tokens × num_batches + code_tokens) × pricing.input / 1_000_000
  output_tokens_estimate = code_tokens × 0.05
  output_cost = output_tokens_estimate × pricing.output / 1_000_000
  synthesis_input = output_tokens_estimate + 3000
  synthesis_output = page_limit × 500
  synthesis_cost = (synthesis_input × pricing.input + synthesis_output × pricing.output) / 1_000_000
  total = classify_cost + input_cost + output_cost + synthesis_cost
```

### Smart Batching
1. Sort files by directory (keeps related code together)
2. For each level (applied to file set — full repo or diff):
   - **Full**: all files in set
   - **Thorough**: ~33% prioritizing security-critical paths (auth/, crypto/, api/, routes/, middleware/, handlers/, controllers/, models/, db/, config/) then fill quota
   - **Opportunistic**: Claude picks most critical ~10% from file listing
3. Cost estimation uses simple percentage of total tokens for fresh, or diff tokens for incremental
4. Group selected files into batches:
   - Each batch ≤ 150K tokens (leaving room for system prompt + output)
   - Files > 100K tokens: split into chunks with overlap
   - Keep same-directory files together when possible

### Execution Flow

#### Step 0: Classification (first audit of a project, or on request)
1. Set status = `classifying`
2. Send Claude the full file listing (all repos: paths, sizes, directory structure) + README files
3. Prompt: classify software category, describe the project, identify involved parties, find or generate threat model
4. Search repos for existing threat model files (SECURITY.md, threat-model.md, etc.)
5. If found: include in prompt, ask Claude to evaluate completeness and validity
6. If not found: ask Claude to generate one in party → can/cannot format
7. Store classification JSON + threat model in `projects` table
8. Classification output determines which audit prompt variant to use

#### Step 1: Fresh Audit
1. Record current HEAD of each repo in `audit_commits`, set status = `analyzing`
2. Include classification context (category, parties, threat model) in every batch prompt
3. Files namespaced by repo in batches: `simplexmq/src/...`, `simplex-chat/src/...`
4. For each batch: call Claude Opus 4.5, parse findings, insert into `audit_findings`, update progress
5. Set status = `synthesizing`
6. Synthesis call: produce executive summary, security posture, cross-component analysis, threat model validation
7. Store `report_summary`, compute `max_severity`, set status = `completed`
8. Set `publishable_after` based on severity rules
9. If requester is not owner → create GitHub issue notifying owner

#### Step 1 (alt): Incremental Audit
1. Fetch all repos, record current HEAD of each in `audit_commits`, set status = `analyzing`
2. For each repo: compute diff against base audit's commit (`git diff --name-status`)
3. Copy all open findings from base audit (inherited)
4. Mark findings in deleted files as `fixed`
5. Analyze only added/modified files (batched, with classification context)
6. For modified files: include base audit findings for context in prompt
7. Dedup new findings against inherited ones using `fingerprint`
8. Synthesis: merge inherited + new findings, cross-component re-evaluation
9. Complete as per fresh audit flow

### Error Handling
- If Claude API call fails (rate limit, invalid key): retry up to 3 times with backoff
- If persistent failure: set status = `failed`, store error message
- Partial results preserved: findings already inserted remain queryable

---

## Audit Prompts

### Classification Prompt (Step 0: `classify.md`)
```
You are analyzing an open-source software project to prepare for a security audit.

The project consists of the following repositories:
{repo_list with directory trees and README contents}

Respond with valid JSON:
{
  "category": one of "library" | "cli_tool" | "build_dependency" | "gui_client" | "client_server" | "decentralized_serverless" | "decentralized_client_server",
  "description": "1-3 sentence description of what this software does",
  "involved_parties": {
    "vendor": "organization/person who develops this",
    "operators": ["server operators", ...] or [] if N/A,
    "end_users": ["mobile app users", "API consumers", ...],
    "networks": ["relay network name", ...] or [] if N/A
  },
  "components": [
    {"repo": "repo_name", "role": "SMP relay server", "languages": ["Haskell"]},
    ...
  ],
  "threat_model_found": true/false,
  "threat_model_files": ["path/to/SECURITY.md", ...],
  "threat_model": {
    "evaluation": "if found: is it comprehensive? what's missing?",
    "generated": "if not found: generate threat model in party→can/cannot format",
    "parties": [
      {
        "name": "Passive network observer",
        "can": ["observe message sizes and timing", ...],
        "cannot": ["read message content", ...]
      },
      ...
    ]
  }
}
```

### Security Audit System Prompt (shared)
```
You are a world-class application security auditor performing a comprehensive code review.

Project context:
- Category: {category}
- Description: {description}
- Components: {components}
- Involved parties: {involved_parties}
- Threat model: {threat_model}

Your audit must consider:
1. The threat model: are the claimed protections actually enforced in code?
2. Cross-component attacks: can a malicious {party} exploit interactions between components?
3. Each party's capabilities: what can a compromised {operator/user/vendor} actually do?

For each vulnerability found, provide a JSON object with:
- severity: "critical" | "high" | "medium" | "low" | "informational"
- cwe_id: CWE identifier (e.g. "CWE-79")
- cvss_score: estimated CVSS 3.1 score (0.0-10.0)
- file: file path
- line_start: starting line number
- line_end: ending line number
- title: short description
- description: detailed explanation
- exploitation: how this could be exploited
- recommendation: specific fix recommendation
- code_snippet: relevant vulnerable code (max 10 lines)

Also identify:
- responsible_disclosure: any security contacts, SECURITY.md, bug bounty info found
- dependencies: list of external dependencies with known concern patterns
- security_posture: overall assessment paragraph

Return valid JSON with structure: { findings: [...], responsible_disclosure: {...}, dependencies: [...], security_posture: "..." }
```

### Full Mode Addition
```
Analyze EVERY line of the provided source code exhaustively. Check for:
- All OWASP Top 10 categories
- CWE Top 25 most dangerous weaknesses
- Memory safety issues (buffer overflows, use-after-free, etc.)
- All injection types (SQL, command, LDAP, XPath, template, etc.)
- Authentication and authorization flaws
- Cryptographic misuse (weak algorithms, improper key management, insufficient entropy)
- Race conditions and TOCTOU
- Deserialization vulnerabilities
- Server-Side Request Forgery (SSRF)
- Path traversal and file inclusion
- Information disclosure and error handling
- Business logic flaws
- Supply chain concerns in dependency usage
Do not skip any file or function. Every code path must be evaluated.
```

### Thorough Mode Addition
```
Focus your analysis on security-critical code paths, analyzing approximately one-third of the codebase. Prioritize:
- Entry points (API routes, request handlers, CLI parsers)
- Authentication and session management
- Authorization and access control checks
- Input validation and sanitization
- Database queries and ORM usage
- File system operations
- Cryptographic operations
- External API calls and network communication
- Deserialization and data parsing
- Configuration and secrets handling
Skim remaining code for obvious red flags but focus depth on the above areas.
```

### Opportunistic Mode Addition
```
Identify and deeply analyze only the most security-critical ~10% of this codebase. Focus exclusively on:
- Authentication and authorization entry points
- The most exposed attack surface (public API endpoints, user input handlers)
- Cryptographic operations and key management
- The riskiest code patterns you can identify
Provide a targeted, high-signal assessment. Skip boilerplate, tests, and low-risk utility code.
```

---

## Color Scheme (CSS Custom Properties)

```css
:root {
    /* Light mode (default) */
    --bg-primary: #ffffff;
    --bg-secondary: #f0f4f8;
    --bg-card: #ffffff;
    --text-primary: #062d56;
    --text-secondary: #4a6785;
    --accent: #07b4b9;
    --accent-hover: #069a9e;
    --btn-primary: #02C0FF;
    --btn-primary-hover: #00a8e0;
    --border: #d0dbe6;
    --severity-critical: #dc2626;
    --severity-high: #ea580c;
    --severity-medium: #d97706;
    --severity-low: #2563eb;
    --severity-info: #6b7280;
    --success: #16a34a;
    --error: #dc2626;
    --code-bg: #f1f5f9;
    --font-main: 'Inter', -apple-system, system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

[data-theme="dark"] {
    --bg-primary: #0a1628;
    --bg-secondary: #11305f;
    --bg-card: #152040;
    --text-primary: #e2e8f0;
    --text-secondary: #a9ccf4;
    --accent: #07b4b9;
    --accent-hover: #08d4da;
    --btn-primary: #02C0FF;
    --btn-primary-hover: #33d0ff;
    --border: #1e3a5f;
    --code-bg: #1a2744;
}
```

---

## Integration Testing Infrastructure

### Approach
Real PostgreSQL + real Express server + real HTTP calls. No mocking of internal services — only external APIs (GitHub) are mocked. Each test run gets a fresh database. Tests validate the full request→response→DB cycle.

### Test Database Lifecycle
1. **Before all tests**: Create a temporary database (`codewatch_test_<random>`), run all migrations from `sql/`
2. **Before each test**: Truncate all tables (fast, preserves schema), re-seed `model_pricing`
3. **After all tests**: Drop the temporary database
4. Requires `DATABASE_URL` pointing to a PostgreSQL server where we can `CREATE DATABASE`

### Test Server
- `setup.ts` exports `startTestServer()`: boots Express app on port 0 (random available port), returns `{ baseUrl, server, db }`
- Tests make real HTTP requests via `fetch` to `baseUrl`
- Server uses the test database pool

### Mocks
- **GitHub API** (`mocks/github.ts`): Intercepts `github.ts` service calls. Provides:
  - Fake org repo listings (returns fixture repos)
  - Fake user info (for OAuth callback simulation)
  - Fake ownership verification (returns configurable true/false)
- **Claude API**: Not mocked in most tests (audit tests use a mock that returns canned findings JSON)
- **Git operations**: Use real git against `test/fixtures/sample-project/` (initialized as a real git repo during test setup)

### Test Fixture: `sample-project/`
A tiny multi-language project with intentional patterns for the scanner to find:
- `src/index.js` — small Express app with a SQL injection and an XSS (intentional, for audit testing)
- `src/auth.js` — basic auth module
- `src/utils.py` — Python utility (tests multi-language scanning)
- `config.json`, `package.json`, `README.md`
- Initialized as a git repo during test setup (`git init` + initial commit); a second commit adds a modified file (for incremental diff testing)

### Session Helpers
- `helpers.ts` provides `createTestSession(userId?)`: inserts a user + session directly into DB, returns session cookie string for authenticated requests
- `authenticatedFetch(url, sessionCookie, options?)`: fetch wrapper that attaches session cookie

### Test Scenarios
- **`projects.test.ts`**: Create project with repos → verify DB records (project, repos, project_repos). List org repos (mocked GitHub). Get project details.
- **`estimate.test.ts`**: Estimate cost for project → verify rough estimate returned. Call precise estimate → verify `count_tokens` called with service key.
- **`audit.test.ts`**: Start audit → poll status → verify classification step → verify findings inserted → verify report. Incremental audit → verify diff detection + finding inheritance.
- **`auth.test.ts`**: OAuth callback (mocked) → user created → session cookie set → `/auth/me` returns profile → logout clears session.
- **`git.test.ts`**: Clone fixture repo → scan files → verify token counts. Make commit → diff → verify added/modified/deleted detection.

### Dev Dependencies
```
vitest @types/node
```
`vitest` chosen over Jest: native TS/ESM support, faster, simpler config.

### npm Scripts
```json
{
  "test": "vitest run",
  "test:watch": "vitest"
}
```

---

## Implementation Phases

### Phase 1: Project Skeleton + Test Infrastructure
- `npm init`, install deps: `express`, `pg`, `simple-git`, `@anthropic-ai/sdk`, `uuid`, `cookie-parser`
- Dev deps: `typescript`, `@types/*`, `concurrently`, `vitest`
- tsconfig files (server + client)
- Express server serving `public/` as static + health endpoint
- Test infrastructure: `test/setup.ts` (DB create/migrate/teardown), `test/helpers.ts` (HTTP client, session factory)
- Test fixture: `test/fixtures/sample-project/` with sample code files
- Basic smoke test: server starts, `GET /` returns 200, DB tables exist
- PostgreSQL connection + migration runner + full initial schema (all tables)
- **Verify:** `npm run dev` starts server, `GET /` serves index.html, DB tables exist

### Phase 2: Frontend Shell
- All 5 HTML pages (index, estimate, audit, report, project) with shared layout, nav, theme toggle
- `style.css` with full SimpleX color scheme, responsive layout, dark/light modes
- `common.ts` with theme toggle, fetch wrapper, DOM helpers
- **Verify:** All pages render, theme toggle works, responsive

### Phase 3: GitHub OAuth + Users
- `auth.ts` routes: OAuth flow, session management
- `github.ts` service: ownership verification, user creation/update
- `users` + `sessions` tables wired up, 14-day session cookie (httpOnly, secure, sameSite)
- Frontend: auth status, login/logout
- `mocks/github.ts`: mock GitHub API responses
- **Tests:** `auth.test.ts` — OAuth callback → user created → /auth/me → logout
- **Verify:** Login via GitHub → user record created → `/auth/me` returns profile → logout works

### Phase 4: Project Creation & Estimation
- `git.ts` service: clone/update repos in permanent dirs (`repos/github.com/org/repo/`), detect default branch
- `tokens.ts` service: rough token counting (`chars/3.3`) per repo + aggregate cost estimation for 3 levels
- `POST /api/estimate/precise` endpoint: uses `ANTHROPIC_SERVICE_KEY` to call free `count_tokens` API
- `github.ts` service: list org repos, fetch repo metadata (stars, language, license, etc.)
- `POST /api/projects` endpoint: create project with selected repos, clone all, return project with repo details
- `POST /api/estimate` endpoint: scan all project repos, aggregate tokens, return per-level cost estimates
- `GET /api/github/orgs/:org/repos` endpoint: list repos for org selector UI
- `home.ts` client: org detection from URL, repo selector checkboxes, project creation
- `estimate.ts` client: cost cards for 3 levels, previous audit detection, "Get precise estimate" button, API key input
- **Tests:** `projects.test.ts` — project CRUD, repo creation. `estimate.test.ts` — rough + precise estimation. `git.test.ts` — clone, scan, token count against fixture.
- **Verify:** Enter repo URL → org detected → select repos → project created → rough estimates shown → precise estimate refines them

### Phase 5: Audit Engine (Fresh)
- `claude.ts` service: API wrapper, takes key as param, tracks actual token usage
- `audit.ts` service: **Step 0 classification** → file batching → async analysis → per-finding DB insertion → synthesis
- Classification prompt (`classify.md`): category, parties, threat model detection/generation
- Security audit prompts in `prompts/` (parameterized by classification output)
- `POST /api/audit/start` + `GET /api/audit/:id` endpoints
- `audit.ts` client: progress polling (shows classification step, then per-file status)
- **Tests:** `audit.test.ts` — fresh audit with mocked Claude → classification stored → findings in DB → report generated
- **Verify:** Fresh audit on small multi-repo project → classification stored → findings in DB → report with threat model

### Phase 6: Incremental Audits
- `git diff` logic between base audit commits (per-repo via `audit_commits`) and current HEAD
- Inherit open findings from base audit, mark deleted-file findings as fixed
- Diff-only file analysis with previous findings as context
- Fingerprint-based dedup of findings
- Incremental cost estimation (diff tokens only)
- `estimate.html`: show "Run Incremental" option when previous audit exists
- **Tests:** `audit.test.ts` — add second commit to fixture → incremental audit → only diff analyzed → findings inherited + deduped
- **Verify:** Make a change to audited repo → incremental audit analyzes only diff → inherited + new findings merged

### Phase 7: Report, Privacy & Comments
- `GET /api/audit/:id/report` + `/findings` with role-based visibility (owner vs non-owner redaction)
- `POST /api/audit/:id/publish` with severity timing rules
- `POST /api/audit/:id/comments` for owner fix annotations
- `report.ts` client: full owner view, redacted non-owner view, comment UI
- `project.ts` client: audit history timeline
- GitHub issue notification for owners
- Non-owner pre-audit warning about redaction
- **Tests:** `audit.test.ts` — owner session sees full findings; non-owner session sees redacted medium+; comments CRUD; publish enforces time-gates
- **Verify:** Owner sees full report; non-owner sees redacted medium+; comments work; publish rules enforced

### Phase 8: Polish
- Input validation on all endpoints
- Error states in UI (invalid URL, bad API key, clone failure, rate limit)
- Loading states and empty states
- Responsible disclosure section in reports
- Meta tags, favicon
- "Developed by SimpleX Chat using Claude Code" footer
- **Verify:** End-to-end fresh + incremental flow, error cases, both roles

---

## Testing / Verification Strategy

### Automated (integration tests via `npm test`)
1. **Project creation:** POST /api/projects → DB records created (project + repos + project_repos)
2. **Rough estimation:** POST /api/estimate → returns approximate token counts and costs
3. **Precise estimation:** POST /api/estimate/precise → calls count_tokens mock → returns precise counts
4. **Auth flow:** OAuth callback (mocked GitHub) → user + session created → /auth/me → logout
5. **Fresh audit:** Start audit (mocked Claude) → poll progress → classification stored → findings inserted → report generated
6. **Incremental audit:** Modify fixture repo → incremental audit → only diff analyzed → findings inherited + merged
7. **Git operations:** Clone fixture → scan files → token counts. Diff between commits → correct added/modified/deleted
8. **Visibility rules:** Owner session → full report. Non-owner session → redacted medium+
9. **API key security:** Verify key never in DB rows, response bodies, or error messages

### Manual verification
10. **Theme:** Verify dark/light mode across all 5 pages
11. **Error UI:** Invalid repo URL, bad API key, clone failure, rate limit
12. **Publish rules:** Non-owner can't publish medium+ before time-gate. Owner can publish anytime.
13. **Audit history:** Multiple audits on same project → project page shows timeline
14. **Cost estimation accuracy:** Compare rough vs precise vs actual API usage

---

## Dependencies (package.json)

```json
{
  "dependencies": {
    "express": "^4",
    "pg": "^8",
    "simple-git": "^3",
    "@anthropic-ai/sdk": "^0.39",
    "uuid": "^10",
    "cookie-parser": "^1"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/express": "^4",
    "@types/pg": "^8",
    "@types/node": "^22",
    "@types/uuid": "^10",
    "@types/cookie-parser": "^1",
    "vitest": "^3",
    "concurrently": "^9"
  },
  "scripts": {
    "build:server": "tsc -p tsconfig.server.json",
    "build:client": "tsc -p tsconfig.client.json",
    "build": "npm run build:server && npm run build:client",
    "dev": "concurrently \"tsc -p tsconfig.server.json --watch\" \"tsc -p tsconfig.client.json --watch\" \"node --watch dist/server/index.js\"",
    "start": "node dist/server/index.js",
    "migrate": "node dist/server/migrate.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```
