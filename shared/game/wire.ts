/**
 * The compact form of a board snapshot (`welcome.packed`). Every line on the
 * board is a stretch of one strand of its rule: it was grown a step at a time
 * by `stepForward`, and joins, splits and folds only ever keep unbroken
 * stretches of such steps. A clean rule pairs every chord end with exactly one
 * other, so a strand never branches. A line is therefore fully described by
 * its first step and its length; the client, which has the field and every
 * rule, grows the rest again itself. A closed loop needs no length at all: it
 * runs until it comes back to its first step. On a busy board this took a
 * 22 MB welcome (90% of it step coordinates, ~129 bytes a step) to well under
 * a megabyte.
 *
 * A step is packed as `tile · 128 + chord · 2 + end`, where `end` says which
 * end of the chord is the step's `a`; `a` and `b` come back as the exact
 * floats `worldChord` gives the engine.
 */

import type { Pt } from '../tiles';
import type { Field } from './field';
import type { GameEvent, PathStatus, PathStepWire, PathWire } from './protocol';
import { ruleKey, type PlayerRule } from './rule';
import { chordTableFor, stepForward, worldChord, type ChordTable } from './strand';

export interface PackedPaths {
  /** Every rule a line on the board is drawn with. */
  readonly rules: readonly PlayerRule[];
  /** Every player who owns a line. */
  readonly owners: readonly string[];
  /**
   * One array per line: `[id, owner, flags, rule, first, n]` — `owner` and
   * `rule` index the tables above, `flags` is status (0 growing, 1 stuck,
   * 2 closed) + 4 · spawned + 8 · back + 16 · pattern, `first` its first
   * step, `n` its length (left off a closed loop, which runs until it is
   * back at `first`).
   */
  readonly paths: readonly (readonly number[])[];
  /** Edge-to-edge claims' regions by line id, as x, y, x, y, … (to 0.001). */
  readonly regions: Readonly<Record<string, readonly number[]>>;
}

/** Room for every chord index a tile can have (the low bits are chord · 2 + end). */
const LOW = 128;

const STATUS: readonly PathStatus[] = ['growing', 'stuck', 'closed'];

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** A step as one number: `tile · 128 + chord · 2 + end`. */
export function packStep(field: Field, table: ChordTable, s: PathStepWire): number {
  const seg = worldChord(field, table, s.tile, s.chord);
  const end = seg[0].x === s.a.x && seg[0].y === s.a.y ? 0 : 1;
  return s.tile * LOW + s.chord * 2 + end;
}

export function unpackStep(field: Field, table: ChordTable, v: number): PathStepWire {
  const tile = Math.floor(v / LOW);
  const chord = (v % LOW) >> 1;
  const end = v & 1;
  const seg = worldChord(field, table, tile, chord);
  return { tile, chord, a: seg[end], b: seg[1 - end] };
}

/**
 * The step after `cur` along its strand. Null, reported, when the strand
 * branches or ends there: a broken invariant (see the file's comment).
 */
export function nextStep(field: Field, table: ChordTable, cur: PathStepWire, line: number): PathStepWire | null {
  const out = stepForward(field, table, cur);
  if (out.kind === 'step') return out.step;
  console.error(`line ${line}: its strand ${out.kind === 'junction' ? 'branches' : 'ends'} at tile ${cur.tile}`);
  return null;
}

/**
 * The events for a client that joined with `packed`: a line's first step
 * becomes a `begin` (one number, not four floats), and every later step
 * — always its rule's next one from the head — just counts towards a
 * `grow`, run together while the same line keeps growing. `tableOf` finds
 * the chord table of `owner`'s pattern `pattern` — what the client will
 * look up for the line (a line of the tick may already be gone); should it
 * find none, the plain `step` goes. Of a player's `score`s only the last
 * one in the batch goes: each just sets the score, and a busy tick sends
 * dozens.
 */
