/**
 * lag-bench in headless Chromium, so the overlay's time includes the canvas
 * actually drawing (the Node run only counts JS). Bundles the bench with
 * esbuild and prints its report.
 *
 *   PW_EXE=/opt/pw-browsers/chromium npx tsx scripts/lag-bench-browser.ts [mode] [level] [bots] [ticks] [seed]
 *   (FLIP=1 as for lag-bench)
 */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const out = await build({ entryPoints: ['scripts/lag-bench.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const page = await browser.newPage();
page.on('console', (m) => console.log(m.text()));
page.on('pageerror', (e) => console.error(e));
await page.setContent('<html><body></body></html>');
await page.evaluate(
  ([args, flip]) => Object.assign(globalThis, { BENCH_ARGS: args, BENCH_FLIP: flip }),
  [process.argv.slice(2), !!process.env.FLIP] as const,
);
await page.addScriptTag({ content: out.outputFiles[0].text });
await browser.close();
