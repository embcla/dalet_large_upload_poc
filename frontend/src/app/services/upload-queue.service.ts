import { Injectable, OnDestroy, WritableSignal, computed, inject, signal } from '@angular/core';
import * as tus from 'tus-js-client';
import { environment } from '../../environments/environment';
import { describeError, getExtension } from '../upload-utils';
import { ConfigService } from './config.service';
import { ProgressService } from './progress.service';

export type UploadStatus =
  | 'idle'
  | 'uploading'
  | 'paused'
  | 'error'
  | 'success'
  | 'abandoned'
  | 'skipped'
  | 'queued';

// §2.11: while a session is uploading/paused/error, keep the server informed
// we're still around so its cleanup job doesn't abort the multipart upload.
const HEARTBEAT_INTERVAL_MS = 20_000;

export interface QueueItem {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  /**
   * `file.lastModified`, captured at selection time. Unused by M6 itself —
   * carried on the item now because it's part of the `(filename, size,
   * lastModified)` fingerprint that M8 (§12) uses for `batch_key`
   * computation and cross-reload batch-manifest matching.
   */
  readonly lastModified: number;
  readonly status: WritableSignal<UploadStatus>;
  readonly bytesUploaded: WritableSignal<number>;
  readonly bytesTotal: WritableSignal<number>;
  readonly uploadId: WritableSignal<string | null>;
  readonly errorMessage: WritableSignal<string | null>;
  tusUpload?: tus.Upload;
  heartbeatInterval?: ReturnType<typeof setInterval>;
}

/**
 * Orchestrates a sequential batch-upload queue (§10): only one `tus.Upload`
 * is active at a time. Per-file status badges and the aggregate progress
 * bar are SSE-driven via `ProgressService.events()`, mirroring M5's
 * `displayStatus` pattern but per `QueueItem`.
 */
@Injectable({ providedIn: 'root' })
export class UploadQueueService implements OnDestroy {
  private readonly configService = inject(ConfigService);
  private readonly progressService = inject(ProgressService);

  readonly items = signal<QueueItem[]>([]);
  /** Index into `items()` of the currently-processing file, or -1 if none. */
  readonly activeIndex = signal(-1);
  readonly validationError = signal<string | null>(null);

  /**
   * The status shown to the user for `item`. A `skipped` item is terminal
   * and local-only (SSE never reports `skipped`), so it's never overridden.
   * Otherwise, a terminal SSE event (`success`/`error`/`abandoned`) for the
   * item's `uploadId` wins over the local status — e.g. a server-pushed
   * `abandoned` while the client still thinks it's `uploading`. A
   * non-terminal SSE event (`uploading`/`paused`) never overrides the local
   * status, so a fresher local transition (e.g. `onError`) isn't masked by a
   * stale in-flight SSE event.
   */
  displayStatus(item: QueueItem): UploadStatus {
    const localStatus = item.status();
    if (localStatus === 'skipped') {
      return 'skipped';
    }

    const id = item.uploadId();
    const event = id ? this.progressService.events().get(id) : undefined;
    if (event && (event.status === 'success' || event.status === 'error' || event.status === 'abandoned')) {
      return event.status;
    }

    return localStatus;
  }

  /**
   * Aggregate progress across the whole queue (§10): sum of `bytesReceived`/
   * `bytesTotal` from the SSE channel, including queued (pending) and
   * completed items, but excluding skipped ones so the bar can still reach
   * 100% once all attempted files finish.
   */
  readonly aggregateBytesUploaded = computed<number>(() => {
    const events = this.progressService.events();
    return this.items().reduce((sum, item) => {
      if (item.status() === 'skipped') {
        return sum;
      }
      const id = item.uploadId();
      const event = id ? events.get(id) : undefined;
      return sum + (event ? event.bytesReceived : 0);
    }, 0);
  });

  readonly aggregateBytesTotal = computed<number>(() => {
    return this.items().reduce((sum, item) => {
      if (item.status() === 'skipped') {
        return sum;
      }
      return sum + item.bytesTotal();
    }, 0);
  });

  readonly aggregateProgressPercent = computed<number>(() => {
    const total = this.aggregateBytesTotal();
    return total === 0 ? 0 : Math.round((this.aggregateBytesUploaded() / total) * 100);
  });

  ngOnDestroy(): void {
    for (const item of this.items()) {
      this.stopHeartbeat(item);
    }
  }

  get acceptAttr(): string {
    return this.configService.get().acceptedExtensions.join(',');
  }

  /**
   * Validates and enqueues `files`. If any file is invalid, sets
   * `validationError` and adds nothing from this selection. Starts
   * processing if the queue was idle.
   */
  addFiles(files: FileList | File[]): void {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) {
      return;
    }

