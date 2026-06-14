import { Router } from 'express';
import type { S3Store } from '@tus/s3-store';
import { getUpload, markUploadStatus, setClientFileHash, touchLastSeen } from '../db';
import { abortUpload } from '../cleanup';
import { broadcast, maybeBroadcastIntegrity } from '../progress';

/**
 * §2.11 heartbeat/abandon endpoints. Both are no-ops (still 204) for unknown
 * or already-terminal uploads so the frontend doesn't need to special-case
 * races with completion/cleanup.
 */
export function createUploadsRouter(datastore: S3Store): Router {
  const router = Router();

  router.post('/uploads/:id/heartbeat', (req, res) => {
    touchLastSeen(req.params.id);
    res.status(204).end();
  });

  // M8 §12.9-12.11: records the client's SHA-256 of the completed file and
  // broadcasts the reconciliation result once the server hash has also
  // been recorded (set asynchronously by tus.ts's onUploadFinish).
  router.post('/uploads/:id/client-hash', (req, res) => {
    const row = setClientFileHash(req.params.id, req.body?.hash);
    maybeBroadcastIntegrity(row);
    res.status(204).end();
  });

  router.post('/uploads/:id/abandon', async (req, res) => {
    const upload = getUpload(req.params.id);
    if (upload && upload.status !== 'success' && upload.status !== 'abandoned') {
      await abortUpload(datastore, req.params.id);
      markUploadStatus(req.params.id, 'abandoned');
      broadcast({
        uploadId: req.params.id,
        status: 'abandoned',
        bytesReceived: upload.bytes_received,
        bytesTotal: upload.size,
      });
    }
    res.status(204).end();
  });

  // M9 §13: permanent, user-initiated cancellation. Mounted before the tus
  // catch-all, so this intercepts the DELETE sent by tus.Upload#abort(true)
  // as well as direct calls. Idempotent: missing/already-cancelled/success
  // rows are a no-op 204.
  router.delete('/uploads/:id', async (req, res) => {
    const upload = getUpload(req.params.id);
    if (upload && upload.status !== 'cancelled' && upload.status !== 'success') {
      await abortUpload(datastore, req.params.id);
      markUploadStatus(req.params.id, 'cancelled');
      broadcast({
        uploadId: req.params.id,
        status: 'cancelled',
        bytesReceived: upload.bytes_received,
        bytesTotal: upload.size,
      });
    }
    res.status(204).end();
  });

  return router;
}
