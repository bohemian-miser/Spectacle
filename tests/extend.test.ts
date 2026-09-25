import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, onFieldBoundary } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { defaultRule, fassRule, randomCleanRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor, tileChords, walkStrand, worldChord } from '../shared/game/strand';

const SPEC = { family: 'spectre', level: 3, rootTile: 'Delta' } as const;
const FIELD = buildField(SPEC);
const FASS = fassRule('spectre');
const TABLE = chordTableFor(FIELD, FASS);

/** A chord well inside a strand that runs from the field's edge to the field's edge. */
function edgeToEdge(): { tile: number; chord: number; length: number } {
  for (let i = 0; i < FIELD.count; i++) {
    for (let c = 0; c < tileChords(FIELD, TABLE, i).length; c++) {
      const fwd = walkStrand(FIELD, TABLE, i, c, 1);
      const back = walkStrand(FIELD, TABLE, i, c, 0);
      if (fwd.stoppedAt !== 'dead' || back.stoppedAt !== 'dead') continue;
      if (fwd.steps.length < 8 || back.steps.length < 8) continue;
      const f = fwd.steps[fwd.steps.length - 1];
      const b = back.steps[back.steps.length - 1];
      if (onFieldBoundary(FIELD, f.tile, f.b) && onFieldBoundary(FIELD, b.tile, b.b)) {
        return { tile: i, chord: c, length: fwd.steps.length + back.steps.length - 1 };
      }
    }
  }
  throw new Error('no edge-to-edge strand');
}

