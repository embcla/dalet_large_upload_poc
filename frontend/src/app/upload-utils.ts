import * as tus from 'tus-js-client';

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
