import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config';
import { s3Client } from './s3client';

/**
 * Computes the SHA-256 of a completed upload's object (M8 §12.9-12.11),
 * streamed from MinIO via the shared `s3Client` rather than loaded fully
 * into memory.
 */
export async function computeServerHash(storageKey: string): Promise<string> {
  const object = await s3Client.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: storageKey }),
  );

  const hash = createHash('sha256');
  for await (const chunk of object.Body as Readable) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
