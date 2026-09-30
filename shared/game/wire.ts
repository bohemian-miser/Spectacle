/**
 * The compact form of a board snapshot (`welcome.packed`). A step on the wire
 * is always a whole chord of its tile — `a` and `b` are `worldChord(tile,
 * chord)` one way round or the other — so it needs no coordinates: the
 * client has the field and every rule, and works them out again exactly
 * (the same floats the engine has). Each step is one integer,
 * `(tile − previous tile) · 128 + chord · 2 + end`, where `end` says which
 * end of the chord is `a`; neighbouring tiles along a line are mostly near in
 * index, so the deltas stay short. On a busy board this is ~8× smaller than
 * the plain snapshot (a 7.5 MB welcome became 0.9 MB).
 */

import type { Pt } from '../tiles';
import type { Field } from './field';
import type { PathStatus, PathStepWire, PathWire } from './protocol';
import { ruleKey, type PlayerRule } from './rule';
import { chordTableFor, worldChord, type ChordTable } from './strand';

/** A line in the packed snapshot. */
export interface PackedPathWire {
  readonly id: number;
  readonly owner: string;
  readonly status: PathStatus;
  /** Its rule: an index into `PackedPaths.rules`. */
  readonly rule: number;
  /** Its steps, one number each (see the file's comment). */
  readonly s: readonly number[];
  /** An edge-to-edge claim's region as x, y, x, y, … (to 0.001). */
  readonly region?: readonly number[];
  readonly pattern?: number;
  readonly spawned?: true;
  readonly back?: true;
}

export interface PackedPaths {
  /** Every rule a line on the board is drawn with. */
  readonly rules: readonly PlayerRule[];
  readonly paths: readonly PackedPathWire[];
}

/** Room for every chord index a tile can have (its low bits are chord · 2 + end). */
const LOW = 128;

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** Pack `paths`, each with the rule and chord table it is drawn with. */
export function packPaths(
  field: Field,
  paths: readonly { wire: PathWire; rule: PlayerRule; table: ChordTable }[],
): PackedPaths {
  const rules: PlayerRule[] = [];
  const ruleIndex = new Map<string, number>();
  const out: PackedPathWire[] = [];
  for (const { wire, rule, table } of paths) {
    const key = ruleKey(rule);
    let r = ruleIndex.get(key);
    if (r === undefined) {
      r = rules.push(rule) - 1;
      ruleIndex.set(key, r);
    }
    const s: number[] = [];
    let last = 0;
    for (const st of wire.steps) {
      const seg = worldChord(field, table, st.tile, st.chord);
      const end = seg[0].x === st.a.x && seg[0].y === st.a.y ? 0 : 1;
      s.push((st.tile - last) * LOW + st.chord * 2 + end);
      last = st.tile;
    }
    const { steps: _steps, region, ...rest } = wire;
    const packed: { -readonly [K in keyof PackedPathWire]: PackedPathWire[K] } = { ...rest, rule: r, s };
    if (region) packed.region = region.flatMap((q) => [round(q.x), round(q.y)]);
    out.push(packed);
  }
  return { rules, paths: out };
}

/** The plain paths back from a packed snapshot. */
export function unpackPaths(field: Field, packed: PackedPaths): PathWire[] {
  const tables = packed.rules.map((rule) => chordTableFor(field, rule));
  return packed.paths.map(({ rule, s, region, ...rest }) => {
    const table = tables[rule];
    const steps: PathStepWire[] = [];
    let tile = 0;
    for (const v of s) {
      const low = ((v % LOW) + LOW) % LOW;
      tile += (v - low) / LOW;
      const chord = low >> 1;
      const seg = worldChord(field, table, tile, chord);
      const end = low & 1;
      steps.push({ tile, chord, a: seg[end], b: seg[1 - end] });
    }
    const wire: { -readonly [K in keyof PathWire]: PathWire[K] } = { ...rest, steps };
    if (region) {
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < region.length; i += 2) pts.push({ x: region[i], y: region[i + 1] });
      wire.region = pts;
    }
    return wire;
  });
}
