import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';

const FIXTURE_DIR = path.join(__dirname, 'tmp');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'e2e-clip.mp4');

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  generateFile(FIXTURE_PATH, 2 * 1024 * 1024);
});

test.afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test('uploads a video file and shows progress through to completion', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Media Upload Platform');

  await page.locator('input[type=file]').setInputFiles(FIXTURE_PATH);

  await expect(page.locator('.queue-item progress').first()).toBeVisible();
  await expect(page.locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });
});
