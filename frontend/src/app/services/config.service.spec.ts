import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ConfigService } from './config.service';
import { environment } from '../../environments/environment';

describe('ConfigService', () => {
  let service: ConfigService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('throws if accessed before load() resolves', () => {
    expect(() => service.get()).toThrow();
  });

  it('loads and caches the config from GET /config', async () => {
    const response = {
      maxFileSizeBytes: 2147483648,
      acceptedExtensions: ['.mp4', '.mkv'],
      acceptedMimeTypes: ['video/mp4', 'video/x-matroska'],
    };

    const loadPromise = service.load();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/config`);
    expect(req.request.method).toBe('GET');
    req.flush(response);

    await loadPromise;

    expect(service.get()).toEqual(response);
  });
});
