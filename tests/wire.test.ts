import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';
import { unpackPaths } from '../shared/game/wire';

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
  ] as const)('%s: unpacks to exactly the plain snapshot, and the store ends up the same', (family, level) => {
    const { spec, field, knobs, e } = busy(family, level);
    const plain = JSON.parse(JSON.stringify(e.snapshot()));
    const packed = JSON.parse(JSON.stringify(e.packedSnapshot()));
    expect(plain.paths.length).toBeGreaterThan(20);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(plain).length / 3);

    // Edge-to-edge claims too, whose regions travel as rounded numbers.
    expect(plain.paths.some((p: { region?: unknown }) => p.region)).toBe(true);
    const back = unpackPaths(field, packed.packed);
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
});
