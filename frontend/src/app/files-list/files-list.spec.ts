import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { FilesList } from './files-list';
import { FileItem, FilesService } from '../services/files.service';
import { environment } from '../../environments/environment';

const playableFile: FileItem = {
  id: 'f1',
  filename: 'compatible.mp4',
  size: 1234,
  status: 'success',
  duration: 2.5,
  resolution: '320x240',
  codec: 'h264/aac',
  playable: true,
};

const unplayableFile: FileItem = {
  id: 'f2',
  filename: 'incompatible.mkv',
  size: 5678,
  status: 'success',
  duration: 2,
  resolution: '320x240',
  codec: 'mpeg2video',
  playable: false,
};

describe('FilesList', () => {
  let fixture: ComponentFixture<FilesList>;
  let httpMock: HttpTestingController;

  async function setup(files: FileItem[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [FilesList],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(FilesList);
    httpMock = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    httpMock.expectOne(`${environment.apiBaseUrl}/files`).flush(files);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture?.destroy();
    httpMock.verify();
  });

  it('shows the empty state and placeholder when there are no files', async () => {
    await setup([]);

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.empty-state')?.textContent).toContain('No uploaded files yet.');
    expect(compiled.querySelector('.placeholder')?.textContent).toContain('Select a file to preview.');
  });

  it('renders a row per file with metadata', async () => {
    await setup([playableFile, unplayableFile]);

    const compiled = fixture.nativeElement as HTMLElement;
    const items = compiled.querySelectorAll('.file-item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.file-name')?.textContent).toContain('compatible.mp4');
    expect(items[0].querySelector('.file-size')?.textContent).toContain('1.2 KB');
    expect(items[0].querySelector('.file-resolution')?.textContent).toContain('320x240');
    expect(items[0].querySelector('.badge--playable')).toBeTruthy();
    expect(items[1].querySelector('.badge--unplayable')).toBeTruthy();
  });

  it('shows a video player when selecting a playable file', async () => {
    await setup([playableFile]);

    const compiled = fixture.nativeElement as HTMLElement;
    (compiled.querySelector('.file-item') as HTMLElement).click();
    fixture.detectChanges();

    const video = compiled.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toBe(`${environment.apiBaseUrl}/files/f1/stream`);
  });

  it('shows "preview not available" when selecting an unplayable file', async () => {
    await setup([unplayableFile]);

    const compiled = fixture.nativeElement as HTMLElement;
    (compiled.querySelector('.file-item') as HTMLElement).click();
    fixture.detectChanges();

    expect(compiled.querySelector('video')).toBeFalsy();
    expect(compiled.querySelector('.message--error')?.textContent).toContain(
      'Preview not available for this format.',
    );
  });

  it('shows "file no longer available" when the selected file disappears from the list (M10 §14.3)', async () => {
    await setup([playableFile]);

    const compiled = fixture.nativeElement as HTMLElement;
    (compiled.querySelector('.file-item') as HTMLElement).click();
    fixture.detectChanges();

    expect(compiled.querySelector('video')).toBeTruthy();

    const filesService = TestBed.inject(FilesService);
    filesService.files.set([]);
    fixture.detectChanges();

    expect(compiled.querySelector('video')).toBeFalsy();
    expect(compiled.querySelector('.message--missing')?.textContent).toContain('File no longer available.');
  });
});
