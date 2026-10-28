import { statSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5188/';
const out = new URL('../docs/assets/inference-lab.png', import.meta.url).pathname;
const maxBytes = 300 * 1024;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'networkidle' });
const scrubber = page.getByTestId('scrubber');
const step = Number(await scrubber.getAttribute('step'));
await scrubber.fill(String(60 * step));
await scrubber.evaluate(e => e.blur());
await page.mouse.move(0, 0);
await page.screenshot({ path: out });
await browser.close();

const bytes = statSync(out).size;
console.log(`${out}: ${(bytes / 1024).toFixed(0)} KiB`);
if (bytes > maxBytes) {
  console.error(`over the ${maxBytes / 1024} KiB budget`);
  process.exitCode = 1;
}
