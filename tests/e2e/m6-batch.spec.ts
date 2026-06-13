import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';
import { sha256OfFile, sha256OfObject } from '../integration/helpers';

const FIXTURE_DIR = path.join(__dirname, 'tmp-m6');

const FILES = [
  { name: 'e2e-batch-1.mp4', sizeBytes: 10 * 1024 * 1024 },
  { name: 'e2e-batch-2.mp4', sizeBytes: 10 * 1024 * 1024 },
  { name: 'e2e-batch-3.mp4', sizeBytes: 10 * 1024 * 1024 },
];

test.describe('M6 batch upload (§10)', () => {
  let filePaths: string[];

  test.beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    filePaths = FILES.map(({ name, sizeBytes }) => {
      const filePath = path.join(FIXTURE_DIR, name);
      generateFile(filePath, sizeBytes);
      return filePath;
    });
  });

  test.afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test('uploads a batch of files sequentially with per-item status and aggregate progress', async ({ page }) => {
    const uploadIds: string[] = [];
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/uploads') {
        const id = response.headers()['location']?.split('/').pop();
        if (id) {
          uploadIds.push(id);
        }
      }
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(filePaths);

    const items = page.locator('.queue-item');
    await expect(items).toHaveCount(3);

    await expect(items.nth(0).locator('.message--info')).toHaveText(/uploading/i);
    await expect(items.nth(1).locator('.message--queued')).toHaveText(/waiting/i);
    await expect(items.nth(2).locator('.message--queued')).toHaveText(/waiting/i);

    for (let i = 0; i < FILES.length; i++) {
      await expect(items.nth(i).locator('.message--success')).toHaveText(/upload complete/i, { timeout: 60_000 });
    }

    await expect(page.locator('.aggregate .progress-percent')).toHaveText('100%');

    expect(uploadIds).toHaveLength(3);
    for (let i = 0; i < FILES.length; i++) {
      const [expectedHash, actualHash] = await Promise.all([
        sha256OfFile(filePaths[i]),
        sha256OfObject(uploadIds[i]),
      ]);
      expect(actualHash).toBe(expectedHash);
    }
  });
});
