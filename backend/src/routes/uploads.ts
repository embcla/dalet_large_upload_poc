import { Router } from 'express';
import type { S3Store } from '@tus/s3-store';
import { getUpload, markUploadStatus, touchLastSeen } from '../db';
import { abortUpload } from '../cleanup';

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

  router.post('/uploads/:id/abandon', async (req, res) => {
    const upload = getUpload(req.params.id);
    if (upload && upload.status !== 'success' && upload.status !== 'abandoned') {
      await abortUpload(datastore, req.params.id);
      markUploadStatus(req.params.id, 'abandoned');
    }
    res.status(204).end();
  });

  return router;
}
