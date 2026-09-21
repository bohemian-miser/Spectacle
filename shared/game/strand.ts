/**
 * Following a strand across the field, one chord at a time.
 *
 * A tile's chords depend only on its type and the player's rule (`localChords`
 * from the Spectre core), and consecutive chords meet at a connection point on
 * the shared seam. So "where does this line go next?" is a local question:
 * look at the neighbouring tiles' chord ends and find the one that coincides
 * with the current head. This is the Infinite Map's tap-to-trace walk, made
 * per-player because every player draws under a different rule.
 */

import {
  DEFAULT_CONTRACTS,
  localChords,
  segmentsCross,
  type Pt,
  type Segment,
  type TileTypeId,
} from '../tiles';
import { tileNeighbours, tileType, tileXform, type Field } from './field';
import { ruleKey, type PlayerRule } from './rule';
import type { Rng } from './rng';

/**
 * Two chord ends closer than this are the same connection point. Coordinates
 * are composed doubles from a modest number of rigid transforms, so real
 * error is ~1e-9; distinct connection points are never closer than ~0.3.
 */
export const SNAP_EPSILON = 1e-3;

/** Tile-local chords per leaf type (indexed like `field.leafTypes`). */
export interface ChordTable {
  readonly key: string;
  readonly rule: PlayerRule;
  readonly byType: readonly (readonly Segment[])[];
}

const tableCache = new Map<string, ChordTable>();

export function chordTableFor(field: Field, rule: PlayerRule): ChordTable {
  const key = `${field.family}|${ruleKey(rule)}`;
  const hit = tableCache.get(key);
  if (hit) return hit;
  const selected = new Set(rule.subset);
  const byType = field.leafTypes.map((type: TileTypeId, i) =>
    localChords(field.family, type, selected, rule.matching[i] ?? 0, DEFAULT_CONTRACTS),
  );
  const table: ChordTable = { key, rule, byType };
  tableCache.set(key, table);
  return table;
}

/** Local chords of tile `i` under a table. */
export function tileChords(field: Field, table: ChordTable, i: number): readonly Segment[] {
  return table.byType[field.types[i]];
}

/** World-space chord `c` of tile `i`. */
export function worldChord(field: Field, table: ChordTable, i: number, c: number): Segment {
  const [a, b] = table.byType[field.types[i]][c];
  const M = tileXform(field, i);
  return [
    { x: M[0] * a.x + M[1] * a.y + M[2], y: M[3] * a.x + M[4] * a.y + M[5] },
    { x: M[0] * b.x + M[1] * b.y + M[2], y: M[3] * b.x + M[4] * b.y + M[5] },
  ];
}

function near(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < SNAP_EPSILON && Math.abs(a.y - b.y) < SNAP_EPSILON;
}

function pointSegDist2(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = a.x + vx * t - p.x;
  const dy = a.y + vy * t - p.y;
  return dx * dx + dy * dy;
}

