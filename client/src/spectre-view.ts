/**
 * The Spectre view of a hexagon arena: the same board drawn as Spectres, and
 * the morph between the two. Client-only — the server never hears of it. The
 * two tilings are isomorphic: every hexagon is a Spectre (a Gamma is the
 * Mystic, two Spectres), every seam of the hexagon is a seam of its Spectre
 * with the same class (the 'spectre-iso' labels), so every hex tile index,
 * chord and step of the game has one place in the Spectre tiling.
 *
 * The view lives in the hexagon world's coordinates: the Spectre patch is
 * fitted to the hexagon patch by a least-squares similarity (rotation, scale,
 * shift) over the tiles' centres. What is left is local — under half a unit
 * per tile at level 6 — so the camera never moves, and the morph is each
 * vertex gliding from its hexagon home to its Spectre position in place.
 * (Spectre's own morph interpolates the two patches as built, with ~21° of
 * net rotation between them; the fit takes that out.)
 *
 * Where a Spectre vertex sits in the hexagon view (`homes`) is label
 * arithmetic per leaf type, in the hex tile's own frame — so the WebGL layer
 * morphs instanced, one shape per Spectre leaf type with the hex parent's
 * transform beside the Spectre's. A vertex that starts (or ends) an edge of
 * seam `k` sits on the hexagon's `k` edge, the seam's minors spread evenly
 * along it; the Mystic's internal seam slides between its placed ends; and
 * Gamma2's thin `6` | `-6` wedge — the stand-in for the hexagons' Delta–Sigma
 * edge, which the hexagon Gamma does not have — collapses on to that edge
 * (its two sides on the Delta's `-6` seam and the Sigma's `6` seam, which
 * always flank it: the wedge sits inside the supertile rules, never at the
 * board's edge).
 *
 * Lines: a hex step's chord runs dot to dot; in the view it runs between the
 * same seams' Spectre dots. The Mystic is treated as one tile, so a chord of
 * the hexagon Gamma that crosses the class-7 seam goes straight from its
 * Gamma1 dot to its Gamma2 dot. The Gamma2 wedge's own chord (its `6` dot to
 * its `-6` dot, there only when class 6 is in the rule) belongs to no hex
 * chord; it is given to the Delta's chord ending on the Delta's `-6` seam,
 * which carries on across the wedge to the Sigma's `6` dot — where the
 * Sigma's own chord starts, so the line stays unbroken.
 */

import {
  DEFAULT_CONTRACTS,
  buildSystem,
  connectionPoints,
  edgeLabels,
  flatten,
  leafOrder,
  leafPts,
  lerpPt,
  mul,
  parseEdgeLabel,
  transPt,
  type Affine,
  type Pt,
  type TileFamilyId,
  type TileTypeId,
} from '../../shared/tiles';
import { acrossEdge, chainOutline, fieldOutline, pointInPolygon, pointSegDist2, tileAt, tileCenter, tilePolygon, tileType, type Box, type Field } from '../../shared/game/field';
import type { ChordTable } from '../../shared/game/strand';
import type { PathStepWire } from '../../shared/game/protocol';

/** The Spectre family whose seams match the hexagons' one for one. */
export const VIEW_FAMILY: TileFamilyId = 'spectre-iso';

export interface SpectreView {
  /** The hexagon field this is the view of. */
  readonly field: Field;
  /** Spectre pieces (every hex tile has one; a Gamma has two: Gamma1 then Gamma2). */
  readonly count: number;
  readonly leafTypes: readonly TileTypeId[];
  /** `leafTypes` index per piece. */
  readonly types: Uint8Array;
  /** 6 doubles per piece: its transform, fitted into the hex world. */
  readonly xforms: Float64Array;
  /** Hex tile per piece. */
  readonly parent: Int32Array;
  /** Hex tile → its first piece; `first[count]` closes it (pieces of a tile are contiguous). */
  readonly first: Int32Array;
  /** Per leaf type, each Spectre vertex's home in the hex parent's own frame. */
  readonly homes: readonly (readonly Pt[])[];
  /** 2 doubles per hex tile: the centre of its piece(s) in the view, for the odd point with no better map. */
  readonly centers: Float64Array;
  readonly bounds: Box;
  /** The similarity that fitted the Spectre patch to the hex patch. */
  readonly align: Affine;
}

