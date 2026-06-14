import { Router } from 'express';
import type { Request, Response } from 'express';
import { config } from './config';
import { getNonTerminalUploads, type UploadRow, type UploadStatus } from './db';

/**
 * A server->client push over the M5 (§9) SSE channel. `bytesReceived`/
 * `bytesTotal` reflect the `bytes_received`/`size` columns (server-confirmed
 * progress, §9.2/§9.5), not the client's local `onProgress`.
 */
export interface ProgressEvent {
  uploadId: string;
  status: UploadStatus;
  bytesReceived: number;
  bytesTotal: number;
  message?: string;
  /** Result of the M8 §12.9-12.11 client/server hash reconciliation. */
  hashVerified?: boolean;
}

const subscribers = new Set<Response>();
let nextEventId = 1;

function formatEvent(event: ProgressEvent): string {
  return `id: ${nextEventId++}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Pushes `event` to every connected SSE client (M5 §9.3/§9.4). */
export function broadcast(event: ProgressEvent): void {
  if (subscribers.size === 0) {
    return;
  }
  const message = formatEvent(event);
  for (const res of subscribers) {
    res.write(message);
  }
}

/**
 * Broadcasts the result of an integrity-hash reconciliation (M8
 * §12.9-12.11), if `row` now has a non-null `hash_verified` (i.e. both the
 * client and server hashes have been recorded). No-op otherwise (only one
 * side has reported so far, or the upload doesn't exist).
 */
export function maybeBroadcastIntegrity(row: UploadRow | undefined): void {
  if (!row || row.hash_verified === null) {
    return;
  }
  broadcast({
    uploadId: row.id,
    status: row.status,
    bytesReceived: row.bytes_received,
    bytesTotal: row.size,
    hashVerified: row.hash_verified === 1,
  });
}

/** Snapshot of all non-terminal uploads, sent on connect (M5 §9.6). */
function snapshot(): ProgressEvent[] {
  return getNonTerminalUploads().map((row) => ({
    uploadId: row.id,
    status: row.status,
    bytesReceived: row.bytes_received,
    bytesTotal: row.size,
  }));
}

/**
 * Handles a `GET /progress/stream` connection: sends the current snapshot,
 * registers the response for future broadcasts, and keeps the connection
 * alive until the client disconnects (M5 §9).
 */
export function handleProgressStream(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  for (const event of snapshot()) {
    res.write(formatEvent(event));
  }

  subscribers.add(res);

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
    // M8 §12.1/12.2: a named `ping` event the frontend listens for via
    // `addEventListener('ping', ...)`, separate from the default-`message`
    // ProgressEvent channel.
    res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
  }, config.progressKeepaliveMs);

  req.on('close', () => {
    clearInterval(keepalive);
    subscribers.delete(res);
  });
}

export function createProgressRouter(): Router {
  const router = Router();
  router.get('/progress/stream', handleProgressStream);
  return router;
}
