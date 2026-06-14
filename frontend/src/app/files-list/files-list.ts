import { Component, OnInit, effect, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { FileItem, FilesService } from '../services/files.service';
import { formatDuration, formatSize } from '../upload-utils';

/**
 * Right-hand column of the M7 (§11) two-column layout: lists completed
 * uploads and plays the selected one if it's `playable` (§2.7).
 */
@Component({
  selector: 'app-files-list',
  imports: [],
  templateUrl: './files-list.html',
  styleUrl: './files-list.scss',
})
export class FilesList implements OnInit {
  readonly filesService = inject(FilesService);

  readonly selected = signal<FileItem | null>(null);

  /** M10 §14.3: set when the selected file's object has disappeared from the bucket. */
  readonly fileMissing = signal(false);

  constructor() {
    effect(() => {
      const selected = this.selected();
      if (selected && !this.filesService.files().some((file) => file.id === selected.id)) {
        this.fileMissing.set(true);
      }
    });
  }

  ngOnInit(): void {
    this.filesService.refresh();
  }

  selectFile(file: FileItem): void {
    this.selected.set(file);
    this.fileMissing.set(false);
  }

  streamUrl(id: string): string {
    return `${environment.apiBaseUrl}/files/${id}/stream`;
  }

  formatSize(bytes: number): string {
    return formatSize(bytes);
  }

  formatDuration(seconds: number | null): string {
    return formatDuration(seconds);
  }
}
