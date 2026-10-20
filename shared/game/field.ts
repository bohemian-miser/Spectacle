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
  countTiles,
  leafOrder,
  leafPts,
  mul,
  transPt,
  type Affine,
  type Pt,
  type TileFamilyId,
  type TileNode,
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
  // Rooted at Psi, the infinite-line rule (hex `128`) draws one single line
  // through every tile — the end-of-round celebration grows it (Delta's
  // board splits it into four).
  rootTile: 'Psi' as TileTypeId,
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

export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
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

/** Sorted unique values of `keys` (sorts a copy). */
function uniqueSorted(keys: Float64Array): Float64Array {
  const s = keys.slice().sort();
  let n = 0;
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) s[n++] = s[i];
  return s.subarray(0, n);
}

/** Index of `v` in ascending `sorted`, or -1. */
function search(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = sorted[mid];
    if (m < v) lo = mid + 1;
    else if (m > v) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * Build (memoised) the field for a spec, with its edge table (`acrossEdge`)
 * and outline (`fieldOutline`). Everything goes straight into typed arrays —
 * no object per tile, corner or edge — so a level-6 build peaks at a fraction
 * of the memory `flatten()` and Maps of vertex lists took, and leaves no
 * garbage behind. The arrays and the outline are exactly what that older
 * build gave (tests/field-build.test.ts keeps a copy of it to compare with).
 */
export function buildField(spec: FieldSpec): Field {
  const key = fieldKey(spec);
  const hit = fieldCache.get(key);
  if (hit) return hit;

  const family = spec.family;
  const sys = buildSystem(family, spec.level);
  const root = sys[spec.rootTile] ?? sys['Delta'];
  const count = countTiles(root);
  const leafTypes = leafOrder(family);
  const typeIndex = new Map<string, number>(leafTypes.map((t, i) => [t, i]));
  const shapes = leafTypes.map((t) => leafPts(family, t));
  const per = Math.max(...shapes.map((s) => s.length));

  const types = new Uint8Array(count);
  const xforms = new Float64Array(count * 6);
  const centers = new Float64Array(count * 2);
  /** Vertex key per (tile, corner); 0 where a tile has fewer corners than `per`. */
  const keys = new Float64Array(count * per);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // The order `flatten()` gives: children in order, transforms composed down.
  let n = 0;
  const walk = (node: TileNode, M: Affine): void => {
    if (node.kind === 'meta') {
      for (const child of node.children) walk(child.node, mul(M, child.xform));
      return;
    }
    const i = n++;
    const t = typeIndex.get(node.type) ?? 0;
    types[i] = t;
    for (let k = 0; k < 6; k++) xforms[i * 6 + k] = M[k];
    const pts = shapes[t];
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < pts.length; k++) {
      const w = transPt(M, pts[k]);
      cx += w.x;
      cy += w.y;
      if (w.x < minX) minX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.x > maxX) maxX = w.x;
      if (w.y > maxY) maxY = w.y;
      keys[i * per + k] = vkey(w.x, w.y);
    }
    centers[i * 2] = cx / pts.length;
    centers[i * 2 + 1] = cy / pts.length;
  };
  walk(root, [1, 0, 0, 0, 1, 0]);

  // Vertex ids (rank among the distinct keys), then vertex → tiles as CSR.
  const uniq = uniqueSorted(keys);
  const verts = uniq.length;
  const vid = new Int32Array(count * per).fill(-1);
  for (let j = 0; j < keys.length; j++) if (keys[j] !== 0) vid[j] = search(uniq, keys[j]);
  const vStart = new Int32Array(verts + 1);
  for (let j = 0; j < vid.length; j++) if (vid[j] >= 0) vStart[vid[j] + 1]++;
  for (let v = 0; v < verts; v++) vStart[v + 1] += vStart[v];
  const vFill = vStart.slice(0, verts);
  const vTiles = new Int32Array(vStart[verts]);
  for (let j = 0; j < vid.length; j++) if (vid[j] >= 0) vTiles[vFill[vid[j]]++] = Math.floor(j / per);

  // Neighbours (CSR, ascending): every tile sharing a vertex. Two passes, count then fill.
  const seen = new Int32Array(count).fill(-1);
  const cand = new Int32Array(per * 32);
  const gather = (i: number): number => {
    let m = 0;
    for (let k = 0; k < per; k++) {
      const v = vid[i * per + k];
      if (v < 0) continue;
      for (let q = vStart[v]; q < vStart[v + 1]; q++) {
        const b = vTiles[q];
        if (b !== i && seen[b] !== i) {
          seen[b] = i;
          cand[m++] = b;
        }
      }
    }
    return m;
  };
  const nbrStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) nbrStart[i + 1] = nbrStart[i] + gather(i);
  seen.fill(-1);
  const nbrs = new Int32Array(nbrStart[count]);
  for (let i = 0; i < count; i++) nbrs.set(cand.subarray(0, gather(i)).sort(), nbrStart[i]);

  // Grid. Cell = 2 × the outline radius, so a point's tile is in its own cell
  // or an immediate neighbour cell.
  let reach = 0;
  for (const s of shapes) for (const p of s) reach = Math.max(reach, Math.hypot(p.x, p.y));
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

  const field: Field = {
    spec,
    family,
    count,
    leafTypes,
    types,
    xforms,
    centers,
    bounds: { minX, minY, maxX, maxY },
    tileArea: polygonArea(shapes[0]),
    nbrStart,
    nbrs,
    grid: { cell, minX, minY, cols, rows, start: gstart, items: gitems },
  };

  // Edge table: across edge k (corner k to k + 1) is the other tile with both
  // corners (the highest, should there be two), -1 on the board's edge; slots
  // past a tile's own corners stay -2.
  const nb = new Int32Array(count * per).fill(-2);
  for (let i = 0; i < count; i++) {
    const m = shapes[types[i]].length;
    for (let k = 0; k < m; k++) {
      const u = vid[i * per + k];
      const w = vid[i * per + ((k + 1) % m)];
      let across = -1;
      for (let q = vStart[u]; q < vStart[u + 1]; q++) {
        const b = vTiles[q];
        if (b === i || b <= across) continue;
        for (let r = vStart[w]; r < vStart[w + 1]; r++) {
          if (vTiles[r] === b) {
            across = b;
            break;
          }
        }
      }
      nb[i * per + k] = across;
    }
  }
  edgeCache.set(field, { per, nb });
  outlineCache.set(field, outlineOf(field, shapes, per, vid, vStart, vTiles));

  fieldCache.set(key, field);
  return field;
}

