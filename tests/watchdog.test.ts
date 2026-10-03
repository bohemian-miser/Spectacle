/**
 * The bot watchdog (shared/game/bots.ts): every room shares one loop, so a
 * brain whose update comes back too slow has its kind benched in its room —
 * its bots leave and `reconcile` won't bring it back — while the other bots
 * play on. A hot-loaded build whose bots keep tripping it is dropped
 * (server/brains.ts), and a live server counts and shows all of it on /status.
 *
 * Brains here "take time" by moving a fake clock on (`Bots.clock`), so the
 * tests neither busy-wait nor depend on the machine's speed — except the
 * live server's, which busy-waits for real: that is what it is there to see.
 */
import { startServer, type TestServer } from './server';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildBrains } from '../scripts/brains';
import { BrainsWatcher, sourceKey } from '../server/brains';
import type { StatusReport } from '../server/status-page';
import { Bots, BUILTIN_BRAINS, DEFAULT_WATCHDOG, type BotOptions, type BotTrip, type Brain, type BrainSet, type WatchdogOptions } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';

const ROOT = join(__dirname, '..');
const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });

/** What an update costs on the fake clock, ms: by kind, given how many that bot has had and whether it changed its rule. */
type Costs = Readonly<Record<string, (call: number, switched: boolean) => number>>;

/**
 * The built-in brains plus a `sloth` (plays like a wanderer); every update
 * moves the fake clock on by its kind's cost. `scoutCost`: what the set's
 * shared `work` costs, while a sloth waits on it (`slothScouts`).
 */
function game(
  mix: Record<string, number>,
  costs: Costs,
  opts: { watchdog?: WatchdogOptions; slothScouts?: boolean; scoutCost?: number; botOptions?: Partial<BotOptions> } = {},
) {
  let clock = 0;
  const set: BrainSet = {
    ...BUILTIN_BRAINS,
    kinds: [...BUILTIN_BRAINS.kinds, 'sloth'],
    info: { ...BUILTIN_BRAINS.info, sloth: { label: 'Sloth', blurb: 'thinks too long' } },
    work(f) {
      BUILTIN_BRAINS.work(f);
      clock += opts.scoutCost ?? 0;
    },
    make(kind, id, ctx): Brain {
      const inner = BUILTIN_BRAINS.make(kind === 'sloth' ? 'wanderer' : kind, id, ctx);
      let calls = 0;
      return {
        id,
        kind,
        get needsScout() {
          return kind === 'sloth' && !!opts.slothScouts;
        },
        firstRule: () => inner.firstRule(),
        start: (now, resumed) => inner.start(now, resumed),
        update(now, p, ev) {
          const rule = p.rule;
          inner.update(now, p, ev);
          clock += costs[kind]?.(++calls, p.rule !== rule) ?? 0;
        },
      };
    },
  };
  const rng = mulberry32(5);
  const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
  const bots = new Bots(engine, rng, undefined, opts.botOptions ?? {}, set);
  bots.clock = () => clock;
  bots.watchdog = opts.watchdog ?? DEFAULT_WATCHDOG;
  const trips: { tick: number; trip: BotTrip }[] = [];
  let tick = 0;
  bots.onSlow = (trip) => trips.push({ tick, trip });
  const events: GameEvent[] = [...bots.add(mix, 0)];
  const dt = engine.knobs.tickMs;
  let now = 0;
  const play = (ms: number): GameEvent[] => {
    const out: GameEvent[] = [];
    for (const end = now + ms; now < end; now += dt) {
      tick++;
      const ev = engine.tick(dt);
      bots.update(now, ev);
      out.push(...ev);
    }
    events.push(...out);
    return out;
  };
  const ids = (kind: string) => bots.list().filter((b) => b.kind === kind).map((b) => b.id);
  return { engine, bots, set, trips, events, play, ids, now: () => now };
}

