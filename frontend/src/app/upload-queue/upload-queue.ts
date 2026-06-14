import { Component, OnInit, inject } from '@angular/core';
import { ProgressService } from '../services/progress.service';
import { QueueItem, UploadQueueService, UploadStatus } from '../services/upload-queue.service';
import { formatSize } from '../upload-utils';

@Component({
  selector: 'app-upload-queue',
  imports: [],
  templateUrl: './upload-queue.html',
  styleUrl: './upload-queue.scss',
})
export class UploadQueue implements OnInit {
  private readonly progressService = inject(ProgressService);
  readonly queue = inject(UploadQueueService);

  ngOnInit(): void {
    this.progressService.connect();
  }

  get acceptAttr(): string {
    return this.queue.acceptAttr;
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) {
      return;
    }
    // Convert to a plain array before resetting `input.value` below — that
    // reset clears the live FileList in place, which would otherwise empty
    // `files` too since it's the same underlying object.
    const fileArray = Array.from(files);
    input.value = '';
    await this.queue.addFiles(fileArray);
  }

  displayStatus(item: QueueItem): UploadStatus {
    return this.queue.displayStatus(item);
  }

  isVerified(item: QueueItem): boolean {
    return this.queue.isVerified(item);
  }

  progressPercent(item: QueueItem): number {
    const total = item.bytesTotal();
    return total === 0 ? 0 : Math.round((item.bytesUploaded() / total) * 100);
  }

  formatSize(bytes: number): string {
    return formatSize(bytes);
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.resume();
  }

  skip(): void {
    this.queue.skip();
  }
}
