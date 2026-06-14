import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateFile } from '../generators/generate-file';
import {
  startUploadAndAbort,
  pong,
  getUploadRow,
  setLastSeen,
  deleteUploadRow,
  deleteObjects,
  runCleanup,
  listMultipartUploadIds,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m8-continuity');
const MB = 1024 * 1024;
const STALE_TIMESTAMP = '2000-01-01 00:00:00';

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('M8 ping/pong session continuity (§12.1/12.2)', () => {
  it('pong refreshes last_seen for the active in-progress row in the batch', async () => {
    const batchKey = crypto.randomBytes(32).toString('hex');
    const filePath = path.join(TMP_DIR, 'pong.mp4');
    generateFile(filePath, 20 * MB);

    let uploadId: string | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, 'pong.mp4', 'video/mp4', 5 * MB, {
        batchKey,
        lastModified: Date.now(),
        batchPosition: 0,
      }));

      setLastSeen(uploadId, STALE_TIMESTAMP);
      expect(getUploadRow(uploadId)?.last_seen).toBe(STALE_TIMESTAMP);

      const res = await pong(batchKey);
      expect(res.status).toBe(204);

      expect(getUploadRow(uploadId)?.last_seen).not.toBe(STALE_TIMESTAMP);
    } finally {
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('is a no-op for a batch key with no active row', async () => {
    const res = await pong('does-not-exist');
    expect(res.status).toBe(204);
  });

  it('a row with no pong and a stale last_seen is cleaned up (abandoned) by the existing cleanup job', async () => {
    const batchKey = crypto.randomBytes(32).toString('hex');
    const filePath = path.join(TMP_DIR, 'no-pong.mp4');
    generateFile(filePath, 20 * MB);

    let uploadId: string | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, 'no-pong.mp4', 'video/mp4', 5 * MB, {
        batchKey,
        lastModified: Date.now(),
        batchPosition: 0,
      }));

      setLastSeen(uploadId, STALE_TIMESTAMP);

      await runCleanup();

      expect(getUploadRow(uploadId)?.status).toBe('abandoned');
      expect(await listMultipartUploadIds(uploadId)).toEqual([]);
    } finally {
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });
});
