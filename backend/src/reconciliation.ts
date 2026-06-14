import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from './config';
import { getCompletedUploads, markUploadStatus } from './db';
import { broadcast } from './progress';
import { s3Client } from './s3client';

/**
 * Returns the set of all object keys currently in the bucket. A single
 * `ListObjectsV2` call is sufficient at PoC scale (§14.5).
 */
export async function listAllObjectKeys(): Promise<Set<string>> {
  const result = await s3Client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket }));
  return new Set((result.Contents ?? []).map((object) => object.Key).filter((key): key is string => !!key));
}

/**
 * M10 §14 reconciliation job: compares `success` rows against the actual
 * contents of the MinIO bucket. Any `success` row whose object has
 * disappeared is marked `missing` and broadcast over SSE so the frontend can
 * drop it from the files list/player and upload queue. Objects in the bucket
 * with no matching `success` row are logged as orphans (§14.4) and otherwise
 * ignored - `.info` keys (tus metadata objects) are excluded from this check
 * since every upload has one and they'd otherwise be logged on every tick.
 */
export async function runReconciliationOnce(): Promise<{ missing: number }> {
  const keys = await listAllObjectKeys();
  const completed = getCompletedUploads();

  let missing = 0;
  for (const row of completed) {
    if (!keys.has(row.storage_key)) {
      markUploadStatus(row.id, 'missing');
      broadcast({
        uploadId: row.id,
        status: 'missing',
        bytesReceived: row.bytes_received,
        bytesTotal: row.size,
      });
      missing += 1;
    }
  }

  const knownKeys = new Set(completed.map((row) => row.storage_key));
  for (const key of keys) {
    if (!knownKeys.has(key) && !key.endsWith('.info')) {
      // eslint-disable-next-line no-console
      console.warn('Orphaned object in bucket', key);
    }
  }

  return { missing };
}

export function startReconciliationInterval(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    runReconciliationOnce().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Reconciliation job failed', error);
    });
  }, intervalMs);
}
