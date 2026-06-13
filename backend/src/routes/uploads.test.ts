import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { S3Store } from '@tus/s3-store';

describe('uploads routes', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let createUploadsRouter: typeof import('./uploads').createUploadsRouter;
  let remove: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-route-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('../db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ createUploadsRouter } = require('./uploads'));

    remove = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  function buildApp() {
    const app = express();
    const datastore = { remove } as unknown as S3Store;
    app.use(createUploadsRouter(datastore));
    return app;
  }

  describe('POST /uploads/:id/heartbeat', () => {
    it('bumps last_seen for an in-progress upload', async () => {
      dbModule.insertUpload({ id: 'u1', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'u1' });
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'u1'`)
        .run();

      await request(buildApp()).post('/uploads/u1/heartbeat').expect(204);

      expect(dbModule.getUpload('u1')?.last_seen).not.toBe('2000-01-01 00:00:00');
    });

    it('is a no-op (still 204) for an unknown upload', async () => {
      await request(buildApp()).post('/uploads/does-not-exist/heartbeat').expect(204);
    });
  });

  describe('POST /uploads/:id/abandon', () => {
    it('aborts the multipart upload and marks the row abandoned', async () => {
      dbModule.insertUpload({ id: 'u2', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'u2' });

      await request(buildApp()).post('/uploads/u2/abandon').expect(204);

      expect(remove).toHaveBeenCalledWith('u2');
      expect(dbModule.getUpload('u2')?.status).toBe('abandoned');
    });

    it('does not touch an already-completed upload', async () => {
      dbModule.insertUpload({ id: 'u3', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'u3' });
      dbModule.markUploadStatus('u3', 'success');

      await request(buildApp()).post('/uploads/u3/abandon').expect(204);

      expect(remove).not.toHaveBeenCalled();
      expect(dbModule.getUpload('u3')?.status).toBe('success');
    });

    it('is a no-op (still 204) for an unknown upload', async () => {
      await request(buildApp()).post('/uploads/does-not-exist/abandon').expect(204);

      expect(remove).not.toHaveBeenCalled();
    });
  });
});
