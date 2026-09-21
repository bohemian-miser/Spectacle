/**
 * Valid edge subsets = the kernel of the (tiles x edge-class) count matrix
 * over GF(2). The kernel is a group under symmetric difference (XOR of masks),
 * and it is computed per family rather than hardcoded — families differ.
 *
 * `bruteForceValidSubsets` is the ported legacy behaviour
 * (`analysis.getValidEdgeCombinations`), kept as an oracle for the linear
 * algebra.
 */

import { connectionCount, familyMajors } from './edges';
import { leafOrder, type TileFamilyId, type TileTypeId } from './families';

/** Bitmask over majors 0..8 (bit k = class k). XOR is the group operation. */
export type Subset = number;

export interface EdgeCountMatrix {
  readonly rows: readonly TileTypeId[];
  readonly cols: readonly number[];
  /** bits[row][col] = parity of that tile's connection count for that class. */
  readonly bits: readonly (readonly (0 | 1)[])[];
}

/** Rows = leaf tile types, cols = majors present in the family. */
export function edgeCountMatrix(family: TileFamilyId): EdgeCountMatrix {
  const rows = leafOrder(family);
  const cols = familyMajors(family);
  const bits = rows.map((type) =>
    cols.map((major) => (connectionCount(family, type, new Set([major])) % 2) as 0 | 1),
  );
  return { rows, cols, bits };
}

/** GF(2) Gaussian elimination; returns a basis of the kernel as Subsets. */
export function kernelBasis(m: EdgeCountMatrix): readonly Subset[] {
  const nCols = m.cols.length;
  // Represent each row as a bitmask over columns.
  const rows: number[] = m.bits.map((r) => {
    let v = 0;
    for (let c = 0; c < nCols; c++) if (r[c]) v |= 1 << c;
    return v;
  });

  const pivotOfCol = new Map<number, number>(); // col -> row bitmask in echelon form
  const echelon: { col: number; row: number }[] = [];
  for (let r of rows) {
    for (const e of echelon) {
      if ((r >> e.col) & 1) r ^= e.row;
    }
    if (r === 0) continue;
    // lowest set bit becomes the pivot column
    let col = 0;
    while (((r >> col) & 1) === 0) col++;
    echelon.push({ col, row: r });
    pivotOfCol.set(col, r);
  }
  // Reduce echelon rows against each other so pivots are unique per row.
  for (let i = 0; i < echelon.length; i++) {
    for (let j = 0; j < echelon.length; j++) {
      if (i === j) continue;
      if ((echelon[i].row >> echelon[j].col) & 1) echelon[i].row ^= echelon[j].row;
    }
  }
  const pivotCols = new Set(echelon.map((e) => e.col));

  const basis: Subset[] = [];
  for (let free = 0; free < nCols; free++) {
    if (pivotCols.has(free)) continue;
    // Free column set to 1; solve the pivot columns.
    let vec = 1 << free;
    for (const e of echelon) {
      if ((e.row >> free) & 1) vec |= 1 << e.col;
    }
    // Translate column indices into major-class bits.
    let mask = 0;
    for (let c = 0; c < nCols; c++) if ((vec >> c) & 1) mask |= 1 << m.cols[c];
    basis.push(mask);
  }
  return basis;
}

export const xorSubsets = (a: Subset, b: Subset): Subset => a ^ b;

export function subsetToEdges(s: Subset): readonly number[] {
  const out: number[] = [];
  for (let k = 0; k < 32; k++) if ((s >> k) & 1) out.push(k);
  return out;
}

export function edgesToSubset(edges: Iterable<number>): Subset {
  let mask = 0;
  for (const e of edges) mask |= 1 << e;
  return mask;
}

/** '2578' style digit string. */
export function subsetToString(s: Subset): string {
  return subsetToEdges(s).join('');
}

export function subsetFromString(s: string): Subset {
  let mask = 0;
  for (const ch of s.trim()) {
    const v = Number.parseInt(ch, 10);
    if (Number.isFinite(v)) mask |= 1 << v;
  }
  return mask;
}

function popcount(n: number): number {
  let c = 0;
  let v = n;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

/** Canonical dropdown order: by size, then numerically. */
function sortSubsets(list: readonly Subset[]): readonly Subset[] {
  return [...list].sort((a, b) => popcount(a) - popcount(b) || a - b);
}

/** Class 7 keeps its Mystic marker in display labels (analysis.ts:367). */
export function subsetLabel(s: Subset): string {
  return subsetToEdges(s)
    .map((e) => (e === 7 ? '7(M)' : String(e)))
    .join(', ');
}

export interface ValidSubset {
  readonly mask: Subset;
  readonly edges: readonly number[];
  /** '2, 5, 7(M), 8' */
  readonly label: string;
}

const validCache = new Map<TileFamilyId, readonly ValidSubset[]>();

/** The whole kernel: span of the basis (2^dim elements), canonically sorted. */
export function validEdgeSubsets(family: TileFamilyId): readonly ValidSubset[] {
  const hit = validCache.get(family);
  if (hit) return hit;
  const basis = kernelBasis(edgeCountMatrix(family));
  const span: Subset[] = [];
  for (let i = 0; i < 1 << basis.length; i++) {
    let mask = 0;
    for (let b = 0; b < basis.length; b++) if ((i >> b) & 1) mask ^= basis[b];
    span.push(mask);
  }
  const out = sortSubsets([...new Set(span)]).map((mask) => ({
    mask,
    edges: subsetToEdges(mask),
    label: subsetLabel(mask),
  }));
  validCache.set(family, out);
  return out;
}

/**
 * Brute-force port of `getValidEdgeCombinations` (analysis.ts:326–372),
 * family-parameterized. Kept as a test oracle for the kernel computation.
 *
 * Deviation from the original: the empty subset is INCLUDED (the old UI code
 * started its loop at 1 purely because an empty dropdown entry is useless).
 */
export function bruteForceValidSubsets(family: TileFamilyId): readonly Subset[] {
  const types = leafOrder(family);
  const edgeTypes = familyMajors(family);
  const out: Subset[] = [];
  const numSubsets = 1 << edgeTypes.length;
  for (let i = 0; i < numSubsets; i++) {
    const subset = new Set<number>();
    let mask = 0;
    for (let j = 0; j < edgeTypes.length; j++) {
      if ((i >> j) & 1) {
        subset.add(edgeTypes[j]);
        mask |= 1 << edgeTypes[j];
      }
    }
    let allEven = true;
    for (const type of types) {
      if (connectionCount(family, type, subset) % 2 !== 0) {
        allEven = false;
        break;
      }
    }
    if (allEven) out.push(mask);
  }
  return sortSubsets(out);
}

/** Known-good spectre answer — TEST FIXTURE, not a source of truth. */
export const SPECTRE_VALID_SUBSETS: readonly string[] = [
  '',
  '15',
  '0136',
  '0356',
  '1278',
  '2578',
  '023678',
  '01235678',
];
