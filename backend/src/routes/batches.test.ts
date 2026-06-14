import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

describe('batches routes (M8 §12.3-12.8 manifest, §12.1/12.2 pong)', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let createBatchesRouter: typeof import('./batches').createBatchesRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-route-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('../db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ createBatchesRouter } = require('./batches'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  function buildApp() {
    const app = express();
    app.use(createBatchesRouter());
    return app;
  }

  describe('GET /batches/:batchKey', () => {
    it('returns manifest entries ordered by batchPosition, deduped', async () => {
      dbModule.insertUpload({
        id: 'file-1',
        filename: 'a.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'file-1',
        batchKey: 'batch-abc',
        lastModified: 1700000000000,
        batchPosition: 0,
      });
      dbModule.markUploadStatus('file-1', 'success');
      dbModule.setBytesReceived('file-1', 100);

      dbModule.insertUpload({
        id: 'file-2-stale',
        filename: 'b.mp4',
        size: 200,
        mimeType: 'video/mp4',
        storageKey: 'file-2-stale',
        batchKey: 'batch-abc',
        lastModified: 1700000001000,
        batchPosition: 1,
      });
      dbModule.markUploadStatus('file-2-stale', 'abandoned');

      dbModule.insertUpload({
        id: 'file-2-fresh',
        filename: 'b.mp4',
        size: 200,
        mimeType: 'video/mp4',
        storageKey: 'file-2-fresh',
        batchKey: 'batch-abc',
        lastModified: 1700000001000,
        batchPosition: 1,
      });
      dbModule.setBytesReceived('file-2-fresh', 50);

      const res = await request(buildApp()).get('/batches/batch-abc').expect(200);

      expect(res.body).toEqual([
        {
          id: 'file-1',
          filename: 'a.mp4',
          size: 100,
          lastModified: 1700000000000,
          batchPosition: 0,
          status: 'success',
          bytesReceived: 100,
          storageKey: 'file-1',
        },
        {
          id: 'file-2-fresh',
          filename: 'b.mp4',
          size: 200,
          lastModified: 1700000001000,
          batchPosition: 1,
          status: 'uploading',
          bytesReceived: 50,
          storageKey: 'file-2-fresh',
        },
      ]);
    });

    it('returns an empty array for an unknown batch key', async () => {
      const res = await request(buildApp()).get('/batches/does-not-exist').expect(200);

      expect(res.body).toEqual([]);
    });
  });

  describe('POST /batches/:batchKey/pong', () => {
    it("bumps last_seen for the batch's active row", async () => {
      dbModule.insertUpload({
        id: 'active',
        filename: 'a.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'active',
        batchKey: 'batch-pong',
        batchPosition: 0,
      });
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'active'`)
        .run();

      await request(buildApp()).post('/batches/batch-pong/pong').expect(204);

      expect(dbModule.getUpload('active')?.last_seen).not.toBe('2000-01-01 00:00:00');
    });

    it('is a no-op (still 204) for a batch with no active row', async () => {
      await request(buildApp()).post('/batches/does-not-exist/pong').expect(204);
    });
  });
});
