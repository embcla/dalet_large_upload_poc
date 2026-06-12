import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AppConfig {
  maxFileSizeBytes: number;
  acceptedExtensions: string[];
  acceptedMimeTypes: string[];
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly http = inject(HttpClient);
  private appConfig?: AppConfig;

  async load(): Promise<void> {
    this.appConfig = await firstValueFrom(
      this.http.get<AppConfig>(`${environment.apiBaseUrl}/config`),
    );
  }

  get(): AppConfig {
    if (!this.appConfig) {
      throw new Error('ConfigService.load() must complete before config is read');
    }
    return this.appConfig;
  }
}
