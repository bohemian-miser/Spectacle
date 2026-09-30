import { describe, expect, it, vi } from 'vitest';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';
import { packEvents, unpackPaths } from '../shared/game/wire';

/** A busy board: bots holding a few patterns each, so flips, splits, circuits and claims. */
function busy(family: 'hex' | 'spectre', level: number) {
  const spec = { family, level, rootTile: 'Delta' } as const;
  const field = buildField(spec);
  const knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
  const e = new Engine(field, knobs, mulberry32(21));
  const rng = mulberry32(22);
  const bots = new Bots(e, mulberry32(23), 0.1);
  bots.add(4, 0);
  for (const p of e.players.values()) {
    for (let k = 0; k < 2; k++) {
      const rule = randomCleanRule(family, rng);
      p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
    }
  }
  let now = 0;
  for (let t = 0; t < 2000; t++) {
    now += knobs.tickMs;
    const ev: GameEvent[] = [];
    bots.update(now, ev);
    e.tick(knobs.tickMs);
  }
  return { spec, field, knobs, e };
}

describe('packed welcome', () => {
  it.each([
    ['hex', 4],
    ['spectre', 3],
  ] as const)('%s: every line grows back from its first step to exactly the plain snapshot, and the store ends up the same', (family, level) => {
    const { spec, field, knobs, e } = busy(family, level);
    const plain = JSON.parse(JSON.stringify(e.snapshot()));
    const packed = JSON.parse(JSON.stringify(e.packedSnapshot()));
    expect(plain.paths.length).toBeGreaterThan(20);
    // The lines themselves: a first step and a length each, where they were every step's coordinates.
    expect(JSON.stringify(packed.packed.paths).length).toBeLessThan(JSON.stringify(plain.paths).length / 15);

    // Edge-to-edge claims too, whose regions travel as rounded numbers.
    expect(plain.paths.some((p: { region?: unknown }) => p.region)).toBe(true);
    // Every line regrows from its first step: no strand branches or ends early.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const back = unpackPaths(field, packed.packed);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(back.length).toBe(plain.paths.length);
    back.forEach((q, i) => {
      const p = plain.paths[i];
      // Steps come back bit for bit; a claim's region to the 0.001 it was rounded to.
      expect({ ...q, region: undefined }).toEqual({ ...p, region: undefined });
      expect(q.region?.length).toBe(p.region?.length);
      q.region?.forEach((pt, k) => {
        expect(Math.abs(pt.x - p.region[k].x)).toBeLessThanOrEqual(0.0005 + 1e-9);
        expect(Math.abs(pt.y - p.region[k].y)).toBeLessThanOrEqual(0.0005 + 1e-9);
      });
    });

    const a = new Store();
    a.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs, players: plain.players, paths: plain.paths });
    const b = new Store();
    b.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs, players: packed.players, paths: [], packed: packed.packed });
    const lines = (s: Store) =>
      [...s.paths.values()].map((q) => `${q.id} ${q.owner} ${q.status} ${q.pattern} ${q.steps.map((st) => `${st.tile}.${st.chord}@${st.a.x},${st.a.y}>${st.b.x},${st.b.y}`).join(' ')}`);
    expect(lines(b)).toEqual(lines(a));
    expect([...b.occupancy.keys()].sort((x, y) => x - y)).toEqual([...a.occupancy.keys()].sort((x, y) => x - y));
  });

  it.each([
    ['hex', 4, 'conquest'],
    ['hex', 4, 'normal'],
    ['spectre', 3, 'conquest'],
  ] as const)('%s %s: a client joining mid-game and fed begin/grow events keeps exactly the engine’s lines', (family, level, mode) => {
    const spec = { family, level, rootTile: 'Delta' } as const;
    const field = buildField(spec);
    const knobs = { ...DEFAULT_KNOBS, mode, maxHeads: 0 };
    const e = new Engine(field, knobs, mulberry32(31));
    const rng = mulberry32(32);
    const bots = new Bots(e, mulberry32(33), 0.1);
    bots.add(4, 0);
    for (const p of e.players.values()) {
      for (let k = 0; k < 2; k++) {
        const rule = randomCleanRule(family, rng);
        p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
      }
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new Store();
    const kinds = new Map<string, number>();
    let plainBytes = 0;
    let packedBytes = 0;
    let now = 0;
    for (let t = 1; t <= 2500; t++) {
      now += knobs.tickMs;
      // As the server does: the tick, then the bots, then packed for the wire.
      const ev: GameEvent[] = e.tick(knobs.tickMs);
      bots.update(now, ev);
      if (t === 500) {
        // Join mid-game, from a packed welcome.
        const snap = JSON.parse(JSON.stringify(e.packedSnapshot()));
        store.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs, players: snap.players, paths: [], packed: snap.packed });
        continue;
      }
      if (t < 500) continue;
      const wire = packEvents(field, ev, (owner, pattern) => e.players.get(owner)?.patterns[pattern]?.table);
      for (const x of wire) kinds.set(x.t, (kinds.get(x.t) ?? 0) + 1);
      plainBytes += JSON.stringify(ev).length;
      packedBytes += JSON.stringify(wire).length;
      store.handle(JSON.parse(JSON.stringify({ t: 'events', ev: wire })));
    }
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(kinds.get('begin')).toBeGreaterThan(0);
    expect(kinds.get('grow')).toBeGreaterThan(0);
    expect(kinds.get('step') ?? 0).toBe(0);
    expect(packedBytes).toBeLessThan(plainBytes / 2);

    const key = (q: { owner: string; status: string; steps: readonly { tile: number; chord: number; a: { x: number; y: number }; b: { x: number; y: number } }[] }) =>
      `${q.owner} ${q.status} ${q.steps.map((s) => `${s.tile}.${s.chord}@${s.a.x},${s.a.y}>${s.b.x},${s.b.y}`).join(' ')}`;
    const engine = new Map<number, string>();
    for (const p of e.players.values()) for (const q of p.paths) engine.set(q.id, key(q));
    expect(store.paths.size).toBe(engine.size);
    for (const q of store.paths.values()) expect(key(q), `path ${q.id}`).toBe(engine.get(q.id));
    // Scores too, though only each tick's last one per player travels.
    for (const p of e.players.values()) expect(store.players.get(p.id)?.score, p.id).toBe(p.score);
  });
});
