import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Engine } from '../shared/game/engine';
import { buildField, pointInPolygon, tileCenter, type Field } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { planRegrow } from '../shared/game/regrow';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, randomCleanRule, type PlayerRule } from '../shared/game/rule';
import { chordTableFor, tileChords, walkStrand } from '../shared/game/strand';

const HEX = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
const SPECTRE = buildField({ family: 'spectre', level: 3, rootTile: 'Delta' });
const KNOBS: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };

/** Ann alone on the board with `taps` lines of the default rule (a tile every `stride`), all grown out. */
function territory(field: Field, seed: number, knobs: Knobs = KNOBS, taps = 40, stride = 7): { e: Engine; ev: GameEvent[] } {
  const e = new Engine(field, knobs, mulberry32(seed));
  const ev: GameEvent[] = [];
  const rule = defaultRule(field.family);
  ev.push(...e.addPlayer('a', 'Ann', rule));
  const table = chordTableFor(field, rule);
  for (let i = 0, n = 0; i < field.count && n < taps; i += stride) {
    if (tileChords(field, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
    const r = e.tap('a', i, tileCenter(field, i));
    ev.push(...r.events);
    if (r.result.ok) n++;
  }
  for (let t = 0; t < 4000; t++) ev.push(...e.tick(knobs.tickMs));
  return { e, ev };
}

function heldTiles(e: Engine, id: string): Set<number> {
  const tiles = new Set<number>();
  for (const q of e.players.get(id)!.paths) for (const s of q.steps) tiles.add(s.tile);
  return tiles;
}

/** Tick until nothing of `id`'s is growing; returns the events and the highest score seen. */
function settle(e: Engine, id: string, ev: GameEvent[] = []): { ev: GameEvent[]; max: number } {
  const p = e.players.get(id)!;
  let max = p.score;
  for (let t = 0; t < 20_000 && p.paths.some((q) => q.status === 'growing'); t++) {
    ev.push(...e.tick(KNOBS.tickMs));
    max = Math.max(max, p.score);
  }
  return { ev, max };
}

// Pairs whose plans exercise both sides: everything affordable, and a budget that runs out.
const CASES: { name: string; field: Field; seed: number; rule: () => PlayerRule }[] = [
  { name: 'hex, all affordable', field: HEX, seed: 1, rule: () => nthRule('hex', 1) },
  { name: 'hex, budget runs out', field: HEX, seed: 3, rule: () => nthRule('hex', 3) },
  { name: 'spectre, budget runs out', field: SPECTRE, seed: 3, rule: () => nthRule('spectre', 3) },
];

/** The `n`th random clean rule from a fixed stream (so the cases stay put). */
function nthRule(family: 'hex' | 'spectre', n: number): PlayerRule {
  const rng = mulberry32(7);
  let rule = randomCleanRule(family, rng);
  for (let k = 0; k < n; k++) rule = randomCleanRule(family, rng);
  return rule;
}

describe('regrowOnRule', () => {
  for (const c of CASES) {
    it(`on an untouched board the score comes back to what the plan bought (${c.name})`, () => {
      const { e } = territory(c.field, c.seed);
      const a = e.players.get('a')!;
      const before = a.score;
      expect(before).toBeGreaterThan(0);
      const rule = c.rule();
      const plan = planRegrow(c.field, chordTableFor(c.field, rule), heldTiles(e, 'a'), before, KNOBS);
      expect(plan.kept.length).toBeGreaterThan(0);

      const bought = [...plan.kept, ...(plan.stretch ? [plan.stretch] : [])];
      expect(plan.outcome).toBe(bought.reduce((n, q) => n + q.price, 0));

      e.setRule('a', rule);
      // Only the circuits' tiles you already held are yours straight away.
      expect(a.score).toBeLessThan(plan.outcome);
      const { max } = settle(e, 'a');

      expect(a.score).toBe(plan.outcome);
      expect(max).toBe(plan.outcome);
      // Past the old score only by what the stretch circuit is worth beyond its held tiles.
      if (plan.stretch) expect(plan.outcome - before).toBeLessThanOrEqual(plan.stretch.price - plan.stretch.seeds.length);
      else expect(a.score).toBeLessThanOrEqual(before);
      // Every bought circuit closed, and nothing else is left.
      expect(a.paths.every((q) => q.status === 'closed')).toBe(true);
      expect(a.paths).toHaveLength(bought.length);
      expect(a.paths.map((q) => q.steps.length).sort((x, y) => x - y)).toEqual(bought.map((q) => q.length).sort((x, y) => x - y));
      // Zero-sum bookkeeping: the score is exactly what the lines carry.
      expect(a.score).toBe(a.paths.reduce((n, q) => n + q.points, 0));
      // Bought circuits close at the starting combo and don't feed the streak.
      expect(a.combo).toBe(KNOBS.comboStart);
    });
  }

  // A few tiles, and the new rule's longest circuit through them would close
  // off a third of the board: far more than the score. Other, cheaper
  // circuits run through the tiles too, so it isn't even the stretch: it is
  // skipped, and the budget goes to the circuits it does cover.
  for (const c of [
    { name: 'hex', field: HEX, rule: () => nthRule('hex', 10) },
    { name: 'spectre', field: SPECTRE, rule: () => nthRule('spectre', 22) },
  ]) {
    it(`skips a giant it can't afford when cheaper circuits are there (${c.name})`, () => {
      const { e } = territory(c.field, 1, KNOBS, 3, 97);
      const a = e.players.get('a')!;
      const before = a.score;
      const tiles = heldTiles(e, 'a');
      expect(tiles.size).toBeLessThan(12);
      const rule = c.rule();
      const table = chordTableFor(c.field, rule);
      const longest = planRegrow(c.field, table, tiles, 1e9, KNOBS).kept[0];
      expect(longest.price).toBeGreaterThan(before);
      expect(longest.area).toBeGreaterThan(c.field.count / 3);
      const plan = planRegrow(c.field, table, tiles, before, KNOBS);
      const bought = [...plan.kept, ...(plan.stretch ? [plan.stretch] : [])];
      expect(plan.kept.length).toBeGreaterThan(0);
      expect(bought.every((q) => q.length < longest.length)).toBe(true);
      // What was bought has to grow out of the held tiles to close.
      expect(bought.some((q) => q.steps.some((s) => !tiles.has(s.tile)))).toBe(true);

      e.setRule('a', rule);
      settle(e, 'a');
      const chord = (s: { tile: number; chord: number }) => s.tile * 64 + s.chord;
      const big = new Set(longest.steps.map(chord));
      expect(a.paths.some((q) => q.steps.some((s) => big.has(chord(s))))).toBe(false);
      expect(a.paths.every((q) => q.status === 'closed')).toBe(true);
      expect(a.paths).toHaveLength(bought.length);
      expect(a.score).toBe(plan.outcome);
      expect(a.score).toBeGreaterThan(0);
    });
  }

  it('a few tiles on one giant circuit get the giant, for just the tiles they hold', () => {
    // One short line (3 tiles, 16 points). Under the new rule those tiles lie
    // on a single loop round 37% of the board, worth 679 closed: nothing is
    // affordable, but its 4 held chords cost 4 points, so it is the stretch.
    const { e } = territory(HEX, 1, KNOBS, 1, 97);
    const a = e.players.get('a')!;
    const before = a.score;
    const tiles = heldTiles(e, 'a');
    const rule = nthRule('hex', 22);
    const plan = planRegrow(HEX, chordTableFor(HEX, rule), tiles, before, KNOBS);
    expect(plan.kept).toHaveLength(0);
    const giant = plan.stretch!;
    expect(giant).toBeDefined();
    expect(giant.price).toBeGreaterThan(10 * before);
    expect(giant.area).toBeGreaterThan(HEX.count / 3);
    expect(giant.seeds.length * KNOBS.pointsPerTile).toBeLessThanOrEqual(before);
    expect(plan.spent).toBe(giant.seeds.length * KNOBS.pointsPerTile);
    expect(plan.outcome).toBe(giant.price);

    e.setRule('a', rule);
    // Straight away: just the held chords, a point each.
    expect(a.score).toBe(giant.seeds.length * KNOBS.pointsPerTile);
    settle(e, 'a');
    // Nobody in the way: it grows all the way round and closes.
    expect(a.paths).toHaveLength(1);
    expect(a.paths[0].status).toBe('closed');
    expect(a.paths[0].steps).toHaveLength(giant.length);
    expect(a.score).toBe(giant.price);
  });

  it('no stretch when the budget left cannot cover the held tiles of the cheapest too-dear circuit', () => {
    const { e } = territory(HEX, 1, KNOBS, 1, 97);
    const tiles = heldTiles(e, 'a');
    const table = chordTableFor(HEX, nthRule('hex', 22));
    const held = planRegrow(HEX, table, tiles, 1e9, KNOBS).kept[0].seeds.length * KNOBS.pointsPerTile;
    expect(planRegrow(HEX, table, tiles, held, KNOBS).stretch).toBeDefined();
    const short = planRegrow(HEX, table, tiles, held - 1, KNOBS);
    expect(short.stretch).toBeUndefined();
    expect(short.kept).toHaveLength(0);
    expect(short.outcome).toBe(0);
  });

  it('lays the new rule only on tiles the old lines held, and only the circuits it could afford', () => {
    const { e } = territory(SPECTRE, 3);
    const tiles = heldTiles(e, 'a');
    const rule = nthRule('spectre', 3);
    const plan = planRegrow(SPECTRE, chordTableFor(SPECTRE, rule), tiles, e.players.get('a')!.score, KNOBS);
    expect(plan.skipped.length).toBeGreaterThan(0);
    const seeds = new Set([...plan.kept, ...(plan.stretch ? [plan.stretch] : [])].flatMap((q) => q.seeds));
    const ev = e.setRule('a', rule);
    const steps = ev.filter((x) => x.t === 'step');
    expect(steps.length).toBeGreaterThan(0);
    for (const x of steps) {
      if (x.t !== 'step') continue;
      expect(tiles.has(x.step.tile)).toBe(true);
      expect(seeds.has(x.step.tile * 64 + x.step.chord)).toBe(true);
    }
    // The old lines go first, then the rule, then the new lines.
    const types = ev.map((x) => x.t);
    expect(types.lastIndexOf('wipe')).toBeLessThan(types.indexOf('rule'));
    expect(types.indexOf('rule')).toBeLessThan(types.indexOf('step'));
  });

  it('buys circuits longest first and skips only what the budget left cannot cover', () => {
    const { e } = territory(SPECTRE, 3);
    const tiles = heldTiles(e, 'a');
    const table = chordTableFor(SPECTRE, nthRule('spectre', 3));
    const full = planRegrow(SPECTRE, table, tiles, 1e9, KNOBS);
    expect(full.skipped).toHaveLength(0);
    const all = full.kept;
    expect(all.length).toBeGreaterThan(3);
    for (const budget of [0, all[all.length - 1].price, Math.floor(full.spent / 3), full.spent - 1, full.spent]) {
      const plan = planRegrow(SPECTRE, table, tiles, budget, KNOBS);
      const held = plan.stretch ? plan.stretch.seeds.length * KNOBS.pointsPerTile : 0;
      expect(plan.spent).toBe(plan.kept.reduce((n, q) => n + q.price, 0) + held);
      expect(plan.spent).toBeLessThanOrEqual(budget);
      // Replay the greedy walk over every circuit there is, longest first:
      // each is bought exactly when what is left covers it.
      let left = budget;
      const kept = new Set(plan.kept.map((q) => q.seeds[0]));
      for (const q of all) {
        if (kept.has(q.seeds[0])) {
          expect(q.price).toBeLessThanOrEqual(left);
          left -= q.price;
        } else expect(q.price).toBeGreaterThan(left);
      }
      expect(plan.kept.length).toBe(kept.size);
      // The stretch: the cheapest of the rest, when what is left covers its held tiles.
      const rest = all.filter((q) => !kept.has(q.seeds[0]));
      const cheapest = rest.reduce<(typeof rest)[number] | undefined>((m, q) => (!m || q.price < m.price ? q : m), undefined);
      if (cheapest && cheapest.seeds.length * KNOBS.pointsPerTile <= left) {
        expect(plan.stretch?.seeds[0]).toBe(cheapest.seeds[0]);
        expect(plan.outcome).toBe(budget - left + cheapest.price);
      } else {
        expect(plan.stretch).toBeUndefined();
        expect(plan.outcome).toBe(plan.spent);
      }
    }
    expect(planRegrow(SPECTRE, table, tiles, full.spent, KNOBS).skipped).toHaveLength(0);
    expect(planRegrow(SPECTRE, table, tiles, full.spent, KNOBS).stretch).toBeUndefined();
    expect(planRegrow(SPECTRE, table, tiles, 0, KNOBS).kept).toHaveLength(0);
  });

  it('a circuit regrowing into a rival is cut like any line, and its price is lost', () => {
    const { e } = territory(HEX, 1);
    const a = e.players.get('a')!;
    const rule = nthRule('hex', 1);
    const table = chordTableFor(HEX, rule);
    const tiles = heldTiles(e, 'a');
    const plan = planRegrow(HEX, table, tiles, a.score, KNOBS);
    // A circuit that starts again as one piece and has to grow out of Ann's
    // tiles to close. (With several, the others would regrow through the gap
    // a collision leaves and close it anyway.)
    const runs = (q: (typeof plan.kept)[number]): number =>
      q.steps.filter((s, i) => tiles.has(s.tile) && !tiles.has(q.steps[(i + q.steps.length - 1) % q.steps.length].tile)).length;
    const target = plan.kept.find((q) => !q.region && runs(q) === 1 && q.steps.some((s) => !tiles.has(s.tile)));
    expect(target).toBeDefined();
    // Bea's line sits on a tile of it Ann never held, on its very chord.
    e.addPlayer('b', 'Bea', rule);
    const out = target!.steps.find((s) => !tiles.has(s.tile) && e.pathsOn(s.tile).length === 0)!;
    const mid = { x: (out.a.x + out.b.x) / 2, y: (out.a.y + out.b.y) / 2 };
    expect(e.tap('b', out.tile, mid).result.ok).toBe(true);
    e.setRule('a', rule);
    const { ev } = settle(e, 'a');
    // They meet: whoever hits, both lines go (mutual cut).
    expect(ev.some((x) => x.t === 'wipe' && x.owner === 'a' && x.by !== undefined)).toBe(true);
    const closed = a.paths.filter((q) => q.status === 'closed');
    expect(closed.some((q) => q.steps.some((s) => s.tile === out.tile))).toBe(false);
    expect(closed.length).toBe(plan.kept.length - 1);
    expect(a.score).toBe(plan.outcome - target!.price);
    expect(a.score).toBe(a.paths.reduce((n, q) => n + q.points, 0));
  });

  it('a regrown circuit captures what it closes round, on top of what it cost', () => {
    const { e } = territory(HEX, 1);
    const a = e.players.get('a')!;
    const rule = nthRule('hex', 1);
    const tiles = heldTiles(e, 'a');
    const plan = planRegrow(HEX, chordTableFor(HEX, rule), tiles, a.score, KNOBS);
    e.setRule('a', rule);
    // Bea draws a small loop inside a bought circuit still regrowing, clear of everything.
    const growing = new Set(a.paths.filter((q) => q.status === 'growing').flatMap((q) => q.steps.map((s) => s.tile * 64 + s.chord)));
    const loops = plan.kept
      .filter((q) => !q.region && q.steps.some((s) => growing.has(s.tile * 64 + s.chord)))
      .sort((x, y) => y.area - x.area);
    // Clear of every bought circuit's tiles, and round none of them.
    const bought = plan.kept.flatMap((q) => q.steps);
    const boughtTiles = new Set(bought.map((s) => s.tile));
    let bea: number | null = null;
    const rng = mulberry32(11);
    for (let k = 0; k < 40 && bea === null; k++) {
      const bRule = randomCleanRule('hex', rng);
      const bTable = chordTableFor(HEX, bRule);
      for (const q of loops) {
        const poly = q.steps.map((s) => s.a);
        for (let i = 0; i < HEX.count && bea === null; i++) {
          if (tileChords(HEX, bTable, i).length === 0 || !pointInPolygon(tileCenter(HEX, i), poly)) continue;
          const w = walkStrand(HEX, bTable, i, 0, 1, 30);
          if (!w.closed) continue;
          const inner = w.steps.map((s) => s.a);
          const clear =
            w.steps.every(
              (s) => !boughtTiles.has(s.tile) && e.pathsOn(s.tile).length === 0 && pointInPolygon({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, poly),
            ) && !bought.some((s) => pointInPolygon(s.a, inner));
          if (!clear) continue;
          if (!e.players.has('b')) e.addPlayer('b', 'Bea', bRule);
          else e.setRule('b', bRule);
          if (e.tap('b', i, tileCenter(HEX, i)).result.ok) bea = i;
        }
        if (bea !== null) break;
      }
    }
    expect(bea).not.toBeNull();
    const { ev } = settle(e, 'a');
    const b = e.players.get('b')!;
    expect(ev.some((x) => x.t === 'take' && x.owner === 'a' && x.from === 'b')).toBe(true);
    expect(b.paths).toHaveLength(0);
    // Ann holds what she bought plus Bea's loop and the points it carried.
    expect(a.score).toBeGreaterThan(plan.outcome);
    expect(a.score).toBe(a.paths.reduce((n, q) => n + q.points, 0));
  });

  it('off, a new rule starts from nothing as before', () => {
    const knobs = { ...KNOBS, regrowOnRule: false };
    const { e } = territory(HEX, 1, knobs);
    const ev = e.setRule('a', nthRule('hex', 1));
    expect(ev.some((x) => x.t === 'step')).toBe(false);
    expect(e.players.get('a')!.paths).toHaveLength(0);
    expect(e.players.get('a')!.score).toBe(0);
  });

  it('a client applying the event stream ends up with exactly the engine’s lines', () => {
    const spec = { family: 'spectre', level: 3, rootTile: 'Delta' } as const;
    const { e, ev } = territory(SPECTRE, 3);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs: KNOBS, players: [], paths: [] });
    store.handle({ t: 'events', ev });
    const after = e.setRule('a', nthRule('spectre', 3));
    settle(e, 'a', after);
    store.handle({ t: 'events', ev: after });
    const key = (owner: string, status: string, steps: readonly { tile: number; chord: number }[]) =>
      `${owner} ${status} ${steps.map((s) => `${s.tile}.${s.chord}`).join(' ')}`;
    const engine = new Map<number, string>();
    for (const q of e.players.get('a')!.paths) engine.set(q.id, key(q.owner, q.status, q.steps));
    const client = new Map<number, string>();
    for (const q of store.paths.values()) client.set(q.id, key(q.owner, q.status, q.steps));
    expect(client).toEqual(engine);
    expect(store.players.get('a')!.score).toBe(e.players.get('a')!.score);
  });
});