const viewCache = new WeakMap<Field, SpectreView>();

const tagOf = (e: { readonly sign: number; readonly major: number; readonly variant: string }): string =>
  `${e.sign < 0 ? '-' : ''}${e.major}${e.variant}`;

/** The hexagon leaf a Spectre leaf stands on: the Mystic's halves on the Gamma, the rest on their namesake. */
export const hexTypeOf = (type: TileTypeId): TileTypeId => (type === 'Gamma1' || type === 'Gamma2' ? 'Gamma' : type);

/**
 * Where each vertex of a Spectre leaf sits in the hexagon view, in the hex
 * parent's frame (the hexagon Gamma's for both halves of the Mystic).
 */
export function vertexHomes(type: TileTypeId): readonly Pt[] {
  const hexType = hexTypeOf(type);
  const hexPts = leafPts('hex', hexType);
  const hexLabels = edgeLabels('hex', hexType).map(parseEdgeLabel);
  const labels = edgeLabels(VIEW_FAMILY, type).map(parseEdgeLabel);
  // Seam lengths in minors over the whole hexagon tile: the Mystic's class-2
  // seam runs from Gamma2 into Gamma1.
  const mates =
    hexType === 'Gamma' ? [...edgeLabels(VIEW_FAMILY, 'Gamma1'), ...edgeLabels(VIEW_FAMILY, 'Gamma2')].map(parseEdgeLabel) : labels;
  const seamLength = (l: (typeof labels)[number]): number =>
    1 + Math.max(...mates.filter((m) => m.sign === l.sign && m.major === l.major && m.variant === l.variant).map((m) => m.minor));
  /** Where along its hexagon edge an edge of this label starts or ends, or null when the hexagon has no such seam. */
  const along = (edge: number, end: boolean): Pt | null => {
    const l = labels[edge];
    const e = hexLabels.findIndex((h) => h.sign === l.sign && h.major === l.major && h.variant === l.variant);
    if (e < 0) return null;
    const n = seamLength(l);
    // A `-k.m` edge glues to `k.m` reversed, so negative seams count down.
    const start = l.sign > 0 ? l.minor / n : (n - 1 - l.minor) / n;
    return lerpPt(hexPts[e], hexPts[(e + 1) % hexPts.length], end ? start + 1 / n : start);
  };
  const n = labels.length;
  const placed: (Pt | null)[] = labels.map((_, k) => along(k, false) ?? along((k - 1 + n) % n, true));
  if (type === 'Gamma2') {
    // The `6` | `-6` wedge (vertices 4–8) lies flat on the Delta–Sigma edge
    // that leaves the Gamma's vertex 3: both of its sides on that unit edge,
    // its tip at the far end. In a hexagon tiling three edges meet at 120°,
    // so the third edge at a vertex is opposite the bisector of the other two.
    const p3 = hexPts[3];
    const u2 = { x: hexPts[2].x - p3.x, y: hexPts[2].y - p3.y };
    const u4 = { x: hexPts[4].x - p3.x, y: hexPts[4].y - p3.y };
    const dx = -(u2.x + u4.x);
    const dy = -(u2.y + u4.y);
    const len = Math.hypot(dx, dy);
    const far = { x: p3.x + dx / len, y: p3.y + dy / len };
    const mid = lerpPt(p3, far, 0.5);
    placed[4] = p3;
    placed[5] = mid;
    placed[6] = far;
    placed[7] = mid;
    placed[8] = p3;
  }
  // Vertices with no hexagon counterpart (the Mystic's internal seam) slide
  // between their nearest placed neighbours round the outline.
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const p = placed[k];
    if (p) {
      out.push(p);
      continue;
    }
    let back = 1;
    while (back < n && !placed[(k - back + n) % n]) back++;
    let fwd = 1;
    while (fwd < n && !placed[(k + fwd) % n]) fwd++;
    out.push(lerpPt(placed[(k - back + n) % n]!, placed[(k + fwd) % n]!, back / (back + fwd)));
  }
  return out;
}

