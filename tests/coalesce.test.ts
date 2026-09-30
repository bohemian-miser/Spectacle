import { describe, expect, it } from 'vitest';
import { flow, motesPerTile, Store } from '../client/src/store';
import { Engine } from '../shared/game/engine';
import { buildField, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { planRegrow } from '../shared/game/regrow';
import { packEvents } from '../shared/game/wire';
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
  it('sends every old tile’s mote to the new tiles in proportion to the budget each takes in', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const { e, store } = setup(knobs);
    const a = e.players.get('a')!;
    const old = new Set(a.paths.flatMap((q) => q.steps.map((s) => s.tile)));
    const budget = a.score;
    const rule = randomCleanRule('hex', mulberry32(11));
    const plan = planRegrow(HEX, chordTableFor(HEX, rule), old, budget, knobs);
    expect(store.coalesce).toHaveLength(0);
    const ev = e.setRule('a', rule);
    store.handle({ t: 'events', ev });
    const seeds = [...new Set(ev.flatMap((x) => (x.t === 'step' ? [x.step.tile] : [])))];
    expect(seeds.length).toBeGreaterThan(1);
    // The server's shares: what each bought circuit costs, over its held tiles, as a fraction of the budget.
    const rev = ev.find((x) => x.t === 'rule');
    if (rev?.t !== 'rule' || !rev.absorb) throw new Error('no shares');
    const share = new Map<number, number>();
    for (let k = 0; k < rev.absorb.length; k += 2) share.set(rev.absorb[k], rev.absorb[k + 1]);
    const bought = [...plan.kept, ...(plan.stretch ? [plan.stretch] : [])];
    const total = [...share.values()].reduce((x, y) => x + y, 0);
    expect(total * budget).toBeCloseTo(bought.reduce((n, q) => n + q.price, 0), 0);

    expect(store.coalesce).toHaveLength(1);
    const c = store.coalesce[0];
    expect(c).toMatchObject({ owner: 'a', mine: true, color: a.color });
    // One mote per old tile, from its centre.
    expect(new Set(c.from.map(key))).toEqual(new Set([...old].map((t) => key(tileCenter(HEX, t)))));
    // Each new tile takes exactly its share of them; what the budget couldn't spend goes nowhere.
    const cap = motesPerTile(seeds.map((t) => share.get(t) ?? 0), c.from.length);
    const got = new Map<string, number>();
    for (const q of c.to) if (q) got.set(key(q), (got.get(key(q)) ?? 0) + 1);
    seeds.forEach((t, j) => expect(got.get(key(tileCenter(HEX, t))) ?? 0, `tile ${t}`).toBe(cap[j]));
    expect(c.to.filter((q) => q === null).length).toBe(c.from.length - Math.round(c.from.length * Math.min(1, total)));
    // A tile that carries on keeps its own mote.
    for (const t of seeds) {
      const k = c.from.findIndex((q) => key(q) === key(tileCenter(HEX, t)));
      expect(key(c.to[k]!)).toBe(key(c.from[k]));
    }
  });

  it('reads the switch just the same from the packed stream (begin / grow)', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const plain = setup(knobs);
    const packed = setup(knobs);
    const rule = randomCleanRule('hex', mulberry32(11));
    const ev = plain.e.setRule('a', rule);
    const ev2 = packed.e.setRule('a', rule);
    plain.store.handle({ t: 'events', ev });
    const wire = packEvents(HEX, ev2, (owner, pattern) => packed.e.players.get(owner)?.patterns[pattern]?.table);
    expect(wire.some((x) => x.t === 'begin')).toBe(true);
    expect(wire.some((x) => x.t === 'step')).toBe(false);
    packed.store.handle({ t: 'events', ev: wire });
    expect(packed.store.coalesce).toHaveLength(1);
    const [a, b] = [plain.store.coalesce[0], packed.store.coalesce[0]];
    expect(b.to.filter(Boolean).length).toBeGreaterThan(0);
    expect(b.from.map(key)).toEqual(a.from.map(key));
    expect(b.to.map((q) => (q ? key(q) : null))).toEqual(a.to.map((q) => (q ? key(q) : null)));
  });

  it('shows the end state the plan bought: every circuit and line, whole', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const plain = setup(knobs);
    const packed = setup(knobs);
    const a = plain.e.players.get('a')!;
    const held = new Set(a.paths.flatMap((q) => q.steps.map((s) => s.tile)));
    const rule = randomCleanRule('hex', mulberry32(11));
    const plan = planRegrow(HEX, chordTableFor(HEX, rule), held, a.score, knobs);
    const bought = [...plan.kept, ...(plan.stretch ? [plan.stretch] : [])];
    expect(bought.length).toBeGreaterThan(1);
    plain.store.handle({ t: 'events', ev: plain.e.setRule('a', rule) });
    const ev2 = packed.e.setRule('a', rule);
    packed.store.handle({ t: 'events', ev: packEvents(HEX, ev2, (o, p) => packed.e.players.get(o)?.patterns[p]?.table) });
    const pt = (q: { x: number; y: number }) => key(q);
    const want = bought.map((q) => ({ pts: [...q.steps.map((s) => s.a), q.steps[q.steps.length - 1].b].map(pt), kind: q.closed ? (q.region ? 2 : 1) : 0 }));
    for (const store of [plain.store, packed.store]) {
      expect(store.coalesce).toHaveLength(1);
      const got = store.coalesce[0].ghost.map((g) => ({ pts: g.pts.map(pt), kind: g.kind }));
      expect(got).toEqual(want);
    }
    // Loops close on themselves: the walk comes back to where it began.
    for (const g of plain.store.coalesce[0].ghost.filter((q) => q.kind === 1)) expect(pt(g.pts[g.pts.length - 1])).toBe(pt(g.pts[0]));
  });

  it('motesPerTile splits in proportion, rounds to whole motes, and drops what was lost', () => {
    expect(motesPerTile([0.5, 0.25, 0.25], 8)).toEqual([4, 2, 2]);
    // Only 60% bought: 6 of 10 motes land, 3:1:2.
    expect(motesPerTile([0.3, 0.1, 0.2], 10)).toEqual([3, 1, 2]);
    // A stretch takes the budget past 1: every mote lands.
    expect(motesPerTile([1.5, 0.5], 4)).toEqual([3, 1]);
    const r = motesPerTile([1 / 3, 1 / 3, 1 / 3], 10);
    expect(r.reduce((x, y) => x + y, 0)).toBe(10);
    expect(Math.max(...r) - Math.min(...r)).toBeLessThanOrEqual(1);
    expect(motesPerTile([], 5)).toEqual([]);
  });

  it('flow fills each target to its room, nearest pairs first', () => {
    const from = [0, 1, 2, 3, 10, 11].map((x) => ({ x, y: 0 }));
    const to = [{ x: 0, y: 0 }, { x: 11, y: 0 }];
    // Room for 4 at the left and 1 at the right: 0–3 fill the left, 11 takes the right,
    // and 10 finds both full — its energy is lost.
    const out = flow(from, to, [4, 1]);
    expect(out.filter((q) => q?.x === 0)).toHaveLength(4);
    expect(out.filter((q) => q?.x === 11)).toHaveLength(1);
    expect(out[5]).toEqual({ x: 11, y: 0 });
    expect(out.filter((q) => q === null)).toHaveLength(1);
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
