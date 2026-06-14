import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { deleteObjects, runReconciliation } from '../integration/helpers';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const COMPATIBLE = path.join(FIXTURES_DIR, 'compatible.mp4');
const FIXTURE_DIR = path.join(__dirname, 'tmp-m10');
// A playable file is needed for the `<video>` element to render, so this is
// a copy of `compatible.mp4` under its own name - reusing `compatible.mp4`
// directly would give this test the same M8 `batch_key` (name|size|
// lastModified) as m7-playback.spec.ts's upload of the same fixture, and
// under parallel workers the two tests would resume/observe each other's row.
const RECONCILE_FIXTURE = path.join(FIXTURE_DIR, 'reconcile.mp4');

test.describe('M10 MinIO object reconciliation (§14)', () => {
  test.beforeAll(() => {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.copyFileSync(COMPATIBLE, RECONCILE_FIXTURE);
  });

  test.afterAll(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  test('a file whose object is deleted out-of-band disappears from the list and clears the player (§14.3)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Media Upload Platform');

    await page.locator('input[type=file]').setInputFiles(RECONCILE_FIXTURE);
    await expect(page.locator('.message--success')).toHaveText(/upload complete/i, { timeout: 30_000 });

    const fileItem = page.locator('.files-list .file-item').filter({ hasText: 'reconcile.mp4' }).first();
    await expect(fileItem).toBeVisible({ timeout: 30_000 });
    await fileItem.click();

    const video = page.locator('video');
    await expect(video).toBeVisible();

    // The video's `src` (`/files/:id/stream`) encodes the upload id, which
    // doubles as the object's storage key (M1).
    const src = await video.getAttribute('src');
    const uploadId = src?.match(/\/files\/(.+)\/stream/)?.[1];

    expect(uploadId).toBeTruthy();
    await deleteObjects([uploadId!, `${uploadId}.info`]);
    await runReconciliation();

    await expect(fileItem).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.files .message--missing')).toHaveText(/file no longer available/i);
    await expect(video).toHaveCount(0);
  });
});