/**
 * Least-squares similarity (rotation, uniform scale, shift) taking points
 * `b` on to points `a`, as an affine.
 */
export function fitSimilarity(a: readonly Pt[], b: readonly Pt[]): Affine {
  const n = Math.min(a.length, b.length);
  if (n === 0) return [1, 0, 0, 0, 1, 0];
  let max = 0, may = 0, mbx = 0, mby = 0;
  for (let i = 0; i < n; i++) {
    max += a[i].x;
    may += a[i].y;
    mbx += b[i].x;
    mby += b[i].y;
  }
  max /= n;
  may /= n;
  mbx /= n;
  mby /= n;
  let sxx = 0, sxy = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[i].x - max, ay = a[i].y - may, bx = b[i].x - mbx, by = b[i].y - mby;
    sxx += bx * ax + by * ay;
    sxy += bx * ay - by * ax;
    nb += bx * bx + by * by;
  }
  if (nb === 0) return [1, 0, max - mbx, 0, 1, may - mby];
  const theta = Math.atan2(sxy, sxx);
  const s = Math.hypot(sxx, sxy) / nb;
  const c = s * Math.cos(theta);
  const d = s * Math.sin(theta);
  return [c, -d, max - (c * mbx - d * mby), d, c, may - (d * mbx + c * mby)];
}

/** The Spectre view of a hexagon field, built once per field. Throws on any other family. */
export function spectreView(field: Field): SpectreView {
  const hit = viewCache.get(field);
  if (hit) return hit;
  if (field.family !== 'hex') throw new Error(`no Spectre view of a ${field.family} field`);
  const sys = buildSystem(VIEW_FAMILY, field.spec.level);
  const instances = flatten(sys[field.spec.rootTile] ?? sys['Delta']);
  const count = instances.length;
  const leafTypes = leafOrder(VIEW_FAMILY);
  const typeIndex = new Map<string, number>(leafTypes.map((t, i) => [t, i]));
  const types = new Uint8Array(count);
  const parent = new Int32Array(count);
  const first = new Int32Array(field.count + 1).fill(-1);
  // Both families come out of the same substitution tree in the same order,
  // the hexagon Gamma standing where the Mystic's two halves stand — so the
  // pieces walk the hex tiles in step.
  let h = 0;
  for (let s = 0; s < count; s++) {
    const inst = instances[s];
    if (h >= field.count || tileType(field, h) !== hexTypeOf(inst.type)) {
      throw new Error(`Spectre view: piece ${s} (${inst.type}) has no hex tile ${h} to stand on`);
    }
    types[s] = typeIndex.get(inst.type) ?? 0;
    parent[s] = h;
    if (first[h] < 0) first[h] = s;
    if (inst.type !== 'Gamma1') h++;
  }
  if (h !== field.count) throw new Error(`Spectre view: ${count} pieces for ${field.count} tiles`);
  first[field.count] = count;

  // Fit the Spectre patch over the hex patch: each hex tile's centre against
  // the centre of its piece(s). An affine map keeps centroids, so a piece's
  // centre is its transform on the leaf's.
  const leafCentre = (() => {
    const pts = leafPts(VIEW_FAMILY, 'Delta');
    let x = 0, y = 0;
    for (const p of pts) {
      x += p.x / pts.length;
      y += p.y / pts.length;
    }
    return { x, y };
  })();
  const hexCentres: Pt[] = [];
  const specCentres: Pt[] = [];
  for (let i = 0; i < field.count; i++) {
    let x = 0, y = 0;
    const n = first[i + 1] - first[i];
    for (let s = first[i]; s < first[i + 1]; s++) {
      const c = transPt(instances[s].xform, leafCentre);
      x += c.x / n;
      y += c.y / n;
    }
    hexCentres.push(tileCenter(field, i));
    specCentres.push({ x, y });
  }
  const align = fitSimilarity(hexCentres, specCentres);

  const xforms = new Float64Array(count * 6);
  const centers = new Float64Array(field.count * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let s = 0; s < count; s++) {
    const X = mul(align, instances[s].xform);
    for (let k = 0; k < 6; k++) xforms[s * 6 + k] = X[k];
    for (const p of leafPts(VIEW_FAMILY, instances[s].type)) {
      const w = transPt(X, p);
      if (w.x < minX) minX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.x > maxX) maxX = w.x;
      if (w.y > maxY) maxY = w.y;
    }
  }
  for (let i = 0; i < field.count; i++) {
    const c = transPt(align, specCentres[i]);
    centers[i * 2] = c.x;
    centers[i * 2 + 1] = c.y;
  }
  const homes = leafTypes.map(vertexHomes);
  const view: SpectreView = {
    field,
    count,
    leafTypes,
    types,
    xforms,
    parent,
    first,
    homes,
    centers,
    bounds: { minX, minY, maxX, maxY },
    align,
  };
  viewCache.set(field, view);
  return view;
}

