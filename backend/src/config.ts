export const ACCEPTED_EXTENSIONS = ['.mp4', '.mkv'] as const;
export const ACCEPTED_MIME_TYPES = ['video/mp4', 'video/x-matroska'] as const;
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

export const config = {
  port: Number(process.env.PORT ?? 3000),

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',

  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
  acceptedMimeTypes: ACCEPTED_MIME_TYPES,

  sqlitePath: process.env.SQLITE_PATH ?? './data/db.sqlite',

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'media-uploads',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    forcePathStyle: true,
  },
};

export type AppConfig = typeof config;

/**
 * Returns the lowercased file extension (including the leading dot), or ''
 * if the filename has none.
 */
export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) {
    return '';
  }
  return filename.slice(idx).toLowerCase();
}

/**
 * Validates a filename's extension against the accepted extensions allowlist.
 * This is the real enforcement boundary (§2.9 / M1) since MIME type is
 * unreliable for formats like .mkv.
 */
export function isAcceptedExtension(filename: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(getExtension(filename));
}

export function publicConfig() {
  return {
    maxFileSizeBytes: config.maxFileSizeBytes,
    acceptedExtensions: config.acceptedExtensions,
    acceptedMimeTypes: config.acceptedMimeTypes,
  };
}
