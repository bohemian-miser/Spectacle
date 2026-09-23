import { describe, expect, it } from 'vitest';
import { buildField, pointInPolygon, tileAt, tileCenter, tileNeighbours, tilePolygon, tilesInsidePolygon } from '../shared/game/field';
import { pointKey } from '../shared/tiles';

describe('field', () => {
  it('tilesInsidePolygon finds exactly the tiles whose centres a loop encloses', () => {
    const f = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
    const c = tileCenter(f, Math.floor(f.count / 2));
    const r = 3;
    const poly = [0, 1, 2, 3, 4, 5].map((k) => ({ x: c.x + r * Math.cos((k * Math.PI) / 3), y: c.y + r * Math.sin((k * Math.PI) / 3) }));
    const inside = tilesInsidePolygon(f, poly);
    const brute = [...Array(f.count).keys()].filter((i) => pointInPolygon(tileCenter(f, i), poly));
    expect(inside.length).toBeGreaterThan(1);
    expect([...inside].sort((a, b) => a - b)).toEqual(brute);
  });

  it('hex level 3 tiles abut: every edge is shared by at most two tiles, interiors by exactly two', () => {
    const f = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
    expect(f.count).toBeGreaterThan(50);
    const edgeCount = new Map<string, number>();
    for (let i = 0; i < f.count; i++) {
      const poly = tilePolygon(f, i);
      for (let k = 0; k < poly.length; k++) {
        const a = pointKey(poly[k]);
        const b = pointKey(poly[(k + 1) % poly.length]);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    const counts = [...edgeCount.values()];
    expect(Math.max(...counts)).toBe(2);
    // Plenty of interior edges (shared) and a boundary (unshared).
    expect(counts.filter((c) => c === 2).length).toBeGreaterThan(counts.length / 2);
    expect(counts.filter((c) => c === 1).length).toBeGreaterThan(0);
  });

  it('no two tiles share a centre', () => {
    const f = buildField({ family: 'spectre', level: 3, rootTile: 'Delta' });
    const seen = new Set<string>();
    for (let i = 0; i < f.count; i++) seen.add(pointKey(tileCenter(f, i)));
    expect(seen.size).toBe(f.count);
  });

  it('neighbours are symmetric and hexes have six edge-neighbours in the interior', () => {
    const f = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
    let sixes = 0;
    for (let i = 0; i < f.count; i++) {
      for (const n of tileNeighbours(f, i)) {
        expect(Array.from(tileNeighbours(f, n))).toContain(i);
      }
      if (tileNeighbours(f, i).length === 6) sixes++;
    }
    expect(sixes).toBeGreaterThan(0);
  });

  it('tileAt finds the tile under its own centre and misses far away', () => {
    const f = buildField({ family: 'spectre', level: 2, rootTile: 'Delta' });
    for (let i = 0; i < f.count; i++) expect(tileAt(f, tileCenter(f, i))).toBe(i);
    expect(tileAt(f, { x: f.bounds.minX - 100, y: 0 })).toBe(-1);
  });
});
