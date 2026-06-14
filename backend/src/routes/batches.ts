import { Router } from 'express';
import { getUploadsByBatchKey, touchLastSeenForBatch, UploadRow } from '../db';

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
export function createBatchesRouter(): Router {
  const router = Router();

  router.get('/batches/:batchKey', (req, res) => {
    res.json(getUploadsByBatchKey(req.params.batchKey).map(toManifestEntry));
  });

  router.post('/batches/:batchKey/pong', (req, res) => {
    touchLastSeenForBatch(req.params.batchKey);
    res.status(204).end();
  });

  return router;
}
