import { describe, expect, it } from 'vitest';
import { Engine } from '../shared/game/engine';
import { buildField, pointInPolygon, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, stepIntervalMs, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { defaultRule, fassRule, oddTypes, randomCleanRule, ruleFromCombo, validateRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor, tileChords, walkStrand } from '../shared/game/strand';

const FIELD = buildField({ family: 'spectre', level: 3, rootTile: 'Delta' });
const SEL15 = ruleFromCombo('spectre', '15', '0000000000');

function make(knobs: Partial<Knobs> = {}) {
  return new Engine(FIELD, { ...DEFAULT_KNOBS, ...knobs }, mulberry32(42));
}

/** A tile whose sel-15 strand closes into a small loop. */
function loopTile(): { tile: number; length: number } {
  const table = chordTableFor(FIELD, SEL15);
  for (let i = 0; i < FIELD.count; i++) {
    if (tileChords(FIELD, table, i).length === 0) continue;
    const w = walkStrand(FIELD, table, i, 0, 1);
    if (w.closed) return { tile: i, length: w.steps.length };
  }
  throw new Error('no loop');
}

function runUntil(e: Engine, pred: (ev: GameEvent[]) => boolean, maxTicks = 5000): GameEvent[] {
  const all: GameEvent[] = [];
  for (let t = 0; t < maxTicks; t++) {
    const ev = e.tick(DEFAULT_KNOBS.tickMs);
    all.push(...ev);
    if (pred(all)) return all;
  }
  return all;
}

describe('engine', () => {
  it('a tap starts a path on the tapped tile and scores a tile', () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    const { tile } = loopTile();
    const { result, events } = e.tap('a', tile, tileCenter(FIELD, tile));
    expect(result.ok).toBe(true);
    expect(events.find((x) => x.t === 'step')).toMatchObject({ owner: 'a', step: { tile } });
    expect(e.players.get('a')!.score).toBe(DEFAULT_KNOBS.pointsPerTile);
  });

  it('refuses a tap on a tile the rule draws nothing on', () => {
    const e = make();
    // Class 2 alone: Theta has an odd count and draws nothing.
    e.addPlayer('a', 'Ann', ruleFromCombo('spectre', '2', '0000000000'));
    const theta = FIELD.types.findIndex((t) => FIELD.leafTypes[t] === 'Theta');
    const { result } = e.tap('a', theta, tileCenter(FIELD, theta));
    expect(result).toEqual({ ok: false, reason: 'your rule draws no line on this tile' });
  });

  it('grows with time, closes the circuit and pays the bonus', () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    const { tile, length } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const ev = runUntil(e, (all) => all.some((x) => x.t === 'circuit'));
    const circuit = ev.find((x) => x.t === 'circuit');
    expect(circuit).toBeDefined();
    if (circuit?.t !== 'circuit') throw new Error();
    expect(circuit.length).toBe(length);
    expect(circuit.area).toBeGreaterThan(0);
    const k = DEFAULT_KNOBS;
    const expected = Math.round(k.comboStart * (k.circuitBase + k.circuitLengthWeight * length + k.circuitAreaWeight * circuit.area));
    expect(circuit.bonus).toBe(expected);
    const p = e.players.get('a')!;
    expect(p.score).toBe(length * k.pointsPerTile + expected);
    expect(p.combo).toBe(k.comboStart + k.comboStep);
    expect(p.paths[0].status).toBe('closed');
    // Closed paths stop consuming time.
    expect(e.tick(10_000)).toEqual([]);
  });

  it('gets stuck at a tail', () => {
    const e = make();
    // Class 2 alone: lots of tails.
    const rule = ruleFromCombo('spectre', '2', '0000000000');
    e.addPlayer('a', 'Ann', rule);
    const table = chordTableFor(FIELD, rule);
    const tile = FIELD.types.findIndex((_, i) => tileChords(FIELD, table, i).length > 0);
    e.tap('a', tile, tileCenter(FIELD, tile));
    const ev = runUntil(e, (all) => all.some((x) => x.t === 'status' || x.t === 'circuit'));
    expect(ev.some((x) => x.t === 'status' && x.status === 'stuck')).toBe(true);
  });

  it('speed rises with score and is clamped', () => {
    expect(stepIntervalMs(DEFAULT_KNOBS, 0)).toBe(DEFAULT_KNOBS.baseStepMs);
    expect(stepIntervalMs(DEFAULT_KNOBS, 100)).toBeLessThan(DEFAULT_KNOBS.baseStepMs);
    expect(stepIntervalMs(DEFAULT_KNOBS, 1e9)).toBe(DEFAULT_KNOBS.minStepMs);
  });

  it('a rival crossing your chord wipes your path (tile mode)', () => {
    const e = make({ crossingMode: 'tile', tapOntoOthers: true });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', fassRule('spectre'));
    const { tile } = loopTile();
    const ta = e.tap('a', tile, tileCenter(FIELD, tile));
    expect(ta.result.ok).toBe(true);
    const tb = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(tb.result.ok).toBe(true);
    const wipes = tb.events.filter((x) => x.t === 'wipe');
    expect(wipes).toHaveLength(2);
    expect(wipes[0]).toMatchObject({ owner: 'a', by: 'b' });
    expect(wipes[1]).toMatchObject({ owner: 'b', by: 'a' });
    // Mutual: both lines are gone.
    expect(e.players.get('a')!.paths).toHaveLength(0);
    expect(e.players.get('b')!.paths).toHaveLength(0);
    expect(e.players.get('b')!.score).toBe(0);
    expect(e.pathsOn(tile)).toHaveLength(0);
  });

  it('geometric mode: identical rules on the same chord conflict, disjoint chords do not', () => {
    const e = make({ crossingMode: 'geometric', tapOntoOthers: true });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', SEL15);
    const { tile } = loopTile();
    const table = chordTableFor(FIELD, SEL15);
    const chords = tileChords(FIELD, table, tile);
    e.tap('a', tile, tileCenter(FIELD, tile));
    // Same tile, same chord → shares both endpoints → cut.
    const tb = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(tb.events.some((x) => x.t === 'wipe' && x.owner === 'a')).toBe(true);
    // Entering a tile where the rival's chord is a different, disjoint chord
    // leaves them alone.
    if (chords.length >= 2) {
      const e2 = make({ crossingMode: 'geometric', tapOntoOthers: true });
      e2.addPlayer('a', 'Ann', SEL15);
      e2.addPlayer('b', 'Bob', SEL15);
      // Tap near each chord's midpoint explicitly.
      const mid = (c: number) => {
        const [p, q] = chords[c];
        const M = FIELD.xforms.subarray(tile * 6, tile * 6 + 6);
        const lx = (p.x + q.x) / 2;
        const ly = (p.y + q.y) / 2;
        return { x: M[0] * lx + M[1] * ly + M[2], y: M[3] * lx + M[4] * ly + M[5] };
      };
      e2.tap('a', tile, mid(0));
      const r = e2.tap('b', tile, mid(1));
      expect(r.events.some((x) => x.t === 'wipe')).toBe(false);
    }
  });

  it('a new rule wipes paths and resets the score', () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const ev = e.setRule('a', fassRule('spectre'));
    expect(ev.some((x) => x.t === 'wipe')).toBe(true);
    expect(ev.find((x) => x.t === 'rule')).toMatchObject({ id: 'a', score: 0 });
    expect(e.players.get('a')!.paths).toHaveLength(0);
  });

  it('leaving removes the player and their paths', () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const ev = e.removePlayer('a');
    expect(ev.map((x) => x.t)).toEqual(['wipe', 'score', 'leave']);
    expect(e.pathsOn(tile)).toHaveLength(0);
  });

  it('validateRule rejects crossing matchings and foreign classes', () => {
    expect(validateRule({ family: 'spectre', subset: [9], matching: new Array(10).fill(0) }, 'spectre')).toBeNull();
    expect(validateRule({ family: 'hex', subset: [1], matching: new Array(9).fill(0) }, 'spectre')).toBeNull();
    // Delta under 1278 has 4 points → matchings 0,1,2; index 1 is the crossing one.
    const bad = { family: 'spectre', subset: [1, 2, 7, 8], matching: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(validateRule(bad, 'spectre')).toBeNull();
    expect(validateRule(fassRule('spectre'), 'spectre')).toEqual(fassRule('spectre'));
  });

  it('the default rule is selection 15 — clean, and not the infinite-line rule', () => {
    for (const family of ['hex', 'spectre'] as const) {
      const d = defaultRule(family);
      expect(d.subset).toEqual([1, 5]);
      expect(oddTypes(d)).toEqual([]);
      expect(d.subset).not.toEqual(fassRule(family).subset);
    }
  });

  it('one head: a tap while a line is growing is refused, and allowed once it closes', () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    const { tile } = loopTile();
    const table = chordTableFor(FIELD, SEL15);
    const other = [...Array(FIELD.count).keys()].find((i) => i !== tile && tileChords(FIELD, table, i).length > 0)!;
    expect(e.tap('a', tile, tileCenter(FIELD, tile)).result.ok).toBe(true);
    expect(e.tap('a', other, tileCenter(FIELD, other)).result).toEqual({ ok: false, reason: 'your line is still growing' });
    runUntil(e, (all) => all.some((x) => x.t === 'circuit'));
    expect(e.tap('a', other, tileCenter(FIELD, other)).result.ok).toBe(true);
  });

  it('losing a head in a collision blocks the next tap for respawnDelayMs', () => {
    const e = make({ crossingMode: 'tile', tapOntoOthers: true });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const tb = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(tb.events.filter((x) => x.t === 'wipe')).toHaveLength(2);
    for (const id of ['a', 'b']) {
      expect(e.tap(id, tile, tileCenter(FIELD, tile)).result).toEqual({ ok: false, reason: 'still recovering from that collision' });
    }
    for (let t = 0; t < DEFAULT_KNOBS.respawnDelayMs; t += DEFAULT_KNOBS.tickMs) e.tick(DEFAULT_KNOBS.tickMs);
    expect(e.tap('a', tile, tileCenter(FIELD, tile)).result.ok).toBe(true);
  });

  it('every tap adds a line; nothing is dropped, and circuits accumulate without limit', () => {
    const e = make({ maxHeads: 0 });
    e.addPlayer('a', 'Ann', SEL15);
    const table = chordTableFor(FIELD, SEL15);
    // Five distinct loop tiles, each on its own circuit.
    const starts: number[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < FIELD.count && starts.length < 5; i++) {
      if (tileChords(FIELD, table, i).length === 0 || seen.has(i)) continue;
      const w = walkStrand(FIELD, table, i, 0, 1);
      if (!w.closed) continue;
      for (const s of w.steps) seen.add(s.tile);
      starts.push(i);
    }
    expect(starts).toHaveLength(5);
    for (const t of starts) expect(e.tap('a', t, tileCenter(FIELD, t)).result.ok).toBe(true);
    const p = e.players.get('a')!;
    expect(p.paths).toHaveLength(5);
    expect(p.paths.every((q) => q.status === 'growing')).toBe(true);
    runUntil(e, (all) => all.filter((x) => x.t === 'circuit').length >= 5);
    expect(p.paths).toHaveLength(5);
    expect(p.paths.every((q) => q.status === 'closed')).toBe(true);
  });

  it('maxLivePaths caps the lines in play, dropping the oldest', () => {
    const e = make({ maxLivePaths: 1, maxHeads: 0 });
    e.addPlayer('a', 'Ann', SEL15);
    const table = chordTableFor(FIELD, SEL15);
    const tiles = [...Array(FIELD.count).keys()].filter((i) => tileChords(FIELD, table, i).length > 0).slice(0, 2);
    e.tap('a', tiles[0], tileCenter(FIELD, tiles[0]));
    const second = e.tap('a', tiles[1], tileCenter(FIELD, tiles[1]));
    expect(second.events.some((x) => x.t === 'wipe' && x.by === undefined)).toBe(true);
    expect(e.players.get('a')!.paths).toHaveLength(1);
  });

  it('mutualCut off: only the line that was hit dies', () => {
    const e = make({ crossingMode: 'tile', tapOntoOthers: true, mutualCut: false });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const tb = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(tb.events.filter((x) => x.t === 'wipe')).toHaveLength(1);
    expect(e.players.get('a')!.paths).toHaveLength(0);
    expect(e.players.get('b')!.paths).toHaveLength(1);
  });

  it('zero sum: a cut line takes its points with it, and a knob hands a share to the cutter', () => {
    const e = make({ crossingMode: 'tile', tapOntoOthers: true, stealFraction: 0.5 });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', SEL15);
    const { tile, length } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    runUntil(e, (all) => all.some((x) => x.t === 'circuit'));
    const a = e.players.get('a')!;
    const held = a.score;
    expect(held).toBeGreaterThan(length);
    expect(a.paths[0].points).toBe(held);
    e.tap('b', tile, tileCenter(FIELD, tile));
    expect(a.score).toBe(0);
    expect(a.paths).toHaveLength(0);
    // Bob's own colliding line died too, so only the stolen share remains.
    expect(e.players.get('b')!.score).toBe(Math.floor(held * 0.5));
  });

  it('a new rule loses every point the old lines held', () => {
    const e = make({ resetScoreOnRule: false });
    e.addPlayer('a', 'Ann', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    runUntil(e, (all) => all.some((x) => x.t === 'circuit'));
    expect(e.players.get('a')!.score).toBeGreaterThan(0);
    e.setRule('a', fassRule('spectre'));
    expect(e.players.get('a')!.score).toBe(0);
  });

  it("a tap on a rival's line is refused by default", () => {
    const e = make();
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', SEL15);
    const { tile } = loopTile();
    e.tap('a', tile, tileCenter(FIELD, tile));
    const r = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(r.result).toEqual({ ok: false, reason: "that's someone else's line" });
  });

  it("a tap inside a rival's closed circuit is refused", () => {
    // Find, on either family and over a handful of clean rules, a closed loop
    // that encloses some tile's centre.
    const rng = mulberry32(11);
    const hexField = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
    const families = [{ field: FIELD, rule: SEL15 }, { field: hexField, rule: ruleFromCombo('hex', '15', '000000000') }];
    for (let k = 0; k < 12; k++) {
      families.push({ field: FIELD, rule: randomCleanRule('spectre', rng) });
      families.push({ field: hexField, rule: randomCleanRule('hex', rng) });
    }
    let found: { field: typeof FIELD; rule: typeof SEL15; start: number; inside: number } | null = null;
    for (const f of families) {
      const table = chordTableFor(f.field, f.rule);
      for (let i = 0; i < f.field.count && !found; i++) {
        if (tileChords(f.field, table, i).length === 0) continue;
        const w = walkStrand(f.field, table, i, 0, 1);
        if (!w.closed) continue;
        const poly = w.steps.map((s) => s.a);
        const onLoop = new Set(w.steps.map((s) => s.tile));
        for (let t = 0; t < f.field.count; t++) {
          if (onLoop.has(t)) continue;
          if (pointInPolygon(tileCenter(f.field, t), poly) && tileChords(f.field, table, t).length > 0) {
            found = { field: f.field, rule: f.rule, start: i, inside: t };
            break;
          }
        }
      }
      if (found) break;
    }
    expect(found).not.toBeNull();
    if (!found) return;
    const e = new Engine(found.field, DEFAULT_KNOBS, mulberry32(1));
    e.addPlayer('a', 'Ann', found.rule);
    e.addPlayer('b', 'Bob', found.rule);
    e.tap('a', found.start, tileCenter(found.field, found.start));
    runUntil(e, (all) => all.some((x) => x.t === 'circuit'));
    expect(e.players.get('a')!.paths[0].status).toBe('closed');
    const r = e.tap('b', found.inside, tileCenter(found.field, found.inside));
    expect(r.result).toEqual({ ok: false, reason: "that's inside someone else's circuit" });
    // The owner may still start inside their own circuit.
    expect(e.tap('a', found.inside, tileCenter(found.field, found.inside)).result.ok).toBe(true);
  });
});