export function packEvents(
  field: Field,
  ev: readonly GameEvent[],
  tableOf: (owner: string, pattern: number) => ChordTable | undefined,
): GameEvent[] {
  const out: GameEvent[] = [];
  const lastScore = new Map<string, number>();
  ev.forEach((e, i) => e.t === 'score' && lastScore.set(e.id, i));
  for (const [i, e] of ev.entries()) {
    if (e.t === 'score' && lastScore.get(e.id) !== i) continue;
    if (e.t !== 'step') {
      out.push(e);
      continue;
    }
    if (e.first) {
      const table = tableOf(e.owner, e.pattern ?? 0);
      if (!table) {
        out.push(e);
        continue;
      }
      const begin: { -readonly [K in keyof Extract<GameEvent, { t: 'begin' }>]: Extract<GameEvent, { t: 'begin' }>[K] } = {
        t: 'begin',
        path: e.path,
        owner: e.owner,
        first: packStep(field, table, e.step),
      };
      if (e.pattern !== undefined) begin.pattern = e.pattern;
      if (e.spawned) begin.spawned = true;
      out.push(begin);
      continue;
    }
    const last = out[out.length - 1];
    if (last?.t === 'grow' && last.path === e.path) out[out.length - 1] = { ...last, n: last.n + 1 };
    else out.push({ t: 'grow', path: e.path, n: 1 });
  }
  return out;
}

/** Pack `paths`, each with the rule and chord table it is drawn with. */
export function packPaths(
  field: Field,
  paths: readonly { wire: PathWire; rule: PlayerRule; table: ChordTable }[],
): PackedPaths {
  const rules: PlayerRule[] = [];
  const ruleIndex = new Map<string, number>();
  const owners: string[] = [];
  const ownerIndex = new Map<string, number>();
  const out: number[][] = [];
  const regions: Record<string, number[]> = {};
  for (const { wire, rule, table } of paths) {
    if (wire.steps.length === 0) continue;
    const key = ruleKey(rule);
    let r = ruleIndex.get(key);
    if (r === undefined) {
      r = rules.push(rule) - 1;
      ruleIndex.set(key, r);
    }
    let o = ownerIndex.get(wire.owner);
    if (o === undefined) {
      o = owners.push(wire.owner) - 1;
      ownerIndex.set(wire.owner, o);
    }
    const flags = STATUS.indexOf(wire.status) + (wire.spawned ? 4 : 0) + (wire.back ? 8 : 0) + 16 * (wire.pattern ?? 0);
    const line = [wire.id, o, flags, r, packStep(field, table, wire.steps[0])];
    if (wire.status !== 'closed' || wire.region) line.push(wire.steps.length);
    out.push(line);
    if (wire.region) regions[wire.id] = wire.region.flatMap((q) => [round(q.x), round(q.y)]);
  }
  return { rules, owners, paths: out, regions };
}

/**
 * The plain paths back from a packed snapshot, each grown again from its
 * first step. A strand that branches or ends before its length is a broken
 * invariant (see the file's comment): it is reported, and the line is kept
 * as far as it got.
 */
export function unpackPaths(field: Field, packed: PackedPaths): PathWire[] {
  const tables = packed.rules.map((rule) => chordTableFor(field, rule));
  return packed.paths.map(([id, owner, flags, rule, first, n]) => {
    const table = tables[rule];
    const start = unpackStep(field, table, first);
    const steps: PathStepWire[] = [start];
    // A loop can't be longer than every chord on the board; the cap only guards a broken invariant.
    const want = n ?? Infinity;
    for (let guard = field.count * 8; steps.length < want && guard > 0; guard--) {
      const next = nextStep(field, table, steps[steps.length - 1], id);
      if (!next) break;
      if (n === undefined && next.tile === start.tile && next.chord === start.chord) break;
      steps.push(next);
    }
    const wire: { -readonly [K in keyof PathWire]: PathWire[K] } = { id, owner: packed.owners[owner], status: STATUS[flags & 3], steps };
    const pattern = flags >> 4;
    if (pattern !== 0) wire.pattern = pattern;
    if (flags & 4) wire.spawned = true;
    if (flags & 8) wire.back = true;
    const region = packed.regions[id];
    if (region) {
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < region.length; i += 2) pts.push({ x: region[i], y: region[i + 1] });
      wire.region = pts;
    }
    return wire;
  });
}
