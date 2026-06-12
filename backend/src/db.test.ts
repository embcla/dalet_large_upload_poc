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
});
