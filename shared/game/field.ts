/**
 * The arena: one finite patch of tiles, identical on server and client.
 *
 * A field is fully determined by `FieldSpec` (family, substitution level, root
 * tile), so the server only ever sends the spec; each client rebuilds the same
 * `flatten()` order locally and tile indices agree byte for byte. Level 5 on
 * hexagons is ~31k tiles, level 6 (the default arena) ~242k.
 *
 * Alongside the instances the field carries what strand-following and tapping
 * need: world-space vertices, vertex-sharing neighbours (CSR), and a uniform
 * grid for point→tile lookup.
 */

import {
  buildSystem,
  flatten,
  leafOrder,
  leafPts,
  transPt,
  type Affine,
  type Pt,
  type TileFamilyId,
  type TileTypeId,
} from '../tiles';

export interface FieldSpec {
  readonly family: TileFamilyId;
  readonly level: number;
  readonly rootTile: TileTypeId;
}

export const DEFAULT_FIELD_SPEC: FieldSpec = Object.freeze({
  family: 'hex' as TileFamilyId,
  level: 6,
  rootTile: 'Delta' as TileTypeId,
});

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface Field {
  readonly spec: FieldSpec;
  readonly family: TileFamilyId;
  readonly count: number;
  /** Leaf order of the family; `types[i]` indexes it. */
  readonly leafTypes: readonly TileTypeId[];
  readonly types: Uint8Array;
  /** 6 doubles per tile, row-major affine (see `geom.ts`). */
  readonly xforms: Float64Array;
  /** 2 doubles per tile: centroid of the tile outline. */
  readonly centers: Float64Array;
  readonly bounds: Box;
  /** Area of one tile in world units (all leaf shapes of a family share it). */
  readonly tileArea: number;
  /** Vertex-sharing neighbours, CSR: `nbrs[nbrStart[i] .. nbrStart[i+1])`. */
  readonly nbrStart: Int32Array;
  readonly nbrs: Int32Array;
  /** Uniform grid for hit-testing. */
  readonly grid: FieldGrid;
}

export interface FieldGrid {
  readonly cell: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  readonly start: Int32Array;
  readonly items: Int32Array;
}

export function tileXform(field: Field, i: number): Affine {
  const x = field.xforms;
  const o = i * 6;
  return [x[o], x[o + 1], x[o + 2], x[o + 3], x[o + 4], x[o + 5]];
}

export function tileType(field: Field, i: number): TileTypeId {
  return field.leafTypes[field.types[i]];
}

/** World-space outline of tile `i`. */
export function tilePolygon(field: Field, i: number): Pt[] {
  const M = tileXform(field, i);
  return leafPts(field.family, tileType(field, i)).map((p) => transPt(M, p));
}

export function tileCenter(field: Field, i: number): Pt {
  return { x: field.centers[i * 2], y: field.centers[i * 2 + 1] };
}

export function tileNeighbours(field: Field, i: number): Int32Array {
  return field.nbrs.subarray(field.nbrStart[i], field.nbrStart[i + 1]);
}

/** Shoelace area of a polygon. */
export function polygonArea(pts: readonly Pt[]): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Vertex key at 1e-3 resolution — comfortably below any real vertex gap (≥ ~0.5). */
function vkey(x: number, y: number): number {
  // Pack two rounded coordinates into one number. Patches up to level 7
  // (extent ~10^4) keep both halves inside 2^26 without collisions.
  const kx = Math.round(x * 1000) + (1 << 25);
  const ky = Math.round(y * 1000) + (1 << 25);
  return kx * 67108864 + ky;
}

const fieldCache = new Map<string, Field>();

export function fieldKey(spec: FieldSpec): string {
  return `${spec.family}/${spec.rootTile}/${spec.level}`;
}

/** Build (memoised) the field for a spec. */
export function buildField(spec: FieldSpec): Field {
  const key = fieldKey(spec);
  const hit = fieldCache.get(key);
  if (hit) return hit;

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
  fieldCache.set(key, field);
  return field;
}

/** Tile containing world point `p`, or -1. */
export function tileAt(field: Field, p: Pt): number {
  const g = field.grid;
  const cx = Math.floor((p.x - g.minX) / g.cell);
  const cy = Math.floor((p.y - g.minY) / g.cell);
  for (let dy = -1; dy <= 1; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= g.rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= g.cols) continue;
      const c = y * g.cols + x;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const i = g.items[k];
        if (pointInPolygon(p, tilePolygon(field, i))) return i;
      }
    }
  }
  return -1;
}

/** Tiles whose centres fall inside `box` (padded by one cell) — the renderer's cull. */
export function tilesInBox(field: Field, box: Box, out: number[] = []): number[] {
  const g = field.grid;
  const x0 = Math.max(0, Math.floor((box.minX - g.minX) / g.cell) - 1);
  const y0 = Math.max(0, Math.floor((box.minY - g.minY) / g.cell) - 1);
  const x1 = Math.min(g.cols - 1, Math.floor((box.maxX - g.minX) / g.cell) + 1);
  const y1 = Math.min(g.rows - 1, Math.floor((box.maxY - g.minY) / g.cell) + 1);
  out.length = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = y * g.cols + x;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) out.push(g.items[k]);
    }
  }
  return out;
}
