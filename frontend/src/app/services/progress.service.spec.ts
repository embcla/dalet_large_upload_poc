import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ProgressService } from './progress.service';
import { environment } from '../../environments/environment';

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

describe('ProgressService', () => {
  let service: ProgressService;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    TestBed.configureTestingModule({});
    service = TestBed.inject(ProgressService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a connection to /progress/stream on connect()', () => {
    service.connect();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(`${environment.apiBaseUrl}/progress/stream`);
  });

  it('does not open a second connection if already connected', () => {
    service.connect();
    service.connect();

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('stores incoming events in the events map, keyed by uploadId', () => {
    service.connect();
    const source = FakeEventSource.instances[0];

    source.emit({ uploadId: 'u1', status: 'uploading', bytesReceived: 100, bytesTotal: 1000 });

    expect(service.events().get('u1')).toEqual({
      uploadId: 'u1',
      status: 'uploading',
      bytesReceived: 100,
      bytesTotal: 1000,
    });
  });

  it('overwrites the previous event for the same uploadId', () => {
    service.connect();
    const source = FakeEventSource.instances[0];

    source.emit({ uploadId: 'u1', status: 'uploading', bytesReceived: 100, bytesTotal: 1000 });
    source.emit({ uploadId: 'u1', status: 'success', bytesReceived: 1000, bytesTotal: 1000 });

    expect(service.events().get('u1')?.status).toBe('success');
    expect(service.events().size).toBe(1);
  });

  it('closes the EventSource on disconnect()', () => {
    service.connect();
    const source = FakeEventSource.instances[0];

    service.disconnect();

    expect(source.close).toHaveBeenCalled();
  });
});
