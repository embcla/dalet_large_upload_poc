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

export type UploadStatus = 'uploading' | 'paused' | 'success' | 'error' | 'abandoned';

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
}

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
}

export function insertUpload(row: {
  id: string;
  filename: string;
  size: number;
  mimeType: string | null;
  storageKey: string;
}): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO uploads (id, filename, size, mime_type, status, storage_key, last_seen, created_at, updated_at)
       VALUES (@id, @filename, @size, @mimeType, 'uploading', @storageKey, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(row);
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
