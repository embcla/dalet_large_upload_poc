import { Router } from 'express';
import type { Readable } from 'stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { config, getExtension } from '../config';
import { getCompletedUploads, getUpload, UploadRow } from '../db';
import { s3Client } from '../s3client';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
};

interface FileMetadata {
  id: string;
  filename: string;
  size: number;
  status: string;
  duration: number | null;
  resolution: string | null;
  codec: string | null;
  playable: boolean;
}

function toFileMetadata(row: UploadRow): FileMetadata {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    status: row.status,
    duration: row.duration_seconds,
    resolution: row.width && row.height ? `${row.width}x${row.height}` : null,
    codec: row.audio_codec ? `${row.video_codec}/${row.audio_codec}` : row.video_codec,
    playable: !!row.playable,
  };
}

/**
 * M7 §11: lists completed uploads (for the files list / player panel) and
 * proxies ranged reads of the underlying object so a `<video>` element can
 * seek.
 */
export function createFilesRouter(): Router {
  const router = Router();

  router.get('/files', (_req, res) => {
    res.json(getCompletedUploads().map(toFileMetadata));
  });

  router.get('/files/:id/stream', async (req, res) => {
    const upload = getUpload(req.params.id);
    if (!upload || upload.status !== 'success') {
      res.status(404).end();
      return;
    }

    const range = req.headers.range;
    try {
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: config.s3.bucket,
          Key: upload.storage_key,
          Range: range,
        }),
      );

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', CONTENT_TYPES[getExtension(upload.filename)] ?? 'application/octet-stream');
      if (object.ContentLength !== undefined) {
        res.setHeader('Content-Length', String(object.ContentLength));
      }

      if (range && object.ContentRange) {
        res.status(206);
        res.setHeader('Content-Range', object.ContentRange);
      } else {
        res.status(200);
      }

      (object.Body as Readable).pipe(res);
    } catch {
      res.status(404).end();
    }
  });

  return router;
}
