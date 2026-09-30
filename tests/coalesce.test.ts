import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Engine } from '../shared/game/engine';
import { buildField, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, randomCleanRule } from '../shared/game/rule';
import { chordTableFor, tileChords } from '../shared/game/strand';

const SPEC = { family: 'hex', level: 3, rootTile: 'Delta' } as const;
const HEX = buildField(SPEC);

/** Ann's territory, and a store that has seen it all. */
function setup(knobs: Knobs) {
  const e = new Engine(HEX, knobs, mulberry32(1));
  const store = new Store();
  store.handle({ t: 'welcome', you: 'a', token: '', field: SPEC, knobs, players: [], paths: [] });
  const ev: GameEvent[] = [...e.addPlayer('a', 'Ann', defaultRule('hex'))];
  const table = chordTableFor(HEX, defaultRule('hex'));
  for (let i = 0, n = 0; i < HEX.count && n < 40; i += 7) {
    if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
    const r = e.tap('a', i, tileCenter(HEX, i));
    ev.push(...r.events);
    if (r.result.ok) n++;
  }
  for (let t = 0; t < 4000; t++) ev.push(...e.tick(knobs.tickMs));
  store.handle({ t: 'events', ev });
  return { e, store };
}

const key = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;

describe('a rule change coalesces', () => {
  it('sends a mote from every old tile to the nearest tile the new lines start on', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const { e, store } = setup(knobs);
    const old = new Set(e.players.get('a')!.paths.flatMap((q) => q.steps.map((s) => s.tile)));
    expect(store.coalesce).toHaveLength(0);
    const ev = e.setRule('a', randomCleanRule('hex', mulberry32(11)));
    store.handle({ t: 'events', ev });
    const seeds = new Set(ev.flatMap((x) => (x.t === 'step' ? [x.step.tile] : [])));
    expect(seeds.size).toBeGreaterThan(0);
    expect(store.coalesce).toHaveLength(1);
    const c = store.coalesce[0];
    expect(c).toMatchObject({ owner: 'a', mine: true, color: e.players.get('a')!.color });
    // One mote per old tile, from its centre.
    expect(new Set(c.from.map(key))).toEqual(new Set([...old].map((t) => key(tileCenter(HEX, t)))));
    const targets = [...seeds].map((t) => tileCenter(HEX, t));
    c.from.forEach((a, k) => {
      const b = c.to[k]!;
      // Always to a tile the new lines start on — itself, when it survives — and the nearest one.
      expect(targets.map(key)).toContain(key(b));
      const d = (q: { x: number; y: number }) => (q.x - a.x) ** 2 + (q.y - a.y) ** 2;
      expect(d(b)).toBeCloseTo(Math.min(...targets.map(d)), 9);
    });
    // Tiles that carry on stay put.
    for (const t of seeds) {
      const k = c.from.findIndex((q) => key(q) === key(tileCenter(HEX, t)));
      expect(k).toBeGreaterThanOrEqual(0);
      expect(key(c.to[k]!)).toBe(key(c.from[k]));
    }
  });

  it('with nothing regrowing, the motes fade where they are', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0, regrowOnRule: false };
    const { e, store } = setup(knobs);
    store.handle({ t: 'events', ev: e.setRule('a', randomCleanRule('hex', mulberry32(11))) });
    expect(store.coalesce).toHaveLength(1);
    expect(store.coalesce[0].to.every((q) => q === null)).toBe(true);
    expect(store.coalesce[0].from.length).toBeGreaterThan(0);
  });

  it('a cut is not a switch: no motes', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const { e, store } = setup(knobs);
    // A pattern swap or a plain wipe without a rule change makes none either.
    const path = e.players.get('a')!.paths[0];
    store.handle({ t: 'events', ev: [{ t: 'wipe', path: path.id, owner: 'a', by: 'b' }] });
    store.handle({ t: 'events', ev: [{ t: 'wipe', path: e.players.get('a')!.paths[1].id, owner: 'a' }] });
    expect(store.coalesce).toHaveLength(0);
  });
});
