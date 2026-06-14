import { Router } from 'express';
import type { S3Store } from '@tus/s3-store';
import { getCancellableUploadsByBatchKey, getUploadsByBatchKey, markUploadStatus, touchLastSeenForBatch, UploadRow } from '../db';
import { abortUpload } from '../cleanup';
import { broadcast } from '../progress';

export interface BatchManifestEntry {
  id: string;
  filename: string;
  size: number;
  lastModified: number | null;
  batchPosition: number | null;
  status: string;
  bytesReceived: number;
  storageKey: string;
}

function toManifestEntry(row: UploadRow): BatchManifestEntry {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    lastModified: row.last_modified,
    batchPosition: row.batch_position,
    status: row.status,
    bytesReceived: row.bytes_received,
    storageKey: row.storage_key,
  };
}

/**
 * M8 §12.3-12.8: the batch manifest used to reconstruct the upload queue
 * across a page reload, and the pong endpoint that keeps a batch's active
 * upload alive (§12.1/12.2).
 */
export function createBatchesRouter(datastore: S3Store): Router {
  const router = Router();

  router.get('/batches/:batchKey', (req, res) => {
    res.json(getUploadsByBatchKey(req.params.batchKey).map(toManifestEntry));
  });

  router.post('/batches/:batchKey/pong', (req, res) => {
    touchLastSeenForBatch(req.params.batchKey);
    res.status(204).end();
  });

  // M9 §13.8: "Cancel remaining" - responds 204 once processing has started,
  // then cancels each still-cancellable row in the batch one at a time
  // (sequential, not Promise.all, so SSE events arrive progressively).
  router.delete('/batches/:batchKey', (req, res) => {
    const rows = getCancellableUploadsByBatchKey(req.params.batchKey);
    res.status(204).end();

    (async () => {
      for (const row of rows) {
        await abortUpload(datastore, row.id);
        markUploadStatus(row.id, 'cancelled');
        broadcast({
          uploadId: row.id,
          status: 'cancelled',
          bytesReceived: row.bytes_received,
          bytesTotal: row.size,
        });
      }
    })();
  });

  return router;
}
