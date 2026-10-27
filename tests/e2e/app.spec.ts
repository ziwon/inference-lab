import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const timeReadout = (page: import('@playwright/test').Page) => page.locator('.time-readout b');

async function readMs(page: import('@playwright/test').Page): Promise<number> {
  const text = (await timeReadout(page).textContent()) ?? '';
  const value = parseFloat(text);
  return text.includes(' s') ? value * 1000 : value;
}

test('loads the default preset, plays, pauses, and steps through events', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Long prefill interruption', level: 2 })).toBeVisible();
  await expect(page.locator('.tl-panel-header')).toHaveCount(2);
  await expect(timeReadout(page)).toHaveText('0.0 ms');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => readMs(page)).toBeGreaterThan(50);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await readMs(page);
  await page.waitForTimeout(250);
  expect(await readMs(page)).toBe(paused);

  await page.getByRole('button', { name: 'Reset to start' }).click();
  await page.getByRole('button', { name: 'Next event' }).click();
  const first = await readMs(page);
  await page.getByRole('button', { name: 'Next event' }).click();
  const second = await readMs(page);
  expect(second).toBeGreaterThan(first);
  await page.getByRole('button', { name: 'Previous event' }).click();
  expect(await readMs(page)).toBe(first);
  await expect(page.locator('.inspector').first()).toContainText('Iteration 1');
  expect(errors).toEqual([]);
});

test('keyboard shortcuts work but never intercept typing in fields', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect(await readMs(page)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  expect(await readMs(page)).toBe(0);

  const budget = page.getByLabel('Token budget per iteration');
  await budget.click();
  await budget.press('End');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await readMs(page)).toBe(0);

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('End');
  await expect(page.locator('.metrics-table')).toContainText('9 / 9');
});

test('changing a control re-simulates, marks the configuration as modified, and updates the link', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Jump to end' }).click();
  await page.getByRole('radio', { name: 'Final' }).click();
  const longRow = page.locator('.request-table tbody tr', { has: page.getByRole('button', { name: 'LONG', exact: true }) });
  const before = await longRow.locator('td').nth(2).textContent();

  const chunk = page.getByRole('textbox', { name: 'Max prefill chunk', exact: true });
  await chunk.fill('4096');
  await expect(page.locator('.brief .tag')).toHaveText('modified');
  await expect(page).toHaveURL(/cfg=/);
  await expect(longRow.locator('td').nth(2)).not.toHaveText(before ?? '');
  // With one 4,000-token chunk, B's first token for LONG matches A's whole-prefill iteration timing.
  await expect(page.locator('.diff-bar')).toContainText('4096');

  await chunk.fill('abc');
  await expect(page.getByText('Enter a number.')).toBeVisible();
  await expect(page.locator('.diff-bar')).toContainText('4096');

  await page.getByRole('button', { name: 'Reset to preset' }).click();
  await expect(page).toHaveURL(/scenario=long-prefill/);
});

test('A/B comparison stays synchronized and supports single-panel views', async ({ page }) => {
  await page.goto('/?scenario=burst');
  await expect(page.getByRole('heading', { name: 'Burst arrivals', level: 2 })).toBeVisible();
  await page.getByLabel('Simulated time').fill('1500');
  const batchA = page.locator('.inspector').filter({ hasText: 'Batch inspector' }).first();
  await expect(batchA).toContainText('Iteration');
  await expect(page.locator('.request-table tbody tr')).toHaveCount(32);

  await page.getByRole('radio', { name: 'B', exact: true }).click();
  await expect(page.locator('.tl-panel-header')).toHaveCount(1);
  await expect(page.locator('.tl-panel-header')).toContainText('Decode-first chunked prefill');
  await page.getByRole('radio', { name: 'A / B' }).click();
  await expect(page.locator('.tl-panel-header')).toHaveCount(2);

  await page.getByRole('button', { name: /Panel A\. R3:/ }).click();
  await expect(page.locator('.details-card h2')).toContainText('Request R3');
  await expect(page.locator('.request-detail')).toHaveCount(2);
  await expect(page.locator('.request-detail').first()).toContainText('Prompt tokens (P)');
});

test('shares a link and exports and re-imports JSON', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?scenario=edge-cases');
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.locator('.toast')).toContainText('copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('scenario=edge-cases');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const doc = JSON.parse(await readFile(path, 'utf8'));
  expect(doc).toMatchObject({ schemaVersion: 1, kind: 'inference-lab-export', seed: 1 });
  expect(doc.trace).toHaveLength(4);
  expect(doc.panels[1].events.some((e: { type: string }) => e.type === 'infeasible')).toBe(true);

  await page.goto('/?scenario=burst');
  await page.getByTestId('import-input').setInputFiles({ name: 'run.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.locator('.toast')).toContainText('Imported configuration');
  await expect(page.getByRole('heading', { name: 'Edge cases', level: 2 })).toBeVisible();

  await page.getByTestId('import-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('<script>alert(1)</script>') });
  await expect(page.locator('.toast')).toContainText('Import failed');
});

test('invalid shared links fall back to the default scenario', async ({ page }) => {
  await page.goto('/?cfg=not-valid!!');
  await expect(page.locator('.toast')).toContainText('Shared link ignored');
  await expect(page.getByRole('heading', { name: 'Long prefill interruption', level: 2 })).toBeVisible();
});

test('mobile layout has no horizontal page overflow and a working configuration drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(page.locator('#config-sidebar')).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#config-sidebar')).not.toHaveClass(/is-open/);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => readMs(page)).toBeGreaterThan(20);
});
