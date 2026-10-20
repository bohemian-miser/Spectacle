/**
 * `buildField` writes its typed arrays, edge table and outline straight off
 * the substitution tree. This pins it to the build it replaced — `flatten()`,
 * Maps of vertex lists, `acrossEdge` worked out from tile polygons, and
 * `chainOutline` over every tile — kept here as the reference: the same
 * bytes, neighbour for neighbour, point for point.
 */
import { describe, expect, it } from 'vitest';
import { buildSystem, flatten, leafOrder, leafPts, transPt, type Pt, type TileFamilyId, type TileTypeId } from '../shared/tiles';
import { acrossEdge, buildField, edgeSlots, fieldOutline, polygonArea, tilePolygon, tileNeighbours, type Field, type FieldSpec } from '../shared/game/field';

function vkey(x: number, y: number): number {
  // Pack two rounded coordinates into one number. Patches up to level 7
  // (extent ~10^4) keep both halves inside 2^26 without collisions.
  const kx = Math.round(x * 1000) + (1 << 25);
  const ky = Math.round(y * 1000) + (1 << 25);
  return kx * 67108864 + ky;
}

function oldBuild(spec: FieldSpec): Field {

  const family = spec.family;
  const sys = buildSystem(family, spec.level);
  const root = sys[spec.rootTile] ?? sys['Delta'];
  const instances = flatten(root);
  const count = instances.length;
  const leafTypes = leafOrder(family);
  const typeIndex = new Map<string, number>(leafTypes.map((t, i) => [t, i]));

  const types = new Uint8Array(count);
  const xforms = new Float64Array(count * 6);
  const centers = new Float64Array(count * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Vertex → tiles incidence, for the neighbour lists.
  const vertTiles = new Map<number, number[]>();

  for (let i = 0; i < count; i++) {
    const inst = instances[i];
    types[i] = typeIndex.get(inst.type) ?? 0;
    for (let k = 0; k < 6; k++) xforms[i * 6 + k] = inst.xform[k];
    const pts = leafPts(family, inst.type);
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      const w = transPt(inst.xform, p);
      cx += w.x;
      cy += w.y;
      if (w.x < minX) minX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.x > maxX) maxX = w.x;
      if (w.y > maxY) maxY = w.y;
      const vk = vkey(w.x, w.y);
      const list = vertTiles.get(vk);
      if (list) list.push(i);
      else vertTiles.set(vk, [i]);
    }
    centers[i * 2] = cx / pts.length;
    centers[i * 2 + 1] = cy / pts.length;
  }

  // Neighbours (CSR). Two passes: count, then fill.
  const nbrStart = new Int32Array(count + 1);
  const scratch: number[][] = new Array(count);
  for (let i = 0; i < count; i++) scratch[i] = [];
  for (const list of vertTiles.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      const s = scratch[a];
      for (const b of list) if (b !== a && !s.includes(b)) s.push(b);
    }
  }
  for (let i = 0; i < count; i++) nbrStart[i + 1] = nbrStart[i] + scratch[i].length;
  const nbrs = new Int32Array(nbrStart[count]);
  for (let i = 0; i < count; i++) {
    const s = scratch[i];
    s.sort((a, b) => a - b);
    nbrs.set(s, nbrStart[i]);
  }

  // Grid. Cell = 2 × the outline radius, so a point's tile is in its own cell
  // or an immediate neighbour cell.
  let reach = 0;
  for (const type of leafTypes) {
    for (const p of leafPts(family, type)) reach = Math.max(reach, Math.hypot(p.x, p.y));
  }
  const cell = Math.max(1, 2 * reach);
  const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
  const gstart = new Int32Array(cols * rows + 1);
  const cellOf = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const cx = Math.min(cols - 1, Math.floor((centers[i * 2] - minX) / cell));
    const cy = Math.min(rows - 1, Math.floor((centers[i * 2 + 1] - minY) / cell));
    const c = cy * cols + cx;
    cellOf[i] = c;
    gstart[c + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) gstart[c + 1] += gstart[c];
  const fill = gstart.slice(0, cols * rows);
  const gitems = new Int32Array(count);
  for (let i = 0; i < count; i++) gitems[fill[cellOf[i]]++] = i;

  const tileArea = polygonArea(leafPts(family, leafTypes[0]));

  const field: Field = {
    spec,
    family,
    count,
    leafTypes,
    types,
    xforms,
    centers,
    bounds: { minX, minY, maxX, maxY },
    tileArea,
    nbrStart,
    nbrs,
    grid: { cell, minX, minY, cols, rows, start: gstart, items: gitems },
  };
  return field;
}


