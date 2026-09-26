/**
 * Where does the lag come from? Plays a busy bot game and, per tick, times
 * each stage a client pays for separately: the engine (server / solo tab),
 * the wire (JSON), the store applying events, the renderer's tint rebuild,
 * and the overlay draw (JS side only — a stub context counts the calls).
 *
 *   npx tsx scripts/lag-bench.ts [mode] [level] [bots] [ticks] [seed]
 */
import { Bots, parseBotMix, prepareBots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode, type GameMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';
import { Store } from '../client/src/store';
import { Renderer } from '../client/src/render';

// In a browser (scripts/lag-bench-browser.ts) the overlay draws on a real
// canvas, so its time includes rasterising; args come from `BENCH_ARGS`.
const browser = typeof document !== 'undefined';
const g = globalThis as { BENCH_ARGS?: string[]; BENCH_FLIP?: boolean };
const argv = browser ? ['', '', ...(g.BENCH_ARGS ?? [])] : process.argv;
const flip = browser ? !!g.BENCH_FLIP : !!process.env.FLIP;
const mode = (argv[2] ?? 'conquest') as GameMode;
const level = Number(argv[3] ?? 5);
const mix = parseBotMix(argv[4] ?? 'bridge:2+hunter:2+farmer:2+wanderer:2').mix;
const ticks = Number(argv[5] ?? 3000);
const seed = Number(argv[6] ?? 7);

const field = buildField({ family: 'hex', level, rootTile: 'Delta' });
fieldOutline(field);
const knobs = { ...knobsForMode(DEFAULT_KNOBS, mode), ...(flip ? { maxHeads: 0 } : {}) };
const e = new Engine(field, knobs, mulberry32(seed));
prepareBots(field, mix);
const bots = new Bots(e, mulberry32(seed + 1));
let now = 0;
const first = bots.add(mix, now);
// FLIP=1: every bot also holds three captured-looking patterns and draws with
// them all, as in flip-bench — the flip storm a big capture sets off.
if (flip) {
  const rng = mulberry32(seed + 2);
  for (const p of e.players.values())
    for (let k = 0; k < 3; k++) {
      const rule = randomCleanRule('hex', rng);
      p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
    }
}

// A stub 2D context: every call is a no-op that is counted.
const calls: Record<string, number> = {};
const stub = new Proxy({} as Record<string, unknown>, {
  get(t, k) {
    if (k in t) return t[k as string];
    return (..._a: unknown[]) => {
      calls[k as string] = (calls[k as string] ?? 0) + 1;
      return k === 'measureText' ? { width: 40 } : undefined;
    };
  },
  set(t, k, v) {
    t[k as string] = v;
    return true;
  },
});
// Node has no Path2D: a stub that counts, like the context.
if (!browser) {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    constructor() {
      return stub;
    }
  };
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return Object.assign(Object.create(stub), { canvas: this });
    }
  };
}
const real = browser ? Object.assign(document.createElement('canvas'), { width: 1600, height: 1000 }) : null;
const ctx = real ? real.getContext('2d')! : stub;
/** Make the canvas actually rasterise what was queued. */
const flush = (): void => void (real && (ctx as CanvasRenderingContext2D).getImageData(0, 0, 1, 1));
const overlay = { getContext: () => ctx, width: 1600, height: 1000, getBoundingClientRect: () => ({ width: 800, height: 500 }) };
const store = new Store();
let tintCalls = 0;
/** A renderer on the stub (or real) overlay, its tile layer a no-op. */
const makeRenderer = (): any => {
  const r = new Renderer({} as HTMLCanvasElement, overlay as unknown as HTMLCanvasElement, store) as any;
  r.tiles = { kind: 'webgl', clearTints() {}, setTint() { tintCalls++; }, draw() {}, resize() {}, setArrows() {}, setTheme() {}, dispose() {} };
  r.field = field;
  r.width = 800;
  r.height = 500;
  r.dpr = 2;
  return r;
};
// Two watchers, the camera still for each: one with the whole board in view, one zoomed in.
const r = makeRenderer();
const rz = makeRenderer();
store.handle(JSON.parse(JSON.stringify({ t: 'welcome', you: 'nobody', token: '', field: field.spec, knobs, players: e.snapshot().players, paths: [] })) as never);
// Watch as the first bot, so "mine" drawing (halo) is exercised.
const watch = [...e.players.keys()][0];
store.you = watch;
store.handle({ t: 'events', ev: first } as never);

