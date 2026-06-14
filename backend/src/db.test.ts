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

  describe('M4 schema migration (additive columns, §8)', () => {
    it('adds bytes_received and the forward-looking columns to a fresh database', () => {
      const columns = dbModule
        .getDb()
        .prepare(`PRAGMA table_info(uploads)`)
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'last_seen',
          'bytes_received',
          'batch_key',
          'last_modified',
          'batch_position',
          'client_file_hash',
          'server_file_hash',
          'hash_verified',
        ]),
      );
    });

    it('defaults bytes_received to 0 and leaves the forward-looking columns NULL', () => {
      dbModule.insertUpload({
        id: 'upload-m4-smoke',
        filename: 'video.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'upload-m4-smoke',
      });

      const row = dbModule.getUpload('upload-m4-smoke');
      expect(row?.bytes_received).toBe(0);
      expect(row?.batch_key).toBeNull();
      expect(row?.last_modified).toBeNull();
      expect(row?.batch_position).toBeNull();
      expect(row?.client_file_hash).toBeNull();
      expect(row?.server_file_hash).toBeNull();
      expect(row?.hash_verified).toBeNull();
    });

    it('is idempotent when run again against an already-migrated database', () => {
      dbModule.insertUpload({
        id: 'upload-m4-idempotent',
        filename: 'video.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'upload-m4-idempotent',
      });

      expect(() => dbModule.runMigrations()).not.toThrow();
      expect(dbModule.getUpload('upload-m4-idempotent')?.status).toBe('uploading');
    });

    it('migrates an existing M0-M3 database (without the new columns) without losing data', () => {
      const database = dbModule.getDb();
      database.exec(`DROP TABLE uploads`);
      database.exec(`
        CREATE TABLE uploads (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime_type TEXT,
          status TEXT NOT NULL DEFAULT 'uploading',
          storage_key TEXT NOT NULL,
          last_seen TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      database
        .prepare(
          `INSERT INTO uploads (id, filename, size, mime_type, status, storage_key)
           VALUES ('pre-m4', 'old.mp4', 123, 'video/mp4', 'success', 'pre-m4')`,
        )
        .run();

      dbModule.runMigrations();

      const row = dbModule.getUpload('pre-m4');
      expect(row?.status).toBe('success');
      expect(row?.size).toBe(123);
      expect(row?.bytes_received).toBe(0);
      expect(row?.batch_key).toBeNull();
    });
  });

  describe('setBytesReceived', () => {
    it('updates bytes_received for the given upload', () => {
      dbModule.insertUpload({
        id: 'upload-progress',
        filename: 'video.mp4',
        size: 1000,
        mimeType: 'video/mp4',
        storageKey: 'upload-progress',
      });

      dbModule.setBytesReceived('upload-progress', 512);

      expect(dbModule.getUpload('upload-progress')?.bytes_received).toBe(512);
    });
  });

  describe('getNonTerminalUploads', () => {
    it('returns only uploading/paused rows, not success/error/abandoned', () => {
      dbModule.insertUpload({
        id: 'in-progress',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'in-progress',
      });
      dbModule.insertUpload({
        id: 'done',
        filename: 'b.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'done',
      });
      dbModule.markUploadStatus('done', 'success');

      const rows = dbModule.getNonTerminalUploads();

      expect(rows.map((row) => row.id)).toEqual(['in-progress']);
    });
  });

  describe('M7 schema migration (additive columns, §11)', () => {
    it('adds the probed-metadata columns to a fresh database', () => {
      const columns = dbModule
        .getDb()
        .prepare(`PRAGMA table_info(uploads)`)
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toEqual(
        expect.arrayContaining([
          'duration_seconds',
          'width',
          'height',
          'video_codec',
          'audio_codec',
          'playable',
        ]),
      );
    });

    it('leaves the probed-metadata columns NULL until set', () => {
      dbModule.insertUpload({
        id: 'upload-m7-smoke',
        filename: 'video.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'upload-m7-smoke',
      });

      const row = dbModule.getUpload('upload-m7-smoke');
      expect(row?.duration_seconds).toBeNull();
      expect(row?.width).toBeNull();
      expect(row?.height).toBeNull();
      expect(row?.video_codec).toBeNull();
      expect(row?.audio_codec).toBeNull();
      expect(row?.playable).toBeNull();
    });
  });

  describe('setProbedMetadata', () => {
    it('stores probed metadata for an upload', () => {
      dbModule.insertUpload({
        id: 'upload-probed',
        filename: 'video.mp4',
        size: 1000,
        mimeType: 'video/mp4',
        storageKey: 'upload-probed',
      });

      dbModule.setProbedMetadata('upload-probed', {
        durationSeconds: 2.5,
        width: 320,
        height: 240,
        videoCodec: 'h264',
        audioCodec: 'aac',
        playable: true,
      });

      const row = dbModule.getUpload('upload-probed');
      expect(row?.duration_seconds).toBe(2.5);
      expect(row?.width).toBe(320);
      expect(row?.height).toBe(240);
      expect(row?.video_codec).toBe('h264');
      expect(row?.audio_codec).toBe('aac');
      expect(row?.playable).toBe(1);
    });

    it('stores playable: false as 0', () => {
      dbModule.insertUpload({
        id: 'upload-not-playable',
        filename: 'video.mkv',
        size: 1000,
        mimeType: 'video/x-matroska',
        storageKey: 'upload-not-playable',
      });

      dbModule.setProbedMetadata('upload-not-playable', {
        durationSeconds: 2,
        width: 320,
        height: 240,
        videoCodec: 'mpeg2video',
        audioCodec: null,
        playable: false,
      });

      expect(dbModule.getUpload('upload-not-playable')?.playable).toBe(0);
    });
  });

  describe('getCompletedUploads', () => {
    it('returns only success rows', () => {
      dbModule.insertUpload({
        id: 'done-1',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'done-1',
      });
      dbModule.markUploadStatus('done-1', 'success');

      dbModule.insertUpload({
        id: 'in-progress-1',
        filename: 'b.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'in-progress-1',
      });

      const rows = dbModule.getCompletedUploads();

      expect(rows.map((row) => row.id)).toEqual(['done-1']);
    });
  });

  describe('insertUpload with batch fields (M8 §12.12)', () => {
    it('round-trips batchKey/lastModified/batchPosition', () => {
      dbModule.insertUpload({
        id: 'batch-1',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'batch-1',
        batchKey: 'abc123',
        lastModified: 1700000000000,
        batchPosition: 0,
      });

      const row = dbModule.getUpload('batch-1');
      expect(row?.batch_key).toBe('abc123');
      expect(row?.last_modified).toBe(1700000000000);
      expect(row?.batch_position).toBe(0);
    });

    it('defaults batch fields to null when omitted', () => {
      dbModule.insertUpload({
        id: 'batch-2',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'batch-2',
      });

      const row = dbModule.getUpload('batch-2');
      expect(row?.batch_key).toBeNull();
      expect(row?.last_modified).toBeNull();
      expect(row?.batch_position).toBeNull();
    });
  });

  describe('getUploadsByBatchKey', () => {
    it('returns rows ordered by batch_position', () => {
      dbModule.insertUpload({
        id: 'pos-1',
        filename: 'b.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'pos-1',
        batchKey: 'batch-x',
        batchPosition: 1,
      });
      dbModule.insertUpload({
        id: 'pos-0',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'pos-0',
        batchKey: 'batch-x',
        batchPosition: 0,
      });

      const rows = dbModule.getUploadsByBatchKey('batch-x');

      expect(rows.map((row) => row.id)).toEqual(['pos-0', 'pos-1']);
    });

    it('dedups by batch_position, keeping the most-recently-inserted row', () => {
      dbModule.insertUpload({
        id: 'stale-attempt',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'stale-attempt',
        batchKey: 'batch-y',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('stale-attempt', 'abandoned');

      dbModule.insertUpload({
        id: 'fresh-attempt',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'fresh-attempt',
        batchKey: 'batch-y',
        batchPosition: 0,
      });

      const rows = dbModule.getUploadsByBatchKey('batch-y');

      expect(rows.map((row) => row.id)).toEqual(['fresh-attempt']);
    });

    it('returns an empty array for an unknown batch key', () => {
      expect(dbModule.getUploadsByBatchKey('does-not-exist')).toEqual([]);
    });
  });

  describe('M9 cancellation (§13)', () => {
    it('markUploadStatus round-trips the cancelled status', () => {
      dbModule.insertUpload({
        id: 'to-cancel',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'to-cancel',
      });

      dbModule.markUploadStatus('to-cancel', 'cancelled');

      expect(dbModule.getUpload('to-cancel')?.status).toBe('cancelled');
    });
  });

  describe('getCancellableUploadsByBatchKey', () => {
    it('excludes success/cancelled rows but includes uploading/paused/error/abandoned', () => {
      const statuses: Array<[string, import('./db').UploadStatus]> = [
        ['row-uploading', 'uploading'],
        ['row-paused', 'paused'],
        ['row-error', 'error'],
        ['row-abandoned', 'abandoned'],
        ['row-success', 'success'],
        ['row-cancelled', 'cancelled'],
      ];

      statuses.forEach(([id, status], index) => {
        dbModule.insertUpload({
          id,
          filename: 'a.mp4',
          size: 10,
          mimeType: 'video/mp4',
          storageKey: id,
          batchKey: 'batch-cancel',
          batchPosition: index,
        });
        dbModule.markUploadStatus(id, status);
      });

      const rows = dbModule.getCancellableUploadsByBatchKey('batch-cancel');

      expect(rows.map((row) => row.id)).toEqual(['row-uploading', 'row-paused', 'row-error', 'row-abandoned']);
    });

    it('respects dedup-by-batch_position ordering', () => {
      dbModule.insertUpload({
        id: 'stale-attempt',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'stale-attempt',
        batchKey: 'batch-cancel-dedup',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('stale-attempt', 'abandoned');

      dbModule.insertUpload({
        id: 'fresh-attempt',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'fresh-attempt',
        batchKey: 'batch-cancel-dedup',
        batchPosition: 0,
      });

      const rows = dbModule.getCancellableUploadsByBatchKey('batch-cancel-dedup');

      expect(rows.map((row) => row.id)).toEqual(['fresh-attempt']);
    });

    it('returns an empty array when all rows are success/cancelled', () => {
      dbModule.insertUpload({
        id: 'done',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'done',
        batchKey: 'batch-all-done',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('done', 'success');

      expect(dbModule.getCancellableUploadsByBatchKey('batch-all-done')).toEqual([]);
    });

    it('returns an empty array for an unknown batch key', () => {
      expect(dbModule.getCancellableUploadsByBatchKey('does-not-exist')).toEqual([]);
    });
  });

  describe('touchLastSeenForBatch', () => {
    it('bumps last_seen for the active row of a batch', () => {
      dbModule.insertUpload({
        id: 'active-row',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'active-row',
        batchKey: 'batch-z',
        batchPosition: 0,
      });
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'active-row'`)
        .run();

      dbModule.touchLastSeenForBatch('batch-z');

      expect(dbModule.getUpload('active-row')?.last_seen).not.toBe('2000-01-01 00:00:00');
    });

    it('is a no-op for a batch with no active (uploading/paused) row', () => {
      dbModule.insertUpload({
        id: 'done-row',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'done-row',
        batchKey: 'batch-w',
        batchPosition: 0,
      });
      dbModule.markUploadStatus('done-row', 'success');
      dbModule
        .getDb()
        .prepare(`UPDATE uploads SET last_seen = '2000-01-01 00:00:00' WHERE id = 'done-row'`)
        .run();

      dbModule.touchLastSeenForBatch('batch-w');

      expect(dbModule.getUpload('done-row')?.last_seen).toBe('2000-01-01 00:00:00');
    });
  });

  describe('setClientFileHash / setServerFileHash (M8 §12.9-12.11)', () => {
    it('leaves hash_verified null until both hashes are present (server then client)', () => {
      dbModule.insertUpload({
        id: 'hash-1',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'hash-1',
      });

      const afterServer = dbModule.setServerFileHash('hash-1', 'deadbeef');
      expect(afterServer?.hash_verified).toBeNull();

      const afterClient = dbModule.setClientFileHash('hash-1', 'deadbeef');
      expect(afterClient?.hash_verified).toBe(1);
      expect(afterClient?.status).toBe('uploading');
    });

    it('sets hash_verified=1 on match (client then server)', () => {
      dbModule.insertUpload({
        id: 'hash-2',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'hash-2',
      });

      const afterClient = dbModule.setClientFileHash('hash-2', 'abc123');
      expect(afterClient?.hash_verified).toBeNull();

      const afterServer = dbModule.setServerFileHash('hash-2', 'abc123');
      expect(afterServer?.hash_verified).toBe(1);
    });

    it('sets hash_verified=0 and status=error on mismatch', () => {
      dbModule.insertUpload({
        id: 'hash-3',
        filename: 'a.mp4',
        size: 10,
        mimeType: 'video/mp4',
        storageKey: 'hash-3',
      });
      dbModule.markUploadStatus('hash-3', 'success');

      dbModule.setClientFileHash('hash-3', 'client-hash');
      const afterServer = dbModule.setServerFileHash('hash-3', 'server-hash');

      expect(afterServer?.hash_verified).toBe(0);
      expect(afterServer?.status).toBe('error');
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
