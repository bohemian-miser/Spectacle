import { describe, expect, it } from 'vitest';
import { flipOrder, flippedBy } from '../client/src/celebration';
import { Store } from '../client/src/store';
import { Bots, botTuningOf, BUILTIN_BRAINS } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, DEFAULT_FIELD_SPEC, tileNeighbours } from '../shared/game/field';
import { applyTuning, DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { fassRule } from '../shared/game/rule';
import { chordTableFor, tileChords, walkStrand } from '../shared/game/strand';

const SPEC = { family: 'hex', level: 3, rootTile: 'Psi' } as const;
const FIELD = buildField(SPEC);

describe('winning a round', () => {
  it('covering winFraction of the board wins: play holds still, then a fresh board with the same players', () => {
    // A small fraction, so a bot game gets there in a few seconds.
    const knobs: Knobs = { ...DEFAULT_KNOBS, mode: 'normal', winFraction: 0.05, winCelebrateMs: 2000 };
    const e = new Engine(FIELD, knobs, mulberry32(1));
    const bots = new Bots(e, mulberry32(2), 0.1);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: SPEC, knobs, players: [], paths: [] });
    store.handle({ t: 'events', ev: bots.add(3, 0) });
    const ids = [...e.players.keys()];
    let now = 0;
    let won: Extract<GameEvent, { t: 'win' }> | null = null;
    let wonAt = 0;
    let restarted = false;
    for (let t = 0; t < 4000 && !restarted; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      store.handle({ t: 'events', ev });
      for (const x of ev) {
        if (x.t === 'win') {
          expect(won).toBeNull();
          won = x;
          wonAt = now;
          expect(x.of).toBe(FIELD.count);
          expect(x.tiles).toBeGreaterThanOrEqual(Math.ceil(0.05 * FIELD.count));
          expect(e.tilesControlled(x.id)).toBe(x.tiles);
          expect(e.tilesControlled(x.id)).toBeGreaterThanOrEqual(e.tilesHeld(x.id));
          // The tail is on one of the winner's lines.
          expect(e.players.get(x.id)!.paths.some((q) => q.steps.some((s) => s.tile === x.tail))).toBe(true);
          expect(e.winner).toBe(x.id);
          expect(store.win?.id).toBe(x.id);
          // No tapping now.
          const r = e.tap(ids[0], 0, { x: 0, y: 0 });
          expect(r.result.ok).toBe(false);
        } else if (x.t === 'restart') {
          restarted = true;
          expect(now - wonAt).toBeGreaterThanOrEqual(knobs.winCelebrateMs);
          expect(x.players.map((p) => p.id).sort()).toEqual([...ids].sort());
        } else if (won) {
          // Between the win and the restart, nothing moves.
          throw new Error(`event ${x.t} while the round was won`);
        }
      }
    }
    expect(won).not.toBeNull();
    expect(restarted).toBe(true);
    expect(e.winner).toBeNull();
    for (const p of e.players.values()) {
      expect(p.paths).toEqual([]);
      expect(p.score).toBe(0);
      expect(p.patterns.length).toBe(1);
      expect(e.tilesHeld(p.id)).toBe(0);
      expect(e.tilesControlled(p.id)).toBe(0);
    }
    expect(store.paths.size).toBe(0);
    expect(store.occupancy.size).toBe(0);
    for (const p of store.players.values()) expect(p.score).toBe(0);
    // The celebration fades on over the fresh board; the renderer drops it.
    expect(store.win?.restartAt).toBeDefined();
    // …and play goes on: the bots start again.
    let steps = 0;
    for (let t = 0; t < 200; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      steps += ev.filter((x) => x.t === 'step').length;
    }
    expect(steps).toBeGreaterThan(0);
  });

  it('control counts the free tiles inside your circuits too, and the client is told', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, mode: 'normal', winFraction: 0 };
    const e = new Engine(FIELD, knobs, mulberry32(5));
    const bots = new Bots(e, mulberry32(6), 0.1);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: SPEC, knobs, players: [], paths: [] });
    store.handle({ t: 'events', ev: bots.add(2, 0) });
    let now = 0;
    let inside = 0;
    for (let t = 0; t < 3000; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      store.handle({ t: 'events', ev });
      if (!ev.some((x) => x.t === 'cover')) continue;
      for (const p of e.players.values()) {
        const c = e.tilesControlled(p.id);
        // Never less than the tiles its lines are on, never more than the board.
        expect(c).toBeGreaterThanOrEqual(e.tilesHeld(p.id));
        expect(c).toBeLessThanOrEqual(FIELD.count);
        inside = Math.max(inside, c - e.tilesHeld(p.id));
        expect(store.players.get(p.id)!.cover).toBe(c);
      }
    }
    // Circuits closed round free tiles at some point.
    expect(inside).toBeGreaterThan(0);
  });

  it('a lone bot on a live-tuned board wins in the end (its lines alone stall short of 90%)', () => {
    const knobs: Knobs = { ...applyTuning(DEFAULT_KNOBS, BUILTIN_BRAINS.tuning).knobs, mode: 'normal' };
    expect(knobs.winFraction).toBe(0.9);
    const e = new Engine(FIELD, knobs, mulberry32(3));
    const bots = new Bots(e, mulberry32(4), undefined, botTuningOf(BUILTIN_BRAINS));
    bots.add({ wanderer: 1 }, 0);
    let now = 0;
    let won = false;
    for (let t = 0; t < (15 * 60_000) / knobs.tickMs && !won; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      won = ev.some((x) => x.t === 'win');
    }
    expect(won).toBe(true);
  });

  it('winFraction 0 never wins', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, mode: 'normal', winFraction: 0 };
    const e = new Engine(FIELD, knobs, mulberry32(1));
    const bots = new Bots(e, mulberry32(2), 0.1);
    bots.add(3, 0);
    let now = 0;
    for (let t = 0; t < 600; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      expect(ev.some((x) => x.t === 'win')).toBe(false);
    }
  });
});

