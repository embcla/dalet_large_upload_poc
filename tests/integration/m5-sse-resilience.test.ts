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
  abandon,
  openProgressStream,
  waitFor,
  ProgressStream,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m5-resilience');
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

describe('M5 SSE resilience (§9.9/§9.11)', () => {
  it('a fresh SSE connection re-syncs an in-progress upload via the snapshot (§9.9)', async () => {
    const filename = 'resync.mp4';
    const filePath = path.join(TMP_DIR, filename);
    const sizeBytes = 20 * MB;
    generateFile(filePath, sizeBytes);

    let uploadId: string | undefined;
    let secondStream: ProgressStream | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);
      uploadId = aborted.uploadId;

      const firstStream = await openProgressStream();
      await waitFor(() => eventsFor(firstStream, uploadId!).length > 0);
      firstStream.close();

      secondStream = await openProgressStream();
      await waitFor(() => eventsFor(secondStream!, uploadId!).length > 0);

      const [snapshotEvent] = eventsFor(secondStream, uploadId);
      const row = getUploadRow(uploadId);
      expect(snapshotEvent.status).toBe('uploading');
      expect(snapshotEvent.bytesReceived).toBe(row?.bytes_received);
      expect(snapshotEvent.bytesTotal).toBe(row?.size);
    } finally {
      secondStream?.close();
      if (uploadId) {
        await abandon(uploadId);
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('shows a dropped upload as still uploading, then resumes to success, with no spurious terminal events (§9.11)', async () => {
    const filename = 'drop-resume.mp4';
    const filePath = path.join(TMP_DIR, filename);
    const sizeBytes = 20 * MB;
    generateFile(filePath, sizeBytes);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);
      uploadId = aborted.uploadId;

      await waitFor(() =>
        eventsFor(stream, uploadId!).some(
          (event) => event.status === 'uploading' && event.bytesReceived === aborted.offsetAtAbort,
        ),
      );
      expect(eventsFor(stream, uploadId).some((event) => event.status !== 'uploading')).toBe(false);

      const result = await resumeUpload(filePath, aborted.uploadUrl);
      expect(result.errorStatus).toBeUndefined();

      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'success'));

      const events = eventsFor(stream, uploadId);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].bytesReceived).toBeGreaterThanOrEqual(events[i - 1].bytesReceived);
      }
      const terminalEvents = events.filter((event) => event.status !== 'uploading');
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0].status).toBe('success');
      expect(terminalEvents[0].bytesReceived).toBe(sizeBytes);
      expect(terminalEvents[0].bytesTotal).toBe(sizeBytes);

      const expectedHash = await sha256OfFile(filePath);
      expect(await getObjectSize(uploadId)).toBe(sizeBytes);
      expect(await sha256OfObject(uploadId)).toBe(expectedHash);
      expect(getUploadRow(uploadId)?.status).toBe('success');
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
