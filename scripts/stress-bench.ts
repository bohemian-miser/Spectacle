/**
 * Two (or more) aggressive humans: each holds the paint gesture down all game,
 * tapping the tile under a wandering cursor every `TAP_MS` whenever it has a
 * free head, with every head a captured pattern would give them and a few
 * patterns to switch between. That is what fills a board with lines and
 * traps far faster than the bots do; this prints what it costs, per stage,
 * as the board fills.
 *
 *   npm run bench:stress -- [mode] [level] [players] [seconds] [seed]   (CLIENT=0: engine only)
 */
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline, tileAt, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode, type GameMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';
import { Store } from '../client/src/store';
import { Renderer } from '../client/src/render';

const mode = (process.argv[2] ?? 'normal') as GameMode;
const level = Number(process.argv[3] ?? 6);
const humans = Number(process.argv[4] ?? 2);
const seconds = Number(process.argv[5] ?? 300);
const seed = Number(process.argv[6] ?? 3);
const TAP_MS = 120;
/** CLIENT=0: the engine alone (for a profile of the server's side). */
const client = process.env.CLIENT !== '0';

const field = buildField({ family: 'hex', level, rootTile: 'Delta' });
fieldOutline(field);
const knobs = knobsForMode(DEFAULT_KNOBS, mode);
const e = new Engine(field, knobs, mulberry32(seed));
const rng = mulberry32(seed + 1);
const ids: string[] = [];
const cursor: { x: number; y: number; vx: number; vy: number; next: number }[] = [];
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (let i = 0; i < field.count; i += 97) {
  const c = tileCenter(field, i);
  minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
  minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
}
const first: GameEvent[] = [];
for (let k = 0; k < humans; k++) {
  const id = `h${k}`;
  ids.push(id);
  first.push(...e.addPlayer(id, id, randomCleanRule('hex', rng)));
  // Every head a pile of captures would give, and patterns to paint with.
  const p = e.players.get(id)!;
  for (let j = 0; j < 5; j++) {
    const rule = randomCleanRule('hex', rng);
    p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
  }
  const c = tileCenter(field, Math.floor(rng.next() * field.count));
  cursor.push({ x: c.x, y: c.y, vx: 0, vy: 0, next: 0 });
}

// A stub 2D context that swallows every call (as in lag-bench).
const stub: any = new Proxy({} as Record<string, unknown>, {
  get: (t, k) => (k in t ? t[k as string] : (..._a: unknown[]) => (k === 'measureText' ? { width: 40 } : undefined)),
  set: (t, k, v) => ((t[k as string] = v), true),
});
(globalThis as any).Path2D = class { constructor() { return stub; } };
(globalThis as any).OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() { return Object.assign(Object.create(stub), { canvas: this }); }
};
const overlay = { getContext: () => stub, width: 1600, height: 1000, getBoundingClientRect: () => ({ width: 800, height: 500 }) };
const store = new Store();
const r: any = new Renderer({} as HTMLCanvasElement, overlay as unknown as HTMLCanvasElement, store);
r.tiles = { kind: 'webgl', clearTints() {}, setTint() {}, draw() {}, resize() {}, setArrows() {}, setTheme() {}, dispose() {} };
r.field = field;
r.width = 800; r.height = 500; r.dpr = 2;
store.handle(JSON.parse(JSON.stringify({ t: 'welcome', you: ids[0], token: '', field: field.spec, knobs, players: e.snapshot().players, paths: [] })) as never);
store.handle({ t: 'events', ev: first } as never);

