import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import * as tus from 'tus-js-client';
import { environment } from '../../environments/environment';
import { ConfigService } from '../services/config.service';
import { ProgressService } from '../services/progress.service';

export type UploadStatus = 'idle' | 'uploading' | 'paused' | 'error' | 'success' | 'abandoned';

// §2.11: while a session is uploading/paused/error, keep the server informed
// we're still around so its cleanup job doesn't abort the multipart upload.
const HEARTBEAT_INTERVAL_MS = 20_000;

@Component({
  selector: 'app-upload-form',
  imports: [],
  templateUrl: './upload-form.html',
  styleUrl: './upload-form.scss',
})
export class UploadForm implements OnDestroy {
  private readonly configService = inject(ConfigService);
  private readonly progressService = inject(ProgressService);

  readonly status = signal<UploadStatus>('idle');
  readonly validationError = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly fileName = signal<string | null>(null);
  readonly bytesUploaded = signal(0);
  readonly bytesTotal = signal(0);
  private readonly uploadId = signal<string | null>(null);

  readonly progressPercent = computed(() => {
    const total = this.bytesTotal();
    return total === 0 ? 0 : Math.round((this.bytesUploaded() / total) * 100);
  });

  /**
   * The status shown to the user. Terminal states (success/error/abandoned,
   * §9.12) are driven by the M5 SSE channel once it reports them for the
   * current upload, since the server may reach those states on its own
   * (e.g. the cleanup job aborting an abandoned session). Otherwise falls
   * back to the locally-driven tus status.
   */
  readonly displayStatus = computed<UploadStatus>(() => {
    const id = this.uploadId();
    const event = id ? this.progressService.events().get(id) : undefined;
    if (event && (event.status === 'success' || event.status === 'error' || event.status === 'abandoned')) {
      return event.status;
    }
    return this.status();
  });

  private tusUpload?: tus.Upload;
  private heartbeatInterval?: ReturnType<typeof setInterval>;

  private readonly handleUnload = (): void => {
    const id = this.uploadId();
    if (id && this.status() !== 'success') {
      navigator.sendBeacon(`${environment.apiBaseUrl}/uploads/${id}/abandon`);
    }
  };

  constructor() {
    this.progressService.connect();
    window.addEventListener('beforeunload', this.handleUnload);
    window.addEventListener('pagehide', this.handleUnload);
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.handleUnload);
    window.removeEventListener('pagehide', this.handleUnload);
    this.stopHeartbeat();
  }

  get acceptAttr(): string {
    return this.configService.get().acceptedExtensions.join(',');
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    this.resetState();
    this.fileName.set(file.name);

    const validationError = this.validate(file);
    if (validationError) {
      this.validationError.set(validationError);
      return;
    }

    this.startUpload(file);
  }

  /** Pauses the active upload, keeping server-side progress for resume. */
  pause(): void {
    if (!this.tusUpload) {
      return;
    }
    this.tusUpload.abort();
    this.status.set('paused');
  }

  /** Resumes a paused upload, or retries one that errored, from the last offset. */
  resume(): void {
    if (!this.tusUpload) {
      return;
    }
    this.errorMessage.set(null);
    this.status.set('uploading');
    this.tusUpload.start();
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

  private startUpload(file: File): void {
    this.status.set('uploading');
    this.bytesTotal.set(file.size);
    this.bytesUploaded.set(0);

    this.tusUpload = new tus.Upload(file, {
      endpoint: `${environment.apiBaseUrl}/uploads`,
      retryDelays: null,
      metadata: {
        filename: file.name,
        filetype: file.type,
      },
      onUploadUrlAvailable: () => {
        const url = this.tusUpload?.url ?? '';
        this.uploadId.set(url.split('/').pop() ?? null);
        this.startHeartbeat();
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        this.bytesUploaded.set(bytesUploaded);
        this.bytesTotal.set(bytesTotal);
      },
      onSuccess: () => {
        this.status.set('success');
        this.stopHeartbeat();
      },
      onError: (error) => {
        this.status.set('error');
        this.errorMessage.set(describeError(error));
      },
    });

    this.tusUpload.start();
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      const id = this.uploadId();
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

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private resetState(): void {
    this.status.set('idle');
    this.validationError.set(null);
    this.errorMessage.set(null);
    this.bytesUploaded.set(0);
    this.bytesTotal.set(0);
    this.tusUpload = undefined;
    this.uploadId.set(null);
    this.stopHeartbeat();
  }
}

export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) {
    return '';
  }
  return filename.slice(idx).toLowerCase();
}

export function describeError(error: Error | tus.DetailedError): string {
  const detailed = error as tus.DetailedError;
  const body = detailed.originalResponse?.getBody()?.trim();
  return body ? body : error.message;
}
