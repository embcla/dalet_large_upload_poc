import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UploadQueue } from './upload-queue/upload-queue';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UploadQueue],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = 'Media Upload Platform';
}