/** Piece `s`'s transform. */
export function pieceXform(view: SpectreView, s: number): Affine {
  const x = view.xforms;
  const o = s * 6;
  return [x[o], x[o + 1], x[o + 2], x[o + 3], x[o + 4], x[o + 5]];
}

/**
 * Piece `s`'s outline `t` of the way from the hexagon view (0) to the Spectre
 * view (1), in world coordinates.
 */
export function viewPolygon(view: SpectreView, s: number, t: number, out: Pt[] = []): Pt[] {
  const type = view.leafTypes[view.types[s]];
  const pts = leafPts(VIEW_FAMILY, type);
  const X = pieceXform(view, s);
  out.length = 0;
  if (t >= 1) {
    for (const p of pts) out.push(transPt(X, p));
    return out;
  }
  const homes = view.homes[view.types[s]];
  const H = hexXform(view.field, view.parent[s]);
  for (let k = 0; k < pts.length; k++) {
    const a = transPt(H, homes[k]);
    if (t <= 0) {
      out.push(a);
      continue;
    }
    const b = transPt(X, pts[k]);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function hexXform(field: Field, i: number): Affine {
  const x = field.xforms;
  const o = i * 6;
  return [x[o], x[o + 1], x[o + 2], x[o + 3], x[o + 4], x[o + 5]];
}

const outlineCache = new WeakMap<SpectreView, readonly Pt[]>();

/** Per Spectre leaf type, the hexagon edge each physical edge is part of (its seam's), or -1 (the internal seam, the wedge). */
const hexEdgeCache = new Map<string, readonly number[]>();
function hexEdgeOf(type: TileTypeId): readonly number[] {
  let hit = hexEdgeCache.get(type);
  if (!hit) {
    const hexLabels = edgeLabels('hex', hexTypeOf(type)).map(parseEdgeLabel);
    hit = edgeLabels(VIEW_FAMILY, type)
      .map(parseEdgeLabel)
      .map((l) => hexLabels.findIndex((h) => h.sign === l.sign && h.major === l.major && h.variant === l.variant));
    hexEdgeCache.set(type, hit);
  }
  return hit;
}

/**
 * The board's edge in the Spectre view, built once, on demand. Every edge of
 * the hexagon board's outline is one seam of one tile, and the Spectre
 * outline is those seams' physical edges on the tile's pieces, in order — so
 * it is read off the hexagon outline (`fieldOutline`) a tile at a time, at a
 * cost that goes with the edge, not the board (chaining every piece's edges
 * took 4 s at level 6). Anything unexpected falls back to that chaining.
 */
export function viewOutline(view: SpectreView): readonly Pt[] {
  let out = outlineCache.get(view);
  if (!out) {
    out = outlineFromHex(view) ?? chainOutline(view.count, (s) => viewPolygon(view, s, 1));
    outlineCache.set(view, out);
  }
  return out;
}

function outlineFromHex(view: SpectreView): Pt[] | null {
  const field = view.field;
  const ring = fieldOutline(field);
  const n = ring.length;
  if (n < 3) return null;
  const g = field.grid;
  const same = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  const out: Pt[] = [];
  const poly: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const u = ring[k];
    const v = ring[(k + 1) % n];
    // The tile this edge of the outline belongs to: in the grid cells round its middle.
    const cx = Math.floor(((u.x + v.x) / 2 - g.minX) / g.cell);
    const cy = Math.floor(((u.y + v.y) / 2 - g.minY) / g.cell);
    let tile = -1;
    let edge = -1;
    let forward = true;
    for (let dy = -1; dy <= 1 && tile < 0; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= g.rows) continue;
      for (let dx = -1; dx <= 1 && tile < 0; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= g.cols) continue;
        const c = y * g.cols + x;
        for (let q = g.start[c]; q < g.start[c + 1] && tile < 0; q++) {
          const i = g.items[q];
          const hex = tilePolygon(field, i);
          for (let e = 0; e < hex.length; e++) {
            const a = hex[e];
            const b = hex[(e + 1) % hex.length];
            if (same(a, u) && same(b, v)) {
              tile = i;
              edge = e;
              forward = true;
              break;
            }
            if (same(a, v) && same(b, u)) {
              tile = i;
              edge = e;
              forward = false;
              break;
            }
          }
        }
      }
    }
    if (tile < 0) return null;
    // The pieces' edges on that seam, chained end to end (the Mystic's class-2 seam spans both halves).
    const segs: [Pt, Pt][] = [];
    for (let s = view.first[tile]; s < view.first[tile + 1]; s++) {
      const map = hexEdgeOf(view.leafTypes[view.types[s]]);
      viewPolygon(view, s, 1, poly);
      for (let j = 0; j < map.length; j++) {
        if (map[j] === edge) segs.push([poly[j], poly[(j + 1) % poly.length]]);
      }
    }
    if (segs.length === 0) return null;
    if (!forward) for (const seg of segs) seg.reverse();
    const starts = segs.filter((seg) => !segs.some((o) => o !== seg && same(o[1], seg[0])));
    if (starts.length !== 1) return null;
    let cur = starts[0];
    const chained: Pt[] = [cur[0]];
    for (let m = 0; m < segs.length; m++) {
      chained.push(cur[1]);
      const next = segs.find((o) => same(o[0], cur[1]));
      if (!next) break;
      cur = next;
    }
    if (chained.length !== segs.length + 1) return null;
    // Each run ends where the next starts.
    for (let m = 0; m < chained.length - 1; m++) out.push(chained[m]);
  }
  return out;
}

