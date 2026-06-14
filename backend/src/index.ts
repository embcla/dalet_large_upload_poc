import { createApp } from './app';
import { config } from './config';
import { runMigrations } from './db';
import { createDatastore } from './tus';
import { startCleanupInterval } from './cleanup';

// M9 §13: a DELETE /uploads/:id (cancel) can race an in-flight PATCH's S3
// multipart part upload (both touching the same MinIO multipart upload).
// When that race resolves against the part upload, the AWS SDK's streaming
// body machinery can reject a promise with no attached handler, which by
// default crashes the whole process (taking down every other upload with
// it). Log and keep the process alive instead - the affected request will
// surface as a tus upload error to that one client.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection', reason);
});

process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception', error);
});

runMigrations();

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${config.port}`);
});

startCleanupInterval(createDatastore(), config.cleanupIntervalMs);
