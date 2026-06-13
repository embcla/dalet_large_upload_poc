import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { generateFile } from '../generators/generate-file';

// Same origin the frontend's ProgressService/tus client talk to
// (environment.apiBaseUrl), so the abandon call below lands on the same
// backend instance and SSE broadcast the page is subscribed to.
const BACKEND_URL = process.env.THROTTLED_BACKEND_URL ?? 'http://localhost:3001';

const FIXTURE_DIR = path.join(__dirname, 'tmp-m5');

test.describe('M5 SSE-driven error/abandoned statuses (§9.12)', () => {
  test.beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  test.afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test('shows an error message and Retry button when the upload PATCH fails', async ({ page }) => {
    const fixturePath = path.join(FIXTURE_DIR, 'e2e-error.mp4');
    generateFile(fixturePath, 2 * 1024 * 1024);

    await page.route('**/uploads/**', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(fixturePath);

    await expect(page.locator('.message--error')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('shows the abandoned message pushed over SSE when the session is abandoned mid-upload', async ({ page }) => {
    const fixturePath = path.join(FIXTURE_DIR, 'e2e-abandon.mp4');
    generateFile(fixturePath, 20 * 1024 * 1024);

    // Hold the data PATCH up so the session is still 'uploading' server-side
    // when we call the abandon endpoint below.
    await page.route('**/uploads/**', async (route) => {
      if (route.request().method() === 'PATCH') {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      await route.continue();
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/uploads',
      ),
      page.locator('input[type=file]').setInputFiles(fixturePath),
    ]);

    const location = createResponse.headers()['location'];
    const uploadId = location?.split('/').pop();
    expect(uploadId).toBeTruthy();

    const res = await fetch(`${BACKEND_URL}/uploads/${uploadId}/abandon`, { method: 'POST' });
    expect(res.status).toBe(204);

    await expect(page.locator('.message--abandoned')).toHaveText(/abandoned/i, { timeout: 10_000 });
  });
});
