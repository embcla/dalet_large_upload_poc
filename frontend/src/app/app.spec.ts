import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { ConfigService, AppConfig } from './services/config.service';

class FakeConfigService {
  private readonly config: AppConfig = {
    maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
    acceptedExtensions: ['.mp4', '.mkv'],
    acceptedMimeTypes: ['video/mp4', 'video/x-matroska'],
  };

  get(): AppConfig {
    return this.config;
  }
}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ConfigService, useClass: FakeConfigService }],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Media Upload Platform');
  });
});
