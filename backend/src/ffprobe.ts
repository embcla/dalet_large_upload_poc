import { execFile } from 'child_process';
import { promisify } from 'util';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, getExtension } from './config';
import { s3Client } from './s3client';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  playable: boolean;
}

const NULL_PROBE_RESULT: ProbeResult = {
  durationSeconds: null,
  width: null,
  height: null,
  videoCodec: null,
  audioCodec: null,
  playable: false,
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/**
 * §2.7: browser-compatible codec allowlist, detect-and-fallback only (no
 * transcoding). `.mkv` is accepted for upload (§2.9) but never `playable` —
 * browsers don't render `video/x-matroska` in `<video>` regardless of the
 * inner codec.
 */
export function classifyPlayable(filename: string, videoCodec: string | null, audioCodec: string | null): boolean {
  const extension = getExtension(filename);
  if (extension === '.mp4') {
    return videoCodec === 'h264' && (audioCodec === null || audioCodec === 'aac');
  }
  if (extension === '.webm') {
    return videoCodec !== null && ['vp8', 'vp9', 'av1'].includes(videoCodec);
  }
  return false;
}

/**
 * Runs `ffprobe` against the MinIO object `storageKey` (via a short-lived
 * presigned URL, so ffprobe can issue its own ranged HTTP reads without
 * downloading the whole file) and extracts duration/resolution/codec
 * metadata (M7 §11). Never throws — a probe failure yields a result with
 * nulls and `playable: false` so it doesn't block `onUploadFinish`.
 */
export async function probeObject(storageKey: string, filename: string): Promise<ProbeResult> {
  try {
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: storageKey }),
      { expiresIn: 60 },
    );

    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );

    const data = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = data.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = data.streams?.find((stream) => stream.codec_type === 'audio');

    const durationSeconds = data.format?.duration ? Number(data.format.duration) : null;
    const width = videoStream?.width ?? null;
    const height = videoStream?.height ?? null;
    const videoCodec = videoStream?.codec_name ?? null;
    const audioCodec = audioStream?.codec_name ?? null;

    return {
      durationSeconds,
      width,
      height,
      videoCodec,
      audioCodec,
      playable: classifyPlayable(filename, videoCodec, audioCodec),
    };
  } catch {
    return NULL_PROBE_RESULT;
  }
}
