/**
 * Hot-loaded bot brains (server/brains.ts): a build of shared/game/brains/
 * swapped into running rooms without a restart — bot players keep their
 * lines and scores, only their brains change.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildBrains } from '../scripts/brains';
import { BrainsWatcher, objectReader, sourceKey, type BrainsVersion } from '../server/brains';
import { Bots, BUILTIN_BRAINS, type Brain, type BrainSet } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode } from '../shared/game/knobs';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import type { StatusReport } from '../server/status-page';

const ROOT = join(__dirname, '..');
const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });

function game(mix: Record<string, number>) {
  const rng = mulberry32(3);
  const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
  const bots = new Bots(engine, rng);
  bots.add(mix, 0);
  const dt = engine.knobs.tickMs;
  let now = 0;
  const play = (ms: number) => {
    for (const end = now + ms; now < end; now += dt) bots.update(now, engine.tick(dt));
  };
  return { engine, bots, play, now: () => now };
}

/** The built-in brains, but every brain made is noted (and can be told to throw). */
function spySet(kinds: readonly string[] = BUILTIN_BRAINS.kinds, opts: { throws?: boolean } = {}) {
  const made: { kind: string; id: string; resumed?: boolean }[] = [];
  const set: BrainSet = {
    ...BUILTIN_BRAINS,
    kinds,
    make(kind, id, ctx): Brain {
      const inner = BUILTIN_BRAINS.make(kind, id, ctx);
      const note = { kind, id } as (typeof made)[number];
      made.push(note);
      return {
        id,
        kind,
        get needsScout() {
          return inner.needsScout;
        },
        firstRule: () => inner.firstRule(),
        start: (now, resumed) => {
          note.resumed = resumed;
          inner.start(now, resumed);
        },
        update: (now, p, ev) => {
          if (opts.throws) throw new Error('boom');
          inner.update(now, p, ev);
        },
      };
    },
  };
  return { set, made };
}

describe('swapping brains under live bots', () => {
  it('keeps every bot player as it is and gives it a resumed brain of its kind', () => {
    const g = game({ wanderer: 2, farmer: 1, bridge: 1 });
    g.play(60_000);
    const before = [...g.engine.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, rule: p.rule, lines: p.paths.map((q) => q.id) }));
    expect(before.some((p) => p.lines.length > 0)).toBe(true);
    const { set, made } = spySet();
    g.bots.setBrains(set, g.now());
    expect(made.map((m) => [m.kind, m.resumed])).toEqual([
      ['wanderer', true],
      ['wanderer', true],
      ['farmer', true],
      ['bridge', true],
    ]);
    const after = [...g.engine.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, rule: p.rule, lines: p.paths.map((q) => q.id) }));
    expect(after).toEqual(before);
    // And they play on under the new brains (a farmer or bridge keeps its rule rather than wait for a scout).
    g.play(60_000);
    expect(g.bots.list().map((b) => b.kind)).toEqual(['wanderer', 'wanderer', 'farmer', 'bridge']);
  });

  it("drops bots whose kind the new brains lack, and reconciles to a mix", () => {
    const g = game({ wanderer: 2, hunter: 1 });
    g.play(10_000);
    const ev = g.bots.setBrains(spySet(['wanderer', 'farmer']).set, g.now(), { wanderer: 1, farmer: 2 });
    expect(ev.filter((e) => e.t === 'leave').length).toBe(2); // the hunter, and the newer wanderer
    expect(ev.filter((e) => e.t === 'join').length).toBe(2);
    expect(g.bots.mix()).toEqual({ wanderer: 1, farmer: 2 });
    expect(g.engine.players.has('bot-1')).toBe(true);
    expect([...g.engine.players.values()].map((p) => p.name)).toEqual(['hexbot', 'Farmer', 'Farmer 2']);
  });

  it('onError keeps one throwing brain from stopping the others', () => {
    const g = game({});
    const errors: string[] = [];
    g.bots.onError = (kind) => errors.push(kind);
    g.bots.setBrains(spySet(['wanderer'], { throws: true }).set, 0, { wanderer: 2 });
    g.play(1000);
    expect(errors.length).toBe(2 * (1000 / g.engine.knobs.tickMs));
  });
});

