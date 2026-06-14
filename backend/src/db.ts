import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(config.sqlitePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(config.sqlitePath);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export type UploadStatus = 'uploading' | 'paused' | 'success' | 'error' | 'abandoned' | 'cancelled' | 'missing';

export interface UploadRow {
  id: string;
  filename: string;
  size: number;
  mime_type: string | null;
  status: UploadStatus;
  storage_key: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
  bytes_received: number;
  batch_key: string | null;
  last_modified: number | null;
  batch_position: number | null;
  client_file_hash: string | null;
  server_file_hash: string | null;
  hash_verified: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  playable: number | null;
}

/**
 * Additive columns introduced after the initial M0 migration (M4, §8).
 * Applied via ALTER TABLE if missing, so the migration stays idempotent
 * against databases already populated by M0-M3.
 */
const ADDITIVE_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'last_seen', ddl: 'last_seen TIMESTAMP' },
  { name: 'bytes_received', ddl: 'bytes_received INTEGER DEFAULT 0' },
  { name: 'batch_key', ddl: 'batch_key TEXT' },
  { name: 'last_modified', ddl: 'last_modified INTEGER' },
  { name: 'batch_position', ddl: 'batch_position INTEGER' },
  { name: 'client_file_hash', ddl: 'client_file_hash TEXT' },
  { name: 'server_file_hash', ddl: 'server_file_hash TEXT' },
  { name: 'hash_verified', ddl: 'hash_verified BOOLEAN' },
  { name: 'duration_seconds', ddl: 'duration_seconds REAL' },
  { name: 'width', ddl: 'width INTEGER' },
  { name: 'height', ddl: 'height INTEGER' },
  { name: 'video_codec', ddl: 'video_codec TEXT' },
  { name: 'audio_codec', ddl: 'audio_codec TEXT' },
  { name: 'playable', ddl: 'playable INTEGER' },
];

export function runMigrations(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'uploading',
      storage_key TEXT NOT NULL,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const existingColumns = new Set(
    (database.prepare(`PRAGMA table_info(uploads)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const column of ADDITIVE_COLUMNS) {
    if (!existingColumns.has(column.name)) {
      database.exec(`ALTER TABLE uploads ADD COLUMN ${column.ddl}`);
    }
  }
}

export function insertUpload(row: {
  id: string;
  filename: string;
  size: number;
  mimeType: string | null;
  storageKey: string;
  batchKey?: string | null;
  lastModified?: number | null;
  batchPosition?: number | null;
}): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO uploads (id, filename, size, mime_type, status, storage_key, last_seen, created_at, updated_at, batch_key, last_modified, batch_position)
       VALUES (@id, @filename, @size, @mimeType, 'uploading', @storageKey, datetime('now'), datetime('now'), datetime('now'), @batchKey, @lastModified, @batchPosition)`,
    )
    .run({
      ...row,
      batchKey: row.batchKey ?? null,
      lastModified: row.lastModified ?? null,
      batchPosition: row.batchPosition ?? null,
    });
}

export function markUploadStatus(id: string, status: UploadStatus): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE uploads SET status = @status, updated_at = datetime('now') WHERE id = @id`,
    )
    .run({ id, status });
}

export function getUpload(id: string): UploadRow | undefined {
  const database = getDb();
  return database.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as UploadRow | undefined;
}

/**
 * Updates last_seen for an in-progress upload (§2.11 heartbeat). No-op if
 * the upload doesn't exist or has already reached a terminal status.
 */
export function touchLastSeen(id: string): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE uploads SET last_seen = datetime('now') WHERE id = @id AND status IN ('uploading', 'paused')`,
    )
    .run({ id });
}

/**
 * Records server-confirmed bytes received for an upload (M5 §9.2/§9.6),
 * read back by the SSE snapshot-on-connect.
 */
export function setBytesReceived(id: string, bytesReceived: number): void {
  const database = getDb();
  database.prepare(`UPDATE uploads SET bytes_received = @bytesReceived WHERE id = @id`).run({
    id,
    bytesReceived,
  });
}

/**
 * Returns uploads that are still in-progress (M5 §9.6 snapshot-on-connect).
 */
