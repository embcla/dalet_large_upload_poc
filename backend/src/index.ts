import { createApp } from './app';
import { config } from './config';
import { runMigrations } from './db';
import { createDatastore } from './tus';
import { startCleanupInterval } from './cleanup';

runMigrations();

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${config.port}`);
});

startCleanupInterval(createDatastore(), config.cleanupIntervalMs);