/** The chord of tile `i` closest to world point `p`, or -1 when the tile draws nothing. */
export function nearestChord(field: Field, table: ChordTable, i: number, p: Pt): number {
  const chords = tileChords(field, table, i);
  let best = -1;
  let bestD = Infinity;
  for (let c = 0; c < chords.length; c++) {
    const [a, b] = worldChord(field, table, i, c);
    const d = pointSegDist2(p, a, b);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export interface ChordEnd {
  readonly tile: number;
  readonly chord: number;
  /** Which end of that chord coincides with the head (0 or 1). */
  readonly end: 0 | 1;
}

/**
 * All chord ends in the neighbourhood of tile `i` that coincide with world
 * point `head`, excluding chord `(i, c)` itself. Normally one (the tile across
 * the seam), none at a tail, two at a class-0 vertex junction.
 */
export function continuations(
  field: Field,
  table: ChordTable,
  i: number,
  c: number,
  head: Pt,
): ChordEnd[] {
  const out: ChordEnd[] = [];
  const consider = (t: number): void => {
    const chords = tileChords(field, table, t);
    if (chords.length === 0) return;
    for (let k = 0; k < chords.length; k++) {
      if (t === i && k === c) continue;
      const [a, b] = worldChord(field, table, t, k);
      if (near(a, head)) out.push({ tile: t, chord: k, end: 0 });
      else if (near(b, head)) out.push({ tile: t, chord: k, end: 1 });
    }
  };
  // The same tile can carry another chord ending here only at a class-0 vertex
  // point shared by two of its own seams — include it for completeness.
  consider(i);
  for (const n of tileNeighbours(field, i)) consider(n);
  return out;
}

export interface WalkStep {
  readonly tile: number;
  readonly chord: number;
  /** Entry point (where the walk arrived). */
  readonly a: Pt;
  /** Exit point (where the walk leaves). */
  readonly b: Pt;
}

export type WalkOutcome =
  | { readonly kind: 'step'; readonly step: WalkStep }
  | { readonly kind: 'dead' }
  | { readonly kind: 'junction'; readonly options: readonly ChordEnd[] };

/**
 * One step forward from `cur` (leaving at `cur.b`). `pickJunction` decides a
 * junction; when absent a junction is reported instead of resolved.
 */
export function stepForward(
  field: Field,
  table: ChordTable,
  cur: WalkStep,
  pickJunction?: (options: readonly ChordEnd[]) => ChordEnd,
): WalkOutcome {
  const options = continuations(field, table, cur.tile, cur.chord, cur.b);
  if (options.length === 0) return { kind: 'dead' };
  let next: ChordEnd;
  if (options.length === 1) next = options[0];
  else if (pickJunction) next = pickJunction(options);
  else return { kind: 'junction', options };
  const seg = worldChord(field, table, next.tile, next.chord);
  const a = seg[next.end];
  const b = seg[1 - next.end];
  return { kind: 'step', step: { tile: next.tile, chord: next.chord, a, b } };
}

/** Start a walk on chord `c` of tile `i`, leaving through end `exitEnd`. */
export function startStep(field: Field, table: ChordTable, i: number, c: number, exitEnd: 0 | 1): WalkStep {
  const seg = worldChord(field, table, i, c);
  return { tile: i, chord: c, a: seg[1 - exitEnd], b: seg[exitEnd] };
}

export function randomJunctionPicker(rng: Rng): (options: readonly ChordEnd[]) => ChordEnd {
  return (options) => options[rng.int(options.length)];
}

/**
 * Do two chords in the same tile conflict? Proper crossing always does;
 * sharing a connection point does when `touchCounts`.
 */
export function chordsConflict(a: Segment, b: Segment, touchCounts: boolean): boolean {
  if (segmentsCross(a[0], a[1], b[0], b[1])) return true;
  if (!touchCounts) return false;
  return near(a[0], b[0]) || near(a[0], b[1]) || near(a[1], b[0]) || near(a[1], b[1]);
}

export interface FullWalk {
  readonly steps: readonly WalkStep[];
  readonly closed: boolean;
  readonly stoppedAt: 'closed' | 'dead' | 'junction' | 'limit';
}

/**
 * Walk a whole strand from a start chord until it closes, dies or hits a
 * junction (with no picker) — the test oracle against `analyze()`.
 */
export function walkStrand(
  field: Field,
  table: ChordTable,
  i: number,
  c: number,
  exitEnd: 0 | 1,
  limit = 1_000_000,
  pickJunction?: (options: readonly ChordEnd[]) => ChordEnd,
): FullWalk {
  const steps: WalkStep[] = [startStep(field, table, i, c, exitEnd)];
  const seen = new Set<number>([i * 64 + c]);
  for (;;) {
    if (steps.length >= limit) return { steps, closed: false, stoppedAt: 'limit' };
    const out = stepForward(field, table, steps[steps.length - 1], pickJunction);
    if (out.kind === 'dead') return { steps, closed: false, stoppedAt: 'dead' };
    if (out.kind === 'junction') return { steps, closed: false, stoppedAt: 'junction' };
    const s = out.step;
    if (s.tile === i && s.chord === c) return { steps, closed: true, stoppedAt: 'closed' };
    const k = s.tile * 64 + s.chord;
    if (seen.has(k)) return { steps, closed: false, stoppedAt: 'dead' };
    seen.add(k);
    steps.push(s);
  }
}
