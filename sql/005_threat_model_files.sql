-- Store threat model file paths from classification for GitHub link construction
ALTER TABLE projects ADD COLUMN threat_model_files TEXT[] DEFAULT '{}';