/**
 * The hex tile whose piece lies under world point `p` in the view `t` of the
 * way across, or -1. The pieces sit within half a unit of their hexagons, so
 * the hex grid's cells round `p` hold every candidate.
 */
export function viewTileAt(view: SpectreView, p: Pt, t = 1): number {
  const field = view.field;
  const g = field.grid;
  const cx = Math.floor((p.x - g.minX) / g.cell);
  const cy = Math.floor((p.y - g.minY) / g.cell);
  const poly: Pt[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= g.rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= g.cols) continue;
      const c = y * g.cols + x;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const i = g.items[k];
        for (let s = view.first[i]; s < view.first[i + 1]; s++) {
          if (pointInPolygon(p, viewPolygon(view, s, t, poly))) return i;
        }
      }
    }
  }
  return tileAt(field, p);
}

/**
 * A hex-world point carried into the view: shifted by what its tile's centre
 * moves. For points no chord end pins down (a collision's sparks, a mote).
 */
export function viewPoint(view: SpectreView, p: Pt, t: number): Pt {
  if (t <= 0) return p;
  const i = tileAt(view.field, p);
  if (i < 0) return p;
  const dx = view.centers[i * 2] - view.field.centers[i * 2];
  const dy = view.centers[i * 2 + 1] - view.field.centers[i * 2 + 1];
  return { x: p.x + dx * t, y: p.y + dy * t };
}

