import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UploadQueue } from './upload-queue/upload-queue';
import { FilesList } from './files-list/files-list';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UploadQueue, FilesList],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = 'Media Upload Platform';
}
