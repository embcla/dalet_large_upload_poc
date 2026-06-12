import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import {
  tusUpload,
  tusCreate,
  getUploadRow,
  deleteUploadRow,
  getObjectSize,
  sha256OfObject,
  sha256OfFile,
  deleteObjects,
} from './helpers';

const TMP_DIR = path.join(__dirname, '../generators/tmp');

const MB = 1024 * 1024;

// Default matrix: small files for fast feedback. Set FULL_MATRIX=1 to also
// run the large-file matrix from the spec (100/200/1000/2000 MB) -- this
// takes several minutes.
const DEFAULT_SIZES_MB = [5, 20];
const FULL_MATRIX_SIZES_MB = [100, 200, 1000, 2000];
const SIZES_MB = process.env.FULL_MATRIX === '1' ? [...DEFAULT_SIZES_MB, ...FULL_MATRIX_SIZES_MB] : DEFAULT_SIZES_MB;

const EXTENSIONS: Array<{ ext: string; mime: string }> = [
  { ext: '.mp4', mime: 'video/mp4' },
  { ext: '.mkv', mime: 'video/x-matroska' },
];

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('M1 upload matrix', () => {
  for (const sizeMb of SIZES_MB) {
    for (const { ext, mime } of EXTENSIONS) {
      it(`uploads a ${sizeMb}MB ${ext} file successfully`, async () => {
        const filename = `matrix-${sizeMb}mb${ext}`;
        const filePath = path.join(TMP_DIR, filename);
        generateFile(filePath, sizeMb * MB);

        const result = await tusUpload(filePath, filename, mime);
        expect(result.errorStatus).toBeUndefined();
        expect(result.uploadId).toBeTruthy();

        try {
          const expectedSize = sizeMb * MB;
          const expectedHash = await sha256OfFile(filePath);

          const objectSize = await getObjectSize(result.uploadId);
          expect(objectSize).toBe(expectedSize);

          const objectHash = await sha256OfObject(result.uploadId);
          expect(objectHash).toBe(expectedHash);

          const row = getUploadRow(result.uploadId);
          expect(row?.status).toBe('success');
          expect(row?.filename).toBe(filename);
          expect(row?.size).toBe(expectedSize);
        } finally {
          await deleteObjects([result.uploadId, `${result.uploadId}.info`]);
          deleteUploadRow(result.uploadId);
          fs.rmSync(filePath, { force: true });
        }
      });
    }
  }
});

describe('M1 rejection cases', () => {
  it('rejects an upload larger than the 2GB limit with 413 and stores nothing', async () => {
    const oversize = 2 * 1024 * 1024 * 1024 + 100 * MB; // 2.1GB
    const res = await tusCreate(oversize, 'too-big.mp4', 'video/mp4');
    expect(res.status).toBe(413);
  });

  it('rejects a disallowed file extension with a 4xx and stores nothing', async () => {
    const res = await tusCreate(1024, 'notes.txt', 'text/plain');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const body = await res.text();
    expect(body).toMatch(/unsupported file type/i);
  });
});
