import * as path from 'path';
import {
  tusUpload,
  postClientHash,
  getUploadRow,
  deleteUploadRow,
  deleteObjects,
  openProgressStream,
  waitFor,
  sha256OfFile,
} from './helpers';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

describe('M8 post-completion integrity check (§12.9-12.11)', () => {
  it('reconciles matching client/server hashes as verified', async () => {
    const filePath = path.join(FIXTURES_DIR, 'compatible.mp4');
    const stream = await openProgressStream();
    let uploadId: string | undefined;

    try {
      ({ uploadId } = await tusUpload(filePath, 'compatible.mp4', 'video/mp4'));

      await waitFor(() => stream.events.some((event) => event.uploadId === uploadId && event.status === 'success'));

      const expectedHash = await sha256OfFile(filePath);
      const res = await postClientHash(uploadId, expectedHash);
      expect(res.status).toBe(204);

      await waitFor(() =>
        stream.events.some((event) => event.uploadId === uploadId && event.hashVerified === true),
      );

      const row = getUploadRow(uploadId);
      expect(row?.client_file_hash).toBe(expectedHash);
      expect(row?.server_file_hash).toBe(expectedHash);
      expect(row?.hash_verified).toBeTruthy();
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
    }
  });

  it('flags a mismatching client hash as corrupt and marks the upload errored', async () => {
    const filePath = path.join(FIXTURES_DIR, 'compatible.mp4');
    const stream = await openProgressStream();
    let uploadId: string | undefined;

    try {
      ({ uploadId } = await tusUpload(filePath, 'compatible.mp4', 'video/mp4'));

      await waitFor(() => stream.events.some((event) => event.uploadId === uploadId && event.status === 'success'));

      const wrongHash = 'deadbeef'.padEnd(64, '0');
      const res = await postClientHash(uploadId, wrongHash);
      expect(res.status).toBe(204);

      await waitFor(() =>
        stream.events.some((event) => event.uploadId === uploadId && event.hashVerified === false),
      );

      const row = getUploadRow(uploadId);
      expect(row?.client_file_hash).toBe(wrongHash);
      expect(row?.hash_verified).toBeFalsy();
      expect(row?.status).toBe('error');
    } finally {
      stream.close();
      if (uploadId) {
        await deleteObjects([uploadId, `${uploadId}.info`]);
        deleteUploadRow(uploadId);
      }
    }
  });
});
