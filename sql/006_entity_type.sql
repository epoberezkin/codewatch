-- Add github_entity_type to projects (User or Organization)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_entity_type TEXT;