// ---------------------------------------------------------------------------
// Chords and steps
// ---------------------------------------------------------------------------

/**
 * One point of a chord's polyline in the view: on which piece of the hex tile
 * (0 = its first, 1 = a Gamma's second, 2 = the Sigma across the Delta's `-6`
 * edge), where in that piece's frame, and which end of the hex chord it
 * belongs to (what it comes from in the morph).
 */
interface ViewPt {
  readonly piece: 0 | 1 | 2;
  readonly x: number;
  readonly y: number;
  readonly end: 0 | 1;
}

interface ViewTable {
  readonly key: string;
  /** Indexed like `ChordTable.byType`, then by chord: the polyline from end 0 to end 1. */
  readonly byType: readonly (readonly (readonly ViewPt[])[])[];
}

const viewTables = new Map<string, ViewTable>();

/** The hex Delta's edge carrying its `-6.0A` label (the Delta–Sigma edge). */
const DELTA_SIX_EDGE = edgeLabels('hex', 'Delta').findIndex((l) => parseEdgeLabel(l).major === 6 && parseEdgeLabel(l).minor === 0);

/** The Sigma's `6` dot in its own frame — the far end of the wedge, where the Sigma's chord starts. */
const SIGMA_SIX: Pt = connectionPoints(VIEW_FAMILY, 'Sigma', new Set([6]), DEFAULT_CONTRACTS)[0].pt;

function viewTable(field: Field, table: ChordTable): ViewTable {
  const key = table.key;
  const hit = viewTables.get(key);
  if (hit) return hit;
  const selected = new Set(table.rule.subset);
  const near = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  const byType = field.leafTypes.map((hexType, ti) => {
    const hexDots = connectionPoints('hex', hexType, selected, DEFAULT_CONTRACTS).map((c) => ({ tag: tagOf(c.edge), pt: c.pt }));
    const dots = new Map<string, { piece: 0 | 1; pt: Pt }>();
    const pieces: readonly (readonly [0 | 1, TileTypeId])[] = hexType === 'Gamma' ? [[0, 'Gamma1'], [1, 'Gamma2']] : [[0, hexType]];
    for (const [piece, type] of pieces) {
      for (const c of connectionPoints(VIEW_FAMILY, type, selected, DEFAULT_CONTRACTS)) dots.set(tagOf(c.edge), { piece, pt: c.pt });
    }
    const endPts = (hexPt: Pt, end: 0 | 1): ViewPt[] => {
      const dot = hexDots.find((d) => near(d.pt, hexPt));
      const v = dot && dots.get(dot.tag);
      if (!dot || !v) return [];
      const out: ViewPt[] = [{ piece: v.piece, x: v.pt.x, y: v.pt.y, end }];
      // The Delta's `-6` end carries on across Gamma2's wedge to the Sigma's `6` dot.
      if (hexType === 'Delta' && dot.tag === '-6A') out.push({ piece: 2, x: SIGMA_SIX.x, y: SIGMA_SIX.y, end });
      return out;
    };
    // Each end's points run from the chord's own dot outward, so the start end is reversed.
    return table.byType[ti].map(([p, q]) => [...endPts(p, 0).reverse(), ...endPts(q, 1)]);
  });
  const out: ViewTable = { key, byType };
  viewTables.set(key, out);
  return out;
}

