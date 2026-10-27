import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const clockMs = async (page: import('@playwright/test').Page) => Number((await page.getByTestId('clock').innerText()).split(' ')[0]);

test('the default scenario plays, pauses, and reaches the long prefill', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inference Lab' })).toBeVisible();
  await expect(page.getByTestId('scenario-long-prefill')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('speed').selectOption('1000');
  await page.getByTestId('play').click();
  await expect.poll(() => clockMs(page), { timeout: 5000 }).toBeGreaterThan(200);
  await page.getByTestId('play').click();
  const paused = await clockMs(page);
  await page.waitForTimeout(300);
  expect(await clockMs(page)).toBe(paused);
  await expect(page.getByTestId('row-A-Long')).toBeVisible();
});

test('event stepping moves one event at a time and keyboard shortcuts skip inputs', async ({ page }) => {
  await page.goto('/');
  const counter = page.getByTestId('event-counter');
  await expect(counter).toHaveText(/^Event 0 of \d+$/);
  await page.getByTestId('next').click();
  await page.getByTestId('next').click();
  await expect(counter).toHaveText(/^Event 2 of/);
  await page.getByTestId('prev').click();
  await expect(counter).toHaveText(/^Event 1 of/);
  await page.locator('body').press('ArrowRight');
  await expect(counter).toHaveText(/^Event 2 of/);
  await page.getByTestId('slo-ttft').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await expect(counter).toHaveText(/^Event 2 of/);
  await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Home');
  await expect(counter).toHaveText(/^Event 0 of/);
});

test('selecting a request and an iteration explains them', async ({ page }) => {
  await page.goto('/');
  for (let i = 0; i < 60; i++) await page.getByTestId('next').click();
  await page.getByTestId('row-A-R1').click();
  await expect(page.getByTestId('details')).toContainText('Request R1');
  await expect(page.getByTestId('detail-state-A')).toHaveText(/Decoding|Prefilling|Admitted/);
  await page.getByTestId('batch-A').getByRole('button', { name: 'Explain this iteration' }).click();
  await expect(page.getByTestId('details')).toContainText('Panel A, iteration');
  await expect(page.getByTestId('details')).toContainText('Iteration overhead');
});

test('changing a control re-runs both panels and marks per-panel overrides', async ({ page }) => {
  await page.goto('/#scenario=kv-pressure');
  const before = await page.getByTestId('results-table').innerText();
  const override = page.getByTestId('override-B-maxActiveSequences');
  await override.fill('4');
  await override.press('Enter');
  await expect(page.getByTestId('override-note-B').first()).toContainText('Max active sequences 4 (shared 16)');
  await expect(page.getByTestId('scenario-kv-pressure')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.getByTestId('results-table').innerText()).not.toBe(before);

  const promptMax = page.getByTestId('prompt-max');
  await promptMax.fill('9000');
  await promptMax.press('Enter');
  await expect(page.getByTestId('config-issues')).toContainText('exceeds the 8192-token context limit');
});

test('configuration problems name the area in words, not the internal field path', async ({ page }) => {
  await page.goto('/#scenario=long-prefill');
  const issues = page.getByTestId('config-issues');
  const budget = page.getByTestId('shared-maxBatchTokens');
  await budget.fill('100');
  await budget.press('Enter');
  await expect(issues).toContainText('Panel A: Request R1 has 160 prompt tokens, more than the 100-token budget.');
  await expect(issues).not.toContainText('panels.');
  await budget.fill('8192');
  await budget.press('Enter');
  await expect(issues).toHaveCount(0);

  const device = page.getByTestId('device-gib');
  await device.fill('1');
  await device.press('Enter');
  await expect(issues.locator('li')).toHaveText(['Memory: Weights plus the runtime allowance do not fit in device memory.']);

  await page.goto('/#scenario=kv-pressure');
  const promptMax = page.getByTestId('prompt-max');
  await promptMax.fill('9000');
  await promptMax.press('Enter');
  await expect(issues.locator('li')).toHaveText([/^Request trace: The longest generated request has P \+ G = \d+, which exceeds the 8192-token context limit\.$/]);
});

test('a share link that fails validation lists its problems without internal paths', async ({ page }) => {
  await page.goto(`/#c=${Buffer.from(JSON.stringify({ version: 2 })).toString('base64url')}`);
  await expect(page.getByTestId('notice').locator('li')).toHaveText(['Unsupported version. Expected version 1.']);
});

test('A/B comparison shows aggregate and request-level outcomes for the same trace', async ({ page }) => {
  await page.goto('/#scenario=burst');
  const table = page.getByTestId('results-table');
  await expect(table).toContainText('A · Whole prefill');
  await expect(table).toContainText('B · Chunked prefill');
  await expect(table).toContainText('n=24');
  await expect(page.getByTestId('request-outcomes').locator('tbody tr')).toHaveCount(24);
});

test('the edge-case preset marks the infeasible request and the one-token request', async ({ page }) => {
  await page.goto('/#scenario=edge-cases');
  const scrubber = page.getByTestId('scrubber');
  await scrubber.fill((await scrubber.getAttribute('max'))!);
  await page.getByTestId('row-A-TooBig').click();
  await expect(page.getByTestId('details')).toContainText('Needs 76 blocks to finish, but the empty pool has 50');
  await page.getByTestId('row-A-OneToken').click();
  await expect(page.getByTestId('detail-generated-A')).toHaveText('1 / 1');
});

