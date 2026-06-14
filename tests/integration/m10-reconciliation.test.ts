import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import {
  tusUpload,
  startUploadAndAbort,
  getUploadRow,
  deleteUploadRow,
  deleteObjects,
  openProgressStream,
  waitFor,
  runReconciliation,
  ProgressStream,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m10-reconciliation');
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

describe('M10 reconciliation (§14)', () => {
  it('marks a success row missing and broadcasts when its object is deleted out-of-band (§14.1-14.3)', async () => {
    const filename = 'reconcile-gone.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 1 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4'));
      expect(getUploadRow(uploadId)?.status).toBe('success');

      await deleteObjects([uploadId]);

      // The 5s auto-interval could win the race against this manual trigger,
      // so don't assert on `missing` here - just that the row ends up
      // `missing` and an SSE event is observed (true regardless of which
      // reconciliation pass caught it).
      await runReconciliation();

      expect(getUploadRow(uploadId)?.status).toBe('missing');
      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'missing'));
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('leaves a success row untouched when its object is still present (§14.5)', async () => {
    const filename = 'reconcile-present.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 1 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4'));
      expect(getUploadRow(uploadId)?.status).toBe('success');

      await runReconciliation();

      expect(getUploadRow(uploadId)?.status).toBe('success');
      expect(eventsFor(stream, uploadId).some((event) => event.status === 'missing')).toBe(false);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('never touches a non-success row regardless of bucket contents (§14.6)', async () => {
    const filename = 'reconcile-non-success.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 5 * MB);

    let uploadId: string | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 2 * MB);
      uploadId = aborted.uploadId;

      const statusBefore = getUploadRow(uploadId)?.status;
      expect(statusBefore).not.toBe('success');

      await runReconciliation();

      expect(getUploadRow(uploadId)?.status).toBe(statusBefore);
    } finally {
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('is idempotent: a second run produces no additional missing event for an already-missing row', async () => {
    const filename = 'reconcile-idempotent.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 1 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4'));
      await deleteObjects([uploadId]);

      await runReconciliation();
      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'missing'));
      const missingCountAfterFirst = eventsFor(stream, uploadId).filter((event) => event.status === 'missing').length;

      const second = await runReconciliation();
      expect(second.missing).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(eventsFor(stream, uploadId).filter((event) => event.status === 'missing').length).toBe(
        missingCountAfterFirst,
      );
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });
});
