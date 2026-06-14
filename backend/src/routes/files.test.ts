import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

describe('files routes', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let createFilesRouter: typeof import('./files').createFilesRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-route-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('../db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ createFilesRouter } = require('./files'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  function buildApp() {
    const app = express();
    app.use(createFilesRouter());
    return app;
  }

  describe('GET /files', () => {
    it('returns an empty array when there are no completed uploads', async () => {
      const res = await request(buildApp()).get('/files').expect(200);
      expect(res.body).toEqual([]);
    });

    it('returns only success rows, shaped with derived duration/resolution/codec/playable', async () => {
      dbModule.insertUpload({ id: 'playable-1', filename: 'clip.mp4', size: 1234, mimeType: 'video/mp4', storageKey: 'playable-1' });
      dbModule.markUploadStatus('playable-1', 'success');
      dbModule.setProbedMetadata('playable-1', {
        durationSeconds: 2.5,
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: 'aac',
        playable: true,
      });

      dbModule.insertUpload({ id: 'not-playable-1', filename: 'clip.mkv', size: 5678, mimeType: 'video/x-matroska', storageKey: 'not-playable-1' });
      dbModule.markUploadStatus('not-playable-1', 'success');
      dbModule.setProbedMetadata('not-playable-1', {
        durationSeconds: 2,
        width: 320,
        height: 240,
        videoCodec: 'mpeg2video',
        audioCodec: null,
        playable: false,
      });

      dbModule.insertUpload({ id: 'in-progress-1', filename: 'pending.mp4', size: 999, mimeType: 'video/mp4', storageKey: 'in-progress-1' });

      const res = await request(buildApp()).get('/files').expect(200);

      expect(res.body.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))).toEqual([
        {
          id: 'not-playable-1',
          filename: 'clip.mkv',
          size: 5678,
          status: 'success',
          duration: 2,
          resolution: '320x240',
          codec: 'mpeg2video',
          playable: false,
        },
        {
          id: 'playable-1',
          filename: 'clip.mp4',
          size: 1234,
          status: 'success',
          duration: 2.5,
          resolution: '320x240',
          codec: 'h264/aac',
          playable: true,
        },
      ]);
    });

    it('represents un-probed metadata as nulls', async () => {
      dbModule.insertUpload({ id: 'unprobed', filename: 'clip.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'unprobed' });
      dbModule.markUploadStatus('unprobed', 'success');

      const res = await request(buildApp()).get('/files').expect(200);

      expect(res.body).toEqual([
        {
          id: 'unprobed',
          filename: 'clip.mp4',
          size: 1,
          status: 'success',
          duration: null,
          resolution: null,
          codec: null,
          playable: false,
        },
      ]);
    });
  });

  describe('GET /files/:id/stream', () => {
    it('returns 404 for an unknown upload', async () => {
      await request(buildApp()).get('/files/does-not-exist/stream').expect(404);
    });

    it('returns 404 for an upload that has not completed', async () => {
      dbModule.insertUpload({ id: 'in-progress', filename: 'clip.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'in-progress' });

      await request(buildApp()).get('/files/in-progress/stream').expect(404);
    });
  });
});
