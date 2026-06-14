import * as tus from 'tus-js-client';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatSize(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[exponent]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return '—';
  }
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) {
    return '';
  }
  return filename.slice(idx).toLowerCase();
}

export function describeError(error: Error | tus.DetailedError): string {
  const detailed = error as tus.DetailedError;
  const body = detailed.originalResponse?.getBody()?.trim();
  return body ? body : error.message;
}

/** Converts a digest (e.g. from `crypto.subtle.digest`) to a lowercase hex string. */
export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sorts files by `name|size|lastModified` (M8 §12.3-12.8), giving a
 * deterministic `batch_position` assignment regardless of selection order —
 * re-selecting the same files after a reload reproduces the same order and
 * `batch_key`.
 */
export function sortFingerprint(files: File[]): File[] {
  return [...files].sort((a, b) => {
    const fa = `${a.name}|${a.size}|${a.lastModified}`;
    const fb = `${b.name}|${b.size}|${b.lastModified}`;
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
}

/**
 * SHA-256 of the joined `name|size|lastModified` tuples of `sortedFiles`
 * (M8 §12.3-12.8), used as the `batch_key` for cross-reload resume.
 */
export async function computeBatchKey(sortedFiles: File[]): Promise<string> {
  const fingerprint = sortedFiles.map((file) => `${file.name}|${file.size}|${file.lastModified}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
  return bufferToHex(digest);
}
