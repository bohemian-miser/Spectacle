import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { planRegrow } from '../shared/game/regrow';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, randomCleanRule, ruleFromCombo } from '../shared/game/rule';
import { chordTableFor, tileChords, walkStrand } from '../shared/game/strand';

const SPEC = { family: 'spectre', level: 3, rootTile: 'Delta' } as const;
const FIELD = buildField(SPEC);
const HEX = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
const SEL15 = ruleFromCombo('spectre', '15', '0000000000');

/** The tiles `id`'s lines are on, counted from the paths themselves. */
function held(e: Engine, id: string): number {
  const tiles = new Set<number>();
  for (const q of e.players.get(id)!.paths) for (const s of q.steps) tiles.add(s.tile);
  return tiles.size;
}

describe('scoreTiles: the score is the tiles you control', () => {
  for (const mode of ['conquest', 'normal'] as const) {
    it(`matches every player's tiles after every tick of a busy game, and the client agrees (${mode})`, () => {
      // Bots holding several patterns in conquest: flips, splits, joins, takes; normal: conversions.
      const knobs: Knobs = { ...DEFAULT_KNOBS, mode, maxHeads: 0 };
      const e = new Engine(FIELD, knobs, mulberry32(3));
      const rng = mulberry32(4);
      const bots = new Bots(e, mulberry32(5), 0.1);
      const store = new Store();
      store.handle({ t: 'welcome', you: 'viewer', token: '', field: SPEC, knobs, players: [], paths: [] });
      store.handle({ t: 'events', ev: bots.add(4, 0) });
      if (mode === 'conquest') {
        for (const p of e.players.values()) {
          for (let k = 0; k < 3; k++) {
            const rule = randomCleanRule('spectre', rng);
            p.patterns.push({ rule, table: chordTableFor(FIELD, rule), color: p.color });
          }
        }
      }
      const seen = { cuts: 0, moves: 0, circuits: 0, max: 0 };
      let now = 0;
      for (let t = 0; t < 2500; t++) {
        now += knobs.tickMs;
        const ev: GameEvent[] = [];
        bots.update(now, ev);
        ev.push(...e.tick(knobs.tickMs));
        store.handle({ t: 'events', ev });
        for (const x of ev) {
          if (x.t === 'wipe' && x.by) seen.cuts++;
          if (x.t === 'take' || x.t === 'convert') seen.moves++;
          if (x.t === 'circuit') {
            seen.circuits++;
            expect(x.bonus).toBe(0);
          }
        }
        for (const p of e.players.values()) {
          const n = held(e, p.id);
          expect(p.score, `${p.name} at tick ${t}`).toBe(n);
          expect(e.tilesHeld(p.id)).toBe(n);
          expect(store.players.get(p.id)?.score, `${p.name} on the client at tick ${t}`).toBe(n);
          seen.max = Math.max(seen.max, n);
        }
      }
      // The game really did cut, move and close things.
      expect(seen.circuits).toBeGreaterThan(0);
      expect(seen.cuts).toBeGreaterThan(0);
      expect(seen.max).toBeGreaterThan(20);
      if (mode === 'conquest') expect(seen.moves).toBeGreaterThan(0);
    });
  }

  it('a tap scores its tile and a circuit pays no bonus', () => {
    const e = new Engine(FIELD, DEFAULT_KNOBS, mulberry32(1));
    e.addPlayer('a', 'Ann', SEL15);
    const table = chordTableFor(FIELD, SEL15);
    let tile = -1;
    let length = 0;
    for (let i = 0; i < FIELD.count && tile < 0; i++) {
      if (tileChords(FIELD, table, i).length === 0) continue;
      const w = walkStrand(FIELD, table, i, 0, 1);
      if (w.closed) [tile, length] = [i, w.steps.length];
    }
    const tap = e.tap('a', tile, tileCenter(FIELD, tile));
    expect(tap.result.ok).toBe(true);
    expect(tap.events.filter((x) => x.t === 'score')).toEqual([{ t: 'score', id: 'a', score: 1, combo: DEFAULT_KNOBS.comboStart }]);
    const ev: GameEvent[] = [];
    for (let t = 0; t < 4000 && !ev.some((x) => x.t === 'circuit'); t++) ev.push(...e.tick(DEFAULT_KNOBS.tickMs));
    const circuit = ev.find((x) => x.t === 'circuit');
    expect(circuit).toMatchObject({ bonus: 0, length });
    expect(e.players.get('a')!.score).toBe(held(e, 'a'));
    // Closing sends no score event of its own: the last tile already counted.
    const last = ev.filter((x) => x.t === 'score').at(-1);
    expect(last).toMatchObject({ score: held(e, 'a') });
  });

  it('leaving sends wipe, score, leave', () => {
    const e = new Engine(FIELD, DEFAULT_KNOBS, mulberry32(1));
    e.addPlayer('a', 'Ann', SEL15);
    const table = chordTableFor(FIELD, SEL15);
    const tile = [...Array(FIELD.count).keys()].find((i) => tileChords(FIELD, table, i).length > 0)!;
    e.tap('a', tile, tileCenter(FIELD, tile));
    expect(e.removePlayer('a').map((x) => x.t)).toEqual(['wipe', 'score', 'leave']);
  });

  it('a new rule budgets in tiles: laid on no more tiles than were held, regrown to the plan', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0, regrowDiscount: 1 };
    const e = new Engine(HEX, knobs, mulberry32(1));
    const rule = defaultRule('hex');
    e.addPlayer('a', 'Ann', rule);
    const table = chordTableFor(HEX, rule);
    for (let i = 0, n = 0; i < HEX.count && n < 40; i += 7) {
      if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
      if (e.tap('a', i, tileCenter(HEX, i)).result.ok) n++;
    }
    for (let t = 0; t < 4000; t++) e.tick(knobs.tickMs);
    const a = e.players.get('a')!;
    const before = a.score;
    expect(before).toBe(held(e, 'a'));
    const tiles = new Set(a.paths.flatMap((q) => q.steps.map((s) => s.tile)));
    const rng = mulberry32(7);
    let checked = 0;
    for (let k = 0; k < 6; k++) {
      const next = randomCleanRule('hex', rng);
      const plan = planRegrow(HEX, chordTableFor(HEX, next), tiles, before, knobs);
      // Prices are tiles: a circuit costs the tiles it runs through, no bonus.
      for (const q of [...plan.kept, ...plan.skipped]) expect(q.price).toBe(new Set(q.steps.map((s) => s.tile)).size);
      expect(plan.spent).toBeLessThanOrEqual(before);
      if (!plan.stretch) expect(plan.outcome).toBeLessThanOrEqual(before);
      checked++;
    }
    expect(checked).toBe(6);
    // One switch played out.
    const next = randomCleanRule('hex', mulberry32(11));
    const plan = planRegrow(HEX, chordTableFor(HEX, next), tiles, before, knobs);
    e.setRule('a', next);
    expect(a.score).toBeLessThanOrEqual(before);
    for (let t = 0; t < 20_000 && a.paths.some((q) => q.status === 'growing'); t++) e.tick(knobs.tickMs);
    expect(a.score).toBe(held(e, 'a'));
    expect(a.score).toBe(plan.outcome);
  });
});
