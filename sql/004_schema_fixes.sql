-- ============================================================
-- 004: Schema fixes — FK constraints, indexes, checks
-- ============================================================

-- #10: audit_findings.component_id — add ON DELETE SET NULL
-- (FK exists from 002 but without delete behavior)
ALTER TABLE audit_findings DROP CONSTRAINT IF EXISTS audit_findings_component_id_fkey;
ALTER TABLE audit_findings
  ADD CONSTRAINT audit_findings_component_id_fkey
  FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE SET NULL;

-- #11: projects.component_analysis_id — add ON DELETE SET NULL
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_component_analysis_id_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_component_analysis_id_fkey
  FOREIGN KEY (component_analysis_id) REFERENCES component_analyses(id) ON DELETE SET NULL;

-- #30: Index on audit_findings(component_id) for component→findings queries
CREATE INDEX IF NOT EXISTS idx_audit_findings_component_id ON audit_findings(component_id);

-- #31: Index on project_repos(repo_id) for JOIN queries
CREATE INDEX IF NOT EXISTS idx_project_repos_repo_id ON project_repos(repo_id);

-- #34: ON DELETE CASCADE on audit_components → components
-- When a component is deleted, its audit_components rows should be cleaned up
ALTER TABLE audit_components DROP CONSTRAINT IF EXISTS audit_components_component_id_fkey;
ALTER TABLE audit_components
  ADD CONSTRAINT audit_components_component_id_fkey
  FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE;

-- #76: Prevent self-referencing project dependencies
ALTER TABLE project_dependencies
  ADD CONSTRAINT chk_no_self_reference CHECK (linked_project_id IS NULL OR linked_project_id != project_id);

-- #18: Add 'completed_with_warnings' to audit status enum
-- (Must drop and re-add CHECK constraint since it's not a true ENUM type)
ALTER TABLE audits DROP CONSTRAINT IF EXISTS audits_status_check;
ALTER TABLE audits ADD CONSTRAINT audits_status_check
  CHECK (status IN ('pending', 'cloning', 'classifying', 'estimating', 'planning', 'analyzing', 'synthesizing', 'completed', 'completed_with_warnings', 'failed'));
