import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import {
  tusUpload,
  tusUploadWithHeartbeat,
  startUploadAndAbort,
  resumeUpload,
  rewriteOrigin,
  getUploadRow,
  deleteUploadRow,
  getObjectSize,
  sha256OfObject,
  sha256OfFile,
  deleteObjects,
  abandon,
  getConfig,
  openProgressStream,
  waitFor,
  THROTTLED_BACKEND_URL,
  THROTTLED_TUS_ENDPOINT,
  ProgressStream,
} from './helpers';
import { addToxic, removeToxic, listToxics, BASELINE_TOXIC_NAME } from './toxiproxy/helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m3');
const MB = 1024 * 1024;

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  // Every test removes the toxics it adds; this is a backstop to catch a
  // leaked toxic from a failed test before it affects later tests.
  const toxics = await listToxics();
  expect(toxics.map((t) => t.name)).toEqual([BASELINE_TOXIC_NAME]);
});

function eventsFor(stream: ProgressStream, uploadId: string) {
  return stream.events.filter((event) => event.uploadId === uploadId);
}

describe('M3 network degradation via Toxiproxy (§7)', () => {
  it('completes an upload through the proxy with added latency (§7.2/§7.3)', async () => {
    const filename = 'latency.mp4';
    const filePath = path.join(TMP_DIR, filename);
    generateFile(filePath, 2 * MB);

    const toxicName = 'test-latency';
    await addToxic({ name: toxicName, type: 'latency', stream: 'upstream', attributes: { latency: 300, jitter: 100 } });

    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, filename, 'video/mp4', THROTTLED_TUS_ENDPOINT));

      const expectedHash = await sha256OfFile(filePath);
      expect(await getObjectSize(uploadId)).toBe(2 * MB);
      expect(await sha256OfObject(uploadId)).toBe(expectedHash);
      expect(getUploadRow(uploadId)?.status).toBe('success');
    } finally {
      await removeToxic(toxicName);
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
      fs.rmSync(filePath, { force: true });
    }
  });

  it(
    'survives a connection reset mid-resume and re-syncs over SSE (§2.4/§7/§9.11)',
    async () => {
      const filename = 'reset.mp4';
      const filePath = path.join(TMP_DIR, filename);
      const sizeBytes = 20 * MB;
      generateFile(filePath, sizeBytes);

      const toxicName = 'test-reset';
      let uploadId: string | undefined;
      let stream: ProgressStream | undefined;
      try {
        const aborted = await startUploadAndAbort(filePath, filename, 'video/mp4', 5 * MB);
        uploadId = aborted.uploadId;

        const bytesBeforeReset = getUploadRow(uploadId)?.bytes_received;

        await addToxic({ name: toxicName, type: 'reset_peer', stream: 'upstream', attributes: { timeout: 1 } });

        const throttledUploadUrl = rewriteOrigin(aborted.uploadUrl, THROTTLED_BACKEND_URL);
        await expect(resumeUpload(filePath, throttledUploadUrl)).rejects.toBeTruthy();

        // The reset connection never got through, so the upload is still
        // stalled at its pre-reset offset.
        expect(getUploadRow(uploadId)?.bytes_received).toBe(bytesBeforeReset);

        await removeToxic(toxicName);

        stream = await openProgressStream();
        await waitFor(() => eventsFor(stream!, uploadId!).length > 0);
        const [snapshotEvent] = eventsFor(stream, uploadId);
        expect(snapshotEvent.status).toBe('uploading');
        expect(snapshotEvent.bytesReceived).toBe(bytesBeforeReset);

        const result = await resumeUpload(filePath, aborted.uploadUrl);
        expect(result.errorStatus).toBeUndefined();
        expect(result.uploadId).toBe(uploadId);

        const expectedHash = await sha256OfFile(filePath);
        expect(await getObjectSize(uploadId)).toBe(sizeBytes);
        expect(await sha256OfObject(uploadId)).toBe(expectedHash);

        await waitFor(() => eventsFor(stream!, uploadId!).some((event) => event.status === 'success'));

        const events = eventsFor(stream, uploadId);
        expect(events.some((event) => event.status === 'error' || event.status === 'abandoned')).toBe(false);
        const successEvent = events.find((event) => event.status === 'success');
        expect(successEvent?.bytesReceived).toBe(sizeBytes);
        expect(successEvent?.bytesTotal).toBe(sizeBytes);
        expect(getUploadRow(uploadId)?.status).toBe('success');
      } finally {
        stream?.close();
        await removeToxic(toxicName).catch(() => undefined);
        if (uploadId) {
          await deleteObjects([uploadId, `${uploadId}.info`]);
          deleteUploadRow(uploadId);
        }
        fs.rmSync(filePath, { force: true });
      }
    },
    30 * 1000,
  );

  const slowScenario = process.env.SLOW_SCENARIOS === '1' ? it : it.skip;

  slowScenario(
    'keeps a heavily-throttled upload alive past the heartbeat timeout (§7.4/§9.10)',
    async () => {
      const filename = 'slow.mp4';
      const filePath = path.join(TMP_DIR, filename);
      const sizeBytes = 6 * MB;
      generateFile(filePath, sizeBytes);

      const toxicName = 'test-slow-bandwidth';
      const { heartbeatTimeoutSeconds } = await getConfig();

      await addToxic({ name: toxicName, type: 'bandwidth', stream: 'upstream', attributes: { rate: 50 } });

      const stream = await openProgressStream();
      let uploadId: string | undefined;
      try {
        const start = Date.now();
        ({ uploadId } = await tusUploadWithHeartbeat(filePath, filename, 'video/mp4', THROTTLED_TUS_ENDPOINT));
        const durationSeconds = (Date.now() - start) / 1000;

        expect(durationSeconds).toBeGreaterThan(heartbeatTimeoutSeconds);

        const row = getUploadRow(uploadId);
        expect(row?.status).toBe('success');
        expect(row?.bytes_received).toBe(sizeBytes);

        const events = eventsFor(stream, uploadId);
        expect(events.some((event) => event.status === 'abandoned')).toBe(false);
        for (let i = 1; i < events.length; i++) {
          expect(events[i].bytesReceived).toBeGreaterThanOrEqual(events[i - 1].bytesReceived);
        }
        const successEvent = events.find((event) => event.status === 'success');
        expect(successEvent?.bytesReceived).toBe(sizeBytes);
        expect(events.filter((event) => event.status !== 'success').every((event) => event.status === 'uploading')).toBe(
          true,
        );
      } finally {
        stream.close();
        await removeToxic(toxicName);
        if (uploadId) {
          await abandon(uploadId);
          await deleteObjects([uploadId, `${uploadId}.info`]);
          deleteUploadRow(uploadId);
        }
        fs.rmSync(filePath, { force: true });
      }
    },
    3 * 60 * 1000,
  );
});
