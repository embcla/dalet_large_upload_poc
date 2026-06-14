import { test, expect } from '@playwright/test';
import * as path from 'path';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const COMPATIBLE = path.join(FIXTURES_DIR, 'compatible.mp4');
const INCOMPATIBLE = path.join(FIXTURES_DIR, 'incompatible.mkv');

test.describe('M7 uploaded files visualization & playback (§11)', () => {
  test('a completed compatible upload auto-appears in the files list and plays back with seeking', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(COMPATIBLE);

    await expect(page.locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });

    // SSE-driven auto-refresh: the file shows up in the right-hand list
    // without reloading the page. `.first()` picks the just-uploaded row —
    // `getCompletedUploads` orders most-recent-first, and repeated runs
    // against the shared dev DB accumulate earlier rows for the same file.
    const fileItem = page.locator('.files-list .file-item').filter({ hasText: 'compatible.mp4' }).first();
    await expect(fileItem).toBeVisible({ timeout: 30_000 });
    await expect(fileItem.locator('.badge--playable')).toBeVisible();

    await fileItem.click();

    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', /\/files\/.+\/stream/);

    await video.evaluate((el: HTMLVideoElement) => el.play());
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0);

    // Seeking exercises the Range-supporting stream endpoint end-to-end.
    await video.evaluate((el: HTMLVideoElement) => {
      el.pause();
      el.currentTime = 1;
    });
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThanOrEqual(1);
  });

  test('a completed incompatible upload shows "preview not available" with no video element', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(INCOMPATIBLE);

    await expect(page.locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });

    const fileItem = page.locator('.files-list .file-item').filter({ hasText: 'incompatible.mkv' }).first();
    await expect(fileItem).toBeVisible({ timeout: 30_000 });
    await expect(fileItem.locator('.badge--unplayable')).toBeVisible();

    await fileItem.click();

    await expect(page.locator('.files .message--error')).toHaveText(/preview not available/i);
    await expect(page.locator('video')).toHaveCount(0);
  });
});
