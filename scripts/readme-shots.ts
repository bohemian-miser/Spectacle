/**
 * The README's screenshots. Start a server or two with bots first, e.g.
 *   PORT=8787 BOTS=6 FIELD_LEVEL=4 SEED=7 npx tsx server/index.ts
 *   PORT=8788 BOTS=5 FIELD_FAMILY=spectre FIELD_LEVEL=4 SEED=3 npx tsx server/index.ts
 * then `PW_EXE=/opt/pw-browsers/chromium npx tsx scripts/readme-shots.ts [hexUrl] [spectreUrl] [outDir]`.
 */
import { chromium, type Page } from '@playwright/test';

const hexUrl = process.argv[2] ?? 'http://localhost:8787/';
const spectreUrl = process.argv[3] ?? 'http://localhost:8788/';
const outDir = process.argv[4] ?? 'docs/images';
const settle = Number(process.env.SETTLE_MS ?? 45000);

const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});

async function open(url: string, theme: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1 });
  await page.goto(`${url}?gl=0&theme=${theme}`);
  await page.getByPlaceholder('player name').fill(name);
  return page;
}

async function enter(page: Page): Promise<{ cx: number; cy: number }> {
  await page.getByRole('button', { name: 'Enter the arena' }).click();
  await page.waitForSelector('.arena-canvas');
  await page.waitForTimeout(500);
  const box = (await page.locator('.arena-canvas:not(.arena-tiles)').boundingBox())!;
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/** Keep tapping near the centre while the bots play, so our line is on the board too. */
async function play(page: Page, cx: number, cy: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) {
    const a = i++ * 2.4;
    await page.mouse.click(cx + Math.cos(a) * 60 * (i % 4), cy + Math.sin(a) * 60 * (i % 4));
    await page.waitForTimeout(1500);
  }
}

// 1. The rule lab.
{
  const page = await open(hexUrl, 'light', 'you');
  await page.setViewportSize({ width: 1100, height: 2400 });
  await page.getByRole('button', { name: 'Random solution' }).click();
  await page.waitForTimeout(1000);
  await page.locator('.thumb-card').first().locator('..').screenshot({ path: `${outDir}/rule-tiles.png` });
  await page.locator('.patch-preview').screenshot({ path: `${outDir}/rule-preview.png` });
  await page.close();
}

// 2. Hex arena, light: the whole field after the bots have had a while.
const hex = await open(hexUrl, 'light', 'you');
const h = await enter(hex);
await play(hex, h.cx, h.cy, settle);
await hex.mouse.move(h.cx + 300, h.cy + 200);
await hex.screenshot({ path: `${outDir}/arena-hex.png` });

// 3. Zoomed in: arrows, the faint rule pattern, lines up close.
await hex.mouse.move(h.cx, h.cy);
for (let i = 0; i < 3; i++) await hex.mouse.wheel(0, -300);
await hex.waitForTimeout(600);
await hex.screenshot({ path: `${outDir}/arena-closeup.png` });
for (let i = 0; i < 3; i++) await hex.mouse.wheel(0, 300);

// 4. Team colours.
await hex.keyboard.press('t');
await hex.waitForTimeout(500);
await hex.screenshot({ path: `${outDir}/arena-teams.png` });
await hex.keyboard.press('t');

// 5. Spectre arena, dark.
const sp = await open(spectreUrl, 'dark', 'you');
const s = await enter(sp);
await play(sp, s.cx, s.cy, settle / 2);
await sp.mouse.move(s.cx + 300, s.cy + 200);
await sp.screenshot({ path: `${outDir}/arena-spectre-dark.png` });

// 6. Settings over the board.
await sp.getByRole('button', { name: 'Settings' }).click();
await sp.getByLabel('Circuit colours').selectOption('e');
await sp.waitForTimeout(500);
await sp.screenshot({ path: `${outDir}/settings.png` });

await browser.close();
