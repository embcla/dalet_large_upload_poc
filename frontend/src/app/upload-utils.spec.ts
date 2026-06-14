import { bufferToHex, computeBatchKey, sortFingerprint } from './upload-utils';

function makeFile(name: string, size: number, lastModified: number): File {
  return new File([new Uint8Array(size)], name, { lastModified });
}

describe('bufferToHex', () => {
  it('matches the known SHA-256 digest of the empty string', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(0));

    expect(bufferToHex(digest)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('sortFingerprint', () => {
  it('sorts files by name|size|lastModified ascending', () => {
    const a = makeFile('b.mp4', 100, 1000);
    const b = makeFile('a.mp4', 100, 1000);
    const c = makeFile('a.mp4', 50, 1000);

    expect(sortFingerprint([a, b, c])).toEqual([c, b, a]);
  });

  it('returns the same order regardless of input order', () => {
    const a = makeFile('one.mp4', 100, 1000);
    const b = makeFile('two.mp4', 200, 2000);
    const c = makeFile('three.mp4', 300, 3000);

    expect(sortFingerprint([a, b, c])).toEqual(sortFingerprint([c, a, b]));
  });
});

describe('computeBatchKey', () => {
  it('is deterministic and independent of input order', async () => {
    const a = makeFile('one.mp4', 100, 1000);
    const b = makeFile('two.mp4', 200, 2000);

    const key1 = await computeBatchKey(sortFingerprint([a, b]));
    const key2 = await computeBatchKey(sortFingerprint([b, a]));

    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different file sets', async () => {
    const a = makeFile('one.mp4', 100, 1000);
    const b = makeFile('two.mp4', 200, 2000);
    const c = makeFile('three.mp4', 300, 3000);

    const key1 = await computeBatchKey(sortFingerprint([a, b]));
    const key2 = await computeBatchKey(sortFingerprint([a, c]));

    expect(key1).not.toBe(key2);
  });
});
