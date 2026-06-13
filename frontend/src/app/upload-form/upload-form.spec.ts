import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import * as tus from 'tus-js-client';
import { UploadForm, getExtension, describeError } from './upload-form';
import { ConfigService, AppConfig } from '../services/config.service';
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

function fileEvent(file: File): Event {
  const input = document.createElement('input');
  input.type = 'file';
  Object.defineProperty(input, 'files', { value: [file] });
  return { target: input } as unknown as Event;
}

interface FakeUpload {
  url: string | null;
  options: tus.UploadOptions;
  start: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
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

describe('UploadForm', () => {
  let lastUpload: FakeUpload;
  let fixture: ComponentFixture<UploadForm>;

  beforeEach(async () => {
    vi.spyOn(tus, 'Upload').mockImplementation(function (this: FakeUpload, _file: unknown, options: tus.UploadOptions) {
      this.url = null;
      this.options = options;
      this.start = vi.fn();
      this.abort = vi.fn();
      lastUpload = this;
    } as unknown as typeof tus.Upload);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
    navigator.sendBeacon = vi.fn().mockReturnValue(true);

    await TestBed.configureTestingModule({
      imports: [UploadForm],
      providers: [{ provide: ConfigService, useClass: FakeConfigService }],
    }).compileComponents();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function selectGoodFile(component: UploadForm): void {
    const goodFile = new File(['hello'], 'movie.mp4', { type: 'video/mp4' });
    component.onFileSelected(fileEvent(goodFile));
  }

  function makeUploadUrlAvailable(id: string): void {
    lastUpload.url = `${environment.apiBaseUrl}/uploads/${id}`;
    lastUpload.options.onUploadUrlAvailable?.();
  }

  it('rejects files larger than the configured max size without starting an upload', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    const bigFile = new File([new ArrayBuffer(10)], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(bigFile, 'size', { value: 3 * 1024 * 1024 * 1024 }); // 3GB

    component.onFileSelected(fileEvent(bigFile));

    expect(component.validationError()).toContain('too large');
    expect(component.status()).toBe('idle');
  });

  it('rejects files with a disallowed extension without starting an upload', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    const badFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    component.onFileSelected(fileEvent(badFile));

    expect(component.validationError()).toContain('.mp4, .mkv');
    expect(component.status()).toBe('idle');
  });

  it('starts an upload for a valid file', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);

    expect(component.validationError()).toBeNull();
    expect(component.status()).toBe('uploading');
    expect(lastUpload.start).toHaveBeenCalled();
  });

  it('pause aborts the upload and sets status to paused', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    component.pause();

    expect(lastUpload.abort).toHaveBeenCalled();
    expect(component.status()).toBe('paused');
  });

  it('resume restarts the upload and sets status back to uploading', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    component.pause();
    component.resume();

    expect(lastUpload.start).toHaveBeenCalledTimes(2);
    expect(component.status()).toBe('uploading');
  });

  it('retry (resume after error) clears the error and resumes the upload', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    lastUpload.options.onError?.(new Error('connection lost'));

    expect(component.status()).toBe('error');
    expect(component.errorMessage()).toBe('connection lost');

    component.resume();

    expect(component.status()).toBe('uploading');
    expect(component.errorMessage()).toBeNull();
    expect(lastUpload.start).toHaveBeenCalledTimes(2);
  });

  it('sends a heartbeat for the upload every ~20s while in progress', () => {
    vi.useFakeTimers();

    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    makeUploadUrlAvailable('upload-123');

    vi.advanceTimersByTime(20_000);

    expect(fetch).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/uploads/upload-123/heartbeat`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends an abandon beacon on page unload for an in-progress upload', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    makeUploadUrlAvailable('upload-456');

    window.dispatchEvent(new Event('pagehide'));

    expect(navigator.sendBeacon).toHaveBeenCalledWith(`${environment.apiBaseUrl}/uploads/upload-456/abandon`);
  });

  it('does not send an abandon beacon once the upload succeeded', () => {
    fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    selectGoodFile(component);
    makeUploadUrlAvailable('upload-789');
    lastUpload.options.onSuccess?.({ lastResponse: {} as tus.HttpResponse });

    window.dispatchEvent(new Event('pagehide'));

    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });
});
