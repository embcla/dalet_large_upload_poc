import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as tus from 'tus-js-client';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
export const TUS_ENDPOINT = `${BACKEND_URL}/uploads`;

// Routed through toxiproxy (§ M5), which throttles upload bandwidth per
// UPLOAD_THROTTLE_RATE_KB (see toxiproxy/init.sh). Used by the M5 progress
// tests to slow uploads enough for multiple SSE progress events to land.
export const THROTTLED_BACKEND_URL = process.env.THROTTLED_BACKEND_URL ?? 'http://localhost:3001';
export const THROTTLED_TUS_ENDPOINT = `${THROTTLED_BACKEND_URL}/uploads`;

/** Rewrites the origin (scheme/host/port) of `url` to `baseUrl`, keeping the path. */
export function rewriteOrigin(url: string, baseUrl: string): string {
  const parsed = new URL(url);
  const base = new URL(baseUrl);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}

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

/** `batch_key`/`last_modified`/`batch_position` metadata (M8 §12.12). */
export interface BatchMeta {
  batchKey: string;
  lastModified: number;
  batchPosition: number;
}

/**
 * Uploads `filePath` via tus, returning the tus upload id (parsed from the
 * final Location URL). Rejects with `{errorStatus, errorBody}` info attached
 * if the server refuses the upload (e.g. bad extension, oversized).
 */
export function tusUpload(
  filePath: string,
  filename: string,
  mimeType: string,
  endpoint: string = TUS_ENDPOINT,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    const upload = new tus.Upload(stream, {
      endpoint,
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
 * Like `tusUpload`, but also sends `POST /uploads/:id/heartbeat` every
 * `heartbeatIntervalMs` once the upload's URL is known, mirroring the
 * frontend's heartbeat behaviour (§2.11/§2.12). Used by the M3 §7.4 test to
 * keep a slow, throttled upload from being marked `abandoned`.
 */
export function tusUploadWithHeartbeat(
  filePath: string,
  filename: string,
  mimeType: string,
  endpoint: string = TUS_ENDPOINT,
  heartbeatIntervalMs = 15_000,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);
    let timer: ReturnType<typeof setInterval> | undefined;

    const upload = new tus.Upload(stream, {
      endpoint,
      uploadSize: size,
      retryDelays: null,
      metadata: { filename, filetype: mimeType },
      onUploadUrlAvailable: () => {
        if (timer) {
          return;
        }
        const uploadId = (upload.url ?? '').split('/').pop() ?? '';
        timer = setInterval(() => {
          void heartbeat(uploadId);
        }, heartbeatIntervalMs);
      },
      onError: (error) => {
        clearInterval(timer);
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
        clearInterval(timer);
        const url = upload.url ?? '';
        const uploadId = url.split('/').pop() ?? '';
        resolve({ uploadId });
      },
    });

    upload.start();
  });
}

/**
 * Like `tusUpload`, but also sends `batchKey`/`lastModified`/`batchPosition`
 * metadata (M8 §12.12), persisted by `onUploadCreate` for batch-manifest
 * reconstruction.
 */
