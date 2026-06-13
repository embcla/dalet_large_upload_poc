import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import {
  startUploadAndAbort,
  resumeUpload,
  getUploadRow,
  deleteUploadRow,
  getObjectSize,
  sha256OfObject,
  sha256OfFile,
  deleteObjects,
  heartbeat,
  abandon,
  runCleanup,
  setLastSeen,
  getConfig,
  listMultipartUploadIds,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m2');
const MB = 1024 * 1024;

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Aborts an in-flight upload, resumes it to completion, and asserts the
 * resulting object matches the source file (size + checksum) with status
 * 'success'. Cleans up the file/object/DB row afterwards. */
async function expectResumeCompletes(filePath: string, sizeBytes: number, aborted: { uploadUrl: string; uploadId: string }) {
  const result = await resumeUpload(filePath, aborted.uploadUrl);
  expect(result.errorStatus).toBeUndefined();
  expect(result.uploadId).toBe(aborted.uploadId);

  try {
    const expectedHash = await sha256OfFile(filePath);
    expect(await getObjectSize(result.uploadId)).toBe(sizeBytes);
    expect(await sha256OfObject(result.uploadId)).toBe(expectedHash);
    expect(getUploadRow(result.uploadId)?.status).toBe('success');
  } finally {
    await deleteObjects([result.uploadId, `${result.uploadId}.info`]);
    deleteUploadRow(result.uploadId);
  }
}

describe('M2 dropped-connection and resume (§2.4)', () => {
  it('resumes an upload aborted mid-stream into a complete, checksum-matching object', async () => {
    const sizeMb = 20;
    const filename = 'resume-default.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, sizeMb * MB);

    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);
      expect(aborted.uploadId).toBeTruthy();
      expect(aborted.offsetAtAbort).toBeGreaterThan(0);
      expect(aborted.offsetAtAbort).toBeLessThan(sizeMb * MB);

      await expectResumeCompletes(filePath, sizeMb * MB, aborted);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  if (process.env.FULL_MATRIX === '1') {
    it(
      'resumes a large upload (200MB) aborted after several completed parts',
      async () => {
        const sizeMb = 200;
        const filename = 'resume-large.mkv';
        const filePath = path.join(TMP_DIR, filename);
        generateFile(filePath, sizeMb * MB);

        try {
          const aborted = await startUploadAndAbort(filePath, filename, 'video/x-matroska', 50 * MB);
          expect(aborted.offsetAtAbort).toBeGreaterThanOrEqual(8 * MB);
          expect(aborted.offsetAtAbort).toBeLessThan(sizeMb * MB);

          await expectResumeCompletes(filePath, sizeMb * MB, aborted);
        } finally {
          fs.rmSync(filePath, { force: true });
        }
      },
      5 * 60 * 1000,
    );
  }
});

describe('M2 pause/resume cycle', () => {
  it('completes with a matching checksum after pause, a wait, then resume', async () => {
    const sizeMb = 20;
    const filename = 'pause-resume.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, sizeMb * MB);

    try {
      const paused = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);

      // simulate the user leaving the upload paused for a while
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await expectResumeCompletes(filePath, sizeMb * MB, paused);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

describe('M2 heartbeat (§2.11)', () => {
  it('updates last_seen for an in-progress upload', async () => {
    const filename = 'heartbeat.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    let uploadId: string | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB));

      setLastSeen(uploadId, '2000-01-01 00:00:00');
      expect(getUploadRow(uploadId)?.last_seen).toBe('2000-01-01 00:00:00');

      const res = await heartbeat(uploadId);
      expect(res.status).toBe(204);

      expect(getUploadRow(uploadId)?.last_seen).not.toBe('2000-01-01 00:00:00');
    } finally {
      if (uploadId) {
        await abandon(uploadId);
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('is a no-op for an unknown upload id', async () => {
    const res = await heartbeat('does-not-exist');
    expect(res.status).toBe(204);
  });
});

describe('M2 abandon (§2.11)', () => {
  it('marks the session abandoned and aborts its multipart upload', async () => {
    const filename = 'abandon.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    try {
      const { uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);

      expect(await listMultipartUploadIds(uploadId)).not.toEqual([]);

      const res = await abandon(uploadId);
      expect(res.status).toBe(204);

      expect(getUploadRow(uploadId)?.status).toBe('abandoned');
      expect(await listMultipartUploadIds(uploadId)).toEqual([]);

      await deleteObjects([uploadId, `${uploadId}.info`]);
      deleteUploadRow(uploadId);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

describe('M2 cleanup job (§2.11)', () => {
  it('aborts and marks abandoned a session with no recent heartbeat', async () => {
    const filename = 'cleanup.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    try {
      const { uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);

      const { heartbeatTimeoutSeconds } = await getConfig();
      const staleTimestamp = new Date(Date.now() - (heartbeatTimeoutSeconds + 30) * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      setLastSeen(uploadId, staleTimestamp);

      await runCleanup();

      expect(getUploadRow(uploadId)?.status).toBe('abandoned');
      expect(await listMultipartUploadIds(uploadId)).toEqual([]);

      await deleteObjects([uploadId, `${uploadId}.info`]);
      deleteUploadRow(uploadId);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
