/**
 * Structured layer over the edge-label strings.
 *
 * Ports the ad-hoc label parsing scattered through `tiles.ts` / `analysis.ts`
 * and generalizes `getEdgeDotMidpoints` (tiles.ts:112–165) into explicit
 * "edge contracts" whose defaults reproduce the old placement exactly.
 */

import { lerpPt, type Pt } from './geom';
import { edgeLabels, leafOrder, leafPts, type TileFamilyId, type TileTypeId } from './families';

// ---------------------------------------------------------------------------
// Label parsing
// ---------------------------------------------------------------------------

export interface EdgeLabel {
  /** The original string, e.g. '-5.1A'. */
  readonly raw: string;
  /** +1, or -1 when the label carries a leading '-'. */
  readonly sign: 1 | -1;
  /** Edge class 0..8. */
  readonly major: number;
  /** Index of this physical edge within its meta-edge (seam). */
  readonly minor: number;
  /** 'A', or 'B' when a tile carries two distinct seams of the same class. */
  readonly variant: string;
}

const LABEL_RE = /^(-?)(\d+)\.(\d+)([A-Z])$/;

const labelCache = new Map<string, EdgeLabel>();

/**
 * Parse `[sign]MAJOR.MINOR[VARIANT]`.
 *
 * Note the old code used `lab.replace('-','').substring(2,3)` for the minor,
 * which silently breaks for multi-digit majors/minors; this regex does not.
 */
export function parseEdgeLabel(raw: string): EdgeLabel {
  const hit = labelCache.get(raw);
  if (hit) return hit;
  const m = LABEL_RE.exec(raw);
  if (!m) throw new Error(`Invalid edge label: ${JSON.stringify(raw)}`);
  const parsed: EdgeLabel = {
    raw,
    sign: m[1] === '-' ? -1 : 1,
    major: Number.parseInt(m[2], 10),
    minor: Number.parseInt(m[3], 10),
    variant: m[4],
  };
  labelCache.set(raw, parsed);
  return parsed;
}

/** Inverse of {@link parseEdgeLabel}. */
export function formatEdgeLabel(l: Omit<EdgeLabel, 'raw'>): string {
  return `${l.sign < 0 ? '-' : ''}${l.major}.${l.minor}${l.variant}`;
}

