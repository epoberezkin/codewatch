import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createApp } from '../src/server/app';
import { initPool, runMigrations } from '../src/server/db';

export const TEST_MODEL_PRICING = {
  opus: { modelId: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', inputCostPerMtok: 5.00, outputCostPerMtok: 25.00 },
  sonnet: { modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', inputCostPerMtok: 3.00, outputCostPerMtok: 15.00 },
  haiku: { modelId: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', inputCostPerMtok: 1.00, outputCostPerMtok: 5.00 },
};

const BASE_DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/postgres';

export interface TestContext {
  baseUrl: string;
  server: http.Server;
  pool: Pool;
  dbName: string;
}

let adminPool: Pool;

export async function setupTestDatabase(): Promise<{ pool: Pool; dbName: string }> {
  const dbName = `codewatch_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Connect to default DB to create test DB
  adminPool = new Pool({ connectionString: BASE_DB_URL });
  await adminPool.query(`CREATE DATABASE "${dbName}"`);

  // Parse the base URL to construct test DB URL
  const url = new URL(BASE_DB_URL);
  url.pathname = `/${dbName}`;
  const testDbUrl = url.toString();

  const pool = initPool(testDbUrl);
  await runMigrations(pool);

  return { pool, dbName };
}

export async function startTestServer(): Promise<TestContext> {
  const { pool, dbName } = await setupTestDatabase();

  const app = createApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  const baseUrl = `http://localhost:${addr.port}`;

  return { baseUrl, server, pool, dbName };
}

export async function teardownTestServer(ctx: TestContext): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ctx.server.close((err) => (err ? reject(err) : resolve()));
  });
  await ctx.pool.end();

  // Drop test database
  if (adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
    await adminPool.end();
  }
}

export async function truncateAllTables(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_migrations') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);

  // Re-seed model_pricing
  await pool.query(`
    INSERT INTO model_pricing VALUES
      ('claude-opus-4-5-20251101', 'Claude Opus 4.5', 5.00, 25.00, 200000, 64000, NOW()),
      ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 3.00, 15.00, 200000, 64000, NOW()),
      ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 1.00, 5.00, 200000, 64000, NOW())
    ON CONFLICT (model_id) DO NOTHING
  `);
}
