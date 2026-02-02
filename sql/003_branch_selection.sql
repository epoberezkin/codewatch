-- ============================================================
-- 003: Branch Selection
-- ============================================================

-- Allow per-project branch overrides for each repo.
-- NULL = use the repository's default_branch.
ALTER TABLE project_repos ADD COLUMN branch TEXT;
