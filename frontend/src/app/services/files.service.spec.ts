import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { FilesService, FileItem } from './files.service';
import { ProgressService, ProgressEvent } from './progress.service';
import { environment } from '../../environments/environment';

class FakeProgressService {
  readonly events = signal<ReadonlyMap<string, ProgressEvent>>(new Map());
  connect = vi.fn();

  emit(event: ProgressEvent): void {
    const next = new Map(this.events());
    next.set(event.uploadId, event);
    this.events.set(next);
  }
}

describe('FilesService', () => {
  let service: FilesService;
  let progressService: FakeProgressService;
  let httpMock: HttpTestingController;

  const sampleFile: FileItem = {
    id: 'f1',
    filename: 'clip.mp4',
    size: 1234,
    status: 'success',
    duration: 2.5,
    resolution: '320x240',
    codec: 'h264/aac',
    playable: true,
  };

  beforeEach(() => {
    progressService = new FakeProgressService();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ProgressService, useValue: progressService },
      ],
    });
    service = TestBed.inject(FilesService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('populates files() from GET /files', async () => {
    const refreshPromise = service.refresh();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/files`);
    expect(req.request.method).toBe('GET');
    req.flush([sampleFile]);

    await refreshPromise;

    expect(service.files()).toEqual([sampleFile]);
  });

  it('refreshes when a new success event arrives over SSE', () => {
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    TestBed.flushEffects();

    httpMock.expectOne(`${environment.apiBaseUrl}/files`).flush([]);
  });

  it('does not refresh again for a repeated success event for the same uploadId', () => {
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    TestBed.flushEffects();
    httpMock.expectOne(`${environment.apiBaseUrl}/files`).flush([]);

    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    TestBed.flushEffects();

    httpMock.expectNone(`${environment.apiBaseUrl}/files`);
  });

  it('does not refresh for non-success events', () => {
    progressService.emit({ uploadId: 'u1', status: 'uploading', bytesReceived: 50, bytesTotal: 100 });
    TestBed.flushEffects();

    httpMock.expectNone(`${environment.apiBaseUrl}/files`);
  });
});
