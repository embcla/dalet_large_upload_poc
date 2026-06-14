import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { ProgressService } from './progress.service';

/**
 * A completed upload, as returned by `GET /files` (M7 §11). `duration`,
 * `resolution`, and `codec` are derived from `ffprobe`-extracted metadata and
 * are `null` until probing completes; `playable` reflects the §2.7
 * browser-compatible codec allowlist.
 */
export interface FileItem {
  id: string;
  filename: string;
  size: number;
  status: string;
  duration: number | null;
  resolution: string | null;
  codec: string | null;
  playable: boolean;
}

/**
 * Loads the list of completed uploads for the files/playback panel and
 * auto-refreshes whenever the SSE channel (M5 §9) reports a new `success`
 * event, so a just-finished upload appears without a manual reload.
 */
@Injectable({ providedIn: 'root' })
export class FilesService {
  private readonly http = inject(HttpClient);
  private readonly progressService = inject(ProgressService);

  readonly files = signal<FileItem[]>([]);

  private readonly seenSuccessIds = new Set<string>();

  constructor() {
    effect(() => {
      for (const event of this.progressService.events().values()) {
        if (event.status === 'success' && !this.seenSuccessIds.has(event.uploadId)) {
          this.seenSuccessIds.add(event.uploadId);
          this.refresh();
        }
      }
    });
  }

  async refresh(): Promise<void> {
    const files = await firstValueFrom(this.http.get<FileItem[]>(`${environment.apiBaseUrl}/files`));
    this.files.set(files);
  }
}
