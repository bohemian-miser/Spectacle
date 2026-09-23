/**
 * Headless smoke run against a live server: join, tap, watch the line grow,
 * screenshot. `npx tsx scripts/smoke.ts [url] [outfile]`.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:8787/';
const enterLabel = /[?&]solo/.test(url) ? 'Play solo' : 'Enter the arena';
const out = process.argv[3] ?? '/tmp/spectacle-smoke.png';

const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
process.on('uncaughtException', (e) => {
  console.error(String(e).split('\n').slice(0, 3).join('\n'));
  console.error('page errors so far:', errors);
  process.exit(1);
});
await page.goto(url);
await page.getByPlaceholder('name').fill('smoke');
// Draw a pairing by hand: on the first tile with a choice, drag dot 0 → dot 1.
const before = await page.locator('.rule-readout code').innerText();
const drawable = page.locator('.thumb-card:not(.is-odd) .thumb.is-drawable').filter({ has: page.locator('.thumb-dot') });
const thumbCount = await drawable.count();
let dragged = false;
for (let i = 0; i < thumbCount && !dragged; i++) {
  const dots = drawable.nth(i).locator('.thumb-dot circle:first-child');
  if ((await dots.count()) < 4) continue;
  await drawable.nth(i).scrollIntoViewIfNeeded();
  const drag = async (from: number, to: number): Promise<void> => {
    const a = (await dots.nth(from).boundingBox())!;
    const b = (await dots.nth(to).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  // 0–1 then 2–3: a complete, non-crossing pairing whatever it was before.
  await drag(0, 1);
  await drag(2, 3);
  dragged = true;
}
await page.waitForTimeout(200);
const after = await page.locator('.rule-readout code').innerText();
console.log('rule before drag:', before, '| after:', after, dragged ? '' : '(no 4-dot tile to drag on)');
await page.screenshot({ path: out.replace('.png', '-lobby.png'), fullPage: true });
await page.getByRole('button', { name: enterLabel }).click();
await page.waitForSelector('.arena-canvas');
await page.waitForTimeout(500);
// Zoom in a bit around the centre, then tap it.
const canvas = page.locator('.arena-canvas:not(.arena-tiles)');
const box = (await canvas.boundingBox())!;
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(200);
await page.mouse.click(cx, cy);
await page.waitForTimeout(4000);
const hud = await page.locator('.hud-me').innerText();
console.log(hud.replace(/\n/g, ' | '));
console.log('tile layer:', await page.evaluate(() => (document.querySelector('.arena-tiles') as HTMLCanvasElement).getContext('webgl2') ? 'webgl2' : 'canvas2d'));
await page.screenshot({ path: out });
// Restart with a fresh rule: New rule → Surprise me → Restart, then tap again.
await page.getByRole('button', { name: 'New rule' }).click();
await page.getByRole('button', { name: 'Surprise me' }).click();
await page.getByRole('button', { name: 'Restart with this rule' }).click();
await page.waitForSelector('.arena-canvas');
await page.waitForTimeout(300);
await page.mouse.click(cx + 40, cy + 30);
await page.waitForTimeout(1500);
console.log((await page.locator('.hud-me').innerText()).replace(/\n/g, ' | '));
await page.waitForTimeout(300);
await page.screenshot({ path: out.replace('.png', '-whole.png') });
console.log('errors:', errors);
if (errors.length) process.exitCode = 1;
await browser.close();
