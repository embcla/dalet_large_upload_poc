import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as tus from 'tus-js-client';
import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
export const TUS_ENDPOINT = `${BACKEND_URL}/uploads`;

const DB_PATH = path.join(__dirname, '../../backend/data/db.sqlite');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_SERVICE_ACCESS_KEY ?? 'media-uploader',
    secretAccessKey: process.env.MINIO_SERVICE_SECRET_KEY ?? 'media-uploader-secret',
  },
  // Avoids AWS SDK v3's default flexible-checksum middleware, which performs
  // a dynamic import() that fails under Jest's CommonJS VM
  // (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET = process.env.MINIO_BUCKET ?? 'media-uploads';

export interface UploadResult {
  uploadId: string;
  /** Final HTTP status if the upload was rejected before completing. */
  errorStatus?: number;
  errorBody?: string;
}

/**
 * Uploads `filePath` via tus, returning the tus upload id (parsed from the
 * final Location URL). Rejects with `{errorStatus, errorBody}` info attached
 * if the server refuses the upload (e.g. bad extension, oversized).
 */
export function tusUpload(filePath: string, filename: string, mimeType: string): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    const upload = new tus.Upload(stream, {
      endpoint: TUS_ENDPOINT,
      uploadSize: size,
      retryDelays: null,
      metadata: { filename, filetype: mimeType },
      onError: (error) => {
        const detailed = error as tus.DetailedError;
        const status = detailed.originalResponse?.getStatus();
        const body = detailed.originalResponse?.getBody();
        if (status !== undefined) {
          resolve({ uploadId: '', errorStatus: status, errorBody: body });
        } else {
          reject(error);
        }
      },
      onSuccess: () => {
        const url = upload.url ?? '';
        const uploadId = url.split('/').pop() ?? '';
        resolve({ uploadId });
      },
    });

    upload.start();
  });
}

/**
 * Sends a raw tus creation request (POST) without uploading any bytes.
 * Used to test server-side rejection (oversized / bad extension) without
 * generating a file.
 */
export async function tusCreate(uploadLength: number, filename: string, mimeType: string): Promise<Response> {
  const metadata = [
    `filename ${Buffer.from(filename).toString('base64')}`,
    `filetype ${Buffer.from(mimeType).toString('base64')}`,
  ].join(',');

  return fetch(TUS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(uploadLength),
      'Upload-Metadata': metadata,
    },
  });
}

export function getUploadRow(uploadId: string): { id: string; filename: string; size: number; status: string } | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare('SELECT id, filename, size, status FROM uploads WHERE id = ?').get(uploadId) as
      | { id: string; filename: string; size: number; status: string }
      | undefined;
  } finally {
    db.close();
  }
}

export function deleteUploadRow(uploadId: string): void {
  const db = new Database(DB_PATH);
  try {
    db.prepare('DELETE FROM uploads WHERE id = ?').run(uploadId);
  } finally {
    db.close();
  }
}

export async function getObjectSize(key: string): Promise<number | undefined> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return res.ContentLength;
  } catch {
    return undefined;
  }
}

export async function sha256OfObject(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const hash = crypto.createHash('sha256');
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function deleteObjects(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => undefined),
    ),
  );
}

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
