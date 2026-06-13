import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import {
  tusUpload,
  startUploadAndAbort,
  getUploadRow,
  deleteUploadRow,
  deleteObjects,
  abandon,
  runCleanup,
  setLastSeen,
  getConfig,
  openProgressStream,
  waitFor,
  THROTTLED_TUS_ENDPOINT,
  ProgressEvent,
  ProgressStream,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m5');
const MB = 1024 * 1024;

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function eventsFor(stream: ProgressStream, uploadId: string): ProgressEvent[] {
  return stream.events.filter((event) => event.uploadId === uploadId);
}

describe('M5 backend-pushed live progress (SSE, §9)', () => {
  it('sends a snapshot of an in-progress upload on connect (§9.6)', async () => {
    const filename = 'snapshot.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    let uploadId: string | undefined;
    let stream: ProgressStream | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB));

      stream = await openProgressStream();
      await waitFor(() => eventsFor(stream!, uploadId!).length > 0);

      const row = getUploadRow(uploadId);
      const [snapshotEvent] = eventsFor(stream, uploadId);
      expect(snapshotEvent.status).toBe('uploading');
      expect(snapshotEvent.bytesTotal).toBe(row?.size);
      expect(snapshotEvent.bytesReceived).toBe(row?.bytes_received);
    } finally {
      stream?.close();
      if (uploadId) {
        await abandon(uploadId);
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('broadcasts a success event with bytesReceived === bytesTotal on completion (§9.3/§9.5)', async () => {
    const filename = 'success.mp4';
    const filePath = path.join(TMP_DIR, filename);
    const sizeBytes = 1 * MB;
    generateFile(filePath, sizeBytes);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4'));

      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'success'));

      const successEvent = eventsFor(stream, uploadId).find((event) => event.status === 'success');
      expect(successEvent?.bytesReceived).toBe(sizeBytes);
      expect(successEvent?.bytesTotal).toBe(sizeBytes);

      const row = getUploadRow(uploadId);
      expect(row?.status).toBe('success');
      expect(row?.bytes_received).toBe(sizeBytes);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('broadcasts an abandoned event when a session is abandoned (§9.12)', async () => {
    const filename = 'abandon.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB));

      const res = await abandon(uploadId);
      expect(res.status).toBe(204);

      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'abandoned'));

      const abandonedEvent = eventsFor(stream, uploadId).find((event) => event.status === 'abandoned');
      const row = getUploadRow(uploadId);
      expect(abandonedEvent?.bytesTotal).toBe(row?.size);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it('broadcasts an abandoned event when the cleanup job aborts a stale session (§2.11/§9.12)', async () => {
    const filename = 'cleanup.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 20 * MB);

    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB));

      const { heartbeatTimeoutSeconds } = await getConfig();
      const staleTimestamp = new Date(Date.now() - (heartbeatTimeoutSeconds + 30) * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      setLastSeen(uploadId, staleTimestamp);

      await runCleanup();

      await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'abandoned'));

      const abandonedEvent = eventsFor(stream, uploadId).find((event) => event.status === 'abandoned');
      const row = getUploadRow(uploadId);
      expect(abandonedEvent?.bytesTotal).toBe(row?.size);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it(
    'emits throttled progress events with non-decreasing bytesReceived while uploading (§9.4)',
    async () => {
      const filename = 'progress.mp4';
      const filePath = path.join(TMP_DIR, filename);
      const sizeBytes = 40 * MB;
      generateFile(filePath, sizeBytes);

      const stream = await openProgressStream();
      let uploadId: string | undefined;
      try {
        ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4', THROTTLED_TUS_ENDPOINT));

        await waitFor(() => eventsFor(stream, uploadId!).some((event) => event.status === 'success'));

        const events = eventsFor(stream, uploadId!);
        const progressEvents = events.filter((event) => event.status === 'uploading');
        expect(progressEvents.length).toBeGreaterThan(0);

        for (let i = 1; i < events.length; i++) {
          expect(events[i].bytesReceived).toBeGreaterThanOrEqual(events[i - 1].bytesReceived);
        }
        expect(progressEvents.some((event) => event.bytesReceived > 0 && event.bytesReceived < sizeBytes)).toBe(
          true,
        );

        const row = getUploadRow(uploadId);
        expect(row?.status).toBe('success');
        expect(row?.bytes_received).toBe(sizeBytes);
      } finally {
        stream.close();
        if (uploadId) {
          await deleteObjects([uploadId, `${uploadId}.info`]);
          deleteUploadRow(uploadId);
        }
        fs.rmSync(filePath, { force: true });
      }
    },
    60 * 1000,
  );
});
