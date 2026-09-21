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
await page.goto(url);
await page.getByPlaceholder('name').fill('smoke');
await page.screenshot({ path: out.replace('.png', '-lobby.png') });
await page.getByRole('button', { name: enterLabel }).click();
await page.waitForSelector('.arena-canvas');
await page.waitForTimeout(500);
// Zoom in a bit around the centre, then tap it.
const canvas = page.locator('.arena-canvas');
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
await page.getByRole('button', { name: 'Find my line' }).click();
await page.getByRole('button', { name: 'Whole arena' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: out.replace('.png', '-whole.png') });
console.log('errors:', errors);
if (errors.length) process.exitCode = 1;
await browser.close();
