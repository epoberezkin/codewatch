import { config } from './config';
import { initPool, runMigrations, closePool } from './db';

async function main() {
  const pool = initPool(config.databaseUrl);
  try {
    await runMigrations(pool);
    console.log('All migrations applied successfully.');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
