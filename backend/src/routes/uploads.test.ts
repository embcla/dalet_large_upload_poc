import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { S3Store } from '@tus/s3-store';

describe('uploads routes', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let progressModule: typeof import('../progress');
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
    progressModule = require('../progress');
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
    app.use(express.json());
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

  describe('POST /uploads/:id/client-hash (M8 §12.9-12.11)', () => {
    it('sets hash_verified=1 when the client hash matches the server hash', async () => {
      dbModule.insertUpload({ id: 'hash-match', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'hash-match' });
      dbModule.setServerFileHash('hash-match', 'abc123');

      await request(buildApp()).post('/uploads/hash-match/client-hash').send({ hash: 'abc123' }).expect(204);

      const row = dbModule.getUpload('hash-match');
      expect(row?.hash_verified).toBe(1);
      expect(row?.status).toBe('uploading');
    });

    it('sets hash_verified=0 and status=error when the hashes mismatch', async () => {
      dbModule.insertUpload({ id: 'hash-mismatch', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'hash-mismatch' });
      dbModule.markUploadStatus('hash-mismatch', 'success');
      dbModule.setServerFileHash('hash-mismatch', 'server-hash');

      await request(buildApp()).post('/uploads/hash-mismatch/client-hash').send({ hash: 'client-hash' }).expect(204);

      const row = dbModule.getUpload('hash-mismatch');
      expect(row?.hash_verified).toBe(0);
      expect(row?.status).toBe('error');
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

  describe('DELETE /uploads/:id (M9 §13)', () => {
    it('aborts the multipart upload, marks the row cancelled, and broadcasts cancelled', async () => {
      const broadcastSpy = jest.spyOn(progressModule, 'broadcast');
      dbModule.insertUpload({ id: 'c1', filename: 'a.mp4', size: 100, mimeType: 'video/mp4', storageKey: 'c1' });
      dbModule.setBytesReceived('c1', 40);

      await request(buildApp()).delete('/uploads/c1').expect(204);

      expect(remove).toHaveBeenCalledWith('c1');
      expect(dbModule.getUpload('c1')?.status).toBe('cancelled');
      expect(broadcastSpy).toHaveBeenCalledWith({
        uploadId: 'c1',
        status: 'cancelled',
        bytesReceived: 40,
        bytesTotal: 100,
      });
    });

    it('cancels an error/abandoned row whose object is already gone, without throwing', async () => {
      remove.mockRejectedValue(
        Object.assign(new Error('not found'), { status_code: 404, code: 'NoSuchUpload' }),
      );
      dbModule.insertUpload({ id: 'c2', filename: 'a.mp4', size: 100, mimeType: 'video/mp4', storageKey: 'c2' });
      dbModule.markUploadStatus('c2', 'abandoned');

      await request(buildApp()).delete('/uploads/c2').expect(204);

      expect(dbModule.getUpload('c2')?.status).toBe('cancelled');
    });

    it('is idempotent: a second DELETE on an already-cancelled row is a no-op', async () => {
      dbModule.insertUpload({ id: 'c3', filename: 'a.mp4', size: 100, mimeType: 'video/mp4', storageKey: 'c3' });
      dbModule.markUploadStatus('c3', 'cancelled');

      await request(buildApp()).delete('/uploads/c3').expect(204);

      expect(remove).not.toHaveBeenCalled();
      expect(dbModule.getUpload('c3')?.status).toBe('cancelled');
    });

    it('is a no-op (still 204) for an unknown upload', async () => {
      await request(buildApp()).delete('/uploads/does-not-exist').expect(204);

      expect(remove).not.toHaveBeenCalled();
    });

    it('does not touch an already-successful upload', async () => {
      dbModule.insertUpload({ id: 'c4', filename: 'a.mp4', size: 100, mimeType: 'video/mp4', storageKey: 'c4' });
      dbModule.markUploadStatus('c4', 'success');

      await request(buildApp()).delete('/uploads/c4').expect(204);

      expect(remove).not.toHaveBeenCalled();
      expect(dbModule.getUpload('c4')?.status).toBe('success');
    });
  });
});
