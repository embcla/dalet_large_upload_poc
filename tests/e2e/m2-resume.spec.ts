import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';

const FIXTURE_DIR = path.join(__dirname, 'tmp-m2');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'e2e-pause-resume.mp4');

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  generateFile(FIXTURE_PATH, 5 * 1024 * 1024);
});

test.afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test('pause and resume an in-progress upload through to completion', async ({ page }) => {
  // Hold up the data PATCH so the upload stays in 'uploading' long enough to
  // click Pause, regardless of how fast the local stack processes a 5MB file.
  let delayPatch = true;
  await page.route('**/uploads/**', async (route) => {
    if (route.request().method() === 'PATCH' && delayPatch) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });

  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Media Upload Platform');

  await page.locator('input[type=file]').setInputFiles(FIXTURE_PATH);

  const pauseButton = page.getByRole('button', { name: 'Pause' });
  await expect(pauseButton).toBeVisible();
  await pauseButton.click();

  await expect(page.locator('.message--paused')).toHaveText(/paused/i);
  const resumeButton = page.getByRole('button', { name: 'Resume' });
  await expect(resumeButton).toBeVisible();

  delayPatch = false;
  await resumeButton.click();

  await expect(page.locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });
});
