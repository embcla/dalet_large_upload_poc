import express, { Express } from 'express';
import cors from 'cors';
import { config } from './config';
import { healthRouter } from './routes/health';
import { configRouter } from './routes/config';
import { createTusHandler } from './tus';

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

  const tusHandler = createTusHandler();
  app.all('/uploads', tusHandler);
  app.all('/uploads/*', tusHandler);

  return app;
}
