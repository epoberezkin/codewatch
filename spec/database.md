# Database Specification

## Overview

CodeWatch uses PostgreSQL with the `pgcrypto` extension for UUID generation (`gen_random_uuid()`).

**Connection management**: [db.ts](../src/server/db.ts) exposes a `pg.Pool` singleton via `initPool(connectionString)` / `getPool()` / `closePool()`.

**Migration system**: [db.ts](../src/server/db.ts#L23-L69) implements a file-based migration runner. [migrate.ts](../src/server/migrate.ts) is the CLI entry point (`npm run migrate`) that calls `runMigrations()`:

1. Creates a `_migrations` tracking table on first run.
2. Reads `sql/*.sql` files sorted lexicographically.
3. For each unapplied file: `BEGIN` -> execute SQL -> insert into `_migrations` -> `COMMIT`. On failure: `ROLLBACK` + throw.
4. Resolves `sql/` relative to source; falls back to `../../sql/` for `dist/` builds.

**Docker bootstrap**: [init-db.sql](../docker/init-db.sql) enables `pgcrypto`; [001_initial.sql](../sql/001_initial.sql) also includes `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` for non-Docker environments. All schema creation is handled by migrations.

### Migration History

| File | Introduced |
|------|-----------|
| [001_initial.sql](../sql/001_initial.sql) | Core schema: users, sessions, projects, repositories, project_repos, audits, audit_commits, audit_findings, audit_comments, project_watches, model_pricing. Seed data for model_pricing. |
| [002_ownership_and_components.sql](../sql/002_ownership_and_components.sql) | `sessions.has_org_scope`, ownership_cache, components, component_analyses, audit_components, project_dependencies. Adds columns to audit_findings, projects, audits. Expands audit status with `planning`. |
| [003_branch_selection.sql](../sql/003_branch_selection.sql) | `project_repos.branch` column for per-project branch overrides. |
| [004_schema_fixes.sql](../sql/004_schema_fixes.sql) | FK cascade fixes (`ON DELETE SET NULL`, `ON DELETE CASCADE`), new indexes, self-reference CHECK on project_dependencies, adds `completed_with_warnings` to audit status. |
| [005_threat_model_files.sql](../sql/005_threat_model_files.sql) | `projects.threat_model_files TEXT[]` column for storing classification threat model file paths. |
| [006_entity_type.sql](../sql/006_entity_type.sql) | `projects.github_entity_type TEXT` column for storing GitHub entity type (User or Organization). |

### Internal Migration Table

#### [`_migrations`](../src/server/db.ts#L25-L31)

Created by `db.ts`, not by any SQL migration file.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `SERIAL` | `PRIMARY KEY` | auto-increment |
| `filename` | `TEXT` | `NOT NULL UNIQUE` | — |
| `applied_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `id`, UNIQUE on `filename` (implicit).

---

## 1. Users & Sessions

### [`users`](../sql/001_initial.sql#L7-L15)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `github_id` | `INTEGER` | `NOT NULL UNIQUE` | — |
| `github_username` | `TEXT` | `NOT NULL` | — |
| `github_type` | `TEXT` | `NOT NULL` | `'User'` |
| `avatar_url` | `TEXT` | — | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |
| `last_seen_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `id`, UNIQUE on `github_id` (implicit).

[GAP] No index on `github_username`. [REC] Add if username lookups become frequent.

---

### [`sessions`](../sql/001_initial.sql#L17-L23)

| Column | Type | Constraints | Default | Migration |
|--------|------|-------------|---------|-----------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` | 001 |
| `user_id` | `UUID` | `NOT NULL` FK -> `users(id)` | — | 001 |
| `github_token` | `TEXT` | `NOT NULL` | — | 001 |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` | 001 |
| `expires_at` | `TIMESTAMPTZ` | — | `NOW() + INTERVAL '14 days'` | 001 |
| `has_org_scope` | `BOOLEAN` | `NOT NULL` | `FALSE` | 002 |

**Indexes**: PK on `id`, `idx_sessions_user(user_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `user_id` | `users(id)` | NO ACTION (default) |

[GAP] No index on `expires_at`. [REC] Add if expired-session cleanup queries are slow.

[GAP] No `ON DELETE CASCADE` on `user_id`. [REC] Consider cascade so deleting a user removes sessions.

---

## 2. Projects & Repositories

### [`projects`](../sql/001_initial.sql#L31-L48)

| Column | Type | Constraints | Default | Migration |
|--------|------|-------------|---------|-----------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` | 001 |
| `name` | `TEXT` | `NOT NULL` | — | 001 |
| `github_org` | `TEXT` | `NOT NULL` | — | 001 |
| `created_by` | `UUID` | FK -> `users(id)` | — | 001 |
| `category` | `TEXT` | `CHECK` (see below) | — | 001 |
| `description` | `TEXT` | — | — | 001 |
| `involved_parties` | `JSONB` | — | — | 001 |
| `threat_model` | `TEXT` | — | — | 001 |
| `threat_model_source` | `TEXT` | `CHECK` (see below) | — | 001 |
| `classification_audit_id` | `UUID` | — | — | 001 |
| `total_files` | `INTEGER` | — | — | 001 |
| `total_tokens` | `INTEGER` | — | — | 001 |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` | 001 |
| `component_analysis_id` | `UUID` | FK -> `component_analyses(id)` `ON DELETE SET NULL` | — | 002 (FK fix in 004) |
| `components_analyzed_at` | `TIMESTAMPTZ` | — | — | 002 |
| `threat_model_files` | `TEXT[]` | — | `'{}'` | 005 |
| `github_entity_type` | `TEXT` | — | — | 006 |

**CHECK constraints**:
- `category IN ('library', 'cli_tool', 'build_dependency', 'gui_client', 'client_server', 'decentralized_serverless', 'decentralized_client_server')`
- `threat_model_source IN ('repo', 'generated', 'none')`

**Indexes**: PK on `id`, `idx_projects_org(github_org)`, `idx_projects_creator(created_by)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `created_by` | `users(id)` | NO ACTION |
| `component_analysis_id` | `component_analyses(id)` | SET NULL (004) |

[GAP] `classification_audit_id` has no FK constraint to `audits(id)`. [REC] Add FK if referential integrity is desired.

---

### [`repositories`](../sql/001_initial.sql#L57-L75)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `repo_url` | `TEXT` | `NOT NULL UNIQUE` | — |
| `github_org` | `TEXT` | `NOT NULL` | — |
| `repo_name` | `TEXT` | `NOT NULL` | — |
| `default_branch` | `TEXT` | `NOT NULL` | `'main'` |
| `repo_path` | `TEXT` | `NOT NULL` | — |
| `total_files` | `INTEGER` | — | — |
| `total_tokens` | `INTEGER` | — | — |
| `github_id` | `INTEGER` | — | — |
| `description` | `TEXT` | — | — |
| `language` | `TEXT` | — | — |
| `stars` | `INTEGER` | — | `0` |
| `forks` | `INTEGER` | — | `0` |
| `license` | `TEXT` | — | — |
| `metadata_updated_at` | `TIMESTAMPTZ` | — | — |
| `last_cloned_at` | `TIMESTAMPTZ` | — | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `id`, UNIQUE on `repo_url` (implicit), `idx_repos_org(github_org)`.

[GAP] No UNIQUE constraint on `(github_org, repo_name)`. [REC] Consider adding if org+name should be unique.

---

### [`project_repos`](../sql/001_initial.sql#L83-L87)

Junction table: projects <-> repositories (many-to-many).

| Column | Type | Constraints | Default | Migration |
|--------|------|-------------|---------|-----------|
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)`, part of PK | — | 001 |
| `repo_id` | `UUID` | `NOT NULL` FK -> `repositories(id)`, part of PK | — | 001 |
| `branch` | `TEXT` | — | — | 003 |

**Indexes**: Composite PK on `(project_id, repo_id)`, `idx_project_repos_repo_id(repo_id)` (004).

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |
| `repo_id` | `repositories(id)` | NO ACTION |

`branch` is `NULL` by default; NULL means use the repository's `default_branch`.

---

## 3. Audits & Findings

### [`audits`](../sql/001_initial.sql#L93-L123)

| Column | Type | Constraints | Default | Migration |
|--------|------|-------------|---------|-----------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` | 001 |
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)` | — | 001 |
| `requester_id` | `UUID` | FK -> `users(id)` | — | 001 |
| `audit_level` | `TEXT` | `NOT NULL` `CHECK` | — | 001 |
| `base_audit_id` | `UUID` | FK -> `audits(id)` (self-ref) | — | 001 |
| `is_incremental` | `BOOLEAN` | `NOT NULL` | `FALSE` | 001 |
| `diff_files_added` | `INTEGER` | — | `0` | 001 |
| `diff_files_modified` | `INTEGER` | — | `0` | 001 |
| `diff_files_deleted` | `INTEGER` | — | `0` | 001 |
| `status` | `TEXT` | `NOT NULL` `CHECK` (see below) | `'pending'` | 001 (expanded 002, 004) |
| `is_owner` | `BOOLEAN` | `NOT NULL` | `FALSE` | 001 |
| `total_files` | `INTEGER` | — | — | 001 |
| `total_tokens` | `INTEGER` | — | — | 001 |
| `files_to_analyze` | `INTEGER` | — | — | 001 |
| `tokens_to_analyze` | `INTEGER` | — | — | 001 |
| `estimated_cost_usd` | `NUMERIC(10,4)` | — | — | 001 |
| `actual_cost_usd` | `NUMERIC(10,4)` | — | — | 001 |
| `files_analyzed` | `INTEGER` | — | `0` | 001 |
| `progress_detail` | `JSONB` | — | `'[]'` | 001 |
| `report_summary` | `JSONB` | — | — | 001 |
| `max_severity` | `TEXT` | `CHECK` (see below) | — | 001 |
| `is_public` | `BOOLEAN` | — | `FALSE` | 001 |
| `publishable_after` | `TIMESTAMPTZ` | — | — | 001 |
| `owner_notified` | `BOOLEAN` | — | `FALSE` | 001 |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` | 001 |
| `started_at` | `TIMESTAMPTZ` | — | — | 001 |
| `completed_at` | `TIMESTAMPTZ` | — | — | 001 |
| `error_message` | `TEXT` | — | — | 001 |
| `selected_component_ids` | `UUID[]` | — | — | 002 |
| `component_analysis_id` | `UUID` | FK -> `component_analyses(id)` | — | 002 |
| `audit_plan` | `JSONB` | — | — | 002 |
| `owner_notified_at` | `TIMESTAMPTZ` | — | — | 002 |

