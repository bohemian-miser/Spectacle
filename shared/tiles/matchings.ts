/**
 * Perfect matchings of a tile's connection points, plus the canonical
 * "combination string" codec used by the blog / notebook / CSV data.
 *
 * `enumerateMatchings` is an index-based port of `analysis.findPerfectMatchings`
 * and preserves its enumeration order exactly.
 */

import type { Pt } from './geom';
import { connectionCount, connectionPoints, DEFAULT_CONTRACTS, type EdgeContracts } from './edges';
import { leafOrder, type TileFamilyId, type TileTypeId } from './families';

/** Pairs of indices into `connectionPoints()` order. */
export type Matching = readonly (readonly [number, number])[];

const matchingCache = new Map<number, readonly Matching[]>();

function enumerateOn(indices: readonly number[]): Matching[] {
  if (indices.length === 0) return [[]];
  if (indices.length % 2 !== 0) return [];

  const first = indices[0];
  const rest = indices.slice(1);
  const solutions: Matching[] = [];
  for (let i = 0; i < rest.length; i++) {
    const pair: readonly [number, number] = [first, rest[i]];
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const sub of enumerateOn(remaining)) solutions.push([pair, ...sub]);
  }
  return solutions;
}

/**
 * All perfect matchings of `n` points in the exact order of the old
 * `findPerfectMatchings`: the first point pairs with each remaining point in
 * order, recursing on the rest. Count = (n-1)!! = 1, 3, 15, 105, 945, …
 */
export function enumerateMatchings(n: number): readonly Matching[] {
  if (n < 0 || !Number.isInteger(n)) return [];
  const hit = matchingCache.get(n);
  if (hit) return hit;
  const out = enumerateOn(Array.from({ length: n }, (_, i) => i));
  matchingCache.set(n, out);
  return out;
}

/** (n-1)!! — the number of perfect matchings of n points (0 for odd n). */
export function matchingCount(n: number): number {
  if (n < 0 || n % 2 !== 0) return 0;
  let acc = 1;
  for (let k = n - 1; k > 0; k -= 2) acc *= k;
  return acc;
}

// ---------------------------------------------------------------------------
// Non-crossing matchings
// ---------------------------------------------------------------------------

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Proper segment intersection (shared endpoints and touching do not count). */
export function segmentsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d2 = cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  const d3 = cross(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d4 = cross(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const EPS = 1e-9;
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  );
}

/**
 * Indices (into `enumerateMatchings` order) of the matchings whose chords do
 * not intersect when drawn between the given connection points.
 *
 * NOTE: this *geometric* test is strictly more permissive than the topological
 * one below, because a Spectre is concave — chords between midpoints of
 * interleaved seams can still miss each other in the plane. The canonical
 * combination-string encoding uses the topological rule (see
 * {@link nonCrossingMatchingIndicesCyclic} and {@link nonCrossingForTile}).
 */
export function geometricNonCrossingMatchingIndices(points: readonly Pt[]): readonly number[] {
  const all = enumerateMatchings(points.length);
  const out: number[] = [];
  for (let mi = 0; mi < all.length; mi++) {
    const m = all[mi];
    let ok = true;
    for (let i = 0; ok && i < m.length; i++) {
      for (let j = i + 1; ok && j < m.length; j++) {
        if (segmentsCross(points[m[i][0]], points[m[i][1]], points[m[j][0]], points[m[j][1]])) {
          ok = false;
        }
      }
    }
    if (ok) out.push(mi);
  }
  return out;
}

/**
 * Topological (and canonical) variant: connection points are listed in cyclic
 * order around the tile, so two chords cross iff their index intervals
 * interleave. This is the notebook's `no_crossing` test and therefore the
 * definition the CSV combination strings are built on.
 */
export function nonCrossingMatchingIndicesCyclic(n: number): readonly number[] {
  const all = enumerateMatchings(n);
  const out: number[] = [];
  for (let mi = 0; mi < all.length; mi++) {
    const pairs = all[mi].map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);
    let ok = true;
    for (let i = 0; ok && i < pairs.length; i++) {
      for (let j = i + 1; ok && j < pairs.length; j++) {
        const [a1, a2] = pairs[i];
        const [b1, b2] = pairs[j];
        if ((a1 < b1 && b1 < a2 && a2 < b2) || (b1 < a1 && a1 < b2 && b2 < a2)) ok = false;
      }
    }
    if (ok) out.push(mi);
  }
  return out;
}

/**
 * Non-crossing matching indices for one leaf tile under a subset of classes,
 * using the canonical topological rule. This is what combination-string digits
 * index into, and it is verified against `graph_analysis/lvl4.csv`.
 *
 * Contracts do not affect the result (they slide points along their seams
 * without reordering them), so the parameter is accepted but unused.
 */
export function nonCrossingForTile(
  family: TileFamilyId,
  type: TileTypeId,
  selected: ReadonlySet<number>,
): readonly number[] {
  return nonCrossingMatchingIndicesCyclic(connectionCount(family, type, selected));
}

