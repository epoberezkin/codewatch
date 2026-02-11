// Spec: spec/database.md
import { Pool, PoolConfig } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

let pool: Pool;

// Spec: spec/database.md#initPool
export function initPool(connectionString: string): Pool {
  pool = new Pool({ connectionString });
  return pool;
}

// Spec: spec/database.md#getPool
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initPool() first.');
  }
  return pool;
}

// Spec: spec/database.md#runMigrations
export async function runMigrations(pool: Pool): Promise<void> {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Read SQL files from sql/ directory
  const sqlDir = path.join(__dirname, '..', '..', 'sql');
  let files: string[];
  try {
    files = fs.readdirSync(sqlDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    // When running from dist/, sql/ is at project root
    const altDir = path.join(__dirname, '..', '..', '..', 'sql');
    files = fs.readdirSync(altDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    return runMigrationsFromDir(pool, altDir, files);
  }
  return runMigrationsFromDir(pool, sqlDir, files);
}

async function runMigrationsFromDir(pool: Pool, dir: string, files: string[]): Promise<void> {
  const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`Migration applied: ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw new Error(`Migration failed: ${file}: ${err}`);
    }
  }
}

// Spec: spec/database.md#closePool
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
