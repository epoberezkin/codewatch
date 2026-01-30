CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Users & Sessions
-- ============================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id INTEGER NOT NULL UNIQUE,
    github_username TEXT NOT NULL,
    github_type TEXT NOT NULL DEFAULT 'User',
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    github_token TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days'
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ============================================================
-- Projects
-- ============================================================

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    github_org TEXT NOT NULL,
    created_by UUID REFERENCES users(id),
    category TEXT CHECK (category IN (
        'library', 'cli_tool', 'build_dependency', 'gui_client',
        'client_server', 'decentralized_serverless', 'decentralized_client_server'
    )),
    description TEXT,
    involved_parties JSONB,
    threat_model TEXT,
    threat_model_source TEXT CHECK (threat_model_source IN ('repo', 'generated', 'none')),
    classification_audit_id UUID,
    total_files INTEGER,
    total_tokens INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_org ON projects(github_org);
CREATE INDEX idx_projects_creator ON projects(created_by);

-- ============================================================
-- Repositories
-- ============================================================

CREATE TABLE repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_url TEXT NOT NULL UNIQUE,
    github_org TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    repo_path TEXT NOT NULL,
    total_files INTEGER,
    total_tokens INTEGER,
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
-- Project <-> Repository
-- ============================================================

CREATE TABLE project_repos (
    project_id UUID NOT NULL REFERENCES projects(id),
    repo_id UUID NOT NULL REFERENCES repositories(id),
    PRIMARY KEY (project_id, repo_id)
);

-- ============================================================
-- Audits
-- ============================================================

CREATE TABLE audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    requester_id UUID REFERENCES users(id),
    audit_level TEXT NOT NULL CHECK (audit_level IN ('full', 'thorough', 'opportunistic')),
    base_audit_id UUID REFERENCES audits(id),
    is_incremental BOOLEAN NOT NULL DEFAULT FALSE,
    diff_files_added INTEGER DEFAULT 0,
    diff_files_modified INTEGER DEFAULT 0,
    diff_files_deleted INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'cloning', 'classifying', 'estimating', 'analyzing', 'synthesizing', 'completed', 'failed')),
    is_owner BOOLEAN NOT NULL DEFAULT FALSE,
    total_files INTEGER,
    total_tokens INTEGER,
    files_to_analyze INTEGER,
    tokens_to_analyze INTEGER,
    estimated_cost_usd NUMERIC(10,4),
    actual_cost_usd NUMERIC(10,4),
    files_analyzed INTEGER DEFAULT 0,
    progress_detail JSONB DEFAULT '[]',
    report_summary JSONB,
    max_severity TEXT CHECK (max_severity IN ('none', 'informational', 'low', 'medium', 'high', 'critical')),
    is_public BOOLEAN DEFAULT FALSE,
    publishable_after TIMESTAMPTZ,
    owner_notified BOOLEAN DEFAULT FALSE,
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
-- Audit commits
-- ============================================================

CREATE TABLE audit_commits (
    audit_id UUID NOT NULL REFERENCES audits(id),
    repo_id UUID NOT NULL REFERENCES repositories(id),
    commit_sha TEXT NOT NULL,
    branch TEXT NOT NULL,
    PRIMARY KEY (audit_id, repo_id)
);

-- ============================================================
-- Findings
-- ============================================================

CREATE TABLE audit_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES audits(id),
    repo_id UUID REFERENCES repositories(id),
    file_path TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER,
    fingerprint TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
    cwe_id TEXT,
    cvss_score NUMERIC(3,1),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    exploitation TEXT,
    recommendation TEXT,
    code_snippet TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'fixed', 'false_positive', 'accepted', 'wont_fix')),
    resolved_in_audit_id UUID REFERENCES audits(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_findings_audit ON audit_findings(audit_id);
CREATE INDEX idx_findings_severity ON audit_findings(severity);
CREATE INDEX idx_findings_fingerprint ON audit_findings(fingerprint);
CREATE INDEX idx_findings_status ON audit_findings(status);

-- ============================================================
-- Comments
-- ============================================================

CREATE TABLE audit_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES audits(id),
    finding_id UUID REFERENCES audit_findings(id),
    user_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comments_audit ON audit_comments(audit_id);
CREATE INDEX idx_comments_finding ON audit_comments(finding_id);

-- ============================================================
-- Project watches (schema-ready, post-MVP)
-- ============================================================

CREATE TABLE project_watches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    user_id UUID NOT NULL REFERENCES users(id),
    watch_type TEXT NOT NULL CHECK (watch_type IN ('branch', 'releases', 'prs')),
    target_branch TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, user_id, watch_type, target_branch)
);

CREATE INDEX idx_watches_project ON project_watches(project_id);
CREATE INDEX idx_watches_user ON project_watches(user_id);

-- ============================================================
-- Model pricing
-- ============================================================

CREATE TABLE model_pricing (
    model_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    input_cost_per_mtok NUMERIC(10,4) NOT NULL,
    output_cost_per_mtok NUMERIC(10,4) NOT NULL,
    context_window INTEGER NOT NULL,
    max_output INTEGER NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO model_pricing VALUES
    ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 5.00, 25.00, 200000, 64000, NOW()),
    ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 3.00, 15.00, 200000, 64000, NOW()),
    ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 1.00, 5.00, 200000, 64000, NOW());