    const errors: string[] = [];
    for (const file of fileArray) {
      const error = this.validate(file);
      if (error) {
        errors.push(`${file.name}: ${error}`);
      }
    }
    if (errors.length > 0) {
      this.validationError.set(errors.join(' '));
      return;
    }

    this.validationError.set(null);
    const newItems = fileArray.map((file) => this.createItem(file));
    this.items.set([...this.items(), ...newItems]);

    if (this.activeIndex() === -1) {
      this.processNext();
    }
  }

  /** Pauses the active upload, keeping server-side progress for resume. */
  pause(): void {
    const item = this.activeItem();
    if (!item?.tusUpload) {
      return;
    }
    item.tusUpload.abort();
    item.status.set('paused');
  }

  /** Resumes a paused upload, or retries one that errored, from the last offset. */
  resume(): void {
    const item = this.activeItem();
    if (!item?.tusUpload) {
      return;
    }
    item.errorMessage.set(null);
    item.status.set('uploading');
    item.tusUpload.start();
  }

  /** Marks the active (errored/abandoned) file as skipped and advances the queue. */
  skip(): void {
    const item = this.activeItem();
    if (!item) {
      return;
    }
    item.tusUpload?.abort();
    item.status.set('skipped');
    this.stopHeartbeat(item);
    this.processNext();
  }

  /**
   * §2.11: notify the server that any non-terminal item is being abandoned
   * (e.g. on page unload), generalizing the single-file abandon beacon to
   * the whole queue.
   */
  sendAbandonBeacons(): void {
    for (const item of this.items()) {
      const id = item.uploadId();
      if (!id) {
        continue;
      }
      const status = this.displayStatus(item);
      if (status === 'success' || status === 'skipped') {
        continue;
      }
      navigator.sendBeacon(`${environment.apiBaseUrl}/uploads/${id}/abandon`);
    }
  }

  private activeItem(): QueueItem | undefined {
    const index = this.activeIndex();
    return index === -1 ? undefined : this.items()[index];
  }

  private createItem(file: File): QueueItem {
    return {
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      status: signal<UploadStatus>('queued'),
      bytesUploaded: signal(0),
      bytesTotal: signal(file.size),
      uploadId: signal<string | null>(null),
      errorMessage: signal<string | null>(null),
    };
  }

  private validate(file: File): string | null {
    const config = this.configService.get();

    if (file.size > config.maxFileSizeBytes) {
      const maxMb = Math.floor(config.maxFileSizeBytes / (1024 * 1024));
      return `File is too large (max ${maxMb} MB).`;
    }

    if (!config.acceptedExtensions.includes(getExtension(file.name))) {
      return `Only ${config.acceptedExtensions.join(', ')} files are accepted.`;
    }

    return null;
  }

  /** Finds the next queued item after `activeIndex()` and starts it, or marks the queue idle. */
  private processNext(): void {
    const items = this.items();
    for (let i = this.activeIndex() + 1; i < items.length; i++) {
      if (items[i].status() === 'queued') {
        this.activeIndex.set(i);
        items[i].status.set('uploading');
        this.startUpload(items[i]);
        return;
      }
    }
    this.activeIndex.set(-1);
  }

  private startUpload(item: QueueItem): void {
    item.tusUpload = new tus.Upload(item.file, {
      endpoint: `${environment.apiBaseUrl}/uploads`,
      retryDelays: null,
      metadata: {
        filename: item.file.name,
        filetype: item.file.type,
      },
      onUploadUrlAvailable: () => {
        const url = item.tusUpload?.url ?? '';
        item.uploadId.set(url.split('/').pop() ?? null);
        this.startHeartbeat(item);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        item.bytesUploaded.set(bytesUploaded);
        item.bytesTotal.set(bytesTotal);
      },
      onSuccess: () => {
        item.status.set('success');
        this.stopHeartbeat(item);
        // Advance immediately on local onSuccess rather than waiting for
        // the (throttled, async) SSE confirmation.
        this.processNext();
      },
      onError: (error) => {
        item.status.set('error');
        item.errorMessage.set(describeError(error));
        this.stopHeartbeat(item);
        // Queue pauses here: the UI offers Retry/Skip for this item.
      },
    });

    item.tusUpload.start();
  }

  private startHeartbeat(item: QueueItem): void {
    if (item.heartbeatInterval) {
      return;
    }
    item.heartbeatInterval = setInterval(() => {
      const id = item.uploadId();
      if (!id) {
        return;
      }
      fetch(`${environment.apiBaseUrl}/uploads/${id}/heartbeat`, {
        method: 'POST',
        keepalive: true,
      }).catch(() => {
        // Best-effort: a missed heartbeat just brings the session closer to
        // the server-side cleanup timeout.
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(item: QueueItem): void {
    if (item.heartbeatInterval) {
      clearInterval(item.heartbeatInterval);
      item.heartbeatInterval = undefined;
    }
  }
}
