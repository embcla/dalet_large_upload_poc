import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import { sha256OfFile, sha256OfObject } from '../integration/helpers';

const FIXTURE_DIR = path.join(__dirname, 'tmp-m8');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'e2e-resume.mp4');
// Large enough that, throttled through toxiproxy (20MB/s), the upload takes
// a few seconds — long enough to observe non-zero progress and click Pause
// before it completes.
const SIZE_BYTES = 60 * 1024 * 1024;

test.describe('M8 cross-reload resume & integrity verification (§12.3-12.11)', () => {
  test.beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    generateFile(FIXTURE_PATH, SIZE_BYTES);
  });

  test.afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test('pausing, reloading, and re-selecting the same file resumes from the manifest and verifies', async ({
    page,
  }) => {
    let uploadId: string | undefined;
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/uploads') {
        uploadId = response.headers()['location']?.split('/').pop();
      }
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(FIXTURE_PATH);

    const progressBar = page.locator('.queue-item progress').first();

    // Wait until enough bytes have been sent that the server's throttled
    // bytes_received persistence (every PROGRESS_THROTTLE_MS, ~6MB per tick
    // at this throttled rate) has landed at least once, then pause. Pausing
    // too early (before the first persisted tick) would resume from 0.
    const MIN_PROGRESS_BEFORE_PAUSE = SIZE_BYTES / 4;
    await expect(async () => {
      const value = await progressBar.evaluate((el) => (el as HTMLProgressElement).value);
      expect(value).toBeGreaterThan(MIN_PROGRESS_BEFORE_PAUSE);
    }).toPass({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.message--paused')).toHaveText(/paused/i);

    const pausedValue = await progressBar.evaluate((el) => (el as HTMLProgressElement).value);
    expect(pausedValue).toBeGreaterThan(0);
    expect(pausedValue).toBeLessThan(SIZE_BYTES);

    await page.reload();
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    // Re-select the same file — same name/size/lastModified, so the
    // frontend computes the same batch_key and the manifest reconstructs
    // this item as `uploading`, resuming via `uploadUrl`.
    await page.locator('input[type=file]').setInputFiles(FIXTURE_PATH);

    const items = page.locator('.queue-item');
    await expect(items).toHaveCount(1);

    const resumedProgressBar = items.first().locator('progress');
    await expect(resumedProgressBar).toBeVisible();
    // The manifest's `bytesReceived` is persisted on a throttle (every
    // PROGRESS_THROTTLE_MS), so it can momentarily lag the in-browser
    // progress value captured at the moment Pause was clicked. What matters
    // for cross-reload resume is that it picks up mid-file, not from zero —
    // either from the manifest's seeded value, or moments later once the
    // resumed tus.Upload's HEAD reports the true server-side offset.
    let resumedInitialValue = 0;
    await expect(async () => {
      resumedInitialValue = await resumedProgressBar.evaluate((el) => (el as HTMLProgressElement).value);
      expect(resumedInitialValue).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    expect(resumedInitialValue).toBeLessThan(SIZE_BYTES);

    await expect(items.first().locator('.message--success')).toHaveText(/upload complete/i, { timeout: 60_000 });

    await expect(items.first().locator('.badge--verified')).toHaveText(/verified/i, { timeout: 15_000 });

    expect(uploadId).toBeTruthy();
    const [expectedHash, actualHash] = await Promise.all([
      sha256OfFile(FIXTURE_PATH),
      sha256OfObject(uploadId!),
    ]);
    expect(actualHash).toBe(expectedHash);
  });
});