/** Geometric variant of {@link nonCrossingForTile} (chords that truly miss). */
export function geometricNonCrossingForTile(
  family: TileFamilyId,
  type: TileTypeId,
  selected: ReadonlySet<number>,
  contracts: EdgeContracts = DEFAULT_CONTRACTS,
): readonly number[] {
  const pts = connectionPoints(family, type, selected, contracts).map((c) => c.pt);
  return geometricNonCrossingMatchingIndices(pts);
}

// ---------------------------------------------------------------------------
// Combination strings
// ---------------------------------------------------------------------------

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

export function comboDigitValue(ch: string): number {
  const v = DIGITS.indexOf(ch.toLowerCase());
  return v < 0 ? 0 : v;
}

export function comboDigitChar(v: number): string | null {
  return v >= 0 && v < DIGITS.length ? DIGITS[v] : null;
}

function toSet(subset: readonly number[]): ReadonlySet<number> {
  return new Set(subset);
}

/**
 * Combination string -> full matching-enumeration indices, in
 * `leafOrder(family)` order. Digit `d` selects that tile's d-th NON-CROSSING
 * matching (clamped when out of range, per the lenient decoder rule).
 */
export function comboToMatchingIndices(
  family: TileFamilyId,
  subset: readonly number[],
  combo: string,
  /** Accepted for API symmetry; contracts never reorder connection points. */
  _contracts?: EdgeContracts,
): readonly number[] {
  const selected = toSet(subset);
  const order = leafOrder(family);
  return order.map((type, i) => {
    const nc = nonCrossingForTile(family, type, selected);
    if (nc.length === 0) return 0;
    const d = i < combo.length ? comboDigitValue(combo[i]) : 0;
    return nc[Math.min(d, nc.length - 1)];
  });
}

/**
 * Inverse of {@link comboToMatchingIndices}; returns null when some selected
 * matching is crossing (not representable as a combo digit) or its
 * non-crossing index is >= 36.
 */
export function matchingIndicesToCombo(
  family: TileFamilyId,
  subset: readonly number[],
  indices: readonly number[],
  /** Accepted for API symmetry; contracts never reorder connection points. */
  _contracts?: EdgeContracts,
): string | null {
  const selected = toSet(subset);
  const order = leafOrder(family);
  let out = '';
  for (let i = 0; i < order.length; i++) {
    const nc = nonCrossingForTile(family, order[i], selected);
    const want = indices[i] ?? 0;
    if (nc.length === 0) {
      // No choice to make for this tile; canonical digit is 0.
      if (want !== 0) return null;
      out += '0';
      continue;
    }
    const pos = nc.indexOf(want);
    if (pos < 0) return null;
    const ch = comboDigitChar(pos);
    if (ch === null) return null;
    out += ch;
  }
  return out;
}

const SHARE_RE = /^([0-9]*)-([0-9a-z]+)$/i;

/** Parse the canonical share form, e.g. '2578-0100101100'. */
export function parseComboShareString(
  s: string,
): { subset: readonly number[]; combo: string } | null {
  const m = SHARE_RE.exec(s.trim());
  if (!m) return null;
  const subset = [...m[1]].map((c) => Number.parseInt(c, 10));
  if (subset.some((n) => !Number.isFinite(n))) return null;
  const sorted = [...new Set(subset)].sort((a, b) => a - b);
  if (sorted.length !== subset.length) return null;
  return { subset: sorted, combo: m[2].toLowerCase() };
}

export function formatComboShareString(subset: readonly number[], combo: string): string {
  return `${[...subset].sort((a, b) => a - b).join('')}-${combo}`;
}

/**
 * Largest valid matching index for one tile under a seam subset. The subset
 * decides how many connection points the tile has, and that decides how many
 * ways they can be paired up.
 */
export function maxMatchingIndex(
  family: TileFamilyId,
  type: TileTypeId,
  subset: readonly number[],
): number {
  return Math.max(0, matchingCount(connectionCount(family, type, new Set(subset))) - 1);
}

/**
 * Re-shape and clamp a matching vector for a family and seam subset. Must be
 * called after ANY change that can invalidate indices — a family swap or, far
 * more often, a subset edit: removing a seam class removes connection points,
 * so an index that was valid a moment ago can now be past the end.
 *
 * Skipping this is not a cosmetic bug. `matchingIndicesToCombo` rejects an
 * out-of-range index exactly as it rejects a crossing one, so a stale vector
 * makes a perfectly good rule report that it "crosses itself" and refuse to
 * produce a combination string.
 */
export function normalizeMatchingVector(
  family: TileFamilyId,
  subset: readonly number[],
  matching: readonly number[],
): readonly number[] {
  return leafOrder(family).map((type, i) => {
    const max = maxMatchingIndex(family, type, subset);
    const want = Math.round(matching[i] ?? 0);
    if (!Number.isFinite(want)) return 0;
    return Math.min(max, Math.max(0, want));
  });
}
