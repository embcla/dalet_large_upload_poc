import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * A server->client push over the M5 (§9) SSE channel. Mirrors
 * `backend/src/progress.ts`'s `ProgressEvent`. `bytesReceived`/`bytesTotal`
 * reflect server-confirmed progress (§9.2/§9.5), not the client's local
 * `onProgress`.
 */
export interface ProgressEvent {
  uploadId: string;
  status: 'uploading' | 'paused' | 'success' | 'error' | 'abandoned' | 'cancelled' | 'missing';
  bytesReceived: number;
  bytesTotal: number;
  message?: string;
  /** Result of the M8 §12.9-12.11 client/server hash reconciliation. */
  hashVerified?: boolean;
}

/**
 * Opens a single shared `GET /progress/stream` connection (§9.1) and keeps a
 * `uploadId -> ProgressEvent` map of the latest server-pushed state, used as
 * the source of truth for terminal upload statuses (§9.12).
 */
@Injectable({ providedIn: 'root' })
export class ProgressService {
  readonly events = signal<ReadonlyMap<string, ProgressEvent>>(new Map());

  /** Bumped on every named `ping` SSE event (M8 §12.1/12.2). */
  readonly pings = signal(0);

  private eventSource?: EventSource;

  /** Opens the shared SSE connection, if not already open. */
  connect(): void {
    if (this.eventSource || typeof EventSource === 'undefined') {
      return;
    }

    this.eventSource = new EventSource(`${environment.apiBaseUrl}/progress/stream`);
    this.eventSource.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as ProgressEvent;
      const next = new Map(this.events());
      next.set(data.uploadId, data);
      this.events.set(next);
    };
    this.eventSource.addEventListener('ping', () => {
      this.pings.set(this.pings() + 1);
    });
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
  }
}
