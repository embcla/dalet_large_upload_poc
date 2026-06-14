import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import * as tus from 'tus-js-client';
import { UploadQueue } from './upload-queue';
import { ConfigService, AppConfig } from '../services/config.service';
import { ProgressService, ProgressEvent } from '../services/progress.service';
import { environment } from '../../environments/environment';

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
  options: tus.UploadOptions;
  start: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function makeFile(name: string, sizeBytes: number, type = 'video/mp4'): File {
  const file = new File([new ArrayBuffer(0)], name, { type });
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

function filesEvent(files: File[]): Event {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: files });
  return { target: input } as unknown as Event;
}

describe('UploadQueue', () => {
  let fixture: ComponentFixture<UploadQueue>;
  let component: UploadQueue;
  let uploads: FakeUpload[];
  let progressService: FakeProgressService;

  beforeEach(async () => {
    uploads = [];
    vi.spyOn(tus, 'Upload').mockImplementation(function (this: FakeUpload, _file: unknown, options: tus.UploadOptions) {
      this.url = null;
      this.options = options;
      this.start = vi.fn();
      this.abort = vi.fn().mockResolvedValue(undefined);
      uploads.push(this);
    } as unknown as typeof tus.Upload);

    vi.spyOn(tus.Upload, 'terminate').mockResolvedValue(undefined);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
    navigator.sendBeacon = vi.fn().mockReturnValue(true);

    progressService = new FakeProgressService();

    await TestBed.configureTestingModule({
      imports: [UploadQueue],
      providers: [
        { provide: ConfigService, useClass: FakeConfigService },
        { provide: ProgressService, useValue: progressService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(UploadQueue);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function selectFiles(files: File[]): Promise<void> {
    await component.onFilesSelected(filesEvent(files));
    fixture.detectChanges();
  }

  function makeUploadUrlAvailable(upload: FakeUpload, id: string): void {
    upload.url = `${environment.apiBaseUrl}/uploads/${id}`;
    upload.options.onUploadUrlAvailable?.();
    fixture.detectChanges();
  }

  it('connects to the progress SSE channel on init', () => {
    expect(progressService.connect).toHaveBeenCalled();
  });

  it('renders one .queue-item per selected file', async () => {
    await selectFiles([makeFile('a.mp4', 100), makeFile('b.mp4', 200), makeFile('c.mp4', 300)]);

    const items = fixture.nativeElement.querySelectorAll('.queue-item');
    expect(items).toHaveLength(3);
  });

  it('shows the first file as uploading and the rest as waiting', async () => {
    await selectFiles([makeFile('a.mp4', 100), makeFile('b.mp4', 200)]);

    const items = fixture.nativeElement.querySelectorAll('.queue-item');
    expect(items[0].querySelector('.message--info')?.textContent).toContain('Uploading');
    expect(items[1].querySelector('.message--queued')?.textContent).toContain('Waiting');
  });

  it('shows a validation error and adds nothing for a disallowed file', async () => {
    await selectFiles([makeFile('notes.txt', 10, 'text/plain')]);

    expect(fixture.nativeElement.querySelector('.message--error')?.textContent).toContain('.mp4, .mkv');
    expect(fixture.nativeElement.querySelectorAll('.queue-item')).toHaveLength(0);
  });

  it('binds the aggregate progress bar to the service aggregate signals', async () => {
    await selectFiles([makeFile('a.mp4', 100), makeFile('b.mp4', 200)]);

    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'uploading', bytesReceived: 50, bytesTotal: 100 });
    fixture.detectChanges();

    const aggregate = fixture.nativeElement.querySelector('.aggregate-progress');
    expect(aggregate.value).toBe(50);
    expect(aggregate.max).toBe(300);
    expect(fixture.nativeElement.querySelector('.aggregate .progress-percent')?.textContent).toContain(
      `${component.queue.aggregateProgressPercent()}%`,
    );
  });

  it('shows Pause for an uploading item and Resume after pausing', async () => {
    await selectFiles([makeFile('a.mp4', 100)]);

    let item = fixture.nativeElement.querySelector('.queue-item');
    expect(item.querySelector('button:not(.cancel-btn)')?.textContent).toContain('Pause');

    component.pause();
    fixture.detectChanges();

    item = fixture.nativeElement.querySelector('.queue-item');
    expect(item.querySelector('button:not(.cancel-btn)')?.textContent).toContain('Resume');
  });

  it('shows Retry and Skip buttons when the active item errors', async () => {
    await selectFiles([makeFile('a.mp4', 100)]);

    uploads[0].options.onError?.(new Error('boom'));
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('.queue-item');
    const buttons = Array.from(item.querySelectorAll('button:not(.cancel-btn)')).map(
      (b) => (b as HTMLButtonElement).textContent,
    );
    expect(buttons).toEqual(['Retry', 'Skip']);
    expect(item.querySelector('.message--error')?.textContent).toContain('boom');
  });

  it('shows the success message once the active item completes', async () => {
    await selectFiles([makeFile('a.mp4', 100)]);

    makeUploadUrlAvailable(uploads[0], 'u1');
    progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
    uploads[0].options.onSuccess?.({ lastResponse: {} as tus.HttpResponse });
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('.queue-item');
    expect(item.querySelector('.message--success')?.textContent).toContain('Upload complete');
  });

  describe('cancel (M9 §13)', () => {
    it('shows a cancel button for queued/uploading/paused/error/abandoned items but not for success', async () => {
      await selectFiles([makeFile('a.mp4', 100), makeFile('b.mp4', 200)]);

      let items = fixture.nativeElement.querySelectorAll('.queue-item');
      expect(items[0].querySelector('.cancel-btn')).not.toBeNull(); // uploading
      expect(items[1].querySelector('.cancel-btn')).not.toBeNull(); // queued

      makeUploadUrlAvailable(uploads[0], 'u1');
      progressService.emit({ uploadId: 'u1', status: 'success', bytesReceived: 100, bytesTotal: 100 });
      uploads[0].options.onSuccess?.({ lastResponse: {} as tus.HttpResponse });
      fixture.detectChanges();

      items = fixture.nativeElement.querySelectorAll('.queue-item');
      expect(items[0].querySelector('.cancel-btn')).toBeNull(); // success
    });

    it('clicking the cancel button calls queue.cancel(item) and moves the item to cancelling/cancelled', async () => {
      await selectFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      const cancelSpy = vi.spyOn(component.queue, 'cancel');

      const item = fixture.nativeElement.querySelector('.queue-item');
      (item.querySelector('.cancel-btn') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(cancelSpy).toHaveBeenCalledWith(component.queue.items()[0]);
      expect(item.querySelector('.message--cancelling')?.textContent).toContain('Cancelling');

      progressService.emit({ uploadId: 'u1', status: 'cancelled', bytesReceived: 50, bytesTotal: 100 });
      fixture.detectChanges();

      expect(item.querySelector('.message--cancelled')?.textContent).toContain('Cancelled');
    });

    it('hides "Cancel remaining" when the queue is empty, shows it once a file is queued', async () => {
      expect(fixture.nativeElement.querySelector('.cancel-all')).toBeNull();

      await selectFiles([makeFile('a.mp4', 100)]);

      expect(fixture.nativeElement.querySelector('.cancel-all')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.cancel-all button')?.textContent).toContain('Cancel remaining');
    });

    it('clicking "Cancel remaining" shows the confirm/deny UI without cancelling; "No" dismisses it', async () => {
      await selectFiles([makeFile('a.mp4', 100)]);
      const confirmAllSpy = vi.spyOn(component.queue, 'confirmCancelAll');

      (fixture.nativeElement.querySelector('.cancel-all button') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.cancel-all__confirm')?.textContent).toContain(
        'Cancel remaining uploads?',
      );
      expect(confirmAllSpy).not.toHaveBeenCalled();

      const buttons = Array.from(fixture.nativeElement.querySelectorAll('.cancel-all__confirm button')) as HTMLButtonElement[];
      const noButton = buttons.find((b) => b.textContent?.includes('No'));
      noButton?.click();
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.cancel-all__confirm')).toBeNull();
      expect(fixture.nativeElement.querySelector('.cancel-all button')?.textContent).toContain('Cancel remaining');
      expect(confirmAllSpy).not.toHaveBeenCalled();
    });

    it('clicking "Yes, cancel" calls confirmCancelAll', async () => {
      await selectFiles([makeFile('a.mp4', 100)]);
      const confirmAllSpy = vi.spyOn(component.queue, 'confirmCancelAll');

      (fixture.nativeElement.querySelector('.cancel-all button') as HTMLButtonElement).click();
      fixture.detectChanges();

      const buttons = Array.from(fixture.nativeElement.querySelectorAll('.cancel-all__confirm button')) as HTMLButtonElement[];
      const yesButton = buttons.find((b) => b.textContent?.includes('Yes, cancel'));
      yesButton?.click();
      fixture.detectChanges();

      expect(confirmAllSpy).toHaveBeenCalled();
    });
  });

  describe('missing (M10 §14)', () => {
    it('shows a cancel button and the "file no longer available" message for a missing item (§14.8)', async () => {
      await selectFiles([makeFile('a.mp4', 100)]);
      makeUploadUrlAvailable(uploads[0], 'u1');

      progressService.emit({ uploadId: 'u1', status: 'missing', bytesReceived: 100, bytesTotal: 100 });
      fixture.detectChanges();

      const item = fixture.nativeElement.querySelector('.queue-item');
      expect(item.querySelector('.cancel-btn')).not.toBeNull();
      expect(item.querySelector('.message--missing')?.textContent).toContain('File no longer available');
    });
  });
});