type Stat = { sum: number; max: number; n: number };
const stat = (): Stat => ({ sum: 0, max: 0, n: 0 });
const add = (s: Stat, v: number) => ((s.sum += v), (s.max = Math.max(s.max, v)), s.n++);
let S = { tick: stat(), taps: stat(), json: stat(), store: stat(), tints: stat(), overlay: stat(), bytes: stat(), snapshot: stat() };
let ok = 0, refused = 0;
/** Wire bytes by event kind, since the last report. */
const mix = new Map<string, number>();
const ticks = Math.round((seconds * 1000) / knobs.tickMs);
let now = 0;
for (let t = 1; t <= ticks; t++) {
  now += knobs.tickMs;
  const ev: GameEvent[] = [];
  let a = performance.now();
  // Paint: every TAP_MS a cursor on the move taps the tile under it.
  for (let k = 0; k < humans; k++) {
    const c = cursor[k];
    c.vx += (rng.next() - 0.5) * 2; c.vy += (rng.next() - 0.5) * 2;
    c.vx *= 0.9; c.vy *= 0.9;
    c.x = Math.min(maxX, Math.max(minX, c.x + c.vx)); c.y = Math.min(maxY, Math.max(minY, c.y + c.vy));
    if (rng.next() < 0.002) Object.assign(c, tileCenter(field, Math.floor(rng.next() * field.count)));
    if (now < c.next) continue;
    c.next = now + TAP_MS;
    const tile = tileAt(field, c);
    if (tile < 0) continue;
    if (rng.next() < 0.05) ev.push(...e.setActive(ids[k], Math.floor(rng.next() * 6)));
    const b = performance.now();
    const res = e.tap(ids[k], tile, c, ev).result;
    add(S.taps, performance.now() - b);
    if (res.ok) ok++; else refused++;
  }
  ev.push(...e.tick(knobs.tickMs));
  add(S.tick, performance.now() - a);
  for (const x of ev) mix.set(x.t, (mix.get(x.t) ?? 0) + JSON.stringify(x).length);
  if (!client) add(S.bytes, JSON.stringify({ t: 'events', ev }).length);
  else {
    a = performance.now();
    const text = JSON.stringify({ t: 'events', ev });
    const msg = JSON.parse(text);
    add(S.json, performance.now() - a);
    add(S.bytes, text.length);
    a = performance.now();
    store.handle(msg);
    add(S.store, performance.now() - a);
    a = performance.now();
    r.syncTints(now);
    add(S.tints, performance.now() - a);
    r.fitToField();
    a = performance.now();
    r.drawOverlay(now);
    add(S.overlay, performance.now() - a);
  }
  if (t % 1200 === 0) {
    a = performance.now();
    const snap = JSON.stringify(e.snapshot());
    add(S.snapshot, performance.now() - a);
    let paths = 0, steps = 0, heads = 0;
    for (const p of e.players.values()) for (const q of p.paths) {
      paths++; steps += q.steps.length; if (q.status === 'growing') heads++;
    }
    const f = (s: Stat) => `${(s.sum / Math.max(1, s.n)).toFixed(2)}/${s.max.toFixed(1)}`;
    const all = [...mix.values()].reduce((x, y) => x + y, 0);
    console.log(
      `${(now / 1000).toFixed(0)}s paths ${paths} steps ${steps} growing ${heads} taps ok/refused ${ok}/${refused} score ${ids.map((id) => e.players.get(id)!.score).join('/')}\n` +
        `  avg/max ms: tick ${f(S.tick)} tap ${f(S.taps)} json ${f(S.json)} store ${f(S.store)} tints ${f(S.tints)} overlay ${f(S.overlay)}\n` +
        `  wire ${((S.bytes.sum / S.bytes.n) * (1000 / knobs.tickMs) / 1024).toFixed(0)} KB/s (${[...mix].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${((100 * v) / all).toFixed(0)}%`).join(', ')})` +
        ` | welcome ${(snap.length / 1024).toFixed(0)} KB in ${S.snapshot.max.toFixed(0)} ms`,
    );
    S = { ...S, tick: stat(), taps: stat(), json: stat(), store: stat(), tints: stat(), overlay: stat(), bytes: stat() };
    ok = refused = 0;
    mix.clear();
  }
}
