import { describe, expect, it } from 'vitest';
import { Engine } from '../shared/game/engine';
import { buildField, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, stepIntervalMs, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { fassRule, ruleFromCombo, validateRule } from '../shared/game/rule';
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
    const e = make({ crossingMode: 'tile' });
    e.addPlayer('a', 'Ann', SEL15);
    e.addPlayer('b', 'Bob', fassRule('spectre'));
    const { tile } = loopTile();
    const ta = e.tap('a', tile, tileCenter(FIELD, tile));
    expect(ta.result.ok).toBe(true);
    const tb = e.tap('b', tile, tileCenter(FIELD, tile));
    expect(tb.result.ok).toBe(true);
    const wipe = tb.events.find((x) => x.t === 'wipe');
    expect(wipe).toMatchObject({ owner: 'a', by: 'b' });
    expect(e.players.get('a')!.paths).toHaveLength(0);
    expect(e.players.get('b')!.paths).toHaveLength(1);
  });

  it('geometric mode: identical rules on the same chord conflict, disjoint chords do not', () => {
    const e = make({ crossingMode: 'geometric' });
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
      const e2 = make({ crossingMode: 'geometric' });
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
    expect(ev.map((x) => x.t)).toEqual(['wipe', 'leave']);
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
});
