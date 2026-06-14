import { classifyPlayable } from './ffprobe';

describe('classifyPlayable (§2.7 codec allowlist)', () => {
  it('mp4 + h264 + aac is playable', () => {
    expect(classifyPlayable('clip.mp4', 'h264', 'aac')).toBe(true);
  });

  it('mp4 + h264 with no audio stream is playable', () => {
    expect(classifyPlayable('clip.mp4', 'h264', null)).toBe(true);
  });

  it('mp4 + h264 + non-aac audio is not playable', () => {
    expect(classifyPlayable('clip.mp4', 'h264', 'mp3')).toBe(false);
  });

  it('mp4 + non-h264 video codec is not playable', () => {
    expect(classifyPlayable('clip.mp4', 'mpeg2video', 'aac')).toBe(false);
  });

  it('mkv is never playable, even with h264/aac', () => {
    expect(classifyPlayable('clip.mkv', 'h264', 'aac')).toBe(false);
  });

  it('mkv with mpeg2video is not playable', () => {
    expect(classifyPlayable('clip.mkv', 'mpeg2video', null)).toBe(false);
  });

  it('webm + vp9 is playable', () => {
    expect(classifyPlayable('clip.webm', 'vp9', 'opus')).toBe(true);
  });

  it('webm + vp8/av1 is playable', () => {
    expect(classifyPlayable('clip.webm', 'vp8', null)).toBe(true);
    expect(classifyPlayable('clip.webm', 'av1', null)).toBe(true);
  });

  it('webm + unsupported video codec is not playable', () => {
    expect(classifyPlayable('clip.webm', 'h264', 'aac')).toBe(false);
  });

  it('unknown extension is not playable', () => {
    expect(classifyPlayable('clip.avi', 'h264', 'aac')).toBe(false);
  });

  it('no video codec detected is not playable', () => {
    expect(classifyPlayable('clip.mp4', null, 'aac')).toBe(false);
  });
});
