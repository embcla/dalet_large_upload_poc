import type { S3Store } from '@tus/s3-store';
import { ERRORS } from '@tus/server';
import { config } from './config';
import { getStaleUploads, markUploadStatus } from './db';

/**
 * Aborts the MinIO multipart upload for `id` and removes the in-progress
 * object/metadata. Tolerates an upload that's already gone.
 */
export async function abortUpload(datastore: S3Store, id: string): Promise<void> {
  try {
    await datastore.remove(id);
  } catch (error) {
    if ((error as { status_code?: number } | undefined)?.status_code === ERRORS.FILE_NOT_FOUND.status_code) {
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
