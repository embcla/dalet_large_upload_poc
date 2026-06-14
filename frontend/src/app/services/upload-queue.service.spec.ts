import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import * as tus from 'tus-js-client';
import { UploadQueueService } from './upload-queue.service';
import { ConfigService, AppConfig } from './config.service';
import { ProgressService, ProgressEvent } from './progress.service';
import { environment } from '../../environments/environment';
import { getExtension, describeError, computeBatchKey, sortFingerprint } from '../upload-utils';

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
  readonly pings = signal(0);
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

interface FakeManifestEntry {
  id: string;
  filename: string;
  size: number;
  lastModified: number | null;
  batchPosition: number | null;
  status: string;
  bytesReceived: number;
  storageKey: string;
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
  let manifestResponses: Map<string, FakeManifestEntry[]>;
  let clientHashCalls: Array<{ id: string; hash: string }>;

  beforeEach(() => {
    uploads = [];
    manifestResponses = new Map();
    clientHashCalls = [];

    vi.spyOn(tus, 'Upload').mockImplementation(function (
      this: FakeUpload,
      file: unknown,
      options: tus.UploadOptions,
    ) {
      this.url = null;
      this.file = file as File;
      this.options = options;
      this.start = vi.fn();
      this.abort = vi.fn().mockResolvedValue(undefined);
      uploads.push(this);
    } as unknown as typeof tus.Upload);

    vi.spyOn(tus.Upload, 'terminate').mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;

        const manifestMatch = path.match(/^\/batches\/([^/]+)$/);
        if (manifestMatch) {
          const entries = manifestResponses.get(manifestMatch[1]) ?? [];
          return new Response(JSON.stringify(entries), { status: 200 });
        }

        const hashMatch = path.match(/^\/uploads\/([^/]+)\/client-hash$/);
        if (hashMatch) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          clientHashCalls.push({ id: hashMatch[1], hash: body.hash });
          return new Response(null, { status: 204 });
        }

        return new Response(null, { status: 204 });
      }),
    );
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

  it('rejects files larger than the configured max size without adding them', async () => {
    const bigFile = makeFile('big.mp4', 3 * 1024 * 1024 * 1024); // 3GB

    await service.addFiles([bigFile]);

    expect(service.validationError()).toContain('too large');
    expect(service.items()).toHaveLength(0);
  });

  it('rejects files with a disallowed extension without adding them', async () => {
    const badFile = makeFile('notes.txt', 10, 'text/plain');

    await service.addFiles([badFile]);

    expect(service.validationError()).toContain('.mp4, .mkv');
    expect(service.items()).toHaveLength(0);
  });

  it('starts processing the first file of a valid selection', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];

    await service.addFiles(files);

    expect(service.validationError()).toBeNull();
    expect(service.items()).toHaveLength(2);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].start).toHaveBeenCalled();
    expect(service.activeIndex()).toBe(0);
    expect(service.items()[0].status()).toBe('uploading');
    expect(service.items()[1].status()).toBe('queued');
  });

  it('processes all files sequentially to success; aggregate progress reaches 100%', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)];
    await service.addFiles(files);

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

  it('pauses the queue on a mid-queue failure; aggregate stalls and remaining items stay queued', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)];
    await service.addFiles(files);

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

  it('resume() retries the failed file on the same tus.Upload instance and continues the queue', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    await service.addFiles(files);

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

  it('skip() marks the failed file as skipped and advances the queue', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    await service.addFiles(files);

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

  it('pause aborts the active upload and sets it to paused', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);

    service.pause();

    expect(uploads[0].abort).toHaveBeenCalled();
    expect(service.items()[0].status()).toBe('paused');
  });

  it('resume restarts a paused upload', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);

    service.pause();
    service.resume();

    expect(uploads[0].start).toHaveBeenCalledTimes(2);
    expect(service.items()[0].status()).toBe('uploading');
  });

  it('displayStatus reflects a terminal status pushed over SSE for the active item (§9.12)', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-sse-1');

    progressService.emit({ uploadId: 'upload-sse-1', status: 'abandoned', bytesReceived: 50, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('abandoned');
  });

  it('displayStatus ignores SSE events for a different uploadId', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-sse-2');

    progressService.emit({ uploadId: 'some-other-upload', status: 'abandoned', bytesReceived: 50, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('uploading');
  });

  it('displayStatus never lets a stale SSE event override a skipped item', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    await service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    uploads[0].options.onError?.(new Error('boom'));
    service.skip();

    progressService.emit({ uploadId: 'u1', status: 'error', bytesReceived: 0, bytesTotal: 100 });

    expect(service.displayStatus(service.items()[0])).toBe('skipped');
  });

  it('items with no uploadId yet display as queued', async () => {
    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    await service.addFiles(files);

    expect(service.displayStatus(service.items()[1])).toBe('queued');
  });

  it('captures file.lastModified on each queue item', async () => {
    const file = makeFile('a.mp4', 100);
    Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });

    await service.addFiles([file]);

    expect(service.items()[0].lastModified).toBe(1_700_000_000_000);
  });

  it('displayStatus returns corrupt when the SSE event reports hashVerified false (M8 §12.9-12.11)', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'u1');

    progressService.emit({
      uploadId: 'u1',
      status: 'success',
      bytesReceived: 100,
      bytesTotal: 100,
      hashVerified: false,
    });

    expect(service.displayStatus(service.items()[0])).toBe('corrupt');
    expect(service.isVerified(service.items()[0])).toBe(false);
  });

  it('isVerified returns true when the SSE event reports hashVerified true (M8 §12.9-12.11)', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'u1');

    progressService.emit({
      uploadId: 'u1',
      status: 'success',
      bytesReceived: 100,
      bytesTotal: 100,
      hashVerified: true,
    });

    expect(service.displayStatus(service.items()[0])).toBe('success');
    expect(service.isVerified(service.items()[0])).toBe(true);
  });

  it('reconstructs a completed item from the batch manifest without creating a tus.Upload (M8 §12.3-12.8)', async () => {
    const file = makeFile('a.mp4', 100);
    const [sorted] = sortFingerprint([file]);
    const batchKey = await computeBatchKey([sorted]);
    manifestResponses.set(batchKey, [
      {
        id: 'prev-success',
        filename: 'a.mp4',
        size: 100,
        lastModified: file.lastModified,
        batchPosition: 0,
        status: 'success',
        bytesReceived: 100,
        storageKey: 'prev-success',
      },
    ]);

    await service.addFiles([file]);

    expect(uploads).toHaveLength(0);
    expect(service.items()[0].status()).toBe('success');
    expect(service.items()[0].uploadId()).toBe('prev-success');
    expect(service.activeIndex()).toBe(-1);
    expect(service.aggregateBytesUploaded()).toBe(100);
    expect(service.aggregateProgressPercent()).toBe(100);
  });

  it('resumes an in-progress item from the batch manifest via uploadUrl (M8 §12.3-12.8)', async () => {
    const file = makeFile('a.mp4', 100);
    const [sorted] = sortFingerprint([file]);
    const batchKey = await computeBatchKey([sorted]);
    manifestResponses.set(batchKey, [
      {
        id: 'prev-uploading',
        filename: 'a.mp4',
        size: 100,
        lastModified: file.lastModified,
        batchPosition: 0,
        status: 'uploading',
        bytesReceived: 40,
        storageKey: 'prev-uploading',
      },
    ]);

    await service.addFiles([file]);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].options.uploadUrl).toBe(`${environment.apiBaseUrl}/uploads/prev-uploading`);
    expect(service.items()[0].bytesUploaded()).toBe(40);
    expect(service.items()[0].status()).toBe('uploading');
    expect(service.items()[0].uploadId()).toBe('prev-uploading');
  });

  it('includes batchKey, lastModified, and batchPosition in upload metadata for a fresh upload (M8 §12.12)', async () => {
    const file = makeFile('a.mp4', 100);
    Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 });

    await service.addFiles([file]);

    expect(uploads[0].options.metadata?.['lastModified']).toBe('1700000000000');
    expect(uploads[0].options.metadata?.['batchPosition']).toBe('0');
    expect(uploads[0].options.metadata?.['batchKey']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never calls the removed heartbeat/abandon-beacon endpoints', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    makeUploadUrlAvailable(uploads[0], 'upload-123');

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));

    expect(calledUrls.some((url) => url.includes('/heartbeat'))).toBe(false);
    expect(calledUrls.some((url) => url.includes('/abandon'))).toBe(false);
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it('pongs the active item batch on each SSE ping (M8 §12.1/12.2)', async () => {
    await service.addFiles([makeFile('a.mp4', 100)]);
    const batchKey = service.items()[0].batchKey;

    progressService.pings.set(1);
    TestBed.flushEffects();

    expect(fetch).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/batches/${batchKey}/pong`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not pong when there is no active item', async () => {
    progressService.pings.set(1);
    TestBed.flushEffects();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/pong'))).toBe(false);
  });

  function deleteCalls(): string[] {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')
      .map(([url]) => String(url));
  }

  describe('cancel (M9 §13)', () => {
    it('removes a queued item without any server call', async () => {
      const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
      await service.addFiles(files);

      const queuedItem = service.items()[1];
      service.cancel(queuedItem);

      expect(service.items()).toHaveLength(1);
      expect(service.items()[0].name).toBe('a.mp4');
      expect(service.activeIndex()).toBe(0);
      expect(deleteCalls()).toHaveLength(0);
    });

    it('cancels the active uploading item: aborts with terminate, sets cancelling, and advances the queue', async () => {
      const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
      await service.addFiles(files);
      makeUploadUrlAvailable(uploads[0], 'u1');

      const activeItem = service.items()[0];
      service.cancel(activeItem);

      expect(uploads[0].abort).toHaveBeenCalledWith(true);
      expect(activeItem.status()).toBe('cancelling');
      expect(uploads).toHaveLength(2); // next item started
      expect(service.activeIndex()).toBe(1);
    });

    it('cancels a paused item via abort(true), setting it to cancelling', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      service.pause();
      const item = service.items()[0];
      expect(service.displayStatus(item)).toBe('paused');

      service.cancel(item);

      expect(uploads[0].abort).toHaveBeenCalledWith(true);
      expect(item.status()).toBe('cancelling');
    });

    it('displayStatus reflects the SSE-confirmed cancelled status once it arrives', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      const item = service.items()[0];
      service.cancel(item);
      expect(service.displayStatus(item)).toBe('cancelling');

      progressService.emit({ uploadId: 'u1', status: 'cancelled', bytesReceived: 50, bytesTotal: 100 });

      expect(service.displayStatus(item)).toBe('cancelled');
    });

    it('displayStatus stays cancelling if no SSE confirmation arrives', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      const item = service.items()[0];
      service.cancel(item);

      expect(service.displayStatus(item)).toBe('cancelling');
    });

    it('removes an already-cancelled item without any server call', async () => {
      const file = makeFile('a.mp4', 100);
      const [sorted] = sortFingerprint([file]);
      const batchKey = await computeBatchKey([sorted]);
      manifestResponses.set(batchKey, [
        {
          id: 'prev-cancelled',
          filename: 'a.mp4',
          size: 100,
          lastModified: file.lastModified,
          batchPosition: 0,
          status: 'cancelled',
          bytesReceived: 30,
          storageKey: 'prev-cancelled',
        },
      ]);

      await service.addFiles([file]);
      expect(service.items()[0].status()).toBe('cancelled');
      expect(uploads).toHaveLength(0);

      service.cancel(service.items()[0]);

      expect(service.items()).toHaveLength(0);
      expect(deleteCalls()).toHaveLength(0);
    });
  });

  describe('missing (M10 §14)', () => {
    it('displayStatus reflects a missing event pushed over SSE for an active item (§14.3)', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      progressService.emit({ uploadId: 'u1', status: 'missing', bytesReceived: 100, bytesTotal: 100 });

      expect(service.displayStatus(service.items()[0])).toBe('missing');
    });

    it('treats a missing manifest entry as a fresh upload, not a resume (§14.7)', async () => {
      const file = makeFile('a.mp4', 100);
      const [sorted] = sortFingerprint([file]);
      const batchKey = await computeBatchKey([sorted]);
      manifestResponses.set(batchKey, [
        {
          id: 'prev-missing',
          filename: 'a.mp4',
          size: 100,
          lastModified: file.lastModified,
          batchPosition: 0,
          status: 'missing',
          bytesReceived: 100,
          storageKey: 'prev-missing',
        },
      ]);

      await service.addFiles([file]);

      expect(uploads).toHaveLength(1);
      expect(uploads[0].options.uploadUrl).toBeUndefined();
      expect(service.items()[0].status()).toBe('uploading');
      expect(service.items()[0].uploadId()).toBeNull();
    });

    it('removes an item whose displayStatus is missing without any server call (§14.8)', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      progressService.emit({ uploadId: 'u1', status: 'missing', bytesReceived: 100, bytesTotal: 100 });
      const item = service.items()[0];
      expect(service.displayStatus(item)).toBe('missing');

      service.cancel(item);

      expect(service.items()).toHaveLength(0);
      expect(deleteCalls()).toHaveLength(0);
    });
  });

  describe('hasCancellableItems / Cancel remaining (M9 §13.7/13.8)', () => {
    it('is false for an empty queue and true once a file is queued', async () => {
      expect(service.hasCancellableItems()).toBe(false);

      await service.addFiles([makeFile('a.mp4', 100)]);

      expect(service.hasCancellableItems()).toBe(true);
    });

    it('requestCancelAll only flips the confirmation flag, issuing no fetch', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);

      service.requestCancelAll();

      expect(service.confirmingCancelAll()).toBe(true);
      expect(deleteCalls()).toHaveLength(0);
    });

    it('dismissCancelAll hides the confirmation without side effects', async () => {
      await service.addFiles([makeFile('a.mp4', 100)]);

      service.requestCancelAll();
      service.dismissCancelAll();

      expect(service.confirmingCancelAll()).toBe(false);
      expect(deleteCalls()).toHaveLength(0);
    });

    it('confirmCancelAll drops queued items, marks the active upload cancelling, aborts it, and issues one batch DELETE', async () => {
      const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
      await service.addFiles(files);
      makeUploadUrlAvailable(uploads[0], 'u1');

      const [first, second] = service.items();
      const batchKey = first.batchKey;

      service.requestCancelAll();
      service.confirmCancelAll();

      expect(service.confirmingCancelAll()).toBe(false);
      // queued item dropped entirely
      expect(service.items()).toHaveLength(1);
      expect(service.items()).toEqual([first]);
      expect(service.items()).not.toContain(second);

      expect(first.status()).toBe('cancelling');
      expect(uploads[0].abort).toHaveBeenCalledWith(true);
      expect(service.activeIndex()).toBe(-1);

      expect(deleteCalls()).toEqual([`${environment.apiBaseUrl}/batches/${batchKey}`]);
    });
  });

  it('verifies integrity via SHA-256 after onSuccess without blocking processNext (M8 §12.9-12.11)', async () => {
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32));

    const files = [makeFile('a.mp4', 100), makeFile('b.mp4', 200)];
    await service.addFiles(files);

    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    succeed(uploads[0]);

    // Queue advances immediately, without waiting for the hash to compute.
    expect(uploads).toHaveLength(2);
    expect(service.activeIndex()).toBe(1);

    await vi.waitFor(() => {
      expect(clientHashCalls).toContainEqual({ id: 'u1', hash: expect.any(String) });
    });
    expect(digestSpy).toHaveBeenCalled();
  });
});
