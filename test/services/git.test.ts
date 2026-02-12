// Product: product/flows/audit-lifecycle.md
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { scanCodeFiles } from '../../src/server/services/git';

describe('Git Service', () => {
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'sample-project');
  const gitDir = path.join(fixtureDir, '.git');
  let isGitRepo = false;

  beforeAll(() => {
    // Initialize fixture as git repo if not already
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: fixtureDir });
      execSync('git add -A', { cwd: fixtureDir });
      execSync('git commit -m "initial commit" --allow-empty', { cwd: fixtureDir });
      isGitRepo = true;
    }
  });

  afterAll(() => {
    // Clean up .git dir if we created it
    if (isGitRepo && fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true });
    }
  });

  describe('scanCodeFiles', () => {
    it('finds code files in fixture project', () => {
      const files = scanCodeFiles(fixtureDir);

      // Should find JS, Python, JSON, and README files
      const paths = files.map(f => f.relativePath).sort();

      expect(paths).toContain('src/index.js');
      expect(paths).toContain('src/auth.js');
      expect(paths).toContain('src/utils.py');
      expect(paths).toContain('config.json');
      expect(paths).toContain('package.json');
    });

    it('skips node_modules and .git directories', () => {
      const files = scanCodeFiles(fixtureDir);
      const paths = files.map(f => f.relativePath);

      for (const p of paths) {
        expect(p).not.toContain('node_modules');
        expect(p).not.toContain('.git');
      }
    });

    it('computes rough token counts', () => {
      const files = scanCodeFiles(fixtureDir);

      for (const file of files) {
        expect(file.roughTokens).toBeGreaterThan(0);
        // Rough tokens = ceil(size / 3.3)
        expect(file.roughTokens).toBe(Math.ceil(file.size / 3.3));
      }
    });

    it('includes file sizes', () => {
      const files = scanCodeFiles(fixtureDir);
      const indexJs = files.find(f => f.relativePath === 'src/index.js');
      expect(indexJs).toBeDefined();
      expect(indexJs!.size).toBeGreaterThan(0);

      // Verify size matches actual file
      const actualSize = fs.statSync(path.join(fixtureDir, 'src/index.js')).size;
      expect(indexJs!.size).toBe(actualSize);
    });
  });
});
