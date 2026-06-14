import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { S3Store } from '@tus/s3-store';

describe('batches routes (M8 §12.3-12.8 manifest, §12.1/12.2 pong)', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let progressModule: typeof import('../progress');
  let createBatchesRouter: typeof import('./batches').createBatchesRouter;
  let remove: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batches-route-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('../db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    progressModule = require('../progress');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ createBatchesRouter } = require('./batches'));

    remove = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  function buildApp() {
    const app = express();
    const datastore = { remove } as unknown as S3Store;
    app.use(createBatchesRouter(datastore));
    return app;
  }

  /** Polls `check` until it returns truthy or `timeoutMs` elapses. */
  async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitFor: timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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

  describe('DELETE /batches/:batchKey (M9 §13.8)', () => {
    it('returns 204 promptly and cancels the non-success row without touching the success row', async () => {
      dbModule.insertUpload({
        id: 'done',
        filename: 'a.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'done',
        batchKey: 'batch-cancel',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('done', 'success');
      dbModule.setBytesReceived('done', 100);

      dbModule.insertUpload({
        id: 'in-progress',
        filename: 'b.mp4',
        size: 200,
        mimeType: 'video/mp4',
        storageKey: 'in-progress',
        batchKey: 'batch-cancel',
        batchPosition: 1,
      });
      dbModule.setBytesReceived('in-progress', 50);

      const broadcastSpy = jest.spyOn(progressModule, 'broadcast');

      const start = Date.now();
      await request(buildApp()).delete('/batches/batch-cancel').expect(204);
      expect(Date.now() - start).toBeLessThan(500);

      await waitFor(() => dbModule.getUpload('in-progress')?.status === 'cancelled');

      expect(remove).toHaveBeenCalledWith('in-progress');
      expect(remove).not.toHaveBeenCalledWith('done');
      expect(dbModule.getUpload('done')?.status).toBe('success');
      expect(broadcastSpy).toHaveBeenCalledWith({
        uploadId: 'in-progress',
        status: 'cancelled',
        bytesReceived: 50,
        bytesTotal: 200,
      });
      expect(broadcastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ uploadId: 'done' }));
    });

    it('processes multiple non-terminal rows sequentially in batch_position order', async () => {
      dbModule.insertUpload({
        id: 'first',
        filename: 'a.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'first',
        batchKey: 'batch-multi',
        batchPosition: 0,
      });
      dbModule.insertUpload({
        id: 'second',
        filename: 'b.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'second',
        batchKey: 'batch-multi',
        batchPosition: 1,
      });

      const order: string[] = [];
      jest.spyOn(progressModule, 'broadcast').mockImplementation((event) => {
        order.push(event.uploadId);
      });

      await request(buildApp()).delete('/batches/batch-multi').expect(204);

      await waitFor(() => order.length === 2);

      expect(order).toEqual(['first', 'second']);
      expect(dbModule.getUpload('first')?.status).toBe('cancelled');
      expect(dbModule.getUpload('second')?.status).toBe('cancelled');
    });

    it('is a no-op (204, no broadcasts) for a batch where everything is already success/cancelled', async () => {
      dbModule.insertUpload({
        id: 'already-done',
        filename: 'a.mp4',
        size: 100,
        mimeType: 'video/mp4',
        storageKey: 'already-done',
        batchKey: 'batch-done',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('already-done', 'success');

      const broadcastSpy = jest.spyOn(progressModule, 'broadcast');

      await request(buildApp()).delete('/batches/batch-done').expect(204);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(remove).not.toHaveBeenCalled();
      expect(broadcastSpy).not.toHaveBeenCalled();
      expect(dbModule.getUpload('already-done')?.status).toBe('success');
    });

    it('is a no-op (204) for an unknown batch key', async () => {
      await request(buildApp()).delete('/batches/does-not-exist').expect(204);

      expect(remove).not.toHaveBeenCalled();
    });
  });
});
