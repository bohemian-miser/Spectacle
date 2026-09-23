import { describe, expect, it } from 'vitest';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline, onFieldBoundary, pathPolygon, polygonArea, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { fassRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor, tileChords, walkStrand, worldChord } from '../shared/game/strand';

const FIELD = buildField({ family: 'spectre', level: 3, rootTile: 'Delta' });
// The endless-line rule: in a finite patch every strand runs edge to edge (tests only).
const FASS = fassRule('spectre');
const TABLE = chordTableFor(FIELD, FASS);

function run(e: Engine, pred: (ev: GameEvent[]) => boolean, maxTicks = 5000): GameEvent[] {
  const all: GameEvent[] = [];
  for (let t = 0; t < maxTicks && !pred(all); t++) all.push(...e.tick(DEFAULT_KNOBS.tickMs));
  return all;
}

/** A chord in the middle of a strand that runs from the field's edge to the field's edge. */
function edgeToEdge(): { tile: number; chord: number } {
  for (let i = 0; i < FIELD.count; i++) {
    for (let c = 0; c < tileChords(FIELD, TABLE, i).length; c++) {
      const fwd = walkStrand(FIELD, TABLE, i, c, 1);
      const back = walkStrand(FIELD, TABLE, i, c, 0);
      if (fwd.stoppedAt !== 'dead' || back.stoppedAt !== 'dead') continue;
      if (fwd.steps.length < 3 || back.steps.length < 3) continue;
      const f = fwd.steps[fwd.steps.length - 1];
      const b = back.steps[back.steps.length - 1];
      if (onFieldBoundary(FIELD, f.tile, f.b) && onFieldBoundary(FIELD, b.tile, b.b)) return { tile: i, chord: c };
    }
  }
  throw new Error('no edge-to-edge strand');
}

function tapChord(e: Engine, id: string, tile: number, chord: number) {
  const [a, b] = worldChord(FIELD, TABLE, tile, chord);
  return e.tap(id, tile, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

describe('the field edge', () => {
  it('the outline is one loop around the whole patch', () => {
    const ring = fieldOutline(FIELD);
    expect(ring.length).toBeGreaterThan(10);
    expect(polygonArea(ring)).toBeCloseTo(FIELD.count * FIELD.tileArea, 3);
  });

  it('a tap on your own line is refused', () => {
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS }, mulberry32(1));
    e.addPlayer('a', 'Ann', FASS);
    const { tile, chord } = edgeToEdge();
    tapChord(e, 'a', tile, chord);
    run(e, (all) => all.some((x) => x.t === 'status'));
    const path = e.players.get('a')!.paths[0];
    const middle = path.steps[1].tile;
    expect(e.tap('a', middle, tileCenter(FIELD, middle)).result).toEqual({ ok: false, reason: "that's your own line" });
  });

  it('tapping the start of a line that ran off the edge turns it round; edge to edge claims the smaller side', () => {
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS }, mulberry32(2));
    e.addPlayer('a', 'Ann', FASS);
    const { tile, chord } = edgeToEdge();
    tapChord(e, 'a', tile, chord);
    run(e, (all) => all.some((x) => x.t === 'status' && x.status === 'stuck'));
    const path = e.players.get('a')!.paths[0];
    expect(path.status).toBe('stuck');
    const firstLeg = path.steps.length;
    const oldEnd = path.steps[firstLeg - 1];

    const turn = e.tap('a', tile, tileCenter(FIELD, tile));
    expect(turn.result).toEqual({ ok: true, path: path.id });
    expect(turn.events).toContainEqual({ t: 'reverse', path: path.id });
    expect(path.status).toBe('growing');
    expect(path.steps[0]).toMatchObject({ tile: oldEnd.tile, a: oldEnd.b, b: oldEnd.a });

    const ev = run(e, (all) => all.some((x) => x.t === 'circuit' || x.t === 'status'));
    const circuit = ev.find((x) => x.t === 'circuit');
    if (circuit?.t !== 'circuit') throw new Error('no claim');
    expect(circuit.region).toBeDefined();
    expect(path.status).toBe('closed');
    expect(path.steps.length).toBeGreaterThan(firstLeg);
    const area = polygonArea(pathPolygon(path));
    expect(circuit.area).toBeCloseTo(area / FIELD.tileArea, 6);
    // The smaller side: at most half the field.
    expect(area).toBeLessThanOrEqual((FIELD.count * FIELD.tileArea) / 2 + 1e-6);
    expect(e.snapshot().paths[0].region).toEqual(circuit.region);
  });
});
