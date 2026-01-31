-- ============================================================
-- 002: Ownership, Components, Dependencies
-- ============================================================

-- ---------- Ownership ----------

-- Track whether session token has read:org scope
ALTER TABLE sessions ADD COLUMN has_org_scope BOOLEAN NOT NULL DEFAULT FALSE;

-- Cache ownership lookups (15-min TTL)
CREATE TABLE ownership_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    github_org TEXT NOT NULL,
    is_owner BOOLEAN NOT NULL,
    role TEXT,                           -- 'admin', 'member', or NULL (personal account)
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
    UNIQUE(user_id, github_org)
);
CREATE INDEX idx_ownership_cache_lookup ON ownership_cache(user_id, github_org, expires_at);

-- ---------- Components ----------

CREATE TABLE components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    repo_id UUID NOT NULL REFERENCES repositories(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    role TEXT,                           -- e.g. 'server', 'client', 'shared library'
    file_patterns TEXT[] NOT NULL,       -- glob patterns: ['src/relay/**', 'src/shared/**']
    languages TEXT[] DEFAULT '{}',
    security_profile JSONB,             -- { summary, sensitive_areas: [{path, reason}], threat_surface: [...] }
    estimated_files INTEGER,
    estimated_tokens INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_components_project ON components(project_id);
CREATE INDEX idx_components_repo ON components(repo_id);

-- Track agentic analysis runs
CREATE TABLE component_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    turns_used INTEGER DEFAULT 0,
    max_turns INTEGER DEFAULT 40,
    input_tokens_used INTEGER DEFAULT 0,
    output_tokens_used INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,4) DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_component_analyses_project ON component_analyses(project_id);

-- Which components were included in each audit
CREATE TABLE audit_components (
    audit_id UUID NOT NULL REFERENCES audits(id),
    component_id UUID NOT NULL REFERENCES components(id),
    tokens_analyzed INTEGER,
    findings_count INTEGER DEFAULT 0,
    PRIMARY KEY (audit_id, component_id)
);

-- Link findings to components
ALTER TABLE audit_findings ADD COLUMN component_id UUID REFERENCES components(id);

-- Track component analysis on projects
ALTER TABLE projects ADD COLUMN component_analysis_id UUID REFERENCES component_analyses(id);
ALTER TABLE projects ADD COLUMN components_analyzed_at TIMESTAMPTZ;

-- Audit: selected components and new status value
ALTER TABLE audits ADD COLUMN selected_component_ids UUID[];
ALTER TABLE audits ADD COLUMN component_analysis_id UUID REFERENCES component_analyses(id);

-- Expand audits.status to include 'planning'
ALTER TABLE audits DROP CONSTRAINT audits_status_check;
ALTER TABLE audits ADD CONSTRAINT audits_status_check
    CHECK (status IN ('pending', 'cloning', 'classifying', 'estimating', 'planning', 'analyzing', 'synthesizing', 'completed', 'failed'));

-- Store the audit plan (ranked file list from planning phase)
ALTER TABLE audits ADD COLUMN audit_plan JSONB;  -- [{file, tokens, priority, reason}]

-- Responsible disclosure: track when owner was actually notified
ALTER TABLE audits ADD COLUMN owner_notified_at TIMESTAMPTZ;

-- ---------- Dependencies ----------

CREATE TABLE project_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    repo_id UUID REFERENCES repositories(id),       -- which repo declared this dependency
    name TEXT NOT NULL,                              -- e.g. 'express', 'tokio', 'aeson'
    version TEXT,                                    -- e.g. '^5.2.1', '>=1.0'
    ecosystem TEXT NOT NULL,                         -- 'npm', 'cargo', 'pip', 'go', 'maven', etc.
    source_repo_url TEXT,                            -- GitHub URL if identifiable
    linked_project_id UUID REFERENCES projects(id),  -- if added as a CodeWatch project
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, repo_id, name, ecosystem)
);
CREATE INDEX idx_project_deps_project ON project_dependencies(project_id);
CREATE INDEX idx_project_deps_linked ON project_dependencies(linked_project_id);