/**
 * The polyline a hex step draws in the view `t` of the way across, as flat
 * `x, y` pairs into `out` — from where the step arrives to where it leaves,
 * two points, or three when the Delta's chord carries on over the wedge.
 */
export function viewStep(view: SpectreView, table: ChordTable, step: PathStepWire, t: number, out: number[]): number[] {
  const field = view.field;
  const i = step.tile;
  const ti = field.types[i];
  const pts = viewTable(field, table).byType[ti]?.[step.chord];
  out.length = 0;
  if (!pts || pts.length < 2) {
    out.push(step.a.x, step.a.y, step.b.x, step.b.y);
    return out;
  }
  // Which way the step runs the chord: end 0 of the table's chord is either where it arrived or where it leaves.
  const [p0] = table.byType[ti][step.chord];
  const H = hexXform(field, i);
  const x0 = H[0] * p0.x + H[1] * p0.y + H[2];
  const y0 = H[3] * p0.x + H[4] * p0.y + H[5];
  const forward = Math.abs(x0 - step.a.x) < 1e-6 && Math.abs(y0 - step.a.y) < 1e-6;
  const n = pts.length;
  for (let q = 0; q < n; q++) {
    const v = pts[forward ? q : n - 1 - q];
    let s: number;
    if (v.piece === 2) {
      const sigma = acrossEdge(field, i, DELTA_SIX_EDGE);
      if (sigma < 0) continue; // the board's edge: no Sigma, no wedge to cross
      s = view.first[sigma];
    } else s = view.first[i] + v.piece;
    const X = view.xforms;
    const o = s * 6;
    let x = X[o] * v.x + X[o + 1] * v.y + X[o + 2];
    let y = X[o + 3] * v.x + X[o + 4] * v.y + X[o + 5];
    if (t < 1) {
      // In the morph, each point comes from the hex end it belongs to.
      const hex = (v.end === 0) === forward ? step.a : step.b;
      x = hex.x + (x - hex.x) * t;
      y = hex.y + (y - hex.y) * t;
    }
    out.push(x, y);
  }
  return out;
}

/** Chord `c` of hex tile `i` in the view, as `viewStep` gives a step along it (end 0 to end 1). */
export function viewChord(view: SpectreView, table: ChordTable, i: number, c: number, t: number, out: number[]): number[] {
  const [a, b] = table.byType[view.field.types[i]][c];
  const H = hexXform(view.field, i);
  return viewStep(view, table, { tile: i, chord: c, a: transPt(H, a), b: transPt(H, b) }, t, out);
}

/**
 * The hex-world point to send for a tap at view point `p` on hex tile `i`:
 * the server picks the chord nearest the point it is sent, in hexagon
 * geometry, so the chord nearest the tap in the view is named by its hexagon
 * midpoint. A tile that draws nothing under the rule sends its centre.
 */
export function viewTap(view: SpectreView, table: ChordTable, i: number, p: Pt, t = 1): Pt {
  const field = view.field;
  const chords = table.byType[field.types[i]];
  let best = -1;
  let bestD = Infinity;
  const pts: number[] = [];
  for (let c = 0; c < chords.length; c++) {
    viewChord(view, table, i, c, t, pts);
    for (let k = 2; k < pts.length; k += 2) {
      const d = pointSegDist2(p, { x: pts[k - 2], y: pts[k - 1] }, { x: pts[k], y: pts[k + 1] });
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  if (best < 0) return tileCenter(field, i);
  const [a, b] = chords[best];
  const H = hexXform(field, i);
  const wa = transPt(H, a);
  const wb = transPt(H, b);
  return { x: (wa.x + wb.x) / 2, y: (wa.y + wb.y) / 2 };
}
