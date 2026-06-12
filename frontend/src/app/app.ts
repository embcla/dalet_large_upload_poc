import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UploadForm } from './upload-form/upload-form';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UploadForm],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = 'Media Upload Platform';
}