// What an overlay frame costs with nothing on the board, and with the plain
// board's outline off: the floor under every number below.
{
  const time = (): number => {
    const a = performance.now();
    for (let k = 0; k < 20; k++) {
      r.fitToField();
      r.drawOverlay(k);
      flush();
    }
    return (performance.now() - a) / 20;
  };
  const plain = r.plain;
  const base = time();
  r.plain = false;
  const bare = time();
  r.plain = plain;
  console.log(`empty board overlay: ${base.toFixed(2)} ms (${bare.toFixed(2)} ms without the plain board's outline)`);
}
type Stat = { sum: number; max: number };
const stat = (): Stat => ({ sum: 0, max: 0 });
const add = (s: Stat, v: number) => ((s.sum += v), (s.max = Math.max(s.max, v)));
const S = { engine: stat(), json: stat(), store: stat(), tints: stat(), overlayFit: stat(), overlayZoom: stat(), events: stat() };
let heads = 0, peakHeads = 0, peakPaths = 0, peakSteps = 0;
const report = (label: string, n: number) => {
  const f = (s: Stat) => `${(s.sum / n).toFixed(2)} / ${s.max.toFixed(1)}`;
  console.log(`${label}: ticks ${n}`);
  console.log(`  engine+bots  avg/max ms ${f(S.engine)}`);
  console.log(`  JSON wire    avg/max ms ${f(S.json)}   events/tick avg/max ${(S.events.sum / n).toFixed(0)} / ${S.events.max}`);
  console.log(`  store.apply  avg/max ms ${f(S.store)}`);
  console.log(`  syncTints    avg/max ms ${f(S.tints)}   (runs every frame the board changed)`);
  console.log(`  overlay fit  avg/max ms ${f(S.overlayFit)}   per frame (whole board in view)`);
  console.log(`  overlay zoom avg/max ms ${f(S.overlayZoom)}   per frame (zoomed in)`);
  console.log(`  growing heads avg ${(heads / n).toFixed(0)}, peak ${peakHeads}; peak paths ${peakPaths}, peak steps ${peakSteps}`);
};
for (let t = 1; t <= ticks; t++) {
  now += knobs.tickMs;
  let a = performance.now();
  const ev: GameEvent[] = e.tick(knobs.tickMs);
  bots.update(now, ev);
  add(S.engine, performance.now() - a);
  add(S.events, ev.length);
  a = performance.now();
  const msg = JSON.parse(JSON.stringify({ t: 'events', ev }));
  add(S.json, performance.now() - a);
  a = performance.now();
  store.handle(msg);
  add(S.store, performance.now() - a);
  a = performance.now();
  r.syncTints(now);
  add(S.tints, performance.now() - a);
  // Three frames per tick (60 fps against the server's 20 Hz), the camera
  // still: what a frame costs while you watch.
  r.fitToField();
  rz.fitToField();
  rz.camera.scale = 30;
  rz.syncTints(now);
  a = performance.now();
  for (let f = 0; f < 3; f++) {
    r.drawOverlay(now + f * 16);
    flush();
  }
  add(S.overlayFit, (performance.now() - a) / 3);
  a = performance.now();
  for (let f = 0; f < 3; f++) {
    rz.drawOverlay(now + f * 16);
    flush();
  }
  add(S.overlayZoom, (performance.now() - a) / 3);
  let h = 0, steps = 0;
  for (const p of store.paths.values()) {
    steps += p.steps.length;
    if (p.status === 'growing') h += p.back ? 2 : 1;
  }
  heads += h;
  peakHeads = Math.max(peakHeads, h);
  peakPaths = Math.max(peakPaths, store.paths.size);
  peakSteps = Math.max(peakSteps, steps);
  if (t % 1000 === 0) {
    report(`${mode} hex L${level} after ${t} ticks (${(t * knobs.tickMs / 1000).toFixed(0)} s)`, 1000);
    for (const k of Object.keys(S) as (keyof typeof S)[]) S[k] = stat();
    heads = 0;
    console.log('  overlay calls per frame ≈', JSON.stringify(Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, Math.round(v / 6000)]))));
    for (const k in calls) delete calls[k];
  }
}