export function tusUploadWithBatchMeta(
  filePath: string,
  filename: string,
  mimeType: string,
  batchMeta: BatchMeta,
  endpoint: string = TUS_ENDPOINT,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    const upload = new tus.Upload(stream, {
      endpoint,
      uploadSize: size,
      retryDelays: null,
      metadata: {
        filename,
        filetype: mimeType,
        batchKey: batchMeta.batchKey,
        lastModified: String(batchMeta.lastModified),
        batchPosition: String(batchMeta.batchPosition),
      },
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

export interface UploadRow {
  id: string;
  filename: string;
  size: number;
  status: string;
  last_seen: string;
  bytes_received: number;
  batch_key: string | null;
  last_modified: number | null;
  batch_position: number | null;
  client_file_hash: string | null;
  server_file_hash: string | null;
  hash_verified: number | null;
}

export function getUploadRow(uploadId: string): UploadRow | undefined {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, filename, size, status, last_seen, bytes_received,
                batch_key, last_modified, batch_position,
                client_file_hash, server_file_hash, hash_verified
         FROM uploads WHERE id = ?`,
      )
      .get(uploadId) as UploadRow | undefined;
  } finally {
    db.close();
  }
}

/** Directly rewrites last_seen, to simulate a session that stopped heartbeating long ago. */
export function setLastSeen(uploadId: string, sqliteDatetime: string): void {
  const db = new Database(DB_PATH);
  try {
    db.prepare('UPDATE uploads SET last_seen = ? WHERE id = ?').run(sqliteDatetime, uploadId);
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

export async function getConfig(): Promise<{ heartbeatTimeoutSeconds: number }> {
  const res = await fetch(`${BACKEND_URL}/config`);
  return (await res.json()) as { heartbeatTimeoutSeconds: number };
}

export async function heartbeat(uploadId: string): Promise<Response> {
  return fetch(`${TUS_ENDPOINT}/${uploadId}/heartbeat`, { method: 'POST' });
}

export async function abandon(uploadId: string): Promise<Response> {
  return fetch(`${TUS_ENDPOINT}/${uploadId}/abandon`, { method: 'POST' });
}

export async function runCleanup(): Promise<{ cleaned: number }> {
  const res = await fetch(`${BACKEND_URL}/internal/cleanup/run`, { method: 'POST' });
  return (await res.json()) as { cleaned: number };
}

/** Entry shape returned by `GET /batches/:batchKey` (M8 §12.3-12.8). */
export interface ManifestEntry {
  id: string;
  filename: string;
  size: number;
  lastModified: number | null;
  batchPosition: number | null;
  status: string;
  bytesReceived: number;
  storageKey: string;
}

export async function getBatchManifest(batchKey: string): Promise<ManifestEntry[]> {
  const res = await fetch(`${BACKEND_URL}/batches/${batchKey}`);
  return (await res.json()) as ManifestEntry[];
}

export async function pong(batchKey: string): Promise<Response> {
  return fetch(`${BACKEND_URL}/batches/${batchKey}/pong`, { method: 'POST' });
}

/**
 * Sends the tus-protocol termination request (M9 §13), mirroring
 * `tus.Upload#abort(true)`.
 */
export async function terminateUpload(uploadUrl: string): Promise<Response> {
  return fetch(uploadUrl, { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0' } });
}

/** "Cancel remaining" for a whole batch (M9 §13.8). */
export async function deleteBatch(batchKey: string): Promise<Response> {
  return fetch(`${BACKEND_URL}/batches/${batchKey}`, { method: 'DELETE' });
}

export async function postClientHash(uploadId: string, hash: string): Promise<Response> {
  return fetch(`${TUS_ENDPOINT}/${uploadId}/client-hash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
}

/** Returns the S3 multipart UploadIds currently open for `key`, if any. */
export async function listMultipartUploadIds(key: string): Promise<string[]> {
  const res = await s3.send(new ListMultipartUploadsCommand({ Bucket: BUCKET }));
  return (res.Uploads ?? []).filter((u) => u.Key === key).map((u) => u.UploadId ?? '');
}

export interface AbortedUpload {
  uploadUrl: string;
  uploadId: string;
  offsetAtAbort: number;
}

/**
 * Starts a tus upload and aborts it (closing the connection, §2.4) once at
 * least `abortAtBytes` have been sent, leaving the upload resumable.
 */
export function startUploadAndAbort(
  filePath: string,
  filename: string,
  mimeType: string,
  abortAtBytes: number,
  batchMeta?: BatchMeta,
): Promise<AbortedUpload> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);
    let settled = false;

    const upload = new tus.Upload(stream, {
      endpoint: TUS_ENDPOINT,
      uploadSize: size,
      retryDelays: null,
      // Forces tus-js-client to send `abortAtBytes` as a single PATCH and
      // wait for its response before sending more, so onProgress fires once
      // that chunk is fully processed server-side and abort() reliably lands
      // before the next PATCH — without this, a fast loopback connection can
      // flush the whole file to the socket (and the server can finish
      // processing it) before onProgress/abort ever runs.
      chunkSize: abortAtBytes,
      metadata: batchMeta
        ? {
            filename,
            filetype: mimeType,
            batchKey: batchMeta.batchKey,
            lastModified: String(batchMeta.lastModified),
            batchPosition: String(batchMeta.batchPosition),
          }
        : { filename, filetype: mimeType },
      onProgress: (bytesUploaded) => {
        if (settled || bytesUploaded < abortAtBytes) {
          return;
        }
        settled = true;
        upload
          .abort()
          .then(() => {
            const url = upload.url ?? '';
            resolve({ uploadUrl: url, uploadId: url.split('/').pop() ?? '', offsetAtAbort: bytesUploaded });
          })
          .catch(reject);
      },
      onError: (error) => {
        if (!settled) {
          reject(error);
        }
      },
      onSuccess: () => {
        if (!settled) {
          reject(new Error('upload completed before it could be aborted'));
        }
      },
    });

    upload.start();
  });
}

/** Resumes a previously-aborted upload from its recorded offset to completion. */
export function resumeUpload(filePath: string, uploadUrl: string): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const stream = fs.createReadStream(filePath);

    const upload = new tus.Upload(stream, {
      endpoint: TUS_ENDPOINT,
      uploadUrl,
      uploadSize: size,
      retryDelays: null,
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

export interface ProgressEvent {
  uploadId: string;
  status: string;
  bytesReceived: number;
  bytesTotal: number;
  message?: string;
  /** Result of the M8 §12.9-12.11 client/server hash reconciliation. */
  hashVerified?: boolean;
}

export interface ProgressStream {
  /** Events received so far, in order (mutated in place as more arrive). */
  events: ProgressEvent[];
  /** Number of named `ping` events received so far (M8 §12.1/12.2). */
  pings: number;
  /** Closes the underlying SSE connection. */
  close: () => void;
}

/**
 * Connects to `GET /progress/stream` (M5 §9) and appends every `data:`
 * payload it receives to `events`. Resolves once the connection is open
 * (after the initial snapshot has started streaming). Also counts named
 * `event: ping` lines into `pings` (M8 §12.1/12.2).
 */
export async function openProgressStream(): Promise<ProgressStream> {
  const events: ProgressEvent[] = [];
  const controller = new AbortController();
  const stream: ProgressStream = { events, pings: 0, close: () => controller.abort() };

  const res = await fetch(`${BACKEND_URL}/progress/stream`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') {
            currentEvent = undefined;
          } else if (line.startsWith('event: ')) {
            currentEvent = line.slice('event: '.length);
          } else if (line.startsWith('data: ')) {
            if (currentEvent === 'ping') {
              stream.pings += 1;
            } else {
              events.push(JSON.parse(line.slice('data: '.length)) as ProgressEvent);
            }
          }
        }
      }
    } catch {
      // expected once `close()` aborts the connection
    }
  })();

  return stream;
}

/** Polls `predicate` until it returns true or `timeoutMs` elapses. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
