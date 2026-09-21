/**
 * A player's rule: which edge classes carry a line, and how the lines pair up
 * inside each tile type. This is exactly the Spectre Explorer's
 * (subset, matching) pair — `matching` is the full `enumerateMatchings` index
 * per leaf type in `leafOrder(family)` order — so any rule the Explorer can
 * show can be played, and vice versa.
 */

import {
  comboToMatchingIndices,
  connectionCount,
  familyMajors,
  leafOrder,
  matchingIndicesToCombo,
  nonCrossingForTile,
  validEdgeSubsets,
  type TileFamilyId,
  type TileTypeId,
} from '../tiles';
import type { Rng } from './rng';

export interface PlayerRule {
  readonly family: TileFamilyId;
  /** Selected edge classes (majors), sorted ascending, no duplicates. */
  readonly subset: readonly number[];
  /** Per-leaf full matching index, `leafOrder(family)` order. */
  readonly matching: readonly number[];
}

/** Families the arena can be built on. Hat/turtle are in the core but not offered yet. */
export const PLAYABLE_FAMILIES: readonly TileFamilyId[] = ['hex', 'spectre'];

/**
 * Validate an untrusted rule against a fixed arena family. Returns a clean
 * copy or null. A rule is rejected (not clamped) when a matching index is
 * crossing or out of range: silently changing a player's lines would be worse
 * than telling them.
 */
export function validateRule(raw: unknown, family: TileFamilyId): PlayerRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { family?: unknown; subset?: unknown; matching?: unknown };
  if (r.family !== family) return null;
  if (!Array.isArray(r.subset) || !Array.isArray(r.matching)) return null;
  const majors = familyMajors(family);
  const subset = [...new Set(r.subset.map((n) => Number(n)))].sort((a, b) => a - b);
  if (subset.some((n) => !Number.isInteger(n) || !majors.includes(n))) return null;
  const order = leafOrder(family);
  if (r.matching.length !== order.length) return null;
  const selected = new Set(subset);
  const matching: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const m = Number(r.matching[i]);
    if (!Number.isInteger(m) || m < 0) return null;
    const allowed = nonCrossingForTile(family, order[i], selected);
    // Types with an odd (or zero) connection count draw nothing; any index is
    // meaningless there and is canonicalised to 0.
    if (allowed.length === 0) {
      matching.push(0);
      continue;
    }
    if (!allowed.includes(m)) return null;
    matching.push(m);
  }
  return { family, subset, matching };
}

/** Stable identity of a rule — chord tables are cached under it. */
export function ruleKey(rule: PlayerRule): string {
  return `${rule.family}|${rule.subset.join('')}|${rule.matching.join('.')}`;
}

/** Leaf types that end up with an odd number of crossings — "tiles with tails". */
export function oddTypes(rule: PlayerRule): readonly TileTypeId[] {
  const selected = new Set(rule.subset);
  return leafOrder(rule.family).filter(
    (type) => connectionCount(rule.family, type, selected) % 2 === 1,
  );
}

/** Leaf types that draw at least one line under the rule. */
export function drawingTypes(rule: PlayerRule): readonly TileTypeId[] {
  const selected = new Set(rule.subset);
  return leafOrder(rule.family).filter((type) => {
    const n = connectionCount(rule.family, type, selected);
    return n >= 2 && n % 2 === 0;
  });
}

/** `128 · 010100000` — the Explorer's canonical share form, or a lossless fallback. */
export function describeRule(rule: PlayerRule): string {
  const combo = matchingIndicesToCombo(rule.family, rule.subset, rule.matching);
  const subset = rule.subset.join('') || '∅';
  return combo ? `${subset} · ${combo}` : `${subset} · m${rule.matching.join('.')}`;
}

/** Build a rule from the Explorer's combo-string form (`'128', '010100000'`). */
export function ruleFromCombo(family: TileFamilyId, subsetDigits: string, combo: string): PlayerRule {
  const subset = [...new Set([...subsetDigits].map((c) => Number.parseInt(c, 10)))]
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return { family, subset, matching: comboToMatchingIndices(family, subset, combo) };
}

/** Random non-crossing matching for each leaf type under `subset`. */
export function randomMatching(family: TileFamilyId, subset: readonly number[], rng: Rng): number[] {
  const selected = new Set(subset);
  return leafOrder(family).map((type) => {
    const allowed = nonCrossingForTile(family, type, selected);
    return allowed.length ? allowed[rng.int(allowed.length)] : 0;
  });
}

/**
 * A random "clean" rule: a non-empty member of the family's kernel (every tile
 * pairs up, nothing dangles) with random non-crossing matchings. What the bots
 * play, and what the "surprise me" button offers.
 */
export function randomCleanRule(family: TileFamilyId, rng: Rng): PlayerRule {
  const valid = validEdgeSubsets(family).filter((v) => v.edges.length > 0);
  const pick = valid[rng.int(valid.length)];
  return { family, subset: pick.edges, matching: randomMatching(family, pick.edges, rng) };
}

/**
 * The rule offered on entry: selection 15 — clean in both families, and it
 * only ever makes short closed loops (3, 6 or 9 segments on the spectre), so
 * it demonstrates circuits without giving away the long lines. The rules
 * that draw an infinite strand are for players to find.
 */
export function defaultRule(family: TileFamilyId): PlayerRule {
  const valid = validEdgeSubsets(family);
  if (valid.some((v) => v.edges.join('') === '15')) {
    return ruleFromCombo(family, '15', leafOrder(family).map(() => '0').join(''));
  }
  const first = valid.find((v) => v.edges.length > 0);
  return { family, subset: first?.edges ?? [], matching: leafOrder(family).map(() => 0) };
}

/** The proven infinite-line (FASS) rule per family — used by tests and bots, never shown as a preset. */
export function fassRule(family: TileFamilyId): PlayerRule {
  switch (family) {
    case 'hex':
      return ruleFromCombo('hex', '128', '010100000');
    case 'spectre':
      return ruleFromCombo('spectre', '1278', '0101000000');
    default:
      return defaultRule(family);
  }
}
