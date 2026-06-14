import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateFile } from '../generators/generate-file';
import {
  tusUploadWithBatchMeta,
  startUploadAndAbort,
  resumeUpload,
  getBatchManifest,
  getUploadRow,
  deleteUploadRow,
  deleteObjects,
  getObjectSize,
  sha256OfObject,
  sha256OfFile,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp-m8-manifest');
const MB = 1024 * 1024;

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('M8 batch manifest (§12.3-12.8, §12.12)', () => {
  it('reconstructs a batch from completed, in-progress, and not-yet-started files', async () => {
    const batchKey = crypto.randomBytes(32).toString('hex');
    const lastModified = Date.now();

    const file1Path = path.join(TMP_DIR, 'manifest-1.mp4');
    const file2Path = path.join(TMP_DIR, 'manifest-2.mp4');
    generateFile(file1Path, 1 * MB);
    generateFile(file2Path, 20 * MB);

    let file1Id: string | undefined;
    let file2Id: string | undefined;

    try {
      ({ uploadId: file1Id } = await tusUploadWithBatchMeta(file1Path, 'manifest-1.mp4', 'video/mp4', {
        batchKey,
        lastModified,
        batchPosition: 0,
      }));

      const aborted = await startUploadAndAbort(file2Path, 'manifest-2.mp4', 'video/mp4', 5 * MB, {
        batchKey,
        lastModified,
        batchPosition: 1,
      });
      file2Id = aborted.uploadId;

      // DB rows carry the batch metadata populated via onUploadCreate (§12.12).
      expect(getUploadRow(file1Id)?.batch_key).toBe(batchKey);
      expect(getUploadRow(file1Id)?.last_modified).toBe(lastModified);
      expect(getUploadRow(file1Id)?.batch_position).toBe(0);
      expect(getUploadRow(file2Id)?.batch_key).toBe(batchKey);
      expect(getUploadRow(file2Id)?.last_modified).toBe(lastModified);
      expect(getUploadRow(file2Id)?.batch_position).toBe(1);

      let manifest = await getBatchManifest(batchKey);
      expect(manifest).toHaveLength(2);
      expect(manifest.map((entry) => entry.batchPosition)).toEqual([0, 1]);

      const [entry1, entry2] = manifest;
      expect(entry1.id).toBe(file1Id);
      expect(entry1.status).toBe('success');
      expect(entry1.bytesReceived).toBe(1 * MB);

      expect(entry2.id).toBe(file2Id);
      expect(entry2.status).toBe('uploading');
      expect(entry2.bytesReceived).toBe(aborted.offsetAtAbort);

      // Resume file2 to completion; the manifest now reports it `success` too.
      const resumed = await resumeUpload(file2Path, aborted.uploadUrl);
      expect(resumed.errorStatus).toBeUndefined();
      expect(resumed.uploadId).toBe(file2Id);

      const expectedHash = await sha256OfFile(file2Path);
      expect(await getObjectSize(file2Id)).toBe(20 * MB);
      expect(await sha256OfObject(file2Id)).toBe(expectedHash);

      manifest = await getBatchManifest(batchKey);
      const resumedEntry = manifest.find((entry) => entry.id === file2Id);
      expect(resumedEntry?.status).toBe('success');
      expect(resumedEntry?.bytesReceived).toBe(20 * MB);
    } finally {
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

  it('returns an empty array for an unknown batch key', async () => {
    expect(await getBatchManifest('does-not-exist')).toEqual([]);
  });
});
