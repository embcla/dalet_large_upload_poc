import * as fs from 'fs';
import * as path from 'path';
import { tusUpload, deleteUploadRow, deleteObjects, openProgressStream, waitFor, BACKEND_URL } from './helpers';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

interface FileMetadata {
  id: string;
  filename: string;
  size: number;
  status: string;
  duration: number | null;
  resolution: string | null;
  codec: string | null;
  playable: boolean;
}

async function getFiles(): Promise<FileMetadata[]> {
  const res = await fetch(`${BACKEND_URL}/files`);
  return (await res.json()) as FileMetadata[];
}

describe('M7 uploaded files visualization & playback (§11)', () => {
  it('probes a browser-compatible mp4 and reports duration/resolution/codec/playable', async () => {
    const filePath = path.join(FIXTURES_DIR, 'compatible.mp4');
    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, 'compatible.mp4', 'video/mp4'));

      await waitFor(() => stream.events.some((event) => event.uploadId === uploadId && event.status === 'success'));

      const files = await getFiles();
      const file = files.find((f) => f.id === uploadId);

      expect(file).toBeDefined();
      expect(file?.duration).toBeCloseTo(2, 0);
      expect(file?.resolution).toBe('320x240');
      expect(file?.codec).toContain('h264');
      expect(file?.codec).toContain('aac');
      expect(file?.playable).toBe(true);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
    }
  });

  it('probes an incompatible mkv and reports playable: false', async () => {
    const filePath = path.join(FIXTURES_DIR, 'incompatible.mkv');
    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, 'incompatible.mkv', 'video/x-matroska'));

      await waitFor(() => stream.events.some((event) => event.uploadId === uploadId && event.status === 'success'));

      const files = await getFiles();
      const file = files.find((f) => f.id === uploadId);

      expect(file).toBeDefined();
      expect(file?.codec).toContain('mpeg2video');
      expect(file?.playable).toBe(false);
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
    }
  });

  it('supports HTTP Range requests on the stream endpoint (§11 playback seeking)', async () => {
    const filePath = path.join(FIXTURES_DIR, 'compatible.mp4');
    const size = fs.statSync(filePath).size;
    const stream = await openProgressStream();
    let uploadId: string | undefined;
    try {
      ({ uploadId } = await tusUpload(filePath, 'compatible.mp4', 'video/mp4'));

      await waitFor(() => stream.events.some((event) => event.uploadId === uploadId && event.status === 'success'));

      const rangeRes = await fetch(`${BACKEND_URL}/files/${uploadId}/stream`, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-1023/${size}`);
      expect(rangeRes.headers.get('accept-ranges')).toBe('bytes');
      const rangeBody = await rangeRes.arrayBuffer();
      expect(rangeBody.byteLength).toBe(1024);

      const fullRes = await fetch(`${BACKEND_URL}/files/${uploadId}/stream`);
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get('accept-ranges')).toBe('bytes');
      expect(fullRes.headers.get('content-length')).toBe(String(size));
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
    }
  });
});
