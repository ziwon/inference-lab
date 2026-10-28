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

test('before Play, a request row previews the whole run faintly and has no played marks', async ({ page }) => {
  await page.goto('/');
  const ghost = page.getByTestId('marks-ghost-A').locator('[data-row="R1"]');
  const played = page.getByTestId('marks-played-A').locator('[data-row="R1"]');
  const plotWidth = Number(await page.getByTestId('marks-played-A').getAttribute('width'));
  await expect(played.locator('rect, path')).toHaveCount(0);
  expect(await ghost.evaluate(g => (g as SVGGElement).getBBox().width)).toBeGreaterThan(0.8 * plotWidth);
  expect(Number(await ghost.evaluate(g => getComputedStyle(g).fillOpacity))).toBeLessThan(1);
  for (let i = 0; i < 3; i++) await page.getByTestId('next').click();
  await expect(played.locator('rect, path')).not.toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`at ${viewport.width}x${viewport.height} Play is on screen on load and after scrolling to the memory inspector`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const play = page.getByTestId('play');
    const visible = () =>
      play.evaluate(button => {
        const r = button.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
    expect(await visible()).toBe(true);
    await page.getByTestId('memory-A').evaluate(e => e.scrollIntoView({ block: 'center' }));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
    expect(await visible()).toBe(true);
  });
}

test('the scrubber steps by a visible share of the run and reads modeled milliseconds', async ({ page }) => {
  await page.goto('/');
  const scrubber = page.getByTestId('scrubber');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '0.00 ms of 871 ms (modeled)');
  await scrubber.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  expect(await clockMs(page)).toBeCloseTo(43.5, 0);
  await expect(scrubber).toHaveAttribute('aria-valuetext', /^43\.\d ms of 871 ms \(modeled\)$/);
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

test('End jumps to the end, + and - change speed, and ? lists the shortcuts and returns focus', async ({ page }) => {
  await page.goto('/');
  const counter = page.getByTestId('event-counter');
  const speed = page.getByTestId('speed');
  await page.locator('body').press('End');
  await expect(counter).toHaveText(/^Event (\d+) of \1$/);
  await page.keyboard.press('Home');
  await expect(speed).toHaveValue('100');
  await page.keyboard.press('+');
  await expect(speed).toHaveValue('200');
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await expect(speed).toHaveValue('50');

  await page.getByTestId('slo-ttft').focus();
  for (const key of ['End', '+', '?']) await page.keyboard.press(key);
  await expect(counter).toHaveText(/^Event 0 of/);
  await expect(speed).toHaveValue('50');

  const dialog = page.getByTestId('shortcuts-dialog');
  await expect(dialog).toBeHidden();
  await page.getByTestId('play').focus();
  await page.keyboard.press('?');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('kbd')).toHaveText(['Space', '←', '→', 'Home', 'End', '−', '+', '?']);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('play')).toBeFocused();

  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
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

test('iterations count from 1 on screen and event counts agree in number', async ({ page }) => {
  await page.goto('/#scenario=long-prefill');
  for (let i = 0; i < 3; i++) await page.getByTestId('next').click();
  const log = page.getByTestId('event-log');
  await expect(log.locator('li[aria-current="step"]')).toHaveText(/Iteration 1 started with 1 request$/);
  await expect(page.getByTestId('batch-title-A')).toHaveText('Iteration 1, executing');
  await expect(page.getByTestId('timeline-A').locator('svg.tl-strip')).toContainText('#1');
  await page.getByTestId('batch-A').getByRole('button', { name: 'Explain this iteration' }).click();
  const details = page.getByTestId('details');
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('Panel A, iteration 1');
  await expect(details.getByRole('button', { name: /→$/ })).toHaveText('2 →');
  await page.getByTestId('row-A-R1').click();
  await expect(details.getByRole('button', { name: 'Panel A, iteration 1' })).toBeVisible();

  for (let i = 0; i < 57; i++) await page.getByTestId('next').click();
  await expect(log).toContainText(/started with [2-9] requests/);
  await expect(log).not.toContainText(/with 1 requests|reserved 1 blocks|released 1 blocks/);
});

test('changing a control re-runs both panels and lists the override in the differences strip', async ({ page }) => {
  await page.goto('/#scenario=kv-pressure');
  const strip = page.getByTestId('differences');
  await expect(strip.locator('li')).toHaveText(['Policy A Whole prefill B Chunked prefill']);
  await expect(strip.locator('p')).toHaveText('Shared: trace, seed, architecture, memory, cost model, SLOs, scheduler limits.');
  const before = await page.getByTestId('results-table').innerText();
  const override = page.getByTestId('override-B-maxActiveSequences');
  await override.fill('4');
  await override.press('Enter');
  await expect(strip.locator('li')).toHaveText(['Policy A Whole prefill B Chunked prefill', 'Max active sequences A 16 B 4 shared 16']);
  await expect(strip.locator('p')).toHaveText('Shared: trace, seed, architecture, memory, cost model, SLOs, other scheduler limits.');
  await expect(page.getByTestId('timeline-B').locator('.card-head')).toHaveText(/^B\s*Decode-first chunked prefill\s*Request timeline$/);
  await expect(page.getByTestId('scenario-kv-pressure')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.getByTestId('results-table').innerText()).not.toBe(before);

  const promptMax = page.getByTestId('prompt-max');
  await promptMax.fill('9000');
  await promptMax.press('Enter');
  await expect(page.getByTestId('config-issues')).toContainText('exceeds the 8192-token context limit');
});

test('a prefill-chunk override with panel A on whole prefill is listed as not used by panel A', async ({ page }) => {
  await page.goto('/#scenario=long-prefill');
  const chunk = page.getByTestId('differences').getByTestId('difference-maxPrefillChunkTokens');
  await expect(chunk).toHaveCount(0);
  const onB = page.getByTestId('override-B-maxPrefillChunkTokens');
  await onB.fill('256');
  await onB.press('Enter');
  await expect(chunk).toHaveText('Max prefill chunk (tokens) A 512 B 256 shared 512 not used by panel A');

  await page.getByTestId('policy-A').selectOption('chunked-prefill');
  const onA = page.getByTestId('override-A-maxPrefillChunkTokens');
  await onA.fill('128');
  await onA.press('Enter');
  await expect(chunk).toHaveText('Max prefill chunk (tokens) A 128 B 256 shared 512');
  await page.getByTestId('policy-A').selectOption('whole-prefill');
  await expect(chunk).toHaveText('Max prefill chunk (tokens) A 128 B 256 shared 512 not used by panel A');
  await expect(chunk.locator('s')).toHaveText('128');
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

test('results at the cursor follow playback and agree with the timelines, and Final shows the whole run', async ({ page }) => {
  await page.goto('/');
  const scrubber = page.getByTestId('scrubber');
  await scrubber.fill(String(142 * Number(await scrubber.getAttribute('step'))));
  const results = page.getByTestId('results');
  const table = page.getByTestId('results-table');
  const row = (label: string) => table.locator('tr', { has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) }).locator('td');
  const final = results.getByRole('button', { name: 'Final' });
  const atCursor = results.getByRole('button', { name: 'At cursor' });
  await expect(final).toHaveAttribute('aria-pressed', 'true');
  await expect(row('Completed')).toHaveText(['8', '8', '0']);

  await atCursor.click();
  await expect(atCursor).toHaveAttribute('aria-pressed', 'true');
  await expect(row('Completed')).toHaveText(['1', '0', '−1']);
  for (const [i, panel] of ['A', 'B'].entries()) {
    const line = await page.getByTestId(`timeline-${panel}`).locator('.outcome-line').innerText();
    const [, waiting, completed] = line.match(/Waiting: (\d+) .* Completed: (\d+)/)!;
    await expect(row('Completed').nth(i)).toHaveText(completed!);
    await expect(row('Waiting').nth(i)).toHaveText(waiting!);
  }
  const long = page.getByTestId('request-outcomes').locator('tr', { hasText: 'Long' });
  await expect(long.locator('td').nth(3)).toHaveText('Completed / Unfinished');
  await expect(long.locator('td').nth(7)).toHaveText('N/A');

  await page.locator('body').press('End');
  await expect(row('Completed')).toHaveText(['8', '8', '0']);
  await expect(atCursor).toHaveAttribute('aria-pressed', 'true');
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

test('an internal error while building a run shows a notice that resets to the default scenario', async ({ page }) => {
  await page.route(/\/src\/sim\/compare\.ts(\?.*)?$/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function buildComparison(config) {';
    expect(source).toContain(signature);
    await route.fulfill({ response, body: source.replace(signature, `${signature} if (location.hash === '#scenario=burst') throw new Error('injected engine fault');`) });
  });
  await page.goto('/#scenario=burst');
  const crash = page.getByTestId('crash');
  await expect(crash).toContainText('internal error');
  await crash.getByRole('button', { name: 'Open the default scenario' }).click();
  await expect(crash).toHaveCount(0);
  await expect(page.getByTestId('scenario-long-prefill')).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#scenario=long-prefill');
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
    const scrubber = page.getByTestId('scrubber');
    await scrubber.fill(String(69 * Number(await scrubber.getAttribute('step'))));
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
