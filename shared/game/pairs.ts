/**
 * Drawing a matching by hand: pairs of connection-point indices, and the
 * translation to and from the Spectre core's matching index.
 *
 * Connection points of a tile are listed in cyclic order around it, so two
 * chords cross iff their index intervals interleave — the same topological
 * rule the combination strings are built on (`nonCrossingMatchingIndicesCyclic`).
 */

import { enumerateMatchings, type Matching } from '../tiles';

export type Pair = readonly [number, number];

function norm(p: Pair): Pair {
  return p[0] < p[1] ? p : [p[1], p[0]];
}

/** Two chords cross (topologically) iff their endpoints interleave. */
export function pairsCross(a: Pair, b: Pair): boolean {
  const [a1, a2] = norm(a);
  const [b1, b2] = norm(b);
  return (a1 < b1 && b1 < a2 && a2 < b2) || (b1 < a1 && a1 < b2 && b2 < a2);
}

/** The pairs of a full matching index over `n` points (empty when unknown). */
export function matchingToPairs(n: number, index: number): Pair[] {
  const m: Matching | undefined = enumerateMatchings(n)[index];
  return m ? m.map(norm) : [];
}

/** The full matching index for a perfect set of pairs over `n` points, or -1. */
export function pairsToMatchingIndex(n: number, pairs: readonly Pair[]): number {
  if (pairs.length * 2 !== n) return -1;
  const key = (ps: readonly Pair[]): string =>
    ps
      .map(norm)
      .sort((p, q) => p[0] - q[0])
      .map((p) => `${p[0]}-${p[1]}`)
      .join(',');
  const want = key(pairs);
  const all = enumerateMatchings(n);
  for (let i = 0; i < all.length; i++) if (key(all[i]) === want) return i;
  return -1;
}

export type ApplyResult =
  | { readonly ok: true; readonly pairs: Pair[]; readonly complete: boolean }
  | { readonly ok: false; readonly reason: 'same' | 'crossing' };

/**
 * Add a drawn chord `[a, b]` to a set of pairs: anything already touching `a`
 * or `b` is dropped, and the new chord must not cross what remains.
 */
export function applyPair(pairs: readonly Pair[], a: number, b: number, n: number): ApplyResult {
  if (a === b) return { ok: false, reason: 'same' };
  const next: Pair = norm([a, b]);
  const kept = pairs.filter((p) => p[0] !== a && p[1] !== a && p[0] !== b && p[1] !== b);
  if (kept.some((p) => pairsCross(p, next))) return { ok: false, reason: 'crossing' };
  kept.push(next);
  return { ok: true, pairs: kept, complete: kept.length * 2 === n };
}

/** Remove the pair touching point `a`, if any. */
export function removePairAt(pairs: readonly Pair[], a: number): Pair[] {
  return pairs.filter((p) => p[0] !== a && p[1] !== a);
}

/** Points not covered by any pair. */
export function unpaired(n: number, pairs: readonly Pair[]): number[] {
  const used = new Set<number>();
  for (const [a, b] of pairs) used.add(a).add(b);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!used.has(i)) out.push(i);
  return out;
}
