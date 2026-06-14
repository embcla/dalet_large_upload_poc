import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config';

/**
 * Shared S3 (MinIO) client, used directly for operations the `@tus/s3-store`
 * datastore doesn't expose: probing object metadata (M7 `ffprobe.ts`) and
 * proxying ranged reads (M7 `routes/files.ts`).
 */
export const s3Client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});
