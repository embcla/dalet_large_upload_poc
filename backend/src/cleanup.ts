import type { S3Store } from '@tus/s3-store';
import { ERRORS } from '@tus/server';
import { config } from './config';
import { getStaleUploads, markUploadStatus } from './db';
import { broadcast } from './progress';

/**
 * Aborts the MinIO multipart upload for `id` and removes the in-progress
 * object/metadata. Tolerates an upload that's already gone.
 *
 * `@tus/s3-store#remove` is meant to throw `ERRORS.FILE_NOT_FOUND` in this
 * case, but its check for the AWS error code is broken (it reads
 * `error.code` while the SDK sets `error.Code`), so a raw AWS SDK
 * `NoSuchKey`/`NoSuchUpload`/`NotFound` error (404) can also surface here -
 * tolerate that shape too.
 */
export async function abortUpload(datastore: S3Store, id: string): Promise<void> {
  try {
    await datastore.remove(id);
  } catch (error) {
    const statusCode =
      (error as { status_code?: number; $metadata?: { httpStatusCode?: number } } | undefined)?.status_code ??
      (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
    const code = (error as { Code?: string; name?: string } | undefined)?.Code;
    if (
      statusCode === ERRORS.FILE_NOT_FOUND.status_code ||
      code === 'NoSuchKey' ||
      code === 'NoSuchUpload' ||
      code === 'NotFound'
    ) {
      return;
    }
    throw error;
  }
}

/**
 * §2.11 cleanup job: finds uploads with no heartbeat within the configured
 * timeout, aborts their MinIO multipart uploads, and marks them abandoned.
 * Returns the number of sessions cleaned up.
 */
export async function runCleanupOnce(datastore: S3Store): Promise<number> {
  const stale = getStaleUploads(config.heartbeatTimeoutSeconds);

  for (const row of stale) {
    await abortUpload(datastore, row.id);
    markUploadStatus(row.id, 'abandoned');
    broadcast({
      uploadId: row.id,
      status: 'abandoned',
      bytesReceived: row.bytes_received,
      bytesTotal: row.size,
    });
  }

  return stale.length;
}

export function startCleanupInterval(datastore: S3Store, intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    runCleanupOnce(datastore).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Cleanup job failed', error);
    });
  }, intervalMs);
}
