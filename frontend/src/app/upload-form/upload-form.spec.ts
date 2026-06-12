import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import * as tus from 'tus-js-client';
import { UploadForm, getExtension, describeError } from './upload-form';
import { ConfigService, AppConfig } from '../services/config.service';

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
  let startSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    startSpy = vi.fn();
    vi.spyOn(tus, 'Upload').mockImplementation(function (this: unknown) {
      Object.assign(this as object, { start: startSpy });
    } as unknown as typeof tus.Upload);

    await TestBed.configureTestingModule({
      imports: [UploadForm],
      providers: [{ provide: ConfigService, useClass: FakeConfigService }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects files larger than the configured max size without starting an upload', () => {
    const fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    const bigFile = new File([new ArrayBuffer(10)], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(bigFile, 'size', { value: 3 * 1024 * 1024 * 1024 }); // 3GB

    component.onFileSelected(fileEvent(bigFile));

    expect(component.validationError()).toContain('too large');
    expect(component.status()).toBe('idle');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('rejects files with a disallowed extension without starting an upload', () => {
    const fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    const badFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    component.onFileSelected(fileEvent(badFile));

    expect(component.validationError()).toContain('.mp4, .mkv');
    expect(component.status()).toBe('idle');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('starts an upload for a valid file', () => {
    const fixture = TestBed.createComponent(UploadForm);
    const component = fixture.componentInstance;

    const goodFile = new File(['hello'], 'movie.mp4', { type: 'video/mp4' });

    component.onFileSelected(fileEvent(goodFile));

    expect(component.validationError()).toBeNull();
    expect(component.status()).toBe('uploading');
    expect(startSpy).toHaveBeenCalled();
  });
});
