import fs from 'fs';
import os from 'os';
import path from 'path';

describe('reconciliation (M10 §14)', () => {
  let tmpDir: string;
  let dbModule: typeof import('./db');
  let progressModule: typeof import('./progress');
  let reconciliationModule: typeof import('./reconciliation');
  let send: jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciliation-test-'));
    process.env.SQLITE_PATH = path.join(tmpDir, 'db.sqlite');
    jest.resetModules();

    send = jest.fn();
    jest.doMock('./s3client', () => ({
      s3Client: { send },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    dbModule = require('./db');
    dbModule.runMigrations();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    progressModule = require('./progress');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    reconciliationModule = require('./reconciliation');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
    jest.dontMock('./s3client');
    jest.restoreAllMocks();
  });

  function setBucketContents(keys: string[]) {
    send.mockResolvedValue({ Contents: keys.map((key) => ({ Key: key })) });
  }

  it('leaves a success row alone when its object is present', async () => {
    dbModule.insertUpload({ id: 'present', filename: 'a.mp4', size: 10, mimeType: 'video/mp4', storageKey: 'present' });
    dbModule.markUploadStatus('present', 'success');
    setBucketContents(['present', 'present.info']);

    const broadcastSpy = jest.spyOn(progressModule, 'broadcast');
    const result = await reconciliationModule.runReconciliationOnce();

    expect(result.missing).toBe(0);
    expect(dbModule.getUpload('present')?.status).toBe('success');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('marks a success row missing and broadcasts when its object is gone', async () => {
    dbModule.insertUpload({ id: 'gone', filename: 'b.mp4', size: 20, mimeType: 'video/mp4', storageKey: 'gone' });
    dbModule.markUploadStatus('gone', 'success');
    dbModule.setBytesReceived('gone', 20);
    setBucketContents([]);

    const broadcastSpy = jest.spyOn(progressModule, 'broadcast');
    const result = await reconciliationModule.runReconciliationOnce();

    expect(result.missing).toBe(1);
    expect(dbModule.getUpload('gone')?.status).toBe('missing');
    expect(broadcastSpy).toHaveBeenCalledWith({
      uploadId: 'gone',
      status: 'missing',
      bytesReceived: 20,
      bytesTotal: 20,
    });
  });

  it('never touches non-success rows regardless of bucket contents', async () => {
    dbModule.insertUpload({ id: 'uploading', filename: 'c.mp4', size: 5, mimeType: 'video/mp4', storageKey: 'uploading' });
    setBucketContents([]);

    const broadcastSpy = jest.spyOn(progressModule, 'broadcast');
    await reconciliationModule.runReconciliationOnce();

    expect(dbModule.getUpload('uploading')?.status).toBe('uploading');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('logs orphaned objects with no matching success row, excluding .info keys', async () => {
    setBucketContents(['orphan-object', 'some-id.info']);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await reconciliationModule.runReconciliationOnce();

    expect(warnSpy).toHaveBeenCalledWith('Orphaned object in bucket', 'orphan-object');
    expect(warnSpy).not.toHaveBeenCalledWith('Orphaned object in bucket', 'some-id.info');
  });

  it('does not re-broadcast on a second run once a row is already missing', async () => {
    dbModule.insertUpload({ id: 'gone', filename: 'b.mp4', size: 20, mimeType: 'video/mp4', storageKey: 'gone' });
    dbModule.markUploadStatus('gone', 'success');
    setBucketContents([]);

    await reconciliationModule.runReconciliationOnce();

    const broadcastSpy = jest.spyOn(progressModule, 'broadcast');
    const result = await reconciliationModule.runReconciliationOnce();

    expect(result.missing).toBe(0);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });
});