/**
 * The field's outline from its vertex ids: the edges that belong to one tile,
 * chained the way `chainOutline` chains them — vertices numbered in the order
 * a scan of the tiles first meets them (each tile from its last corner), edges
 * taken in scan order — so the ring comes out the same, point for point.
 */
function outlineOf(
  field: Field,
  shapes: readonly (readonly Pt[])[],
  per: number,
  vid: Int32Array,
  vStart: Int32Array,
  vTiles: Int32Array,
): readonly Pt[] {
  const { count, types } = field;
  // An edge belongs to one tile when no other tile has both its corners.
  const shared = (u: number, w: number, i: number): boolean => {
    for (let q = vStart[u]; q < vStart[u + 1]; q++) {
      const b = vTiles[q];
      if (b === i) continue;
      for (let r = vStart[w]; r < vStart[w + 1]; r++) if (vTiles[r] === b) return true;
    }
    return false;
  };
  const order = new Int32Array(vStart.length - 1).fill(-1);
  let next = 0;
  const idOf = (v: number): number => (order[v] < 0 ? (order[v] = next++) : order[v]);
  const where = new Map<number, number>(); // scan id → (tile * per + corner), the first sighting
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (let i = 0; i < count; i++) {
    const m = shapes[types[i]].length;
    const corner = (k: number): number => {
      const v = vid[i * per + k];
      const fresh = order[v] < 0;
      const id = idOf(v);
      if (fresh) where.set(id, i * per + k);
      return id;
    };
    let prevK = m - 1;
    let prev = corner(prevK);
    for (let k = 0; k < m; k++) {
      const cur = corner(k);
      if (!shared(vid[i * per + prevK], vid[i * per + k], i)) {
        const u = Math.min(prev, cur);
        const w = Math.max(prev, cur);
        link(u, w);
        link(w, u);
      }
      prev = cur;
      prevK = k;
    }
  }
  const edgeKey = (u: number, v: number): number => (u < v ? u * 0x4000000 + v : v * 0x4000000 + u);
  const used = new Set<number>();
  let best: number[] = [];
  for (const start of adj.keys()) {
    const loop: number[] = [start];
    let cur = start;
    for (;;) {
      const nextV = adj.get(cur)!.find((x) => !used.has(edgeKey(cur, x)));
      if (nextV === undefined) break;
      used.add(edgeKey(cur, nextV));
      if (nextV === start) break;
      loop.push(nextV);
      cur = nextV;
    }
    if (loop.length > best.length) best = loop;
  }
  return best.map((id) => {
    const j = where.get(id)!;
    const i = Math.floor(j / per);
    return transPt(tileXform(field, i), shapes[types[i]][j % per]);
  });
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

/** Tiles whose centres lie strictly inside `poly` — a closed circuit's interior. */
export function tilesInsidePolygon(field: Field, poly: readonly Pt[]): number[] {
  if (poly.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const out: number[] = [];
  for (const i of tilesInBox(field, { minX, minY, maxX, maxY })) {
    const c = { x: field.centers[i * 2], y: field.centers[i * 2 + 1] };
    if (c.x < minX || c.x > maxX || c.y < minY || c.y > maxY) continue;
    if (pointInPolygon(c, poly)) out.push(i);
  }
  return out;
}

/**
 * Each tile's neighbour across each of its edges (edge k runs from polygon
 * point k to k + 1), or -1 on the board's edge. Worked out a tile at a time,
 * as a fill first reaches it. Vertex neighbours aren't enough to fill with: on
 * the Spectre board tiles of both sides of a line can meet at one corner.
 */
interface EdgeNeighbours {
  readonly per: number;
  /** `per` slots a tile; -2 = not worked out yet. */
  readonly nb: Int32Array;
}
const edgeCache = new WeakMap<Field, EdgeNeighbours>();

function edgeNeighbours(field: Field): EdgeNeighbours {
  let e = edgeCache.get(field);
  if (!e) {
    const per = Math.max(...field.leafTypes.map((t) => leafPts(field.family, t).length));
    e = { per, nb: new Int32Array(field.count * per).fill(-2) };
    edgeCache.set(field, e);
  }
  return e;
}

/** How many edges `acrossEdge` takes per tile: the most any tile has (a smaller tile's spare ones answer -1 or less). */
export function edgeSlots(field: Field): number {
  return edgeNeighbours(field).per;
}

/** The tile across edge `k` of tile `i`, or -1 on the board's edge. */
export function acrossEdge(field: Field, i: number, k: number): number {
  const e = edgeNeighbours(field);
  const o = i * e.per;
  if (e.nb[o] === -2) {
    const poly = tilePolygon(field, i);
    const keys = poly.map((p) => vkey(p.x, p.y));
    for (let j = 0; j < poly.length; j++) e.nb[o + j] = -1;
    for (const n of tileNeighbours(field, i)) {
      const nkeys = new Set(tilePolygon(field, n).map((p) => vkey(p.x, p.y)));
      for (let j = 0; j < poly.length; j++) {
        if (nkeys.has(keys[j]) && nkeys.has(keys[(j + 1) % poly.length])) e.nb[o + j] = n;
      }
    }
  }
  return e.nb[o + k];
}

/**
 * Work out every tile's `acrossEdge` now. It is lazy, so the first fill
 * through a region pays for it — a claim round a fifth of a hex-5 board
 * took 60–75 ms in the engine's once-a-second `updateCover`, ~25 ms warm.
 * ~1.4 s at hex level 6: the server and solo do it at startup, with
 * `fieldOutline`.
 */
export function warmEdges(field: Field): void {
  for (let i = 0; i < field.count; i++) acrossEdge(field, i, 0);
}

/** Which tiles a fill has already reached (or may not enter): `mark[tile] === stamp`. */
const fillMarks = new WeakMap<Field, { mark: Uint32Array; stamp: number }>();

/**
 * The tiles a closed line encloses, found by filling from the line inward:
 * seeded with the tiles next to the line on its inside, spread across shared
 * edges, stopped by the line's own tiles and the board's edge. Its cost is
 * the size of the inside — testing every tile against the whole loop
 * (`tilesInsidePolygon`) took seconds for a circuit round half the board.
 *
 * The inside is the side of the line its polygon (`region`, for an
 * edge-to-edge claim, else the loop itself) lies on: the polygon's turning
 * direction says whether that is left or right of travel. Within each tile
 * the chord splits the tile's edges in two; the edges on the inside side
 * give the seeds. The tiles come out in order of distance from the line,
 * `rings[r]` being where ring r starts, so the fill can be shown spreading.
 *
 * Should a fill outgrow the polygon's area (it would leak through a gap — a
 * bug), the old test answers instead.
 */
export function tilesEnclosed(
  field: Field,
  steps: readonly { readonly tile: number; readonly a: Pt; readonly b: Pt }[],
  region?: readonly Pt[],
): { tiles: number[]; rings: number[] } {
  const poly = region ?? steps.map((s) => s.a);
  if (poly.length < 3 || steps.length === 0) return { tiles: [], rings: [] };
  const area = signedArea(poly);
  const insideLeft = area > 0;
  let marks = fillMarks.get(field);
  if (!marks) fillMarks.set(field, (marks = { mark: new Uint32Array(field.count), stamp: 0 }));
  const stamp = ++marks.stamp;
  const mark = marks.mark;
  for (const s of steps) mark[s.tile] = stamp;
  const tiles: number[] = [];
  // A loop can cross a tile more than once, so each tile's outline is split
  // by all of its chords: sorted round the outline, every chord end starts a
  // stretch on one side of its chord, and that stretch's edges seed if that
  // side is the inside.
  const byTile = new Map<number, { a: Pt; b: Pt }[]>();
  for (const s of steps) {
    const list = byTile.get(s.tile);
    if (list) list.push(s);
    else byTile.set(s.tile, [s]);
  }
  for (const [tile, chords] of byTile) {
    const v = tilePolygon(field, tile);
    const m = v.length;
    const ends: { edge: number; at: number; inside: boolean }[] = [];
    for (const c of chords) {
      const ia = nearestEdge(v, c.a);
      const ib = nearestEdge(v, c.b);
      if (ia === ib) continue;
      // The outline from a round to b and the chord bound one part of the
      // tile; its turning says which side of a→b that part is on.
      const arc: Pt[] = [c.a];
      for (let k = (ia + 1) % m; k !== (ib + 1) % m; k = (k + 1) % m) arc.push(v[k]);
      arc.push(c.b);
      const arcInside = signedArea(arc) < 0 === insideLeft;
      const along = (k: number, p: Pt): number => Math.hypot(p.x - v[k].x, p.y - v[k].y);
      ends.push({ edge: ia, at: along(ia, c.a), inside: arcInside });
      ends.push({ edge: ib, at: along(ib, c.b), inside: !arcInside });
    }
    if (ends.length === 0) continue;
    ends.sort((x, y) => x.edge - y.edge || x.at - y.at);
    const has = new Set(ends.map((e) => e.edge));
    for (let k = 0; k < m; k++) {
      if (has.has(k)) continue;
      // The last chord end before this edge, going round the outline.
      let before = ends[ends.length - 1];
      for (const e of ends) if (e.edge < k) before = e;
      if (!before.inside) continue;
      const n = acrossEdge(field, tile, k);
      if (n >= 0 && mark[n] !== stamp) {
        mark[n] = stamp;
        tiles.push(n);
      }
    }
  }
  // A little over the polygon's own area, in tiles: any more and it leaked.
  const cap = Math.ceil((Math.abs(area) / field.tileArea) * 1.25) + 16;
  const rings: number[] = [];
  for (let start = 0; start < tiles.length; ) {
    rings.push(start);
    const end = tiles.length;
    for (let q = start; q < end; q++) {
      const t = tiles[q];
      const per = tilePolygon(field, t).length;
      for (let k = 0; k < per; k++) {
        const n = acrossEdge(field, t, k);
        if (n >= 0 && mark[n] !== stamp) {
          mark[n] = stamp;
          tiles.push(n);
        }
      }
    }
    if (tiles.length > cap) {
      const old = new Set(steps.map((s) => s.tile));
      return { tiles: tilesInsidePolygon(field, poly).filter((t) => !old.has(t)), rings: [0] };
    }
    start = end;
  }
  return { tiles, rings };
}

/** Shoelace area with its sign: positive when the points run anticlockwise. */
function signedArea(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** The edge of polygon `v` that point `p` lies on (the nearest). */
function nearestEdge(v: readonly Pt[], p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < v.length; k++) {
    const d = pointSegDist2(p, v[k], v[(k + 1) % v.length]);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export function pointSegDist2(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = a.x + vx * t - p.x;
  const dy = a.y + vy * t - p.y;
  return dx * dx + dy * dy;
}

/**
 * Is `p` (a point on the outline of tile `i`) on the edge of the field — no
 * other tile touches it? A line that dies there ran off the board, rather than
 * into a tail of its rule.
 */
export function onFieldBoundary(field: Field, i: number, p: Pt): boolean {
  const eps2 = 1e-6;
  for (const n of tileNeighbours(field, i)) {
    const poly = tilePolygon(field, n);
    for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
      if (pointSegDist2(p, poly[j], poly[k]) < eps2) return false;
    }
  }
  return true;
}

const outlineCache = new WeakMap<Field, readonly Pt[]>();

/**
 * The field's outer boundary as one closed polygon: the tile edges that belong
 * to a single tile, chained end to end. Where the outline pinches into several
 * loops the longest (the outer one) wins. Built once per field, on demand.
 */
export function fieldOutline(field: Field): readonly Pt[] {
  const hit = outlineCache.get(field);
  if (hit) return hit;
  const out = chainOutline(field.count, (i) => tilePolygon(field, i));
  outlineCache.set(field, out);
  return out;
}

/**
 * The outer boundary of any set of polygons that tile a patch (`polygonAt(i)`
 * for `i < count`): the edges that belong to one polygon only, chained into
 * the longest loop. `fieldOutline` is this over the field's tiles; the
 * client's Spectre view runs it over its own pieces.
 */
export function chainOutline(count: number, polygonAt: (i: number) => readonly Pt[]): readonly Pt[] {
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

/**
 * A line that runs from the field's edge to the field's edge cuts the board in
 * two; the smaller side is the region it claims. `line` is the line's points in
 * order, first and last on the outline. Returns the region's polygon (the line,
 * then the outline back to its start), or null when an end is off the outline.
 */
export function boundaryRegion(field: Field, line: readonly Pt[]): Pt[] | null {
  const ring = fieldOutline(field);
  const n = ring.length;
  if (n < 3 || line.length < 2) return null;
  const edgeOf = (p: Pt): number => {
    let best = -1;
    let bestD = 1e-4;
    for (let k = 0; k < n; k++) {
      const d = pointSegDist2(p, ring[k], ring[(k + 1) % n]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const start = line[0];
  const end = line[line.length - 1];
  const es = edgeOf(start);
  const ee = edgeOf(end);
  if (es < 0 || ee < 0) return null;
  // Walk the ring from the end back to the start, both ways round. Both ends on
  // one edge: one way is direct, the other goes all the way round.
  const t = (p: Pt, k: number): number => {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    return (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  };
  const endFirst = es === ee && t(end, ee) < t(start, es);
  const fwdSteps = (es - ee + n) % n || (es === ee && !endFirst ? n : 0);
  const backSteps = (ee - es + n) % n || (es === ee && endFirst ? n : 0);
  const forward: Pt[] = [];
  for (let j = 0; j < fwdSteps; j++) forward.push(ring[(ee + 1 + j) % n]);
  const backward: Pt[] = [];
  for (let j = 0; j < backSteps; j++) backward.push(ring[(ee - j + n) % n]);
  const a = [...line, ...forward];
  const b = [...line, ...backward];
  return polygonArea(a) <= polygonArea(b) ? a : b;
}

/** The polygon a closed path encloses: its own loop, or the region it claims against the edge. */
export function pathPolygon(path: { readonly steps: readonly { readonly a: Pt }[]; readonly region?: readonly Pt[] }): readonly Pt[] {
  return path.region ?? path.steps.map((s) => s.a);
}