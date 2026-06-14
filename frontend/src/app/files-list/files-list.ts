import { Component, OnInit, inject, signal } from '@angular/core';
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

  ngOnInit(): void {
    this.filesService.refresh();
  }

  selectFile(file: FileItem): void {
    this.selected.set(file);
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