describe('the celebration: the infinite line flips the board', () => {
  it('the default board is rooted at Psi, where the infinite-line rule is one single line through every tile', () => {
    expect(DEFAULT_FIELD_SPEC.rootTile).toBe('Psi');
    const table = chordTableFor(FIELD, fassRule('hex'));
    const walk = walkStrand(FIELD, table, 0, 0, 1);
    const other = walkStrand(FIELD, table, 0, 0, 0);
    const tiles = new Set([...walk.steps, ...other.steps].map((s) => s.tile));
    expect(tiles.size).toBe(FIELD.count);
  });

  for (const root of ['Psi', 'Delta'] as const) {
    it(`flips every tile once, from the tail outward, accelerating (${root})`, () => {
      const field = root === 'Psi' ? FIELD : buildField({ ...SPEC, rootTile: root });
      const table = chordTableFor(field, fassRule('hex'));
      const start = 17;
      const { order, rank, at } = flipOrder(field, table, start);
      expect(order.length).toBe(field.count);
      expect(new Set(order).size).toBe(field.count);
      expect(order[0]).toBe(start);
      for (let j = 0; j < order.length; j++) expect(rank[order[j]]).toBe(j);
      expect(at[0]).toBe(0);
      expect(at[at.length - 1]).toBe(1);
      for (let j = 1; j < at.length; j++) expect(at[j]).toBeGreaterThanOrEqual(at[j - 1]);
      // Every tile but the first flips next to one that flipped before it.
      for (let j = 1; j < order.length; j++) {
        expect([...tileNeighbours(field, order[j])].some((t) => rank[t] < j && at[rank[t]] < at[j])).toBe(true);
      }
      // Accelerating: half the time flips far fewer than half the tiles.
      expect(flippedBy(at, 0.5)).toBeLessThan(field.count / 2);
      expect(flippedBy(at, -1)).toBe(0);
      expect(flippedBy(at, 1)).toBe(field.count);
      expect(tileChords(field, table, start).length).toBeGreaterThan(0);
    });
  }
});
