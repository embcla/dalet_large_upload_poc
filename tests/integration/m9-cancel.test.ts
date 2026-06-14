import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateFile } from '../generators/generate-file';
import {
  startUploadAndAbort,
  tusUploadWithBatchMeta,
  terminateUpload,
  deleteBatch,
  getUploadRow,
  deleteUploadRow,
  deleteObjects,
  listMultipartUploadIds,
  openProgressStream,
  waitFor,
  setLastSeen,
  runCleanup,
  ProgressStream,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m9-cancel');
const MB = 1024 * 1024;

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function eventsFor(stream: ProgressStream, uploadId: string) {
  return stream.events.filter((event) => event.uploadId === uploadId);
}

describe('M9 cancellation (§13)', () => {
  it('cancels an in-progress upload: row becomes cancelled, multipart aborted, SSE cancelled event (§13.1-13.6)', async () => {
    const filename = 'cancel-active.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);
      uploadId = aborted.uploadId;

      const res = await terminateUpload(aborted.uploadUrl);
      expect(res.status).toBe(204);

      expect(getUploadRow(uploadId)?.status).toBe('cancelled');
      expect(await listMultipartUploadIds(uploadId)).toEqual([]);

      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'cancelled'));
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('cancels an abandoned upload whose object is already gone, without throwing (§13.6)', async () => {
    const filename = 'cancel-abandoned.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 5 * MB);

    let uploadId: string | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 2 * MB);
      uploadId = aborted.uploadId;

      setLastSeen(uploadId, '2000-01-01 00:00:00');
      await runCleanup();
      expect(getUploadRow(uploadId)?.status).toBe('abandoned');
      expect(await listMultipartUploadIds(uploadId)).toEqual([]);

      const res = await terminateUpload(aborted.uploadUrl);
      expect(res.status).toBe(204);
      expect(getUploadRow(uploadId)?.status).toBe('cancelled');
    } finally {
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('DELETE /uploads/:id is idempotent: a second call is a no-op (204, no extra SSE event)', async () => {
    const filename = 'cancel-idempotent.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 5 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 2 * MB);
      uploadId = aborted.uploadId;

      const first = await terminateUpload(aborted.uploadUrl);
      expect(first.status).toBe(204);
      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'cancelled'));
      const cancelledCountAfterFirst = eventsFor(stream, uploadId).filter(
        (event) => event.status === 'cancelled',
      ).length;

      const second = await terminateUpload(aborted.uploadUrl);
      expect(second.status).toBe(204);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(eventsFor(stream, uploadId).filter((event) => event.status === 'cancelled').length).toBe(
        cancelledCountAfterFirst,
      );
      expect(getUploadRow(uploadId)?.status).toBe('cancelled');
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('DELETE /uploads/:id is a no-op for an unknown id', async () => {
    const res = await terminateUpload('http://localhost:3000/uploads/does-not-exist');
    expect(res.status).toBe(204);
  });

  it('batch cancel: returns 204 promptly, cancels the non-success row, and leaves the success row untouched (§13.7-13.10)', async () => {
    const batchKey = crypto.randomBytes(32).toString('hex');
    const lastModified = Date.now();

    const file1Path = path.join(TMP_DIR, 'batch-cancel-1.mp4');
    const file2Path = path.join(TMP_DIR, 'batch-cancel-2.mp4');
    generateFile(file1Path, 1 * MB);
    generateFile(file2Path, 20 * MB);

    const stream = await openProgressStream();
    let file1Id: string | undefined;
    let file2Id: string | undefined;
    try {
      ({ uploadId: file1Id } = await tusUploadWithBatchMeta(file1Path, 'batch-cancel-1.mp4', 'video/mp4', {
        batchKey,
        lastModified,
        batchPosition: 0,
      }));

      const aborted = await startUploadAndAbort(file2Path, 'batch-cancel-2.mp4', 'video/mp4', 5 * MB, {
        batchKey,
        lastModified,
        batchPosition: 1,
      });
      file2Id = aborted.uploadId;

      const start = Date.now();
      const res = await deleteBatch(batchKey);
      expect(res.status).toBe(204);
      expect(Date.now() - start).toBeLessThan(1000);

      await waitFor(() => eventsFor(stream, file2Id!).some((event) => event.status === 'cancelled'));

      expect(getUploadRow(file1Id)?.status).toBe('success');
      expect(getUploadRow(file2Id)?.status).toBe('cancelled');
      expect(await listMultipartUploadIds(file2Id)).toEqual([]);
      expect(eventsFor(stream, file1Id).some((event) => event.status === 'cancelled')).toBe(false);
    } finally {
      stream.close();
      if (file1Id) {
        await deleteObjects([file1Id, `${file1Id}.info`]);
        deleteUploadRow(file1Id);
      }
      if (file2Id) {
        await deleteObjects([file2Id, `${file2Id}.info`]);
        deleteUploadRow(file2Id);
      }
      fs.rmSync(file1Path, { force: true });
      fs.rmSync(file2Path, { force: true });
    }
  });

  it('batch cancel is a no-op for an unknown/empty batch key', async () => {
    const res = await deleteBatch('does-not-exist');
    expect(res.status).toBe(204);
  });
});