function tapChord(e: Engine, id: string, tile: number, chord: number, table = TABLE) {
  const [a, b] = worldChord(FIELD, table, tile, chord);
  return e.tap(id, tile, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

function engine(knobs: Partial<Knobs> = {}): Engine {
  const e = new Engine(FIELD, { ...DEFAULT_KNOBS, ...knobs }, mulberry32(7));
  e.addPlayer('a', 'Ann', FASS);
  return e;
}

describe('a tap on your own growing line', () => {
  it('is refused with only one head', () => {
    const e = engine();
    const { tile, chord } = edgeToEdge();
    const first = tapChord(e, 'a', tile, chord).result;
    if (!first.ok) throw new Error('tap refused');
    const again = tapChord(e, 'a', tile, chord);
    expect(again.result).toEqual({ ok: false, reason: 'your line is still growing' });
    expect(e.getPath(first.path)!.back).toBeFalsy();
  });

  it('with a head to spare, grows it from both ends: two heads, one edge-to-edge claim', () => {
    const e = engine({ maxHeads: 2 });
    const { tile, chord, length } = edgeToEdge();
    const first = tapChord(e, 'a', tile, chord).result;
    if (!first.ok) throw new Error('tap refused');
    const path = e.getPath(first.path)!;
    for (let t = 0; t < 3; t++) e.tick(DEFAULT_KNOBS.tickMs);
    const s = path.steps[path.steps.length - 1];
    const both = tapChord(e, 'a', s.tile, s.chord);
    expect(both.result).toEqual({ ok: true, path: path.id });
    expect(both.events).toContainEqual({ t: 'back', path: path.id, back: true });
    const p = e.players.get('a')!;
    expect(e.headsInUse(p)).toBe(2);
    // No head left: a third tap anywhere is refused.
    expect(tapChord(e, 'a', s.tile, s.chord).result).toMatchObject({ ok: false });
    expect(e.snapshot().paths[0].back).toBe(true);

    const store = new Store();
    store.handle({ t: 'welcome', you: 'a', token: '', field: SPEC, knobs: e.knobs, players: [e.publicOf(p)], paths: e.snapshot().paths });
    expect(store.heads()).toEqual({ free: 0, total: 2 });
    let circuit: GameEvent | undefined;
    const startTile = path.steps[0].tile;
    let grewBack = false;
    for (let t = 0; t < 5000 && !circuit; t++) {
      const ev = e.tick(DEFAULT_KNOBS.tickMs);
      store.handle({ t: 'events', ev });
      if (path.steps[0].tile !== startTile) grewBack = true;
      circuit = ev.find((x) => x.t === 'circuit');
    }
    expect(grewBack).toBe(true);
    if (circuit?.t !== 'circuit') throw new Error('no claim');
    expect(circuit.region).toBeDefined();
    expect(path.status).toBe('closed');
    expect(path.steps.length).toBe(length);
    expect(p.paths).toEqual([path]);
    expect(p.score).toBe(length * DEFAULT_KNOBS.pointsPerTile + circuit.bonus);
    // The client drew the same line.
    const cp = store.paths.get(path.id)!;
    expect(cp.status).toBe('closed');
    expect(cp.steps.map((q) => `${q.tile}.${q.chord}`)).toEqual(path.steps.map((q) => `${q.tile}.${q.chord}`));
    expect(store.heads().free).toBe(2);
  });

  it('when one end stops, the other keeps growing and the line holds one head again', () => {
    const e = engine({ maxHeads: 2 });
    const { tile, chord } = edgeToEdge();
    const first = tapChord(e, 'a', tile, chord).result;
    if (!first.ok) throw new Error('tap refused');
    const path = e.getPath(first.path)!;
    tapChord(e, 'a', tile, chord);
    expect(path.back).toBe(true);
    let saw: GameEvent[] = [];
    for (let t = 0; t < 5000 && path.status === 'growing' && path.back; t++) saw = e.tick(DEFAULT_KNOBS.tickMs);
    expect(saw).toContainEqual({ t: 'back', path: path.id, back: false });
    expect(path.status).toBe('growing');
    expect(e.headsInUse(e.players.get('a')!)).toBe(1);
  });
});

describe('a tap on your own line of another pattern', () => {
  it('turns the whole line into the active pattern, points and all', () => {
    const e = engine({ headsWithCapture: 1 });
    const p = e.players.get('a')!;
    const other = defaultRule('spectre');
    const otherTable = chordTableFor(FIELD, other);
    p.patterns.push({ rule: other, table: otherTable, color: 'hsl(0, 90%, 62%)' });
    const { tile, chord } = edgeToEdge();
    tapChord(e, 'a', tile, chord);
    for (let t = 0; t < 5000 && p.paths[0].status === 'growing'; t++) e.tick(DEFAULT_KNOBS.tickMs);
    const line = p.paths[0];
    const score = p.score;
    expect(score).toBeGreaterThan(0);
    // A tile of the line where the active pattern draws something too.
    const at = line.steps.find((q) => tileChords(FIELD, otherTable, q.tile).length > 0)!;
    // Take the only head with another line elsewhere: recolouring needs none.
    const elsewhere = line.steps.map((q) => q.tile);
    for (let t = 0; t < FIELD.count && e.headsInUse(p) === 0; t++) {
      if (!elsewhere.includes(t) && tileChords(FIELD, TABLE, t).length > 0) tapChord(e, 'a', t, 0);
    }
    expect(e.headsInUse(p)).toBe(1);
    e.setActive('a', 1);
    const res = tapChord(e, 'a', at.tile, at.chord);
    expect(res.result).toEqual({ ok: true, path: line.id });
    expect(res.events.some((x) => x.t === 'split')).toBe(true);
    for (let t = 0; t < 5000 && p.paths.some((q) => q.pattern === 0 && q.id === line.id); t++) e.tick(DEFAULT_KNOBS.tickMs);
    for (let t = 0; t < 400; t++) e.tick(DEFAULT_KNOBS.tickMs);
    expect(p.paths.some((q) => q.pattern === 0 && q.steps.some((x) => elsewhere.includes(x.tile)))).toBe(false);
    expect(p.paths.length).toBeGreaterThan(0);
    // Zero-sum: the pieces hold what they grew plus what the old line had.
    expect(p.paths.reduce((n, q) => n + q.points, 0)).toBe(p.score);
    expect(p.score).toBeGreaterThanOrEqual(score);
  });
});

describe('tapping your own lines, replayed into a client', () => {
  it('ends with exactly the engine’s lines', () => {
    const knobs = { ...DEFAULT_KNOBS, maxHeads: 3 };
    const e = new Engine(FIELD, knobs, mulberry32(11));
    const rng = mulberry32(12);
    const bots = new Bots(e, mulberry32(13), 0.1);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: SPEC, knobs, players: [], paths: [] });
    store.handle({ t: 'events', ev: bots.add(4, 0) });
    for (const p of e.players.values()) {
      for (let k = 0; k < 2; k++) {
        const rule = randomCleanRule('spectre', rng);
        p.patterns.push({ rule, table: chordTableFor(FIELD, rule), color: p.color });
      }
    }
    let backs = 0;
    let now = 0;
    for (let t = 0; t < 3000; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      // Every so often each player taps one of their own lines.
      if (t % 7 === 0) {
        for (const p of e.players.values()) {
          if (p.paths.length === 0) continue;
          const q = p.paths[rng.int(p.paths.length)];
          const s = q.steps[rng.int(q.steps.length)];
          if (rng.next() < 0.5) ev.push(...e.setActive(p.id, rng.int(p.patterns.length)));
          const [a, b] = worldChord(FIELD, q.table, s.tile, s.chord);
          e.tap(p.id, s.tile, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ev);
        }
      }
      ev.push(...e.tick(knobs.tickMs));
      for (const x of ev) if (x.t === 'back' && x.back) backs++;
      store.handle({ t: 'events', ev });
    }
    expect(backs).toBeGreaterThan(0);
    const key = (owner: string, status: string, back: boolean, steps: readonly { tile: number; chord: number; a: { x: number; y: number } }[]) =>
      `${owner} ${status} ${back} ${steps.map((s) => `${s.tile}.${s.chord}@${s.a.x.toFixed(3)},${s.a.y.toFixed(3)}`).join(' ')}`;
    const eng = new Map<number, string>();
    for (const p of e.players.values()) {
      for (const q of p.paths) eng.set(q.id, key(q.owner, q.status, !!q.back && q.status === 'growing', q.steps));
      // Heads never exceed the limit through two-way growth.
      expect(e.headsInUse(p)).toBeLessThanOrEqual(e.headLimit(p));
    }
    const client = new Map<number, string>();
    for (const q of store.paths.values()) client.set(q.id, key(q.owner, q.status, !!q.back && q.status === 'growing', q.steps));
    expect(client.size).toBe(eng.size);
    for (const [id, k] of eng) expect(client.get(id), `path ${id}`).toBe(k);
  });
});