test('a share link restores the configuration and seed', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#scenario=kv-pressure');
  const seed = page.getByTestId('seed');
  await seed.fill('99');
  await seed.press('Enter');
  await page.getByTestId('share').click();
  await expect(page.getByTestId('notice')).toContainText(/Link copied|Address bar updated/);
  const url = page.url();
  expect(url).toContain('#c=');
  const fresh = await context.newPage();
  await fresh.goto(url);
  await expect(fresh.getByTestId('seed')).toHaveValue('99');
  expect(await fresh.getByTestId('results-table').innerText()).toBe(await page.getByTestId('results-table').innerText());
});

test('edits survive a reload, and a link pasted into an open tab loads it', async ({ page }) => {
  await page.goto('/#scenario=kv-pressure');
  const seed = page.getByTestId('seed');
  await seed.fill('77');
  await seed.press('Enter');
  await expect(page).toHaveURL(/#c=/);
  await page.reload();
  await expect(page.getByTestId('seed')).toHaveValue('77');

  await page.evaluate(() => {
    location.hash = 'scenario=burst';
  });
  await expect(page.getByTestId('scenario-burst')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('request-outcomes').locator('tbody tr')).toHaveCount(24);
});

test('a whole-prefill panel offers no prefill-chunk override, since its policy never splits a prompt', async ({ page }) => {
  await page.goto('/#scenario=long-prefill');
  await expect(page.getByTestId('override-A-maxBatchTokens')).toBeAttached();
  await expect(page.getByTestId('override-A-maxPrefillChunkTokens')).toHaveCount(0);
  await expect(page.getByTestId('override-B-maxPrefillChunkTokens')).toBeAttached();
});

test('a broken share link falls back to the default scenario with a notice', async ({ page }) => {
  await page.goto('/#c=not-a-config');
  await expect(page.getByTestId('notice')).toContainText('could not be used');
  await expect(page.getByTestId('scenario-long-prefill')).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#scenario=long-prefill');
  await page.reload();
  await expect(page.getByTestId('notice')).toHaveCount(0);
});

test('a scenario link from the earlier app opens that preset and moves to the fragment form', async ({ page }) => {
  await page.goto('/?scenario=burst');
  await expect(page.getByTestId('scenario-burst')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('request-outcomes').locator('tbody tr')).toHaveCount(24);
  await expect(page.getByTestId('notice')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#scenario=burst');
});

test('a configuration link from the earlier app falls back to the default scenario and says why', async ({ page }) => {
  for (const query of ['?v=1&cfg=eyJ2ZXJzaW9uIjoxfQ', '?scenario=not-a-scenario']) {
    await page.goto(`/${query}`);
    await expect(page.getByTestId('notice')).toContainText('earlier version of Inference Lab');
    await expect(page.getByTestId('scenario-long-prefill')).toHaveAttribute('aria-pressed', 'true');
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).hash).toBe('#scenario=long-prefill');
  }
});

test('a fragment link wins over an earlier-app query in the same address', async ({ page }) => {
  await page.goto('/?v=1&cfg=eyJ2ZXJzaW9uIjoxfQ#scenario=kv-pressure');
  await expect(page.getByTestId('scenario-kv-pressure')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('notice')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#scenario=kv-pressure');
});

test('export then import round-trips the run', async ({ page }, testInfo) => {
  await page.goto('/#scenario=burst');
  const download = page.waitForEvent('download');
  await page.getByTestId('export').click();
  const file = testInfo.outputPath('run.json');
  await (await download).saveAs(file);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  expect(doc.schema).toBe('inference-lab.run');
  expect(doc.panels.A.events.length).toBeGreaterThan(0);
  await page.getByTestId('scenario-long-prefill').click();
  await page.getByTestId('import-file').setInputFiles(file);
  await expect(page.getByTestId('notice')).toContainText('event history matches the rebuild');
  await expect(page.getByTestId('request-outcomes').locator('tbody tr')).toHaveCount(24);
});

test('the model assumptions dialog documents the equations', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-model').click();
  const dialog = page.getByTestId('model-dialog');
  await expect(dialog).toContainText('kvBytesPerToken = 2 × layers × kvHeads × headDim × kvElementBytes');
  await expect(dialog).toContainText('q·c + q(q+1)/2');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test.describe('narrow screens', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the page never scrolls horizontally and the segmented control picks a panel', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scrubber').fill('300000');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await expect(page.getByTestId('batch-A')).toBeVisible();
    await expect(page.getByTestId('batch-B')).toBeHidden();
    await page.getByTestId('show-B').click();
    await expect(page.getByTestId('batch-B')).toBeVisible();
    await expect(page.getByTestId('batch-A')).toBeHidden();
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('playback still advances', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('speed').selectOption('1000');
    await page.getByTestId('play').click();
    await expect.poll(() => clockMs(page), { timeout: 5000 }).toBeGreaterThan(50);
  });
});