export function getNonTerminalUploads(): UploadRow[] {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM uploads WHERE status IN ('uploading', 'paused')`)
    .all() as UploadRow[];
}

/**
 * Returns uploads that are still marked in-progress but haven't sent a
 * heartbeat within `timeoutSeconds` (§2.11 cleanup job).
 */
export function getStaleUploads(timeoutSeconds: number): UploadRow[] {
  const database = getDb();
  return database
    .prepare(
      `SELECT * FROM uploads
       WHERE status IN ('uploading', 'paused')
         AND (strftime('%s', 'now') - strftime('%s', last_seen)) > @timeoutSeconds`,
    )
    .all({ timeoutSeconds }) as UploadRow[];
}

/**
 * Stores `ffprobe`-derived metadata for a completed upload (M7 §11), used by
 * `GET /files` to report duration/resolution/codec and the `playable` flag.
 */
export function setProbedMetadata(
  id: string,
  metadata: {
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    playable: boolean;
  },
): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE uploads
       SET duration_seconds = @durationSeconds,
           width = @width,
           height = @height,
           video_codec = @videoCodec,
           audio_codec = @audioCodec,
           playable = @playable
       WHERE id = @id`,
    )
    .run({
      id,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      videoCodec: metadata.videoCodec,
      audioCodec: metadata.audioCodec,
      playable: metadata.playable ? 1 : 0,
    });
}

/**
 * Returns all successfully completed uploads (M7 §11 `GET /files`), most
 * recent first.
 */
export function getCompletedUploads(): UploadRow[] {
  const database = getDb();
  return database
    .prepare(`SELECT * FROM uploads WHERE status = 'success' ORDER BY created_at DESC`)
    .all() as UploadRow[];
}

/**
 * Returns the rows belonging to a batch (M8 §12), one per `batch_position`.
 * If a position has multiple rows (e.g. an abandoned attempt followed by a
 * fresh retry on a later reload), the most-recently-inserted row wins.
 * Ordered ascending by `batch_position`.
 */
export function getUploadsByBatchKey(batchKey: string): UploadRow[] {
  const database = getDb();
  const rows = database
    .prepare(`SELECT * FROM uploads WHERE batch_key = @batchKey ORDER BY rowid ASC`)
    .all({ batchKey }) as UploadRow[];

  const byPosition = new Map<number, UploadRow>();
  for (const row of rows) {
    if (row.batch_position !== null) {
      byPosition.set(row.batch_position, row);
    }
  }

  return Array.from(byPosition.values()).sort(
    (a, b) => (a.batch_position ?? 0) - (b.batch_position ?? 0),
  );
}

/**
 * Rows belonging to a batch that are still cancellable (M9 §13.8 "Cancel
 * remaining") — i.e. not already `success` or `cancelled`. Same
 * dedup-by-`batch_position` ordering as `getUploadsByBatchKey`.
 */
export function getCancellableUploadsByBatchKey(batchKey: string): UploadRow[] {
  return getUploadsByBatchKey(batchKey).filter(
    (row) => row.status !== 'success' && row.status !== 'cancelled',
  );
}

/**
 * Updates last_seen for the active (uploading/paused) row of a batch (M8
 * §12.2 pong), mirroring `touchLastSeen` but addressed by `batch_key`.
 */
export function touchLastSeenForBatch(batchKey: string): void {
  const database = getDb();
  database
    .prepare(
      `UPDATE uploads SET last_seen = datetime('now') WHERE batch_key = @batchKey AND status IN ('uploading', 'paused')`,
    )
    .run({ batchKey });
}

/**
 * If both client and server hashes are now present, sets `hash_verified`
 * (1 on match, 0 and `status = 'error'` on mismatch). Returns the
 * up-to-date row, or `undefined` if the upload doesn't exist.
 */
function reconcileHash(id: string): UploadRow | undefined {
  const database = getDb();
  const row = getUpload(id);
  if (!row || row.client_file_hash === null || row.server_file_hash === null) {
    return row;
  }

  if (row.client_file_hash === row.server_file_hash) {
    database
      .prepare(`UPDATE uploads SET hash_verified = 1, updated_at = datetime('now') WHERE id = @id`)
      .run({ id });
  } else {
    database
      .prepare(
        `UPDATE uploads SET hash_verified = 0, status = 'error', updated_at = datetime('now') WHERE id = @id`,
      )
      .run({ id });
  }

  return getUpload(id);
}

/**
 * Records the client's SHA-256 of the completed file (M8 §12.9-12.11) and
 * reconciles against the server hash if already present.
 */
export function setClientFileHash(id: string, hash: string): UploadRow | undefined {
  const database = getDb();
  database.prepare(`UPDATE uploads SET client_file_hash = @hash WHERE id = @id`).run({ id, hash });
  return reconcileHash(id);
}

/**
 * Records the server's SHA-256 of the completed object (M8 §12.9-12.11) and
 * reconciles against the client hash if already present.
 */
export function setServerFileHash(id: string, hash: string): UploadRow | undefined {
  const database = getDb();
  database.prepare(`UPDATE uploads SET server_file_hash = @hash WHERE id = @id`).run({ id, hash });
  return reconcileHash(id);
}
