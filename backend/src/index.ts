import { createApp } from './app';
import { config } from './config';
import { runMigrations } from './db';

runMigrations();

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${config.port}`);
});