describe('the bot watchdog', () => {
  it('benches a kind whose update takes over the hard limit once; the others play on', () => {
    // Both sloths' 40th update takes 250 ms (the first one's is enough).
    const g = game({ wanderer: 2, sloth: 2 }, { sloth: (n) => (n === 40 ? 250 : 0) });
    const sloths = g.ids('sloth');
    const wanderers = g.ids('wanderer');
    const early = g.play(10_000);
    expect(g.trips).toEqual([{ tick: 40, trip: { kind: 'sloth', ms: 250, why: 'hard', source: 'update', removed: 2 } }]);
    // Both sloths left the game; their kind is no longer in it, nor on offer.
    for (const id of sloths) {
      expect(g.engine.players.has(id)).toBe(false);
      expect(early.some((e) => e.t === 'leave' && e.id === id)).toBe(true);
    }
    expect(g.bots.mix()).toEqual({ wanderer: 2 });
    expect(g.bots.kinds()).not.toContain('sloth');
    expect(g.bots.roomBots(3, 6).kinds.map((k) => k.kind)).not.toContain('sloth');
    expect(g.bots.benched().map((t) => t.kind)).toEqual(['sloth']);
    // Asking for it again — the room's choice, live tuning's mix — adds nothing.
    expect(g.bots.reconcile({ wanderer: 2, sloth: 2 }, g.now()).filter((e) => e.t === 'join')).toEqual([]);
    expect(g.bots.add({ sloth: 1 }, g.now())).toEqual([]);
    expect(g.bots.mix()).toEqual({ wanderer: 2 });
    // The wanderers play on.
    const later = g.play(60_000);
    for (const id of wanderers) expect(later.filter((e) => e.t === 'step' && e.owner === id).length, id).toBeGreaterThan(0);
    expect(g.trips.length).toBe(1);
  });

  it('lets a slow update now and then go, but not too many within the window', () => {
    // 30 ms every 25th update: 8 strikes in any 200 ticks, never 10.
    const fine = game({ wanderer: 1, sloth: 1 }, { sloth: (n) => (n % 25 === 0 ? 30 : 0) });
    fine.play(100_000);
    expect(fine.trips).toEqual([]);
    expect(fine.bots.mix()).toEqual({ wanderer: 1, sloth: 1 });
    // 30 ms every 20th update: the 10th strike, at tick 200, benches it.
    const slow = game({ wanderer: 1, sloth: 1 }, { sloth: (n) => (n % 20 === 0 ? 30 : 0) });
    slow.play(100_000);
    expect(slow.trips).toEqual([{ tick: 200, trip: { kind: 'sloth', ms: 30, why: 'soft', source: 'update', removed: 1 } }]);
    expect(slow.bots.mix()).toEqual({ wanderer: 1 });
  });

  it('holds a rule switch only to the soft budget: it pays for the regrow, as a human’s does', () => {
    // A rotator starting over every ~10 s, each switch made to cost 250 ms: over the hard limit, but only a strike.
    const g = game({ rotator: 1, wanderer: 1 }, { rotator: (_, switched) => (switched ? 250 : 0) }, { botOptions: { rotateMs: 10_000 } });
    const id = g.ids('rotator')[0];
    const switches = g.play(120_000).filter((e) => e.t === 'rule' && e.id === id).length;
    expect(switches).toBeGreaterThanOrEqual(8);
    expect(g.trips).toEqual([]);
    // Switching every few ticks at that cost is still too often.
    const h = game({ rotator: 1 }, { rotator: (_, switched) => (switched ? 250 : 0) }, { botOptions: { rotateMs: 400 } });
    h.play(20_000);
    expect(h.trips.map((t) => [t.trip.kind, t.trip.why])).toEqual([['rotator', 'soft']]);
  });

  it('is off unless set: nothing timed, nothing benched', () => {
    const g = game({ wanderer: 1, sloth: 1 }, { sloth: () => 10_000 });
    let reads = 0;
    g.bots.clock = () => ++reads;
    g.bots.watchdog = null;
    g.play(5000);
    expect(reads).toBe(0);
    expect(g.trips).toEqual([]);
    expect(g.bots.mix()).toEqual({ wanderer: 1, sloth: 1 });
  });

  it('new brains get a clean slate: a benched kind may play again', () => {
    const g = game({ wanderer: 1, sloth: 1 }, { sloth: () => 250 });
    g.play(1000);
    expect(g.bots.mix()).toEqual({ wanderer: 1 });
    g.bots.setBrains(g.set, g.now(), { wanderer: 1, sloth: 1 });
    expect(g.bots.benched()).toEqual([]);
    expect(g.bots.mix()).toEqual({ wanderer: 1, sloth: 1 });
  });

  it('times the shared scout too, against the hard limit: the kinds waiting on it are benched', () => {
    // Slices over the soft budget, every tick: finite, budgeted work a busy machine stretches — let be.
    const busy = game({ wanderer: 1, sloth: 1 }, {}, { slothScouts: true, scoutCost: 40 });
    busy.play(30_000);
    expect(busy.trips).toEqual([]);
    const g = game({ wanderer: 1, sloth: 1 }, {}, { slothScouts: true, scoutCost: 250 });
    g.play(1000);
    expect(g.trips.map((t) => t.trip)).toEqual([{ kind: 'sloth', ms: 250, why: 'hard', source: 'scout', removed: 1 }]);
    expect(g.bots.mix()).toEqual({ wanderer: 1 });
  });

  it('times a throwing brain’s update too, through onError', () => {
    const g = game({ wanderer: 1 }, {});
    const errors: string[] = [];
    g.bots.onError = (kind) => errors.push(kind);
    let clock = 0;
    g.bots.clock = () => clock;
    const thrower: BrainSet = {
      ...g.set,
      make: (kind, id) => ({
        id,
        kind,
        needsScout: false,
        firstRule: () => defaultRule('hex'),
        start: () => {},
        update: () => {
          clock += 300;
          throw new Error('slow, then boom');
        },
      }),
    };
    g.bots.setBrains(thrower, g.now());
    g.play(200);
    expect(errors).toEqual(['wanderer']);
    expect(g.trips.map((t) => [t.trip.kind, t.trip.why])).toEqual([['wanderer', 'hard']]);
  });
});

