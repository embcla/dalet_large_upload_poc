import { createHash } from 'crypto';
import { Readable } from 'stream';

jest.mock('./s3client', () => ({
  s3Client: { send: jest.fn() },
}));

import { s3Client } from './s3client';
import { computeServerHash } from './integrity';

describe('computeServerHash (M8 §12.9-12.11)', () => {
  it('returns the SHA-256 hex digest of the object body', async () => {
    const buffer = Buffer.from('hello world');
    (s3Client.send as jest.Mock).mockResolvedValue({ Body: Readable.from(buffer) });

    const hash = await computeServerHash('some-storage-key');

    expect(hash).toBe(createHash('sha256').update(buffer).digest('hex'));
  });
});
