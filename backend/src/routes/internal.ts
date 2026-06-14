import { Router } from 'express';
import type { S3Store } from '@tus/s3-store';
import { runCleanupOnce } from '../cleanup';
import { runReconciliationOnce } from '../reconciliation';

/**
 * Test-support endpoint: runs one pass of the §2.11 cleanup job synchronously
 * so integration tests can assert its effects without waiting for the
 * interval timer or real wall-clock time.
 */
export function createInternalRouter(datastore: S3Store): Router {
  const router = Router();

  router.post('/internal/cleanup/run', async (_req, res) => {
    const cleaned = await runCleanupOnce(datastore);
    res.status(200).json({ cleaned });
  });

  // M10 §14: test-support endpoint, mirrors /internal/cleanup/run above -
  // runs one pass of the reconciliation job synchronously.
  router.post('/internal/reconcile/run', async (_req, res) => {
    const result = await runReconciliationOnce();
    res.status(200).json(result);
  });

  return router;
}
