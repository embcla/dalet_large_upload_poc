import { Server } from '@tus/server';
import { S3Store } from '@tus/s3-store';
import type { Request, Response, NextFunction } from 'express';
import { config, isAcceptedExtension } from './config';
import { insertUpload, markUploadStatus } from './db';

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
      return { res };
    },
  });

  return (req: Request, res: Response, _next: NextFunction) => {
    server.handle(req, res);
  };
}
