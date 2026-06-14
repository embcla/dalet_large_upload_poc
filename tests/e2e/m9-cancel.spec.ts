import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';

const FIXTURE_DIR = path.join(__dirname, 'tmp-m9');
const MB = 1024 * 1024;

test.describe('M9 cancellation (§13)', () => {
  // These tests share the single toxiproxy-throttled (20MB/s) backend
  // connection with in-progress uploads; running them concurrently with
  // each other (or with other large e2e uploads) can starve a transfer
  // enough to fail outright. Keep them serial.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  test.afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test('cancelling an in-progress upload shows cancelling then cancelled (§13.1-13.6, 13.12)', async ({ page }) => {
    const filePath = path.join(FIXTURE_DIR, 'cancel-active.mp4');
    generateFile(filePath, 20 * MB);

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(filePath);

    const item = page.locator('.queue-item').first();
    await expect(item.locator('.message--info')).toHaveText(/uploading/i);

    // Wait for some progress so the cancel hits a genuinely in-progress upload.
    const progressBar = item.locator('progress');
    await expect(async () => {
      const value = await progressBar.evaluate((el) => (el as HTMLProgressElement).value);
      expect(value).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });

    await item.locator('.cancel-btn').click();

    // The local "cancelling" -> SSE-confirmed "cancelled" transition can
    // happen too fast to reliably observe both states; assert the
    // immediate local state is one of them, then wait for the terminal one.
    await expect(item.locator('.message--cancelling, .message--cancelled')).toBeVisible();
    await expect(item.locator('.message--cancelled')).toHaveText(/cancelled/i, { timeout: 15_000 });
  });

  test('cancelling a queued file removes it from the list immediately (§13.11)', async ({ page }) => {
    const filePaths = ['cancel-queued-1.mp4', 'cancel-queued-2.mp4', 'cancel-queued-3.mp4'].map((name) => {
      const filePath = path.join(FIXTURE_DIR, name);
      generateFile(filePath, name === 'cancel-queued-3.mp4' ? 1 * MB : 30 * MB);
      return filePath;
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(filePaths);

    const items = page.locator('.queue-item');
    await expect(items).toHaveCount(3);

    await expect(items.nth(0).locator('.message--info')).toHaveText(/uploading/i);
    await expect(items.nth(2).locator('.message--queued')).toHaveText(/waiting/i);

    await items.nth(2).locator('.cancel-btn').click();

    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator('.message--info')).toHaveText(/uploading/i);
    await expect(items.nth(1).locator('.message--queued')).toHaveText(/waiting/i);
  });

  test('Cancel remaining: confirm/deny flow, then batch-cancels non-terminal items (§13.7-13.10)', async ({
    page,
  }) => {
    // Names are chosen so the browser's FileList (alphabetical) preserves
    // the intended queue order: small (completes first), large (active when
    // "Cancel remaining" is clicked), queued (still waiting).
    const smallPath = path.join(FIXTURE_DIR, 'cancel-batch-a-small.mp4');
    const largePath = path.join(FIXTURE_DIR, 'cancel-batch-b-large.mp4');
    const queuedPath = path.join(FIXTURE_DIR, 'cancel-batch-c-queued.mp4');
    generateFile(smallPath, 1 * MB);
    generateFile(largePath, 60 * MB);
    generateFile(queuedPath, 10 * MB);

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles([smallPath, largePath, queuedPath]);

    const items = page.locator('.queue-item');
    await expect(items).toHaveCount(3);

    // First (small) file finishes quickly; second (large) becomes active.
    await expect(items.nth(0).locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });
    await expect(items.nth(1).locator('.message--info')).toHaveText(/uploading/i);
    await expect(items.nth(2).locator('.message--queued')).toHaveText(/waiting/i);

    const cancelAllButton = page.locator('.cancel-all button');
    await expect(cancelAllButton).toHaveText(/cancel remaining/i);

    // "No" dismisses the confirmation without cancelling anything.
    await cancelAllButton.click();
    await expect(page.locator('.cancel-all__confirm')).toHaveText(/cancel remaining uploads/i);
    const buttons = page.locator('.cancel-all__confirm button');
    await buttons.filter({ hasText: 'No' }).click();
    await expect(page.locator('.cancel-all__confirm')).toHaveCount(0);
    await expect(items).toHaveCount(3);
    await expect(items.nth(1).locator('.message--info')).toHaveText(/uploading/i);

    // "Yes, cancel" cancels the in-progress and queued items.
    await cancelAllButton.click();
    await page.locator('.cancel-all__confirm button').filter({ hasText: 'Yes, cancel' }).click();

    // The queued item is dropped entirely; the active item transitions
    // cancelling -> cancelled via SSE confirmation (too fast to reliably
    // observe the intermediate "cancelling" state separately).
    await expect(items).toHaveCount(2);
    await expect(items.nth(1).locator('.message--cancelling, .message--cancelled')).toBeVisible();
    await expect(items.nth(1).locator('.message--cancelled')).toHaveText(/cancelled/i, { timeout: 15_000 });

    // The already-completed item is untouched.
    await expect(items.nth(0).locator('.message--success')).toHaveText(/upload complete/i);
  });
});