**CHECK constraints**:
- `audit_level IN ('full', 'thorough', 'opportunistic')`
- `status IN ('pending', 'cloning', 'classifying', 'estimating', 'planning', 'analyzing', 'synthesizing', 'completed', 'completed_with_warnings', 'failed')` (final form after 004)
- `max_severity IN ('none', 'informational', 'low', 'medium', 'high', 'critical')`

**Indexes**: PK on `id`, `idx_audits_project(project_id)`, `idx_audits_requester(requester_id)`, `idx_audits_status(status)`, `idx_audits_base(base_audit_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |
| `requester_id` | `users(id)` | NO ACTION |
| `base_audit_id` | `audits(id)` | NO ACTION |
| `component_analysis_id` | `component_analyses(id)` | NO ACTION |

[GAP] `audits.component_analysis_id` has no `ON DELETE SET NULL`, unlike `projects.component_analysis_id` which was fixed in 004. [REC] Add `ON DELETE SET NULL` for consistency.

---

### [`audit_commits`](../sql/001_initial.sql#L134-L140)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `audit_id` | `UUID` | `NOT NULL` FK -> `audits(id)`, part of PK | — |
| `repo_id` | `UUID` | `NOT NULL` FK -> `repositories(id)`, part of PK | — |
| `commit_sha` | `TEXT` | `NOT NULL` | — |
| `branch` | `TEXT` | `NOT NULL` | — |

**Indexes**: Composite PK on `(audit_id, repo_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `audit_id` | `audits(id)` | NO ACTION |
| `repo_id` | `repositories(id)` | NO ACTION |

[GAP] No `ON DELETE CASCADE` from `audits(id)`. [REC] Consider cascade so deleting an audit removes its commit records.

---

### [`audit_findings`](../sql/001_initial.sql#L146-L166)

| Column | Type | Constraints | Default | Migration |
|--------|------|-------------|---------|-----------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` | 001 |
| `audit_id` | `UUID` | `NOT NULL` FK -> `audits(id)` | — | 001 |
| `repo_id` | `UUID` | FK -> `repositories(id)` | — | 001 |
| `file_path` | `TEXT` | `NOT NULL` | — | 001 |
| `line_start` | `INTEGER` | — | — | 001 |
| `line_end` | `INTEGER` | — | — | 001 |
| `fingerprint` | `TEXT` | — | — | 001 |
| `severity` | `TEXT` | `NOT NULL` `CHECK` | — | 001 |
| `cwe_id` | `TEXT` | — | — | 001 |
| `cvss_score` | `NUMERIC(3,1)` | — | — | 001 |
| `title` | `TEXT` | `NOT NULL` | — | 001 |
| `description` | `TEXT` | `NOT NULL` | — | 001 |
| `exploitation` | `TEXT` | — | — | 001 |
| `recommendation` | `TEXT` | — | — | 001 |
| `code_snippet` | `TEXT` | — | — | 001 |
| `status` | `TEXT` | `NOT NULL` `CHECK` | `'open'` | 001 |
| `resolved_in_audit_id` | `UUID` | FK -> `audits(id)` | — | 001 |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` | 001 |
| `component_id` | `UUID` | FK -> `components(id)` `ON DELETE SET NULL` | — | 002 (FK fix in 004) |

**CHECK constraints**:
- `severity IN ('critical', 'high', 'medium', 'low', 'informational')`
- `status IN ('open', 'fixed', 'false_positive', 'accepted', 'wont_fix')`

**Indexes**: PK on `id`, `idx_findings_audit(audit_id)`, `idx_findings_severity(severity)`, `idx_findings_fingerprint(fingerprint)`, `idx_findings_status(status)`, `idx_audit_findings_component_id(component_id)` (004).

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `audit_id` | `audits(id)` | NO ACTION |
| `repo_id` | `repositories(id)` | NO ACTION |
| `resolved_in_audit_id` | `audits(id)` | NO ACTION |
| `component_id` | `components(id)` | SET NULL (004) |

---

### [`audit_comments`](../sql/001_initial.sql#L177-L185)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `audit_id` | `UUID` | `NOT NULL` FK -> `audits(id)` | — |
| `finding_id` | `UUID` | FK -> `audit_findings(id)` | — |
| `user_id` | `UUID` | `NOT NULL` FK -> `users(id)` | — |
| `content` | `TEXT` | `NOT NULL` | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |
| `updated_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `id`, `idx_comments_audit(audit_id)`, `idx_comments_finding(finding_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `audit_id` | `audits(id)` | NO ACTION |
| `finding_id` | `audit_findings(id)` | NO ACTION |
| `user_id` | `users(id)` | NO ACTION |

---

## 4. Components & Analysis

### [`components`](../sql/002_ownership_and_components.sql#L25-L39)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)` | — |
| `repo_id` | `UUID` | `NOT NULL` FK -> `repositories(id)` | — |
| `name` | `TEXT` | `NOT NULL` | — |
| `description` | `TEXT` | `NOT NULL` | — |
| `role` | `TEXT` | — | — |
| `file_patterns` | `TEXT[]` | `NOT NULL` | — |
| `languages` | `TEXT[]` | — | `'{}'` |
| `security_profile` | `JSONB` | — | — |
| `estimated_files` | `INTEGER` | — | — |
| `estimated_tokens` | `INTEGER` | — | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |
| `updated_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `id`, `idx_components_project(project_id)`, `idx_components_repo(repo_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |
| `repo_id` | `repositories(id)` | NO ACTION |

`security_profile` JSONB shape: `{ summary, sensitive_areas: [{path, reason}], threat_surface: [...] }`.

[GAP] No `ON DELETE CASCADE` from `projects(id)`. [REC] Consider cascade so deleting a project removes its components.

---

### [`component_analyses`](../sql/002_ownership_and_components.sql#L44-L57)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)` | — |
| `status` | `TEXT` | `NOT NULL` `CHECK` | `'pending'` |
| `turns_used` | `INTEGER` | — | `0` |
| `max_turns` | `INTEGER` | — | `40` |
| `input_tokens_used` | `INTEGER` | — | `0` |
| `output_tokens_used` | `INTEGER` | — | `0` |
| `cost_usd` | `NUMERIC(10,4)` | — | `0` |
| `error_message` | `TEXT` | — | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |
| `completed_at` | `TIMESTAMPTZ` | — | — |

**CHECK constraints**:
- `status IN ('pending', 'running', 'completed', 'failed')`

**Indexes**: PK on `id`, `idx_component_analyses_project(project_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |

---

### [`audit_components`](../sql/002_ownership_and_components.sql#L61-L67)

Junction table: audits <-> components.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `audit_id` | `UUID` | `NOT NULL` FK -> `audits(id)`, part of PK | — |
| `component_id` | `UUID` | `NOT NULL` FK -> `components(id)` `ON DELETE CASCADE`, part of PK | — |
| `tokens_analyzed` | `INTEGER` | — | — |
| `findings_count` | `INTEGER` | — | `0` |

**Indexes**: Composite PK on `(audit_id, component_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `audit_id` | `audits(id)` | NO ACTION |
| `component_id` | `components(id)` | CASCADE (004) |

---

## 5. Ownership & Cache

### [`ownership_cache`](../sql/002_ownership_and_components.sql#L11-L20)

Cache for GitHub org ownership lookups (15-minute TTL).

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `user_id` | `UUID` | `NOT NULL` FK -> `users(id)` | — |
| `github_org` | `TEXT` | `NOT NULL` | — |
| `is_owner` | `BOOLEAN` | `NOT NULL` | — |
| `role` | `TEXT` | — | — |
| `checked_at` | `TIMESTAMPTZ` | `NOT NULL` | `NOW()` |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` | `NOW() + INTERVAL '15 minutes'` |

**UNIQUE constraint**: `(user_id, github_org)`.

**Indexes**: PK on `id`, UNIQUE on `(user_id, github_org)` (implicit), `idx_ownership_cache_lookup(user_id, github_org, expires_at)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `user_id` | `users(id)` | NO ACTION |

`role` values: `'admin'`, `'member'`, or `NULL` (personal account).

---

### [`project_dependencies`](../sql/002_ownership_and_components.sql#L93-L106)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)` | — |
| `repo_id` | `UUID` | FK -> `repositories(id)` | — |
| `name` | `TEXT` | `NOT NULL` | — |
| `version` | `TEXT` | — | — |
| `ecosystem` | `TEXT` | `NOT NULL` | — |
| `source_repo_url` | `TEXT` | — | — |
| `linked_project_id` | `UUID` | FK -> `projects(id)` | — |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |

**UNIQUE constraint**: `(project_id, repo_id, name, ecosystem)`.

**CHECK constraints**:
- `chk_no_self_reference`: `linked_project_id IS NULL OR linked_project_id != project_id` (004)

**Indexes**: PK on `id`, UNIQUE on `(project_id, repo_id, name, ecosystem)` (implicit), `idx_project_deps_project(project_id)`, `idx_project_deps_linked(linked_project_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |
| `repo_id` | `repositories(id)` | NO ACTION |
| `linked_project_id` | `projects(id)` | NO ACTION |

---

## 6. Configuration & Metadata

### [`project_watches`](../sql/001_initial.sql#L194-L203)

Schema-ready, post-MVP.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | `PRIMARY KEY` | `gen_random_uuid()` |
| `project_id` | `UUID` | `NOT NULL` FK -> `projects(id)` | — |
| `user_id` | `UUID` | `NOT NULL` FK -> `users(id)` | — |
| `watch_type` | `TEXT` | `NOT NULL` `CHECK` | — |
| `target_branch` | `TEXT` | — | — |
| `is_active` | `BOOLEAN` | — | `TRUE` |
| `created_at` | `TIMESTAMPTZ` | — | `NOW()` |

**UNIQUE constraint**: `(project_id, user_id, watch_type, target_branch)`.

**CHECK constraints**:
- `watch_type IN ('branch', 'releases', 'prs')`

**Indexes**: PK on `id`, UNIQUE on `(project_id, user_id, watch_type, target_branch)` (implicit), `idx_watches_project(project_id)`, `idx_watches_user(user_id)`.

**Foreign Keys**:
| Column | References | On Delete |
|--------|-----------|-----------|
| `project_id` | `projects(id)` | NO ACTION |
| `user_id` | `users(id)` | NO ACTION |

---

### [`model_pricing`](../sql/001_initial.sql#L212-L225)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `model_id` | `TEXT` | `PRIMARY KEY` | — |
| `display_name` | `TEXT` | `NOT NULL` | — |
| `input_cost_per_mtok` | `NUMERIC(10,4)` | `NOT NULL` | — |
| `output_cost_per_mtok` | `NUMERIC(10,4)` | `NOT NULL` | — |
| `context_window` | `INTEGER` | `NOT NULL` | — |
| `max_output` | `INTEGER` | `NOT NULL` | — |
| `updated_at` | `TIMESTAMPTZ` | — | `NOW()` |

**Indexes**: PK on `model_id`.

#### Seed Data

Inserted in [001_initial.sql](../sql/001_initial.sql#L222-L225):

| model_id | display_name | input $/Mtok | output $/Mtok | context_window | max_output |
|----------|-------------|-------------|--------------|----------------|------------|
| `claude-opus-4-5-20251101` | Claude Opus 4.5 | 5.00 | 25.00 | 200,000 | 64,000 |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | 3.00 | 15.00 | 200,000 | 64,000 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | 1.00 | 5.00 | 200,000 | 64,000 |

---

## Comprehensive Index Registry

| Index Name | Table | Column(s) | Type | Migration |
|-----------|-------|-----------|------|-----------|
| (PK) | `users` | `id` | PRIMARY KEY | 001 |
| (UNIQUE) | `users` | `github_id` | UNIQUE | 001 |
| (PK) | `sessions` | `id` | PRIMARY KEY | 001 |
| `idx_sessions_user` | `sessions` | `user_id` | B-tree | 001 |
| (PK) | `projects` | `id` | PRIMARY KEY | 001 |
| `idx_projects_org` | `projects` | `github_org` | B-tree | 001 |
| `idx_projects_creator` | `projects` | `created_by` | B-tree | 001 |
| (PK) | `repositories` | `id` | PRIMARY KEY | 001 |
| (UNIQUE) | `repositories` | `repo_url` | UNIQUE | 001 |
| `idx_repos_org` | `repositories` | `github_org` | B-tree | 001 |
| (PK) | `project_repos` | `(project_id, repo_id)` | PRIMARY KEY | 001 |
| `idx_project_repos_repo_id` | `project_repos` | `repo_id` | B-tree | 004 |
| (PK) | `audits` | `id` | PRIMARY KEY | 001 |
| `idx_audits_project` | `audits` | `project_id` | B-tree | 001 |
| `idx_audits_requester` | `audits` | `requester_id` | B-tree | 001 |
| `idx_audits_status` | `audits` | `status` | B-tree | 001 |
| `idx_audits_base` | `audits` | `base_audit_id` | B-tree | 001 |
| (PK) | `audit_commits` | `(audit_id, repo_id)` | PRIMARY KEY | 001 |
| (PK) | `audit_findings` | `id` | PRIMARY KEY | 001 |
| `idx_findings_audit` | `audit_findings` | `audit_id` | B-tree | 001 |
| `idx_findings_severity` | `audit_findings` | `severity` | B-tree | 001 |
| `idx_findings_fingerprint` | `audit_findings` | `fingerprint` | B-tree | 001 |
| `idx_findings_status` | `audit_findings` | `status` | B-tree | 001 |
| `idx_audit_findings_component_id` | `audit_findings` | `component_id` | B-tree | 004 |
| (PK) | `audit_comments` | `id` | PRIMARY KEY | 001 |
| `idx_comments_audit` | `audit_comments` | `audit_id` | B-tree | 001 |
| `idx_comments_finding` | `audit_comments` | `finding_id` | B-tree | 001 |
| (PK) | `project_watches` | `id` | PRIMARY KEY | 001 |
| (UNIQUE) | `project_watches` | `(project_id, user_id, watch_type, target_branch)` | UNIQUE | 001 |
| `idx_watches_project` | `project_watches` | `project_id` | B-tree | 001 |
| `idx_watches_user` | `project_watches` | `user_id` | B-tree | 001 |
| (PK) | `model_pricing` | `model_id` | PRIMARY KEY | 001 |
| (PK) | `ownership_cache` | `id` | PRIMARY KEY | 002 |
| (UNIQUE) | `ownership_cache` | `(user_id, github_org)` | UNIQUE | 002 |
| `idx_ownership_cache_lookup` | `ownership_cache` | `(user_id, github_org, expires_at)` | B-tree | 002 |
| (PK) | `components` | `id` | PRIMARY KEY | 002 |
| `idx_components_project` | `components` | `project_id` | B-tree | 002 |
| `idx_components_repo` | `components` | `repo_id` | B-tree | 002 |
| (PK) | `component_analyses` | `id` | PRIMARY KEY | 002 |
| `idx_component_analyses_project` | `component_analyses` | `project_id` | B-tree | 002 |
| (PK) | `audit_components` | `(audit_id, component_id)` | PRIMARY KEY | 002 |
| (PK) | `project_dependencies` | `id` | PRIMARY KEY | 002 |
| (UNIQUE) | `project_dependencies` | `(project_id, repo_id, name, ecosystem)` | UNIQUE | 002 |
| `idx_project_deps_project` | `project_dependencies` | `project_id` | B-tree | 002 |
| `idx_project_deps_linked` | `project_dependencies` | `linked_project_id` | B-tree | 002 |
| (PK) | `_migrations` | `id` | PRIMARY KEY | db.ts |
| (UNIQUE) | `_migrations` | `filename` | UNIQUE | db.ts |

---

## Foreign Key Summary

All FK relationships with final cascade behavior (after 004):

| Source Table | Column | Target Table | Column | On Delete |
|-------------|--------|-------------|--------|-----------|
| `sessions` | `user_id` | `users` | `id` | NO ACTION |
| `projects` | `created_by` | `users` | `id` | NO ACTION |
| `projects` | `component_analysis_id` | `component_analyses` | `id` | SET NULL |
| `project_repos` | `project_id` | `projects` | `id` | NO ACTION |
| `project_repos` | `repo_id` | `repositories` | `id` | NO ACTION |
| `audits` | `project_id` | `projects` | `id` | NO ACTION |
| `audits` | `requester_id` | `users` | `id` | NO ACTION |
| `audits` | `base_audit_id` | `audits` | `id` | NO ACTION |
| `audits` | `component_analysis_id` | `component_analyses` | `id` | NO ACTION |
| `audit_commits` | `audit_id` | `audits` | `id` | NO ACTION |
| `audit_commits` | `repo_id` | `repositories` | `id` | NO ACTION |
| `audit_findings` | `audit_id` | `audits` | `id` | NO ACTION |
| `audit_findings` | `repo_id` | `repositories` | `id` | NO ACTION |
| `audit_findings` | `resolved_in_audit_id` | `audits` | `id` | NO ACTION |
| `audit_findings` | `component_id` | `components` | `id` | SET NULL |
| `audit_comments` | `audit_id` | `audits` | `id` | NO ACTION |
| `audit_comments` | `finding_id` | `audit_findings` | `id` | NO ACTION |
| `audit_comments` | `user_id` | `users` | `id` | NO ACTION |
| `project_watches` | `project_id` | `projects` | `id` | NO ACTION |
| `project_watches` | `user_id` | `users` | `id` | NO ACTION |
| `ownership_cache` | `user_id` | `users` | `id` | NO ACTION |
| `components` | `project_id` | `projects` | `id` | NO ACTION |
| `components` | `repo_id` | `repositories` | `id` | NO ACTION |
| `component_analyses` | `project_id` | `projects` | `id` | NO ACTION |
| `audit_components` | `audit_id` | `audits` | `id` | NO ACTION |
| `audit_components` | `component_id` | `components` | `id` | CASCADE |
| `project_dependencies` | `project_id` | `projects` | `id` | NO ACTION |
| `project_dependencies` | `repo_id` | `repositories` | `id` | NO ACTION |
| `project_dependencies` | `linked_project_id` | `projects` | `id` | NO ACTION |

---

## Gap Summary

| ID | Location | Description | Recommendation |
|----|----------|-------------|----------------|
| [GAP] | `users` | No index on `github_username` | [REC] Add if username lookups become frequent |
| [GAP] | `sessions` | No index on `expires_at` | [REC] Add if expired-session cleanup is a recurring query |
| [GAP] | `sessions.user_id` | FK has no `ON DELETE CASCADE` | [REC] Cascade so user deletion cleans up sessions |
| [GAP] | `repositories` | No UNIQUE on `(github_org, repo_name)` | [REC] Add if org+name must be unique |
| [GAP] | `projects.classification_audit_id` | No FK constraint to `audits(id)` | [REC] Add FK for referential integrity |
| [GAP] | `audits.component_analysis_id` | No `ON DELETE SET NULL` (unlike `projects.component_analysis_id`) | [REC] Add `ON DELETE SET NULL` for consistency with 004 pattern |
| [GAP] | `audit_commits` | No `ON DELETE CASCADE` from `audits(id)` | [REC] Cascade so audit deletion cleans up commit records |
| [GAP] | `components` | No `ON DELETE CASCADE` from `projects(id)` | [REC] Cascade so project deletion cleans up components |
| [GAP] | Most FKs | Default `NO ACTION` on delete throughout | [REC] Audit all FKs for appropriate cascade behavior in a future migration |