/** All edge classes (majors) that appear anywhere in a family's label tables. */
export function familyMajors(family: TileFamilyId): readonly number[] {
  const seen = new Set<number>();
  for (const type of leafOrder(family)) {
    for (const raw of edgeLabels(family, type)) seen.add(parseEdgeLabel(raw).major);
  }
  return [...seen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Meta-edges (seams)
// ---------------------------------------------------------------------------

/** A seam: a maximal cyclic run of physical edges sharing (sign, major, variant). */
export interface MetaEdge {
  /** Stable key for hit areas / URLs, e.g. 'Delta/-5A'. */
  readonly id: string;
  readonly tileType: TileTypeId;
  readonly major: number;
  readonly sign: 1 | -1;
  readonly variant: string;
  /** Indices into the tile's label/vertex arrays, in label order. */
  readonly edgeIndices: readonly number[];
  /** `minor` of each entry of {@link edgeIndices}. */
  readonly minors: readonly number[];
  /** Parsed labels of each entry of {@link edgeIndices}. */
  readonly labels: readonly EdgeLabel[];
}

const metaEdgeCache = new Map<string, readonly MetaEdge[]>();

function sameSeam(a: EdgeLabel, b: EdgeLabel): boolean {
  return a.sign === b.sign && a.major === b.major && a.variant === b.variant;
}

/**
 * Seams of a tile, in label order (a seam that wraps past the end of the
 * label array — Sigma's class-4 seam — is returned as one group).
 */
export function metaEdges(family: TileFamilyId, type: TileTypeId): readonly MetaEdge[] {
  const cacheKey = `${family}/${type}`;
  const cached = metaEdgeCache.get(cacheKey);
  if (cached) return cached;

  const labels = edgeLabels(family, type);
  const n = labels.length;
  const out: MetaEdge[] = [];
  if (n > 0) {
    const parsed = labels.map(parseEdgeLabel);

    // Rotate so we start at a seam boundary (handles wrap-around runs).
    let start = 0;
    while (start < n && sameSeam(parsed[(start - 1 + n) % n], parsed[start])) start++;
    if (start === n) start = 0; // whole tile is one seam

    let i = 0;
    while (i < n) {
      const head = parsed[(start + i) % n];
      const idxs: number[] = [(start + i) % n];
      let j = i + 1;
      while (j < n && sameSeam(parsed[(start + j) % n], head)) {
        idxs.push((start + j) % n);
        j++;
      }
      out.push({
        id: `${type}/${head.sign < 0 ? '-' : ''}${head.major}${head.variant}`,
        tileType: type,
        major: head.major,
        sign: head.sign,
        variant: head.variant,
        edgeIndices: idxs,
        minors: idxs.map((k) => parsed[k].minor),
        labels: idxs.map((k) => parsed[k]),
      });
      i = j;
    }
  }

  metaEdgeCache.set(cacheKey, out);
  return out;
}

/** The seam containing a given physical edge index. */
export function metaEdgeOfIndex(
  family: TileFamilyId,
  type: TileTypeId,
  edgeIndex: number,
): MetaEdge | null {
  for (const e of metaEdges(family, type)) {
    if (e.edgeIndices.includes(edgeIndex)) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edge contracts
// ---------------------------------------------------------------------------

/**
 * Where a drawn line crosses a seam of a given class, expressed on the
 * POSITIVE label orientation as (minor edge index, fraction t along that
 * physical edge in label direction). The negative-side placement is derived
 * automatically as (same minor, 1 - t) along the negative tile's own edge
 * direction, which is exactly the condition making abutting tiles' points
 * coincide.
 */
export interface EdgeContract {
  readonly minor: number;
  /** in [0, 1] */
  readonly t: number;
}

export type EdgeContracts = Readonly<Partial<Record<number, EdgeContract>>>;

/**
 * Defaults reproducing `getEdgeDotMidpoints` exactly:
 *  - signed classes: midpoint of the `.0` edge (t = 0.5 is self-mirroring,
 *    which is why the old code could ignore signs);
 *  - class 0 (self-gluing): the seam's center. For the two-edge spectre η seam
 *    that is the shared vertex after `0.0A`, canonically {minor: 0, t: 1}; in
 *    the hexagon family the seam is a single edge so the center is its
 *    midpoint (resolved automatically — see {@link seamCenterU}).
 */
export const DEFAULT_CONTRACTS: EdgeContracts = Object.freeze({
  0: { minor: 0, t: 1 },
  1: { minor: 0, t: 0.5 },
  2: { minor: 0, t: 0.5 },
  3: { minor: 0, t: 0.5 },
  4: { minor: 0, t: 0.5 },
  5: { minor: 0, t: 0.5 },
  6: { minor: 0, t: 0.5 },
  7: { minor: 0, t: 0.5 },
  8: { minor: 0, t: 0.5 },
});

/**
 * Position of a contract along a seam in "edge units": `u = minor + t`, so a
 * seam with M minors is parameterized by u in [0, M]. The gluing involution is
 * `u -> M - u`; class 0 glues to itself, so its contract must be the fixed
 * point `u = M / 2`.
 */
export function contractU(c: EdgeContract): number {
  return c.minor + c.t;
}

export function seamCenterU(seam: MetaEdge): number {
  return seam.edgeIndices.length / 2;
}

/** True when a class-0 contract is symmetric about the seam center. */
export function isSymmetricContract(c: EdgeContract, seam: MetaEdge): boolean {
  return Math.abs(contractU(c) - seamCenterU(seam)) < 1e-9;
}

export interface ValidateOptions {
  /** Throw instead of clamping (used in dev builds / tests). */
  readonly strict?: boolean;
}

/**
 * Clamp contracts into range and enforce the class-0 symmetry constraint.
 * Invalid class-0 entries are clamped to the seam center (or throw in strict
 * mode); out-of-range minors/t are clamped.
 */
export function validateContracts(
  family: TileFamilyId,
  contracts: EdgeContracts,
  opts: ValidateOptions = {},
): EdgeContracts {
  const out: Record<number, EdgeContract> = {};
  for (const [key, value] of Object.entries(contracts)) {
    const major = Number(key);
    if (!value || !Number.isFinite(major)) continue;

    const seams = allSeamsOfMajor(family, major);
    // Use the widest seam of the class: partial seams (e.g. Gamma1's lone
    // '2.2A', which continues onto Gamma2) must not shrink the usable range.
    const maxMinor = seams.length ? Math.max(...seams.map((s) => s.edgeIndices.length)) - 1 : 0;
    let minor = Math.round(value.minor);
    if (!Number.isFinite(minor)) minor = 0;
    minor = Math.max(0, Math.min(maxMinor, minor));
    let t = Number.isFinite(value.t) ? value.t : 0.5;
    t = Math.max(0, Math.min(1, t));

    let candidate: EdgeContract = { minor, t };

    if (major === 0) {
      for (const seam of seams) {
        if (!isSymmetricContract(candidate, seam)) {
          if (opts.strict) {
            throw new Error(
              `Class-0 contract must be symmetric about the seam center (u = ${seamCenterU(seam)}), got u = ${contractU(candidate)}`,
            );
          }
          candidate = centerContract(seam);
          break;
        }
      }
    }
    out[major] = candidate;
  }
  return out;
}

function centerContract(seam: MetaEdge): EdgeContract {
  const u = seamCenterU(seam);
  let minor = Math.floor(u);
  let t = u - minor;
  const M = seam.edgeIndices.length;
  // Canonical form: a point that lands exactly on a vertex is expressed as the
  // END of the previous edge (t = 1), matching DEFAULT_CONTRACTS[0].
  if (t === 0 && minor > 0) {
    minor -= 1;
    t = 1;
  }
  if (minor >= M) {
    minor = M - 1;
    t = 1;
  }
  return { minor, t };
}

function allSeamsOfMajor(family: TileFamilyId, major: number): readonly MetaEdge[] {
  const out: MetaEdge[] = [];
  for (const type of leafOrder(family)) {
    for (const seam of metaEdges(family, type)) {
      if (seam.major === major) out.push(seam);
    }
  }
  return out;
}

/** Resolve the contract that applies to one seam. */
function resolveContract(seam: MetaEdge, contracts: EdgeContracts): EdgeContract {
  if (seam.major === 0) {
    // Self-gluing class: the only admissible contract is the seam center.
    return centerContract(seam);
  }
  const c = contracts[seam.major] ?? DEFAULT_CONTRACTS[seam.major] ?? { minor: 0, t: 0.5 };
  const t = Math.max(0, Math.min(1, c.t));
  return { minor: c.minor, t };
}

// ---------------------------------------------------------------------------
// Connection points
// ---------------------------------------------------------------------------

/**
 * Connection point of one seam, in tile-local coordinates.
 *
 * With {@link DEFAULT_CONTRACTS} this reproduces `getEdgeDotMidpoints`:
 * midpoint of the `minor == 0` physical edge, except class 0 in non-hex
 * families where the point is the vertex shared by the seam's two edges.
 */
export function connectionPoint(
  family: TileFamilyId,
  type: TileTypeId,
  edge: MetaEdge,
  contracts: EdgeContracts = DEFAULT_CONTRACTS,
): Pt {
  const pts = leafPts(family, type);
  const n = pts.length;
  const c = resolveContract(edge, contracts);

  // Locate the physical edge carrying the requested minor (clamping to the
  // nearest available minor for partial seams such as Gamma1's '2.2A').
  let best = 0;
  let bestDelta = Infinity;
  for (let k = 0; k < edge.minors.length; k++) {
    const d = Math.abs(edge.minors[k] - c.minor);
    if (d < bestDelta) {
      bestDelta = d;
      best = k;
    }
  }
  const idx = edge.edgeIndices[best];
  // A `k.mA` edge glues to the neighbour's `-k.mA` edge traversed in reverse,
  // so the negative side measures the same contract from the other end.
  const t = edge.sign > 0 ? c.t : 1 - c.t;
  return lerpPt(pts[idx], pts[(idx + 1) % n], t);
}

export interface ConnectionPoint {
  readonly edge: MetaEdge;
  readonly pt: Pt;
}

/**
 * All connection points of a tile for the selected edge classes, in the exact
 * order the old `getEdgeDotMidpoints` produced them (physical-label order of
 * the `minor == 0` edges).
 *
 * ORDER IS LOAD-BEARING: matching indices (sliders, URLs, CSV combos) are
 * defined against it. Contracts move points geometrically, never reorder them.
 */
export function connectionPoints(
  family: TileFamilyId,
  type: TileTypeId,
  selected: ReadonlySet<number>,
  contracts: EdgeContracts = DEFAULT_CONTRACTS,
): readonly ConnectionPoint[] {
  const labels = edgeLabels(family, type);
  if (labels.length === 0) return [];
  const seams = metaEdges(family, type);

  const out: ConnectionPoint[] = [];
  for (let i = 0; i < labels.length; i++) {
    const parsed = parseEdgeLabel(labels[i]);
    if (parsed.minor !== 0 || !selected.has(parsed.major)) continue;
    const seam = seams.find((s) => s.edgeIndices.includes(i));
    if (!seam) continue;
    out.push({ edge: seam, pt: connectionPoint(family, type, seam, contracts) });
  }
  return out;
}

/** Ports `analysis.getEdgeDotCount`: one dot per selected seam (minor `.0`). */
export function connectionCount(
  family: TileFamilyId,
  type: TileTypeId,
  selected: ReadonlySet<number>,
): number {
  let count = 0;
  for (const raw of edgeLabels(family, type)) {
    const { major, minor } = parseEdgeLabel(raw);
    if (minor === 0 && selected.has(major)) count++;
  }
  return count;
}

/** Midpoints of every physical edge whose class is selected (label placement). */
export function physicalEdgeMidpoints(
  family: TileFamilyId,
  type: TileTypeId,
  selected: ReadonlySet<number>,
): readonly { index: number; label: EdgeLabel; pt: Pt }[] {
  const labels = edgeLabels(family, type);
  const pts = leafPts(family, type);
  const n = pts.length;
  const out: { index: number; label: EdgeLabel; pt: Pt }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = parseEdgeLabel(labels[i]);
    if (!selected.has(label.major)) continue;
    out.push({ index: i, label, pt: lerpPt(pts[i], pts[(i + 1) % n], 0.5) });
  }
  return out;
}
