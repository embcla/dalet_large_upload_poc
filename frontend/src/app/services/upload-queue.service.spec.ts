import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import * as tus from 'tus-js-client';
import { UploadQueueService } from './upload-queue.service';
import { ConfigService, AppConfig } from './config.service';
import { ProgressService, ProgressEvent } from './progress.service';
import { environment } from '../../environments/environment';
import { getExtension, describeError } from '../upload-utils';

class FakeConfigService {
  private readonly config: AppConfig = {
    maxFileSizeBytes: 2 * 1024 * 1024 * 1024, // 2GB
    acceptedExtensions: ['.mp4', '.mkv'],
    acceptedMimeTypes: ['video/mp4', 'video/x-matroska'],
  };

  get(): AppConfig {
    return this.config;
  }
}

class FakeProgressService {
  readonly events = signal<ReadonlyMap<string, ProgressEvent>>(new Map());
  connect = vi.fn();

  emit(event: ProgressEvent): void {
    const next = new Map(this.events());
    next.set(event.uploadId, event);
    this.events.set(next);
  }
}

interface FakeUpload {
  url: string | null;
  file: File;
  options: tus.UploadOptions;
  start: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function makeFile(name: string, sizeBytes: number, type = 'video/mp4'): File {
  const file = new File([new ArrayBuffer(0)], name, { type });
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

describe('getExtension', () => {
  it('returns the lowercased extension', () => {
    expect(getExtension('movie.MP4')).toBe('.mp4');
    expect(getExtension('movie.mkv')).toBe('.mkv');
  });

  it('returns empty string when there is no extension', () => {
    expect(getExtension('noext')).toBe('');
  });
});

describe('describeError', () => {
  it('returns the response body when present', () => {
    const error = new tus.DetailedError('upload failed');
    error.originalResponse = {
      getStatus: () => 415,
      getHeader: () => undefined,
      getBody: () => 'Unsupported file type\n',
      getUnderlyingObject: () => undefined,
    };
    expect(describeError(error)).toBe('Unsupported file type');
  });

  it('falls back to the error message when there is no response body', () => {
    const error = new Error('network error');
    expect(describeError(error)).toBe('network error');
  });
});

describe('UploadQueueService', () => {
  let service: UploadQueueService;
  let progressService: FakeProgressService;
  let uploads: FakeUpload[];

  beforeEach(() => {
    uploads = [];
    vi.spyOn(tus, 'Upload').mockImplementation(function (
      this: FakeUpload,
      file: unknown,
      options: tus.UploadOptions,
    ) {
      this.url = null;
      this.file = file as File;
      this.options = options;
      this.start = vi.fn();
      this.abort = vi.fn();
      uploads.push(this);
    } as unknown as typeof tus.Upload);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
    navigator.sendBeacon = vi.fn().mockReturnValue(true);

    progressService = new FakeProgressService();

    TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useClass: FakeConfigService },
        { provide: ProgressService, useValue: progressService },
      ],
    });

    service = TestBed.inject(UploadQueueService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeUploadUrlAvailable(upload: FakeUpload, id: string): void {
    upload.url = `${environment.apiBaseUrl}/uploads/${id}`;
    upload.options.onUploadUrlAvailable?.();
  }

  function succeed(upload: FakeUpload): void {
    upload.options.onSuccess?.({ lastResponse: {} as tus.HttpResponse });
  }

  it('rejects files larger than the configured max size without adding them', () => {
    const bigFile = makeFile('big.mp4', 3 * 1024 * 1024 * 1024); // 3GB

    service.addFiles([bigFile]);

    expect(service.validationError()).toContain('too large');
    expect(service.items()).toHaveLength(0);
  });

  it('rejects files with a disallowed extension without adding them', () => {
    const badFile = makeFile('notes.txt', 10, 'text/plain');

    service.addFiles([badFile]);

    expect(service.validationError()).toContain('.mp4, .mkv');
    expect(service.items()).toHaveLength(0);
  });

  it('starts processing the first file of a valid selection', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];

    service.addFiles(files);

    expect(service.validationError()).toBeNull();
    expect(service.items()).toHaveLength(2);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].start).toHaveBeenCalled();
    expect(service.activeIndex()).toBe(0);
    expect(service.items()[0].status()).toBe('uploading');
    expect(service.items()[1].status()).toBe('queued');
  });

  it('processes all files sequentially to success; aggregate progress reaches 100%', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)];
    service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    succeed(uploads[0]);

    expect(uploads).toHaveLength(2);
    expect(service.activeIndex()).toBe(1);
    expect(service.displayStatus(service.items()[0])).toBe('success');

    makeUploadUrlAvailable(uploads[1], 'u2');
    progressService.emit({ uploadId: 'u2', status: 'success', bytesReceived: 200, bytesTotal: 200 });
    succeed(uploads[1]);

    expect(uploads).toHaveLength(3);
    expect(service.activeIndex()).toBe(2);

    makeUploadUrlAvailable(uploads[2], 'u3');
    progressService.emit({ uploadId: 'u3', status: 'success', bytesReceived: 300, bytesTotal: 300 });
    succeed(uploads[2]);

    expect(service.items().map((item) => service.displayStatus(item))).toEqual(['success', 'success', 'success']);
    expect(service.aggregateProgressPercent()).toBe(100);
    expect(service.activeIndex()).toBe(-1);
  });

  it('pauses the queue on a mid-queue failure; aggregate stalls and remaining items stay queued', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)];
    service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    succeed(uploads[0]);

    makeUploadUrlAvailable(uploads[1], 'u2');
    progressService.emit({ uploadId: 'u2', status: 'uploading', bytesReceived: 50, bytesTotal: 200 });
    uploads[1].options.onError?.(new Error('connection lost'));

    expect(service.displayStatus(service.items()[1])).toBe('error');
    expect(service.items()[1].errorMessage()).toBe('connection lost');
    expect(service.displayStatus(service.items()[2])).toBe('queued');
    expect(uploads).toHaveLength(2); // file 3 not started
    expect(service.activeIndex()).toBe(1); // still stuck on file 2

    expect(service.aggregateBytesUploaded()).toBe(150); // 100 (file1) + 50 (file2) + 0 (file3)
    expect(service.aggregateBytesTotal()).toBe(600); // 100 + 200 + 300

    const percent = service.aggregateProgressPercent();
    expect(percent).toBe(25);
    expect(service.aggregateProgressPercent()).toBe(percent); // stalled, doesn't move
  });

  it('resume() retries the failed file on the same tus.Upload instance and continues the queue', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    uploads[0].options.onError?.(new Error('boom'));
    expect(service.displayStatus(service.items()[0])).toBe('error');

    service.resume();

    expect(uploads).toHaveLength(1); // same instance, no new tus.Upload
    expect(uploads[0].start).toHaveBeenCalledTimes(2);
    expect(service.items()[0].status()).toBe('uploading');
    expect(service.items()[0].errorMessage()).toBeNull();

    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    succeed(uploads[0]);

    expect(uploads).toHaveLength(2);
    expect(service.activeIndex()).toBe(1);
  });

  it('skip() marks the failed file as skipped and advances the queue', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    uploads[0].options.onError?.(new Error('boom'));

    service.skip();

    expect(uploads[0].abort).toHaveBeenCalled();
    expect(service.items()[0].status()).toBe('skipped');
    expect(service.displayStatus(service.items()[0])).toBe('skipped');
    expect(uploads).toHaveLength(2);
    expect(service.activeIndex()).toBe(1);

    // skipped file excluded from the aggregate denominator
    expect(service.aggregateBytesTotal()).toBe(200);
  });

  it('pause aborts the active upload and sets it to paused', () => {
    service.addFiles([makeFile('a.mp4', 100)]);

    service.pause();

    expect(uploads[0].abort).toHaveBeenCalled();
    expect(service.items()[0].status()).toBe('paused');
  });

  it('resume restarts a paused upload', () => {
    service.addFiles([makeFile('a.mp4', 100)]);

    service.pause();
    service.resume();

    expect(uploads[0].start).toHaveBeenCalledTimes(2);
    expect(service.items()[0].status()).toBe('uploading');
  });

  it('sends a heartbeat for the active item every ~20s while in progress', () => {
    vi.useFakeTimers();

    service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-123');

    vi.advanceTimersByTime(20_000);

    expect(fetch).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/uploads/upload-123/heartbeat`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sendAbandonBeacons notifies for in-progress items but not success/skipped/not-yet-started items', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)];
    service.addFiles(files);

    // file 1 succeeds
    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    succeed(uploads[0]);

    // file 2 is now active/in-progress; file 3 has no uploadId yet (queued)
    makeUploadUrlAvailable(uploads[1], 'u2');

    service.sendAbandonBeacons();

    expect(navigator.sendBeacon).toHaveBeenCalledTimes(1);
    expect(navigator.sendBeacon).toHaveBeenCalledWith(`${environment.apiBaseUrl}/uploads/u2/abandon`);
  });

  it('displayStatus reflects a terminal status pushed over SSE for the active item (§9.12)', () => {
    service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-sse-1');

    progressService.emit({ uploadId: 'upload-sse-1', status: 'abandoned', bytesReceived: 50, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('abandoned');
  });

  it('displayStatus ignores SSE events for a different uploadId', () => {
    service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-sse-2');

    progressService.emit({ uploadId: 'some-other-upload', status: 'abandoned', bytesReceived: 50, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('uploading');
  });

  it('displayStatus never lets a stale SSE event override a skipped item', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    uploads[0].options.onError?.(new Error('boom'));
    service.skip();

    progressService.emit({ uploadId: 'u1', status: 'error', bytesReceived: 0, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('skipped');
  });

  it('items with no uploadId yet display as queued', () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    service.addFiles(files);

    expect(service.displayStatus(service.items()[1])).toBe('queued');
  });

  it('captures file.lastModified on each queue item', () => {
    const file = makeFile('a.mp4', 100);
    Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });

    service.addFiles([file]);

    expect(service.items()[0].lastModified).toBe(1_700_000_000_000);
  });
});
