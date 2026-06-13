import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { S3Store } from '@tus/s3-store';

describe('POST /internal/cleanup/run', () => {
  let tmpDir: string;
  let dbModule: typeof import('../db');
  let createInternalRouter: typeof import('./internal').createInternalRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-route-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('../db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ createInternalRouter } = require('./internal'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it('runs a cleanup pass and reports how many sessions were cleaned', async () => {
    dbModule.insertUpload({ id: 'stale', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'stale' });
    dbModule
      .getDb()
      .prepare(`UPDATE uploads SET last_seen = datetime('now', '-1 hour') WHERE id = 'stale'`)
      .run();

    const remove = jest.fn().mockResolvedValue(undefined);
    const datastore = { remove } as unknown as S3Store;

    const app = express();
    app.use(createInternalRouter(datastore));

    const res = await request(app).post('/internal/cleanup/run').expect(200);

    expect(res.body).toEqual({ cleaned: 1 });
    expect(dbModule.getUpload('stale')?.status).toBe('abandoned');
  });
});
