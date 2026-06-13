import fs from 'fs';
import os from 'os';
import path from 'path';

describe('db', () => {
  let tmpDir: string;
  let dbModule: typeof import('./db');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('./db');
    dbModule.runMigrations();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it('creates the uploads table with the expected columns', () => {
    const columns = dbModule
      .getDb()
      .prepare(`PRAGMA table_info(uploads)`)
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'filename',
        'size',
        'mime_type',
        'status',
        'storage_key',
        'last_seen',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('inserts a row with status uploading and last_seen set', () => {
    dbModule.insertUpload({
      id: 'upload-1',
      filename: 'video.mp4',
      size: 1024,
      mimeType: 'video/mp4',
      storageKey: 'upload-1',
    });

    const row = dbModule.getUpload('upload-1');
    expect(row).toBeDefined();
    expect(row?.status).toBe('uploading');
    expect(row?.filename).toBe('video.mp4');
    expect(row?.size).toBe(1024);
    expect(row?.last_seen).toBeTruthy();
  });

  it('updates status via markUploadStatus', () => {
    dbModule.insertUpload({
      id: 'upload-2',
      filename: 'video.mkv',
      size: 2048,
      mimeType: 'video/x-matroska',
      storageKey: 'upload-2',
    });

    dbModule.markUploadStatus('upload-2', 'success');

    const row = dbModule.getUpload('upload-2');
    expect(row?.status).toBe('success');
  });

  describe('touchLastSeen', () => {
    it('bumps last_seen for an in-progress upload', () => {
      dbModule.insertUpload({
        id: 'upload-3',
        filename: 'video.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'upload-3',
      });
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'upload-3'`)
        .run();

      dbModule.touchLastSeen('upload-3');

      expect(dbModule.getUpload('upload-3')?.last_seen).not.toBe('2000-01-01 00:00:00');
    });

    it('is a no-op for an upload that already succeeded', () => {
      dbModule.insertUpload({
        id: 'upload-4',
        filename: 'video.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'upload-4',
      });
      dbModule.markUploadStatus('upload-4', 'success');
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'upload-4'`)
        .run();

      dbModule.touchLastSeen('upload-4');

      expect(dbModule.getUpload('upload-4')?.last_seen).toBe('2000-01-01 00:00:00');
    });

    it('is a no-op for an unknown upload id', () => {
      expect(() => dbModule.touchLastSeen('does-not-exist')).not.toThrow();
    });
  });

  describe('getStaleUploads', () => {
    it('returns only in-progress uploads whose last_seen exceeds the timeout', () => {
      dbModule.insertUpload({
        id: 'stale',
        filename: 'stale.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'stale',
      });
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = datetime('now', '-1 hour') WHERE id = 'stale'`)
        .run();

      dbModule.insertUpload({
        id: 'fresh',
        filename: 'fresh.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'fresh',
      });

      dbModule.insertUpload({
        id: 'stale-but-done',
        filename: 'done.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'stale-but-done',
      });
      dbModule.markUploadStatus('stale-but-done', 'success');
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = datetime('now', '-1 hour') WHERE id = 'stale-but-done'`)
        .run();

      const stale = dbModule.getStaleUploads(90);

      expect(stale.map((row) => row.id)).toEqual(['stale']);
    });
  });
});
