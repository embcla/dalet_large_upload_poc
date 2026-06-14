import { Server } from '@tus/server';
import { EVENTS } from '@tus/utils';
import { S3Store } from '@tus/s3-store';
import type { Request, Response, NextFunction } from 'express';
import { config, isAcceptedExtension } from './config';
import { getUpload, insertUpload, markUploadStatus, setBytesReceived, setProbedMetadata, setServerFileHash } from './db';
import { computeServerHash } from './integrity';
import { probeObject } from './ffprobe';
import { broadcast, maybeBroadcastIntegrity } from './progress';

export function createDatastore(): S3Store {
  return new S3Store({
    partSize: 8 * 1024 * 1024,
    s3ClientConfig: {
      bucket: config.s3.bucket,
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    },
  });
}

export function createTusHandler(datastore: S3Store) {
  const server = new Server({
    path: '/uploads',
    datastore,
    maxSize: config.maxFileSizeBytes,
    postReceiveInterval: config.progressThrottleMs,

    async onUploadCreate(_req, res, upload) {
      const filename = upload.metadata?.filename ?? '';

      if (!isAcceptedExtension(filename)) {
        throw {
          status_code: 415,
          body: `Unsupported file type. Accepted extensions: ${config.acceptedExtensions.join(', ')}\n`,
        };
      }

      // M8 §12.12: every upload belongs to a batch (single files are
      // "batches of one"), keyed/positioned by the frontend's
      // `computeBatchKey`/`sortFingerprint`.
      const metadata = upload.metadata ?? {};
      const batchKey = metadata.batchKey ?? null;
      const lastModified = metadata.lastModified !== undefined ? Number(metadata.lastModified) : null;
      const batchPosition = metadata.batchPosition !== undefined ? Number(metadata.batchPosition) : null;

      insertUpload({
        id: upload.id,
        filename,
        size: upload.size ?? 0,
        mimeType: upload.metadata?.filetype ?? null,
        storageKey: upload.id,
        batchKey,
        lastModified,
        batchPosition,
      });

      return { res };
    },

    async onUploadFinish(_req, res, upload) {
      markUploadStatus(upload.id, 'success');
      setBytesReceived(upload.id, upload.size ?? 0);

      // M7 §11: probe the completed object for duration/resolution/codec and
      // classify it as `playable` before broadcasting `success`, so the
      // frontend's SSE-triggered `GET /files` refetch sees full metadata.
      const filename = upload.metadata?.filename ?? '';
      const probeResult = await probeObject(upload.id, filename);
      setProbedMetadata(upload.id, probeResult);

      broadcast({
        uploadId: upload.id,
        status: 'success',
        bytesReceived: upload.size ?? 0,
        bytesTotal: upload.size ?? 0,
      });

      // M8 §12.9-12.11: hash the completed object server-side, without
      // blocking the response — the integrity result is broadcast over SSE
      // once both the client and server hashes have been recorded.
      computeServerHash(upload.id)
        .then((hash) => {
          const row = setServerFileHash(upload.id, hash);
          maybeBroadcastIntegrity(row);
        })
        .catch(() => {});

      return { res };
    },
  });

  // M5 §9.4: emits a throttled progress event (and keeps bytes_received fresh
  // during a long PATCH) as bytes are written, via POST_RECEIVE_V2 (the
  // non-deprecated event; the deprecated POST_RECEIVE has an incompatible
  // (req, res, upload) signature).
  //
  // M9 §13: a chunk that was in flight when the upload got cancelled can
  // still finish writing and fire this event afterwards. If it broadcast
  // 'uploading' after the DELETE handler's 'cancelled' broadcast, the
  // frontend would see 'uploading' as the latest event and get stuck on
  // "Cancelling...". Once cancelled, suppress further progress for this id.
  server.on(EVENTS.POST_RECEIVE_V2, (_req, upload) => {
    if (getUpload(upload.id)?.status === 'cancelled') {
      return;
    }
    setBytesReceived(upload.id, upload.offset);
    broadcast({
      uploadId: upload.id,
      status: 'uploading',
      bytesReceived: upload.offset,
      bytesTotal: upload.size ?? 0,
    });
  });

  return (req: Request, res: Response, _next: NextFunction) => {
    // `server.handle` returns a promise that can reject if its own internal
    // error-response write fails (e.g. a concurrent DELETE/abort races an
    // in-flight PATCH's S3 part upload, which can surface as a write-after-
    // abort here). Left unhandled, that rejection crashes the whole process.
    server.handle(req, res).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Unhandled tus handler error', error);
      if (!res.headersSent) {
        res.status(500).end();
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    // M8 §12.3-12.8: POST_RECEIVE_V2 above is throttled (postReceiveInterval),
    // so a PATCH that completes faster than one throttle tick can leave
    // bytes_received stale for the batch manifest. Per the tus protocol, a
    // successful PATCH writes exactly `Content-Length` bytes starting at the
    // request's `Upload-Offset` header, so the new offset is computable
    // synchronously here on response finish, without a deprecated event.
    if (req.method === 'PATCH') {
      res.once('finish', () => {
        if (res.statusCode !== 204) {
          return;
        }
        const id = req.params[0];
        const startOffset = Number(req.headers['upload-offset']);
        const chunkLength = Number(req.headers['content-length']);
        if (!id || Number.isNaN(startOffset) || Number.isNaN(chunkLength)) {
          return;
        }
        if (getUpload(id)?.status === 'cancelled') {
          return;
        }
        setBytesReceived(id, startOffset + chunkLength);
      });
    }
  };
}
