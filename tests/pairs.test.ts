import { describe, expect, it } from 'vitest';
import { applyPair, matchingToPairs, pairsCross, pairsToMatchingIndex, unpaired } from '../shared/game/pairs';
import { enumerateMatchings, nonCrossingMatchingIndicesCyclic } from '../shared/tiles';

describe('pairs', () => {
  it('round-trips every matching index', () => {
    for (const n of [2, 4, 6, 8]) {
      const all = enumerateMatchings(n);
      for (let i = 0; i < all.length; i++) {
        expect(pairsToMatchingIndex(n, matchingToPairs(n, i))).toBe(i);
      }
    }
  });

  it('crossing test agrees with the core cyclic rule', () => {
    for (const n of [4, 6]) {
      const nc = new Set(nonCrossingMatchingIndicesCyclic(n));
      const all = enumerateMatchings(n);
      for (let i = 0; i < all.length; i++) {
        const pairs = all[i];
        let crosses = false;
        for (let p = 0; p < pairs.length && !crosses; p++)
          for (let q = p + 1; q < pairs.length; q++) if (pairsCross(pairs[p], pairs[q])) crosses = true;
        expect(crosses).toBe(!nc.has(i));
      }
    }
  });

  it('drawing a chord replaces pairs at its ends and refuses a crossing', () => {
    // 0-1, 2-3 on four points; draw 1-2 → drops both, incomplete.
    const r1 = applyPair([[0, 1], [2, 3]], 1, 2, 4);
    expect(r1).toEqual({ ok: true, pairs: [[1, 2]], complete: false });
    if (!r1.ok) throw new Error();
    expect(unpaired(4, r1.pairs)).toEqual([0, 3]);
    // Then 0-3 completes it, non-crossing.
    const r2 = applyPair(r1.pairs, 3, 0, 4);
    expect(r2).toEqual({ ok: true, pairs: [[1, 2], [0, 3]], complete: true });
    if (!r2.ok) throw new Error();
    expect(nonCrossingMatchingIndicesCyclic(4)).toContain(pairsToMatchingIndex(4, r2.pairs));
    // 0-2 across 1-3 is refused.
    expect(applyPair([[1, 3]], 0, 2, 4)).toEqual({ ok: false, reason: 'crossing' });
    expect(applyPair([], 2, 2, 4)).toEqual({ ok: false, reason: 'same' });
  });
});
