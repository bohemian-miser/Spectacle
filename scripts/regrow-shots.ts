/**
 * What a rule switch buys, with and without `regrowDiscount`. For each
 * example a player alone on the board grows lines of the default rule, then
 * switches; the same switch is played out twice in the engine — no discount
 * (1) and the default (0.99) — until nothing grows. Three panels a picture:
 * the lines before, then each played out (circuits filled, the tiles held
 * before outlined), with the plan's figures underneath.
 *
 *   PW_EXE=/opt/pw-browsers/chromium npx tsx scripts/regrow-shots.ts [outDir]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { Engine, type Path } from '../shared/game/engine';
import { buildField, pathPolygon, tileCenter, tilePolygon, type Field } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import { planRegrow, type RegrowPlan } from '../shared/game/regrow';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, describeRule, randomCleanRule, type PlayerRule } from '../shared/game/rule';
import { chordTableFor, tileChords } from '../shared/game/strand';

const outDir = process.argv[2] ?? 'regrow-shots';
mkdirSync(outDir, { recursive: true });

interface Example {
  readonly name: string;
  readonly family: 'hex' | 'spectre';
  readonly level: number;
  readonly taps: number;
  readonly stride: number;
  /** Which rule of `randomCleanRule`'s stream (seed 7) to switch to. */
  readonly rule: number;
}

const EXAMPLES: Example[] = [
  { name: 'hex-small', family: 'hex', level: 4, taps: 10, stride: 97, rule: 3 },
  { name: 'hex-medium', family: 'hex', level: 4, taps: 40, stride: 17, rule: 6 },
  { name: 'hex-large', family: 'hex', level: 4, taps: 120, stride: 7, rule: 3 },
  { name: 'spectre-medium', family: 'spectre', level: 4, taps: 40, stride: 17, rule: 4 },
  { name: 'spectre-large', family: 'spectre', level: 4, taps: 120, stride: 7, rule: 2 },
];

function nthRule(family: 'hex' | 'spectre', n: number): PlayerRule {
  const rng = mulberry32(7);
  let rule = randomCleanRule(family, rng);
  for (let k = 0; k < n; k++) rule = randomCleanRule(family, rng);
  return rule;
}

function territory(field: Field, knobs: Knobs, ex: Example): Engine {
  const e = new Engine(field, knobs, mulberry32(1));
  const rule = defaultRule(field.family);
  e.addPlayer('a', 'Ann', rule);
  const table = chordTableFor(field, rule);
  for (let i = 0, n = 0; i < field.count && n < ex.taps; i += ex.stride) {
    if (tileChords(field, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
    if (e.tap('a', i, tileCenter(field, i)).result.ok) n++;
  }
  for (let t = 0; t < 4000; t++) e.tick(knobs.tickMs);
  return e;
}

const heldOf = (e: Engine): Set<number> => new Set(e.players.get('a')!.paths.flatMap((q) => q.steps.map((s) => s.tile)));

/** Switch and play out; the plan and the lines it ends with. */
function playOut(field: Field, ex: Example, discount: number): { plan: RegrowPlan; paths: Path[]; score: number; before: number } {
  const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0, regrowDiscount: discount };
  const e = territory(field, knobs, ex);
  const a = e.players.get('a')!;
  const before = a.score;
  const rule = nthRule(ex.family, ex.rule);
  const plan = planRegrow(field, chordTableFor(field, rule), heldOf(e), before, knobs);
  e.setRule('a', rule);
  for (let t = 0; t < 100_000 && a.paths.some((q) => q.status === 'growing'); t++) e.tick(knobs.tickMs);
  return { plan, paths: [...a.paths], score: a.score, before };
}

const fmt = (n: number): string => n.toFixed(2).replace(/\.?0+$/, '');
const pts = (ps: readonly { x: number; y: number }[]): string => ps.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

function panel(field: Field, title: string, lines: string[], paths: readonly Path[], held: ReadonlySet<number>, color: string): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const tiles: string[] = [];
  for (let i = 0; i < field.count; i++) {
    const poly = tilePolygon(field, i);
    for (const p of poly) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    tiles.push(`<polygon points="${pts(poly)}" class="${held.has(i) ? 'held' : 'tile'}"/>`);
  }
  const w = maxX - minX, h = maxY - minY;
  const sw = Math.max(w, h) / 700;
  const fills = paths.filter((q) => q.status === 'closed').map((q) => `<polygon points="${pts(pathPolygon(q))}" fill="${color}" fill-opacity="0.16"/>`);
  const strokes = paths.map((q) => {
    const ps = [...q.steps.map((s) => s.a), q.steps[q.steps.length - 1].b];
    return `<polyline points="${pts(ps)}" fill="none" stroke="${color}" stroke-width="${fmt(sw * 2.2)}" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  return `<figure>
  <figcaption><b>${title}</b>${lines.map((l) => `<br>${l}`).join('')}</figcaption>
  <svg viewBox="${fmt(minX - sw * 4)} ${fmt(minY - sw * 4)} ${fmt(w + sw * 8)} ${fmt(h + sw * 8)}" style="--sw:${fmt(sw * 0.4)}">
    <g>${tiles.join('')}</g><g>${fills.join('')}</g><g>${strokes.join('')}</g>
  </svg></figure>`;
}

const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 1 });
for (const ex of EXAMPLES) {
  const field = buildField({ family: ex.family, level: ex.level, rootTile: 'Delta' });
  const e = territory(field, { ...DEFAULT_KNOBS, maxHeads: 0 }, ex);
  const held = heldOf(e);
  const old = [...e.players.get('a')!.paths];
  const flat = playOut(field, ex, 1);
  const disc = playOut(field, ex, DEFAULT_KNOBS.regrowDiscount);
  const rule = describeRule(nthRule(ex.family, ex.rule));
  const figures = (r: typeof flat): string[] => [
    `spent ${fmt(r.plan.spent)} of ${r.before} · ${r.plan.kept.length} bought${r.plan.stretch ? ' + stretch' : ''}`,
    `plan ${r.plan.outcome} tiles · played out <b>${r.score}</b> (${r.score >= r.before ? '+' : ''}${fmt(((r.score - r.before) / r.before) * 100)}%)`,
  ];
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 16px; font: 15px/1.35 system-ui, sans-serif; background: #fbfaf7; color: #222; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    .row { display: flex; gap: 16px; }
    figure { margin: 0; flex: 1; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
    svg { width: 100%; height: 680px; display: block; margin-top: 8px; }
    .tile { fill: #f1efe9; stroke: #d6d2c8; stroke-width: var(--sw); }
    .held { fill: #b9b4a8; stroke: #8f8a7f; stroke-width: var(--sw); }
  </style>
  <h1>${ex.family} level ${ex.level} · ${ex.taps} lines of the default rule → switch to <code>${rule}</code></h1>
  <div class="row">
  ${panel(field, `Before · score ${flat.before}`, [`${held.size} tiles held (grey)`, `rule 15, ${old.length} lines`], old, held, '#222')}
  ${panel(field, 'Switch, no discount (1)', figures(flat), flat.paths, held, '#d0532a')}
  ${panel(field, `Switch, discount ${DEFAULT_KNOBS.regrowDiscount}`, figures(disc), disc.paths, held, '#2a6fd0')}
  </div>`;
  await page.setContent(html);
  const path = `${outDir}/${ex.name}.png`;
  await page.screenshot({ path, fullPage: true });
  const line = { name: ex.name, rule, before: flat.before, flat: flat.score, flatPlan: flat.plan.outcome, discounted: disc.score, discPlan: disc.plan.outcome };
  console.log(JSON.stringify(line));
}
await browser.close();
