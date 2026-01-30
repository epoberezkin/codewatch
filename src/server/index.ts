import { config } from './config';
import { initPool, runMigrations } from './db';
import { createApp } from './app';

async function main() {
  const pool = initPool(config.databaseUrl);
  await runMigrations(pool);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`CodeWatch server listening on port ${config.port}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
