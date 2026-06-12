import { getExtension, isAcceptedExtension, publicConfig, MAX_FILE_SIZE_BYTES } from './config';

describe('getExtension', () => {
  it('returns the lowercased extension including the dot', () => {
    expect(getExtension('video.MP4')).toBe('.mp4');
    expect(getExtension('movie.mkv')).toBe('.mkv');
  });

  it('returns empty string when there is no extension', () => {
    expect(getExtension('noext')).toBe('');
    expect(getExtension('trailing.')).toBe('');
  });
});

describe('isAcceptedExtension', () => {
  it('accepts .mp4 and .mkv (case-insensitive)', () => {
    expect(isAcceptedExtension('movie.mp4')).toBe(true);
    expect(isAcceptedExtension('movie.MKV')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isAcceptedExtension('movie.avi')).toBe(false);
    expect(isAcceptedExtension('notes.txt')).toBe(false);
    expect(isAcceptedExtension('noextension')).toBe(false);
  });
});

describe('publicConfig', () => {
  it('exposes maxFileSizeBytes, acceptedExtensions and acceptedMimeTypes', () => {
    const cfg = publicConfig();
    expect(cfg.maxFileSizeBytes).toBe(MAX_FILE_SIZE_BYTES);
    expect(cfg.acceptedExtensions).toEqual(['.mp4', '.mkv']);
    expect(cfg.acceptedMimeTypes).toEqual(['video/mp4', 'video/x-matroska']);
  });
});