describe('the watcher', () => {
  let dir: string;
  const key = sourceKey(ROOT);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brains-test-'));
    await buildBrains(dir, { source: "export * from './index';", label: 'hot-1' });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function watcher(over: Partial<ConstructorParameters<typeof BrainsWatcher>[0]> = {}) {
    const applied: BrainsVersion[] = [];
    const logs: string[] = [];
    const w = new BrainsWatcher({
      url: dir,
      key,
      builtin: 'builtin',
      builtinSet: BUILTIN_BRAINS,
      apply: (set, v) => {
        expect(set.kinds).toEqual(BUILTIN_BRAINS.kinds);
        applied.push(v);
      },
      log: (_, t) => logs.push(t),
      read: async (name) => readFileSync(join(dir, name)),
      ...over,
    });
    return { w, applied, logs };
  }

  it('loads a build made from the same source, once', async () => {
    const { w, applied } = watcher();
    expect(await w.check()).toBe(true);
    expect(applied.map((v) => [v.source, v.brains])).toEqual([['hot', 'hot-1']]);
    expect(await w.check()).toBe(false);
    expect(applied.length).toBe(1);
  });

  it('leaves a build of other source for that deploy', async () => {
    const { w, applied } = watcher({ key: 'not-this-one' });
    expect(await w.check()).toBe(false);
    expect(applied).toEqual([]);
    expect(w.refused?.reason).toMatch(/other shared\/ source/);
  });

  it('refuses a build whose checksum is off, and does not try it again', async () => {
    let reads = 0;
    const { w, applied } = watcher({
      read: async (name) => {
        const b = readFileSync(join(dir, name));
        if (name === 'manifest.json') return b;
        reads++;
        return Buffer.concat([b, Buffer.from('\n// tampered')]);
      },
    });
    expect(await w.check()).toBe(false);
    expect(await w.check()).toBe(false);
    expect(applied).toEqual([]);
    expect(reads).toBe(1);
    expect(w.refused?.reason).toMatch(/checksum/);
  });

  it('goes back to the built-in brains when a hot build keeps throwing', async () => {
    const { w, applied } = watcher({ maxFailures: 3 });
    await w.check();
    w.failed(0);
    w.failed(1);
    expect(w.version.source).toBe('hot');
    w.failed(2);
    expect(w.version.source).toBe('built-in');
    expect(applied.map((v) => v.source)).toEqual(['hot', 'built-in']);
    // …and stays there.
    expect(await w.check()).toBe(false);
    expect(w.refused?.reason).toMatch(/threw 3 times/);
  });

  it('reads over http too', async () => {
    const http = serve(dir);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const port = (http.address() as { port: number }).port;
    const manifest = JSON.parse((await objectReader(`http://127.0.0.1:${port}/`)('manifest.json')).toString());
    expect(manifest.brains).toBe('hot-1');
    http.close();
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

describe('a live server', () => {
  const PORT = 21000 + Math.floor(Math.random() * 1000);
  let server: ChildProcess;
  let http: Server;
  let dir: string;
  let ws: WebSocket;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'brains-live-'));
    http = serve(dir);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const bucket = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;
    server = spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(PORT), BOTS: '1', FIELD_LEVEL: '3', BOTS_URL: bucket, BOTS_POLL_MS: '200' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);

  afterAll(() => {
    ws?.close();
    server?.kill();
    http?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const status = async () => (await (await fetch(`http://127.0.0.1:${PORT}/status.json`)).json()) as StatusReport;

  it('swaps new brains (and a bot mix) into a running room without touching the board', async () => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen: ServerMessage[] = [];
    ws.on('message', (d) => seen.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'watcher', rule: defaultRule('hex') }));
    // Nothing published yet: the built-in brains play.
    await new Promise((r) => setTimeout(r, 3000));
    let s = await status();
    expect(s.brains.source).toBe('built-in');
    const room = () => s.rooms.find((r) => r.id === 'normal-1')!;
    const bot = room().players.find((p) => p.bot)!;
    expect(bot.lines).toBeGreaterThan(0);

    // Publish brains that also ask for a hunter in normal rooms.
    await buildBrains(dir, {
      source: "import { brains as b } from './index';\nexport const brains = { ...b, mix: { normal: { wanderer: 1, hunter: 1 } } };",
      label: 'live-2',
    });
    for (let i = 0; i < 50 && s.brains.brains !== 'live-2'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = await status();
    }
    expect(s.brains).toMatchObject({ source: 'hot', brains: 'live-2', refused: null });
    // Same wanderer, lines intact; a hunter joined beside it; the human never dropped.
    const again = room().players.find((p) => p.name === bot.name)!;
    expect(again.lines).toBeGreaterThanOrEqual(1);
    expect(room().players.map((p) => p.name)).toContain('Hunter');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // /status shows the swap at once; its events reach the socket with the room's next tick.
    const hunterJoined = () => seen.some((m) => m.t === 'events' && m.ev.some((e) => e.t === 'join' && e.player.name === 'Hunter'));
    for (let i = 0; i < 40 && !hunterJoined(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(hunterJoined()).toBe(true);
    expect(seen.some((m) => m.t === 'events' && m.ev.some((e) => e.t === 'leave'))).toBe(false);
  }, 30_000);
});
