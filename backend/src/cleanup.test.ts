import fs from 'fs';
import os from 'os';
import path from 'path';
import { ERRORS } from '@tus/server';
import type { S3Store } from '@tus/s3-store';

describe('cleanup', () => {
  let tmpDir: string;
  let dbModule: typeof import('./db');
  let cleanupModule: typeof import('./cleanup');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('./db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cleanupModule = require('./cleanup');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  function fakeDatastore(remove: jest.Mock): S3Store {
    return { remove } as unknown as S3Store;
  }

  it('aborts and marks stale in-progress uploads as abandoned, leaving fresh ones alone', async () => {
    dbModule.insertUpload({ id: 'stale', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'stale' });
    dbModule
      .getDb()
      .prepare(`UPDATE uploads SET last_seen = datetime('now', '-1 hour') WHERE id = 'stale'`)
      .run();

    dbModule.insertUpload({ id: 'fresh', filename: 'b.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'fresh' });

    const remove = jest.fn().mockResolvedValue(undefined);
    const cleaned = await cleanupModule.runCleanupOnce(fakeDatastore(remove));

    expect(cleaned).toBe(1);
    expect(remove).toHaveBeenCalledWith('stale');
    expect(dbModule.getUpload('stale')?.status).toBe('abandoned');
    expect(dbModule.getUpload('fresh')?.status).toBe('uploading');
  });

  it('still marks the row abandoned if the datastore has no matching upload', async () => {
    dbModule.insertUpload({ id: 'stale', filename: 'a.mp4', size: 1, mimeType: 'video/mp4', storageKey: 'stale' });
    dbModule
      .getDb()
      .prepare(`UPDATE uploads SET last_seen = datetime('now', '-1 hour') WHERE id = 'stale'`)
      .run();

    const remove = jest.fn().mockRejectedValue(ERRORS.FILE_NOT_FOUND);
    const cleaned = await cleanupModule.runCleanupOnce(fakeDatastore(remove));

    expect(cleaned).toBe(1);
    expect(dbModule.getUpload('stale')?.status).toBe('abandoned');
  });

  it('returns 0 when there is nothing stale', async () => {
    const remove = jest.fn();
    const cleaned = await cleanupModule.runCleanupOnce(fakeDatastore(remove));

    expect(cleaned).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});
