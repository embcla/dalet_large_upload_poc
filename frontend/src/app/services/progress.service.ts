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
  status: 'uploading' | 'paused' | 'success' | 'error' | 'abandoned';
  bytesReceived: number;
  bytesTotal: number;
  message?: string;
}

/**
 * Opens a single shared `GET /progress/stream` connection (§9.1) and keeps a
 * `uploadId -> ProgressEvent` map of the latest server-pushed state, used as
 * the source of truth for terminal upload statuses (§9.12).
 */
@Injectable({ providedIn: 'root' })
export class ProgressService {
  readonly events = signal<ReadonlyMap<string, ProgressEvent>>(new Map());

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
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
  }
}