function oldChain(count: number, polygonAt: (i: number) => readonly Pt[]): readonly Pt[] {
  // Vertices get small integer ids so an edge packs into one numeric key.
  const ids = new Map<number, number>();
  const pos: Pt[] = [];
  const idOf = (p: Pt): number => {
    const k = vkey(p.x, p.y);
    let id = ids.get(k);
    if (id === undefined) {
      id = pos.length;
      ids.set(k, id);
      pos.push(p);
    }
    return id;
  };
  const edges = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const poly = polygonAt(i);
    let prev = idOf(poly[poly.length - 1]);
    for (const p of poly) {
      const cur = idOf(p);
      const key = prev < cur ? prev * 0x4000000 + cur : cur * 0x4000000 + prev;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      prev = cur;
    }
  }
  const adj = new Map<number, number[]>();
  const link = (u: number, v: number): void => {
    const list = adj.get(u);
    if (list) list.push(v);
    else adj.set(u, [v]);
  };
  for (const [key, c] of edges) {
    if (c !== 1) continue;
    const u = Math.floor(key / 0x4000000);
    const v = key % 0x4000000;
    link(u, v);
    link(v, u);
  }
  const edgeKey = (u: number, v: number): number => (u < v ? u * 0x4000000 + v : v * 0x4000000 + u);
  const used = new Set<number>();
  let best: number[] = [];
  for (const start of adj.keys()) {
    const loop: number[] = [start];
    let cur = start;
    for (;;) {
      const next = adj.get(cur)!.find((n) => !used.has(edgeKey(cur, n)));
      if (next === undefined) break;
      used.add(edgeKey(cur, next));
      if (next === start) break;
      loop.push(next);
      cur = next;
    }
    if (loop.length > best.length) best = loop;
  }
  return best.map((k) => pos[k]);
}


function oldAcross(field: Field, i: number, k: number): number {
  const poly = tilePolygon(field, i);
  if (k >= poly.length) return -2;
  const keys = poly.map((p) => vkey(p.x, p.y));
  let out = -1;
  for (const n of tileNeighbours(field, i)) {
    const nkeys = new Set(tilePolygon(field, n).map((p) => vkey(p.x, p.y)));
    if (nkeys.has(keys[k]) && nkeys.has(keys[(k + 1) % poly.length])) out = n;
  }
  return out;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => Object.is(v, b[i]));

describe('buildField', () => {
  for (const family of ['hex', 'spectre'] as TileFamilyId[]) {
    for (const rootTile of ['Delta', 'Psi'] as TileTypeId[]) {
      it(`${family} level 3 from ${rootTile} matches the old build`, () => {
        const spec: FieldSpec = { family, level: 3, rootTile };
        const a = oldBuild(spec);
        const b = buildField(spec);
        expect(b.count).toBe(a.count);
        expect(b.bounds).toEqual(a.bounds);
        expect(b.tileArea).toBe(a.tileArea);
        for (const k of ['types', 'xforms', 'centers', 'nbrStart', 'nbrs'] as const) expect(same(b[k], a[k]), k).toBe(true);
        expect(same(b.grid.start, a.grid.start) && same(b.grid.items, a.grid.items)).toBe(true);
        const per = edgeSlots(b);
        for (let i = 0; i < b.count; i++) for (let k = 0; k < per; k++) expect(acrossEdge(b, i, k)).toBe(oldAcross(a, i, k));
        const ring = oldChain(a.count, (i) => tilePolygon(a, i));
        const got = fieldOutline(b);
        expect(got.length).toBe(ring.length);
        expect(got.every((p, i) => Object.is(p.x, ring[i].x) && Object.is(p.y, ring[i].y))).toBe(true);
      });
    }
  }
});
