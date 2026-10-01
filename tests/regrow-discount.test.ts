import { describe, expect, it } from 'vitest';
import { Engine } from '../shared/game/engine';
import { buildField, tileCenter, type Field } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import { planRegrow, type RegrowCircuit } from '../shared/game/regrow';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, randomCleanRule, type PlayerRule } from '../shared/game/rule';
import { chordTableFor, tileChords } from '../shared/game/strand';

const HEX = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
const SPECTRE = buildField({ family: 'spectre', level: 3, rootTile: 'Delta' });
const KNOBS: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };

/** Ann alone with `taps` default-rule lines, a tile every `stride`, grown out. */
function territory(field: Field, knobs: Knobs, taps: number, stride: number): Engine {
  const e = new Engine(field, knobs, mulberry32(1));
  const rule = defaultRule(field.family);
  e.addPlayer('a', 'Ann', rule);
  const table = chordTableFor(field, rule);
  for (let i = 0, n = 0; i < field.count && n < taps; i += stride) {
    if (tileChords(field, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
    if (e.tap('a', i, tileCenter(field, i)).result.ok) n++;
  }
  for (let t = 0; t < 4000; t++) e.tick(knobs.tickMs);
  return e;
}

const held = (e: Engine): Set<number> => new Set(e.players.get('a')!.paths.flatMap((q) => q.steps.map((s) => s.tile)));

function nthRule(family: 'hex' | 'spectre', n: number): PlayerRule {
  const rng = mulberry32(7);
  let rule = randomCleanRule(family, rng);
  for (let k = 0; k < n; k++) rule = randomCleanRule(family, rng);
  return rule;
}

/** The cost, the slow way: each tile not held at g ** (steps to the nearest held one, either way). */
function bruteCost(q: RegrowCircuit, tiles: ReadonlySet<number>, g: number): number {
  const n = q.steps.length;
  const loop = q.closed && !q.region;
  const best = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let d = Infinity;
    for (let j = 0; j < n; j++) {
      if (!tiles.has(q.steps[j].tile)) continue;
      const k = Math.abs(i - j);
      d = Math.min(d, loop ? Math.min(k, n - k) : k);
    }
    const t = q.steps[i].tile;
    best.set(t, Math.max(best.get(t) ?? 0, g ** d));
  }
  return [...best.values()].reduce((x, y) => x + y, 0);
}

describe('regrowDiscount', () => {
  for (const c of [
    { name: 'hex', family: 'hex' as const, field: HEX, rules: [1, 3, 10] },
    { name: 'spectre', family: 'spectre' as const, field: SPECTRE, rules: [3, 22] },
  ]) {
    it(`a tile not held costs 0.99 ** its distance from the held ones (${c.name})`, () => {
      const e = territory(c.field, KNOBS, 6, 61);
      const tiles = held(e);
      for (const n of c.rules) {
        const table = chordTableFor(c.field, nthRule(c.family, n));
        const plan = planRegrow(c.field, table, tiles, 1e9, KNOBS);
        expect(plan.kept.length).toBeGreaterThan(0);
        for (const q of plan.kept) {
          expect(q.cost).toBeCloseTo(bruteCost(q, tiles, 0.99), 6);
          expect(q.cost).toBeLessThanOrEqual(q.price);
          expect(q.cost).toBeGreaterThanOrEqual(new Set(q.seeds.map((k) => Math.floor(k / 64))).size);
        }
        // Off, cost is price.
        for (const q of planRegrow(c.field, table, tiles, 1e9, { ...KNOBS, regrowDiscount: 1 }).kept) expect(q.cost).toBe(q.price);
      }
    });
  }

  it('the same budget buys more, and an untouched board grows out to the plan', () => {
    const e = territory(HEX, KNOBS, 40, 7);
    const a = e.players.get('a')!;
    const before = a.score;
    const tiles = held(e);
    const rule = nthRule('hex', 14);
    const table = chordTableFor(HEX, rule);
    const flat = planRegrow(HEX, table, tiles, before, { ...KNOBS, regrowDiscount: 1 });
    const plan = planRegrow(HEX, table, tiles, before, KNOBS);
    expect(plan.spent).toBeLessThanOrEqual(before);
    expect(plan.outcome).toBeGreaterThan(flat.outcome);
    e.setRule('a', rule);
    for (let t = 0; t < 40_000 && a.paths.some((q) => q.status === 'growing'); t++) e.tick(KNOBS.tickMs);
    expect(a.score).toBe(plan.outcome);
  });

  it('the cost of a gap is bounded however long the circuit', () => {
    const e = territory(HEX, KNOBS, 1, 97);
    const tiles = held(e);
    for (let n = 0; n < 20; n++) {
      const plan = planRegrow(HEX, chordTableFor(HEX, nthRule('hex', n)), tiles, 1e9, KNOBS);
      for (const q of plan.kept) {
        const seeds = new Set(q.seeds.map((k) => Math.floor(k / 64))).size;
        // Each run between held tiles is a geometric series both ways: under 2 / (1 - g).
        expect(q.cost).toBeLessThan(seeds + (2 * seeds * 0.99) / 0.01 + 1e-6);
      }
    }
  });
});
