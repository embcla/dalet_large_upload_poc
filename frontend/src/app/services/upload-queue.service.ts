import { Injectable, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import * as tus from 'tus-js-client';
import { environment } from '../../environments/environment';
import { bufferToHex, computeBatchKey, describeError, getExtension, sortFingerprint } from '../upload-utils';
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
  | 'queued'
  | 'corrupt'
  | 'cancelling'
  | 'cancelled';

/** Shape of an entry returned by `GET /batches/:batchKey` (M8 §12.3-12.8). */
interface BatchManifestEntry {
  id: string;
  filename: string;
  size: number;
  lastModified: number | null;
  batchPosition: number | null;
  status: string;
  bytesReceived: number;
  storageKey: string;
}

export interface QueueItem {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  /** `file.lastModified`, captured at selection time — part of the `batch_key` fingerprint (M8 §12.3-12.8). */
  readonly lastModified: number;
  /** SHA-256 of the batch's sorted `(name, size, lastModified)` fingerprint (M8 §12.3-12.8). */
  readonly batchKey: string;
  /** Position within the sorted batch, persisted as `batch_position` (M8 §12.12). */
  readonly batchPosition: number;
  readonly status: WritableSignal<UploadStatus>;
  readonly bytesUploaded: WritableSignal<number>;
  readonly bytesTotal: WritableSignal<number>;
  readonly uploadId: WritableSignal<string | null>;
  readonly errorMessage: WritableSignal<string | null>;
  tusUpload?: tus.Upload;
  /**
   * Set when this item was reconstructed from a manifest row that was
   * still `uploading`/`paused` (M8 §12.3-12.8) — `startUpload` resumes this
   * upload via `uploadUrl` instead of creating a new one.
   */
  resumeUploadId?: string;
}

/**
 * Orchestrates a sequential batch-upload queue (§10): only one `tus.Upload`
 * is active at a time. Per-file status badges and the aggregate progress
 * bar are SSE-driven via `ProgressService.events()`, mirroring M5's
 * `displayStatus` pattern but per `QueueItem`.
 */
@Injectable({ providedIn: 'root' })
export class UploadQueueService {
  private readonly configService = inject(ConfigService);
  private readonly progressService = inject(ProgressService);

  readonly items = signal<QueueItem[]>([]);
  /** Index into `items()` of the currently-processing file, or -1 if none. */
  readonly activeIndex = signal(-1);
  readonly validationError = signal<string | null>(null);

  constructor() {
    // M8 §12.1/12.2: on each server-pushed `ping`, tell the server the
    // active item's batch is still alive (replaces the M2 client heartbeat).
    effect(() => {
      if (this.progressService.pings() === 0) {
        return;
      }
      const item = this.activeItem();
      if (!item) {
        return;
      }
      fetch(`${environment.apiBaseUrl}/batches/${item.batchKey}/pong`, {
        method: 'POST',
        keepalive: true,
      }).catch(() => {});
    });
  }

  /**
   * The status shown to the user for `item`. A `skipped` item is terminal
   * and local-only (SSE never reports `skipped`), so it's never overridden.
   * A failed integrity check (M8 §12.9-12.11) overrides everything else with
   * `corrupt`. Otherwise, a terminal SSE event (`success`/`error`/
   * `abandoned`) for the item's `uploadId` wins over the local status — e.g.
   * a server-pushed `abandoned` while the client still thinks it's
   * `uploading`. A non-terminal SSE event (`uploading`/`paused`) never
   * overrides the local status, so a fresher local transition (e.g.
   * `onError`) isn't masked by a stale in-flight SSE event.
   */
  displayStatus(item: QueueItem): UploadStatus {
    const localStatus = item.status();
    if (localStatus === 'skipped') {
      return 'skipped';
    }

    const id = item.uploadId();
    const event = id ? this.progressService.events().get(id) : undefined;

    if (event?.hashVerified === false) {
      return 'corrupt';
    }

    if (
      event &&
      (event.status === 'success' ||
        event.status === 'error' ||
        event.status === 'abandoned' ||
        event.status === 'cancelled')
    ) {
      return event.status;
    }

    return localStatus;
  }

  /** Whether `item`'s completed upload passed the M8 §12.9-12.11 integrity check. */
  isVerified(item: QueueItem): boolean {
    const id = item.uploadId();
    const event = id ? this.progressService.events().get(id) : undefined;
    return event?.hashVerified === true;
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
      // Manifest-restored `success` items have no SSE event in the current
      // session (the M5 snapshot only covers non-terminal uploads), but
      // their bytesUploaded signal is pre-set to file.size (M8 §12.3-12.8).
      return sum + (event ? event.bytesReceived : item.bytesUploaded());
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

  get acceptAttr(): string {
    return this.configService.get().acceptedExtensions.join(',');
  }

  /**
   * Validates and enqueues `files`. If any file is invalid, sets
   * `validationError` and adds nothing from this selection. Otherwise,
   * computes the batch's `batch_key` (M8 §12.3-12.8), fetches its manifest
   * to reconstruct already-completed/in-progress items, and starts
   * processing if the queue was idle.
   */
  async addFiles(files: FileList | File[]): Promise<void> {
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

    const sorted = sortFingerprint(fileArray);
    const batchKey = await computeBatchKey(sorted);
    const manifest = await this.fetchManifest(batchKey);
    const manifestByPosition = new Map(manifest.map((entry) => [entry.batchPosition, entry]));

    const newItems = sorted.map((file, position) =>
      this.createItem(file, batchKey, position, manifestByPosition.get(position)),
    );
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

  /** Marks the active (errored/abandoned/corrupt) file as skipped and advances the queue. */
  skip(): void {
    const item = this.activeItem();
    if (!item) {
      return;
    }
    item.tusUpload?.abort();
    item.status.set('skipped');
    this.processNext();
  }

  /**
   * Permanent, user-initiated cancellation of a single item (M9 §13.1-13.6,
   * §13.11). A `queued` or already-`cancelled` item is just removed from the
   * queue (nothing to tell the server). Otherwise the item is marked
   * `cancelling` locally — the SSE-pushed `cancelled` event (once the server
   * confirms) flips it to `cancelled` via `displayStatus`'s terminal-event
   * override.
   */
  cancel(item: QueueItem): void {
    const status = this.displayStatus(item);

    if (status === 'queued' || status === 'cancelled') {
      this.removeItem(item);
      return;
    }

    item.status.set('cancelling');
    this.terminate(item);

    if (status === 'uploading') {
      this.processNext();
    }
  }

  /** True if any item could still be cancelled via "Cancel remaining" (M9 §13.7/13.8). */
  readonly hasCancellableItems = computed<boolean>(() => {
    return this.items().some((item) => {
      const status = this.displayStatus(item);
      return (
        status === 'queued' ||
        status === 'uploading' ||
        status === 'paused' ||
        status === 'error' ||
        status === 'abandoned'
      );
    });
  });

  /** Whether the "Cancel remaining" confirmation prompt is shown (M9 §13.7). */
  readonly confirmingCancelAll = signal(false);

  requestCancelAll(): void {
    this.confirmingCancelAll.set(true);
  }

  dismissCancelAll(): void {
    this.confirmingCancelAll.set(false);
  }

  /**
   * "Cancel remaining" (M9 §13.7/13.8): drops not-yet-started items, marks
   * every other non-terminal item `cancelling`, stops the active upload's
   * in-flight request immediately, and asks the server to cancel the rest of
   * each affected batch.
   */
  confirmCancelAll(): void {
    this.confirmingCancelAll.set(false);

    const activeItem = this.activeItem();
    const activeWasUploading = activeItem !== undefined && this.displayStatus(activeItem) === 'uploading';

    const batchKeys = new Set<string>();
    const remaining = this.items().filter((item) => {
      const status = this.displayStatus(item);
      if (status === 'queued') {
        return false;
      }
      if (status === 'uploading' || status === 'paused' || status === 'error' || status === 'abandoned') {
        batchKeys.add(item.batchKey);
        item.status.set('cancelling');
      }
      return true;
    });
    this.items.set(remaining);

    if (activeWasUploading) {
      activeItem?.tusUpload?.abort(true).catch(() => {});
    }
    this.activeIndex.set(-1);

    for (const batchKey of batchKeys) {
      fetch(`${environment.apiBaseUrl}/batches/${batchKey}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  /** Sends the server-side cancellation for `item` (M9 §13.1-13.6). */
  private terminate(item: QueueItem): void {
    if (item.tusUpload?.url) {
      item.tusUpload.abort(true).catch(() => {});
      return;
    }
    const id = item.uploadId();
    if (id) {
      tus.Upload.terminate(`${environment.apiBaseUrl}/uploads/${id}`, { retryDelays: null }).catch(() => {});
    }
  }

  /** Removes `item` from the queue, keeping `activeIndex` pointed at the same item (if any). */
  private removeItem(item: QueueItem): void {
    const items = this.items();
    const activeItem = this.activeIndex() === -1 ? undefined : items[this.activeIndex()];
    const newItems = items.filter((i) => i !== item);
    this.items.set(newItems);
    this.activeIndex.set(activeItem ? newItems.indexOf(activeItem) : -1);
  }

  private activeItem(): QueueItem | undefined {
    const index = this.activeIndex();
    return index === -1 ? undefined : this.items()[index];
  }

  private async fetchManifest(batchKey: string): Promise<BatchManifestEntry[]> {
    try {
      const res = await fetch(`${environment.apiBaseUrl}/batches/${batchKey}`);
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as BatchManifestEntry[];
    } catch {
      return [];
    }
  }

  /**
   * Builds a queue item for `file` at `position` in the batch. If
   * `manifestEntry` is a completed (`success`) row, the item starts already
   * done with no `tus.Upload`. If it's still `uploading`/`paused`, the item
   * is queued for resume via `uploadUrl` (`startUpload`). Otherwise (no
   * entry, or `abandoned`/`error`), it's a normal fresh upload.
   */
  private createItem(
    file: File,
    batchKey: string,
    batchPosition: number,
    manifestEntry?: BatchManifestEntry,
  ): QueueItem {
    const item: QueueItem = {
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      batchKey,
      batchPosition,
      status: signal<UploadStatus>('queued'),
      bytesUploaded: signal(0),
      bytesTotal: signal(file.size),
      uploadId: signal<string | null>(null),
      errorMessage: signal<string | null>(null),
    };

    if (!manifestEntry || manifestEntry.status === 'abandoned' || manifestEntry.status === 'error') {
      return item;
    }

    if (manifestEntry.status === 'cancelled') {
      item.status.set('cancelled');
      item.uploadId.set(manifestEntry.id);
      item.bytesUploaded.set(manifestEntry.bytesReceived);
      item.bytesTotal.set(file.size);
      return item;
    }

    if (manifestEntry.status === 'success') {
      item.status.set('success');
      item.uploadId.set(manifestEntry.id);
      item.bytesUploaded.set(file.size);
      item.bytesTotal.set(file.size);
      return item;
    }

    // uploading/paused: resume on its turn (still status 'queued' until then)
    item.uploadId.set(manifestEntry.id);
    item.bytesUploaded.set(manifestEntry.bytesReceived);
    item.resumeUploadId = manifestEntry.id;
    return item;
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
    const options: tus.UploadOptions = {
      endpoint: `${environment.apiBaseUrl}/uploads`,
      retryDelays: null,
      metadata: {
        filename: item.file.name,
        filetype: item.file.type,
        batchKey: item.batchKey,
        lastModified: String(item.lastModified),
        batchPosition: String(item.batchPosition),
      },
      onUploadUrlAvailable: () => {
        const url = item.tusUpload?.url ?? '';
        item.uploadId.set(url.split('/').pop() ?? null);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        item.bytesUploaded.set(bytesUploaded);
        item.bytesTotal.set(bytesTotal);
      },
      onSuccess: () => {
        item.status.set('success');
        // Advance immediately on local onSuccess rather than waiting for
        // the (throttled, async) SSE confirmation.
        this.processNext();
        // M8 §12.9-12.11: fire-and-forget, doesn't block queue progression.
        void this.verifyIntegrity(item);
      },
      onError: (error) => {
        item.status.set('error');
        item.errorMessage.set(describeError(error));
        // Queue pauses here: the UI offers Retry/Skip for this item.
      },
    };

    // M8 §12.3-12.8: cross-reload resume — skip the creation POST and
    // HEAD-then-PATCH from the manifest's reported offset.
    if (item.resumeUploadId) {
      options.uploadUrl = `${environment.apiBaseUrl}/uploads/${item.resumeUploadId}`;
    }

    item.tusUpload = new tus.Upload(item.file, options);
    item.tusUpload.start();
  }

  /** Computes the completed file's SHA-256 and posts it for server-side reconciliation (M8 §12.9-12.11). */
  private async verifyIntegrity(item: QueueItem): Promise<void> {
    const id = item.uploadId();
    if (!id) {
      return;
    }
    try {
      const buffer = await item.file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hash = bufferToHex(digest);
      await fetch(`${environment.apiBaseUrl}/uploads/${id}/client-hash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
    } catch {
      // Best-effort: a failed hash post just leaves hash_verified null.
    }
  }
}
