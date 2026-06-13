import { Server } from '@tus/server';
import { EVENTS } from '@tus/utils';
import { S3Store } from '@tus/s3-store';
import type { Request, Response, NextFunction } from 'express';
import { config, isAcceptedExtension } from './config';
import { insertUpload, markUploadStatus, setBytesReceived } from './db';
import { broadcast } from './progress';

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

      insertUpload({
        id: upload.id,
        filename,
        size: upload.size ?? 0,
        mimeType: upload.metadata?.filetype ?? null,
        storageKey: upload.id,
      });

      return { res };
    },

    async onUploadFinish(_req, res, upload) {
      markUploadStatus(upload.id, 'success');
      setBytesReceived(upload.id, upload.size ?? 0);
      broadcast({
        uploadId: upload.id,
        status: 'success',
        bytesReceived: upload.size ?? 0,
        bytesTotal: upload.size ?? 0,
      });
      return { res };
    },
  });

  // M5 §9.4: emits a throttled progress event (and persists bytes_received)
  // as bytes are written, via POST_RECEIVE_V2 (the non-deprecated event).
  server.on(EVENTS.POST_RECEIVE_V2, (_req, upload) => {
    setBytesReceived(upload.id, upload.offset);
    broadcast({
      uploadId: upload.id,
      status: 'uploading',
      bytesReceived: upload.offset,
      bytesTotal: upload.size ?? 0,
    });
  });

  return (req: Request, res: Response, _next: NextFunction) => {
    server.handle(req, res);
  };
}
