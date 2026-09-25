import { describe, expect, it } from 'vitest';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline, onFieldBoundary, pathPolygon, polygonArea, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { fassRule } from '../shared/game/rule';
import { mulberry32, type Rng } from '../shared/game/rng';
import { chordTableFor, startStep, tileChords, walkStrand, worldChord } from '../shared/game/strand';

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

/** An Rng whose next tap leaves through the end the test sets in `exit.end`. */
function steered(): { rng: Rng; exit: { end: 0 | 1 } } {
  const exit = { end: 0 as 0 | 1 };
  const next = (): number => (exit.end === 0 ? 0.25 : 0.75);
  return { rng: { next, int: (n) => Math.floor(next() * n) }, exit };
}

/** The exit end that starts chord (tile, c) heading out through point `to`. */
function exitThrough(tile: number, c: number, to: { x: number; y: number }): 0 | 1 {
  const b = startStep(FIELD, TABLE, tile, c, 1).b;
  return Math.abs(b.x - to.x) < 1e-9 && Math.abs(b.y - to.y) < 1e-9 ? 1 : 0;
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

  it('a tap anywhere on your stuck line turns it round; on a finished one it is refused', () => {
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS, overlapOwnLines: false }, mulberry32(1));
    e.addPlayer('a', 'Ann', FASS);
    const { tile, chord } = edgeToEdge();
    tapChord(e, 'a', tile, chord);
    run(e, (all) => all.some((x) => x.t === 'status'));
    const path = e.players.get('a')!.paths[0];
    expect(path.status).toBe('stuck');
    const middle = path.steps[1];
    const turn = tapChord(e, 'a', middle.tile, middle.chord);
    expect(turn.result).toEqual({ ok: true, path: path.id });
    expect(turn.events).toContainEqual({ t: 'reverse', path: path.id });
    run(e, (all) => all.some((x) => x.t === 'circuit'));
    expect(path.status).toBe('closed');
    const mid = path.steps[1].tile;
    expect(e.tap('a', mid, tileCenter(FIELD, mid)).result).toEqual({ ok: false, reason: "that's your own line" });
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

    const turn = tapChord(e, 'a', tile, chord);
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

  it('a line that meets the loose end of your own line joins it; two dead ends make one edge-to-edge claim', () => {
    const { rng, exit } = steered();
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS, junctionPolicy: 'stop' }, rng);
    e.addPlayer('a', 'Ann', FASS);
    const { tile, chord } = edgeToEdge();
    const fwd = walkStrand(FIELD, TABLE, tile, chord, 1);

    // A: from the middle chord back to one edge.
    exit.end = 0;
    const a = tapChord(e, 'a', tile, chord).result;
    if (!a.ok) throw new Error('tap A refused');
    run(e, (all) => all.some((x) => x.t === 'status' && x.path === a.path));
    const lineA = e.getPath(a.path)!;
    expect(lineA.status).toBe('stuck');

    // B: further along the strand, heading back towards A's loose start.
    const k = 3;
    const bs = fwd.steps[k];
    exit.end = exitThrough(bs.tile, bs.chord, bs.a);
    const b = tapChord(e, 'a', bs.tile, bs.chord).result;
    if (!b.ok) throw new Error('tap B refused');
    const joined = run(e, (all) => all.some((x) => x.t === 'wipe' && x.path === a.path));
    expect(joined).toContainEqual({ t: 'wipe', path: a.path, owner: 'a' });
    const lineB = e.getPath(b.path)!;
    expect(e.getPath(a.path)).toBeUndefined();
    expect(e.players.get('a')!.paths).toEqual([lineB]);
    run(e, () => lineB.status !== 'growing');
    expect(lineB.status).toBe('stuck');
    // B took A's steps once: no chord twice, and every tile scored once.
    const keys = lineB.steps.map((q) => `${q.tile}:${q.chord}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(e.players.get('a')!.score).toBe(lineB.steps.length * DEFAULT_KNOBS.pointsPerTile);

    // Turned round, it runs to the other edge and claims.
    const turn = tapChord(e, 'a', lineB.steps[0].tile, lineB.steps[0].chord);
    expect(turn.result).toEqual({ ok: true, path: b.path });
    const ev = run(e, (all) => all.some((x) => x.t === 'circuit' || (x.t === 'status' && x.path === b.path)));
    const circuit = ev.find((x) => x.t === 'circuit');
    if (circuit?.t !== 'circuit') throw new Error('no claim');
    expect(circuit.region).toBeDefined();
    expect(lineB.status).toBe('closed');
    expect(lineB.steps.length).toBe(fwd.steps.length + walkStrand(FIELD, TABLE, tile, chord, 0).steps.length - 1);
  });

  it('a line that runs off the edge with your loose end just behind its start joins it without a tap', () => {
    const { rng, exit } = steered();
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS, junctionPolicy: 'stop' }, rng);
    e.addPlayer('a', 'Ann', FASS);
    const { tile, chord } = edgeToEdge();
    const fwd = walkStrand(FIELD, TABLE, tile, chord, 1);
    const back = walkStrand(FIELD, TABLE, tile, chord, 0);

    // A: from the middle chord to one edge.
    exit.end = 0;
    const a = tapChord(e, 'a', tile, chord).result;
    if (!a.ok) throw new Error('tap A refused');
    run(e, (all) => all.some((x) => x.t === 'status' && x.path === a.path));
    expect(e.getPath(a.path)!.status).toBe('stuck');

    // B: the very next chord, heading away from A to the other edge.
    const bs = fwd.steps[1];
    exit.end = exitThrough(bs.tile, bs.chord, bs.b);
    const b = tapChord(e, 'a', bs.tile, bs.chord).result;
    if (!b.ok) throw new Error('tap B refused');
    const lineB = e.getPath(b.path)!;
    const ev = run(e, (all) => all.some((x) => x.t === 'circuit' || (x.t === 'status' && x.path === b.path)));
    expect(ev).toContainEqual({ t: 'reverse', path: b.path });
    expect(ev).toContainEqual({ t: 'wipe', path: a.path, owner: 'a' });
    const circuit = ev.find((x) => x.t === 'circuit');
    if (circuit?.t !== 'circuit') throw new Error('no claim');
    expect(circuit.region).toBeDefined();
    expect(lineB.status).toBe('closed');
    expect(e.players.get('a')!.paths).toEqual([lineB]);
    expect(lineB.steps.length).toBe(fwd.steps.length + back.steps.length - 1);
  });

  it('a line stops as soon as it runs into another of your lines', () => {
    const { rng, exit } = steered();
    const e = new Engine(FIELD, { ...DEFAULT_KNOBS, junctionPolicy: 'stop', crossingMode: 'tile', overlapOwnLines: false }, rng);
    e.addPlayer('a', 'Ann', FASS);
    // A tile with two chords on different strands; B's approach avoids A's strand.
    let setup: { t: number; bTile: number; bChord: number; toward: { x: number; y: number } } | null = null;
    for (let t = 0; t < FIELD.count && !setup; t++) {
      if (tileChords(FIELD, TABLE, t).length < 2) continue;
      const aTiles = new Set([
        ...walkStrand(FIELD, TABLE, t, 0, 0).steps.map((q) => q.tile),
        ...walkStrand(FIELD, TABLE, t, 0, 1).steps.map((q) => q.tile),
      ]);
      const wb = walkStrand(FIELD, TABLE, t, 1, 0);
      if (wb.steps.length < 3 || aTiles.has(wb.steps[1].tile) || aTiles.has(wb.steps[2].tile)) continue;
      setup = { t, bTile: wb.steps[2].tile, bChord: wb.steps[2].chord, toward: wb.steps[2].a };
    }
    if (!setup) throw new Error('no crossing tile');
    exit.end = 0;
    const a = tapChord(e, 'a', setup.t, 0).result;
    if (!a.ok) throw new Error('tap A refused');
    run(e, () => e.getPath(a.path)!.status !== 'growing');
    exit.end = exitThrough(setup.bTile, setup.bChord, setup.toward);
    const b = tapChord(e, 'a', setup.bTile, setup.bChord).result;
    if (!b.ok) throw new Error('tap B refused');
    run(e, () => e.getPath(b.path)!.status !== 'growing');
    const lineB = e.getPath(b.path)!;
    expect(lineB.status).toBe('stuck');
    expect(lineB.steps.length).toBe(2);
    expect(lineB.steps.some((q) => q.tile === setup!.t)).toBe(false);
    expect(e.getPath(a.path)).toBeDefined();
  });
});