describe('a hot build that keeps tripping the watchdog', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-build-'));
    await buildBrains(dir, { source: "export * from './index';", label: 'hot-slow' });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('goes back to the built-in brains and is not loaded again', async () => {
    const applied: string[] = [];
    const w = new BrainsWatcher({
      url: dir,
      key: sourceKey(ROOT),
      builtin: 'builtin',
      builtinSet: BUILTIN_BRAINS,
      apply: (_, v) => applied.push(v.source),
      log: () => {},
      read: async (name) => readFileSync(join(dir, name)),
    });
    w.slow(0); // built-in brains: nothing to go back from
    await w.check();
    expect(w.version.source).toBe('hot');
    w.slow(1000);
    w.slow(2000);
    expect(w.version.source).toBe('hot');
    w.slow(3000);
    expect(w.version.source).toBe('built-in');
    expect(applied).toEqual(['hot', 'built-in']);
    expect(w.refused?.reason).toMatch(/tripped the bot watchdog 3 times/);
    expect(await w.check()).toBe(false);
  });

  it('only counts trips within the window', async () => {
    const w = new BrainsWatcher({
      url: dir,
      key: sourceKey(ROOT),
      builtin: 'builtin',
      builtinSet: BUILTIN_BRAINS,
      apply: () => {},
      log: () => {},
      read: async (name) => readFileSync(join(dir, name)),
      slowWindowMs: 10_000,
    });
    await w.check();
    for (let t = 0; t < 100_000; t += 6_000) w.slow(t);
    expect(w.version.source).toBe('hot');
  });
});

function serve(dir: string): Server {
  return createServer((req, res) => {
    const name = (req.url ?? '/').slice(1);
    if (!readdirSync(dir).includes(name)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(readFileSync(join(dir, name)));
  });
}

describe('a live server with a brain that hogs the loop', () => {
  const PORT = 25000 + Math.floor(Math.random() * 1000); // a band of its own (tests/*.test.ts)
  let server: TestServer;
  let http: Server;
  let dir: string;
  let ws: WebSocket;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'watchdog-live-'));
    http = serve(dir);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const bucket = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    server = await startServer(PORT, { BOTS: '1', FIELD_LEVEL: '3', BOTS_URL: bucket, BOTS_POLL_MS: '200', BOT_WATCHDOG_HARD_MS: '100' });
  }, 30_000);

  afterAll(async () => {
    ws?.close();
    await server?.stop();
    http?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const status = async () => (await (await fetch(`http://127.0.0.1:${PORT}/status.json`)).json()) as StatusReport;

  it('benches the slow kinds, drops the build, and /status shows the stall for the minute after', async () => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'watcher', rule: defaultRule('hex') }));
    // Brains whose every update busy-waits 150 ms (the server's limit here is 100), three kinds of them.
    await buildBrains(dir, {
      source:
        "import { brains as b } from './index';\n" +
        'const hog = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };\n' +
        'export const brains = { ...b, mix: { normal: { wanderer: 1, hunter: 1, rotator: 1 } }, make(kind: string, id: string, ctx: any) {\n' +
        '  const inner = b.make(kind, id, ctx);\n' +
        '  return { id, kind, get needsScout() { return inner.needsScout; }, firstRule: () => inner.firstRule(), start: (n: number, r: boolean) => inner.start(n, r),\n' +
        '    update(now: number, p: any, ev: any[]) { hog(150); inner.update(now, p, ev); } };\n' +
        '} };',
      label: 'hog-1',
    });
    let s = await status();
    for (let i = 0; i < 100 && !s.brains.refused; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = await status();
    }
    // Each kind was benched once, and three trips sent the build back.
    expect(s.counters.watchdog).toBe(3);
    expect(s.counters.errors).toBe(0);
    expect(s.brains).toMatchObject({ source: 'built-in', refused: expect.stringMatching(/tripped the bot watchdog 3 times/) });
    expect(s.recent.filter((l) => l.level === 'warn' && l.text.startsWith('watchdog:')).length).toBe(3);
    // The built-in wanderer plays in the room again.
    expect(s.rooms.find((r) => r.id === 'normal-1')!.players.some((p) => p.bot)).toBe(true);
    // That pass took three 150 ms updates, and /status keeps showing it —
    // and the gap it left before the next pass, once that pass has begun.
    expect(s.tick.maxMs).toBeGreaterThanOrEqual(450);
    await new Promise((r) => setTimeout(r, 1500));
    s = await status();
    expect(s.tick.maxMs).toBeGreaterThanOrEqual(450);
    expect(s.tick.gapMs).toBeGreaterThanOrEqual(450);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
