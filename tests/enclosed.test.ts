import { describe, expect, it } from 'vitest';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { boundaryRegion, buildField, onFieldBoundary, pathPolygon, tilesEnclosed, tilesInsidePolygon } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor, startStep, stepForward, tileChords, type WalkStep } from '../shared/game/strand';

describe('tilesEnclosed', () => {
  it.each([
    ['hex', 4],
    ['spectre', 3],
  ] as const)('%s: filling from the line finds the tiles whose centres are inside, for every circuit and claim', (family, level) => {
    const field = buildField({ family, level, rootTile: 'Delta' });
    const knobs = { ...DEFAULT_KNOBS, mode: 'normal' as const, maxHeads: 0 };
    const e = new Engine(field, knobs, mulberry32(41));
    const rng = mulberry32(42);
    const bots = new Bots(e, mulberry32(43), 0.1);
    bots.add(4, 0);
    for (const p of e.players.values()) {
      for (let k = 0; k < 2; k++) {
        const rule = randomCleanRule(family, rng);
        p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
      }
    }
    let loops = 0, claims = 0, tiles = 0, differ = 0;
    const seen = new Set<number>();
    for (let t = 1; t <= 3000; t++) {
      const ev: GameEvent[] = e.tick(knobs.tickMs);
      bots.update(t * knobs.tickMs, ev);
      for (const x of ev) {
        if (x.t !== 'circuit' || seen.has(x.path)) continue;
        seen.add(x.path);
        const path = e.getPath(x.path);
        if (!path || path.status !== 'closed') continue;
        const own = new Set(path.steps.map((s) => s.tile));
        const want = tilesInsidePolygon(field, pathPolygon(path)).filter((q) => !own.has(q)).sort((a, b) => a - b);
        const got = tilesEnclosed(field, path.steps, path.region).tiles.sort((a, b) => a - b);
        if (path.region) claims++;
        else loops++;
        tiles += want.length;
        if (JSON.stringify(got) !== JSON.stringify(want)) differ++;
      }
    }
    expect(loops).toBeGreaterThan(50);
    expect(claims).toBeGreaterThan(0);
    expect(differ).toBe(0);
  });

  it.each([
    ['hex', 5],
    ['spectre', 4],
  ] as const)('%s: and for whole strands of random rules, loops and edge to edge, some of them huge', (family, level) => {
    const field = buildField({ family, level, rootTile: 'Delta' });
    const rng = mulberry32(51);
    let checked = 0, biggest = 0;
    for (let r = 0; r < 12; r++) {
      const table = chordTableFor(field, randomCleanRule(family, rng));
      const done = new Set<string>();
      for (let n = 0; n < 60; n++) {
        const tile = Math.floor(rng.next() * field.count);
        const chords = tileChords(field, table, tile);
        if (chords.length === 0 || done.has(`${tile}.0`)) continue;
        // Walk the strand both ways from here: a loop, or a line edge to edge.
        const fwd: WalkStep[] = [startStep(field, table, tile, 0, 1)];
        let closed = false;
        for (let g = 0; g < 50000; g++) {
          const o = stepForward(field, table, fwd[fwd.length - 1]);
          if (o.kind !== 'step') break;
          if (o.step.tile === tile && o.step.chord === 0) {
            closed = true;
            break;
          }
          fwd.push(o.step);
        }
        let steps = fwd;
        let region: ReturnType<typeof boundaryRegion> = null;
        if (!closed) {
          const back: WalkStep[] = [];
          let cur: WalkStep = { ...fwd[0], a: fwd[0].b, b: fwd[0].a };
          for (let g = 0; g < 50000; g++) {
            const o = stepForward(field, table, cur);
            if (o.kind !== 'step') break;
            back.push(o.step);
            cur = o.step;
          }
          steps = [...back.reverse().map((q) => ({ ...q, a: q.b, b: q.a })), ...fwd];
          const first = steps[0], last = steps[steps.length - 1];
          if (!onFieldBoundary(field, first.tile, first.a) || !onFieldBoundary(field, last.tile, last.b)) continue;
          region = boundaryRegion(field, [...steps.map((q) => q.a), last.b]);
          if (!region) continue;
        }
        for (const q of steps) done.add(`${q.tile}.${q.chord}`);
        const own = new Set(steps.map((q) => q.tile));
        const poly = pathPolygon({ steps, region: region ?? undefined });
        const want = tilesInsidePolygon(field, poly).filter((q) => !own.has(q)).sort((a, b) => a - b);
        const got = tilesEnclosed(field, steps, region ?? undefined).tiles.sort((a, b) => a - b);
        expect(got.length, `rule ${r} strand ${n}`).toBe(want.length);
        expect(got).toEqual(want);
        checked++;
        biggest = Math.max(biggest, want.length);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(biggest).toBeGreaterThan(1000);
    // The reference (every tile against the whole loop) is the slow part.
  }, 60_000);
});
