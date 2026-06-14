import express, { Express } from 'express';
import cors from 'cors';
import { config } from './config';
import { healthRouter } from './routes/health';
import { configRouter } from './routes/config';
import { createUploadsRouter } from './routes/uploads';
import { createInternalRouter } from './routes/internal';
import { createFilesRouter } from './routes/files';
import { createProgressRouter } from './progress';
import { createDatastore, createTusHandler } from './tus';

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: config.corsOrigin,
      exposedHeaders: ['Location', 'Upload-Offset', 'Upload-Length', 'Tus-Resumable'],
    }),
  );

  app.use(healthRouter);
  app.use(configRouter);

  const datastore = createDatastore();

  // Mounted before the tus catch-all so /uploads/:id/heartbeat and
  // /uploads/:id/abandon aren't swallowed by the tus handler below.
  app.use(createUploadsRouter(datastore));
  app.use(createInternalRouter(datastore));
  app.use(createFilesRouter());
  app.use(createProgressRouter());

  const tusHandler = createTusHandler(datastore);
  app.all('/uploads', tusHandler);
  app.all('/uploads/*', tusHandler);

  return app;
}
