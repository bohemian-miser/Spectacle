/**
 * A new rule without starting from nothing. Your lines' points are a budget;
 * the new rule's circuits through the tiles you already hold are what it
 * buys. Each costs what it would score closed — a point per tile plus the
 * circuit bonus at `comboStart` — and they are bought longest first, skipping
 * any the budget left can't cover. Then one stretch: the cheapest circuit
 * that was too dear comes too, if what is left still covers the tiles of it
 * you hold (a point each, what they score the moment they're laid). So a
 * few tiles on one huge circuit get that circuit — to grow it out and close
 * it, if nobody cuts it first. What is left after that is lost with the old
 * lines.
 *
 * The budget already paid for the tiles you hold, and a bought circuit's held
 * tiles score straight back when laid; so really the switch trades: tiles
 * you gain beyond your own cost the smaller circuits you can then no longer
 * afford.
 *
 * Only the tiles you held change hands: the engine lays the bought circuits'
 * chords there and lets them grow the rest of the way, scoring as they go, so
 * on a board nobody touches you end with exactly `outcome`: what you paid,
 * plus whatever the stretch circuit is worth beyond its tiles. A circuit that
 * gets cut on the way is lost like any other line; one that closes round a
 * rival's lines captures them as usual — a bonus the price doesn't include.
 *
 * Planned against the board as it stands: a strand that runs into a tile an
 * opponent's line is on (`blocked`) can't close, so it is a line from your
 * tiles up to theirs, priced at its tiles alone — and when it regrows it
 * stops there instead of crashing into them. A tail makes a line the same way.
 *
 * Pure: a function of the field, the new rule's table, the tiles, the budget
 * and which tiles are blocked.
 */

import type { Pt } from '../tiles';
import { boundaryRegion, onFieldBoundary, polygonArea, type Field } from './field';
import type { Knobs } from './knobs';
import { startStep, stepForward, tileChords, type ChordTable, type WalkStep } from './strand';

/**
 * What the new rule would draw through tiles you hold: a circuit, or — where
 * the strand runs into an opponent or a tail — a line that stops there.
 * Each is found once, however many of your tiles it passes through.
 */
export interface RegrowCircuit {
  /** All of it, in walking order (a claim runs edge to edge). */
  readonly steps: readonly WalkStep[];
  /** A circuit (loop or claim), priced closed; false for a line that stops short. */
  readonly closed: boolean;
  /** Its region against the field's edge, when it is an edge-to-edge claim. */
  readonly region?: Pt[];
  readonly length: number;
  /** Enclosed area in tiles (as `closeCircuit` counts it); 0 for a line. */
  readonly area: number;
  /** What it scores once drawn: its tiles, plus a circuit's bonus at `comboStart`. */
  readonly price: number;
  /** Its chords on tiles you hold (`tile * 64 + chord`): where it starts again. */
  readonly seeds: readonly number[];
}

export interface RegrowPlan {
  readonly budget: number;
  /** Bought, longest first. */
  readonly kept: readonly RegrowCircuit[];
  /** Found but not affordable when their turn came (the stretch not among them). */
  readonly skipped: readonly RegrowCircuit[];
  /** The cheapest circuit too dear to buy, taken for just its held tiles' points. */
  readonly stretch?: RegrowCircuit;
  /** Budget used: the kept circuits' prices, plus the stretch's held tiles. */
  readonly spent: number;
  /** The score it all comes to once closed, on a board nobody touches. */
  readonly outcome: number;
}

/**
 * A circuit's closing bonus — what `closeCircuit` pays, at combo `combo`. Tile
 * areas come in exact quarters and halves, so the sum often lands on .5; the
 * area is snapped first so float noise from walking the loop from a different
 * start can't round it the other way.
 */
export function circuitBonus(knobs: Knobs, length: number, area: number, combo: number): number {
  const a = Math.round(area * 1e6) / 1e6;
  return Math.round(combo * (knobs.circuitBase + knobs.circuitLengthWeight * length + knobs.circuitAreaWeight * a));
}

/** Total chord steps the plan may walk, whatever the territory (a guard, far above real use). */
const WALK_CAP = 400_000;

export function planRegrow(
  field: Field,
  table: ChordTable,
  tiles: ReadonlySet<number>,
  budget: number,
  knobs: Knobs,
  blocked: (tile: number) => boolean = () => false,
): RegrowPlan {
  const key = (t: number, c: number): number => t * 64 + c;
  // Every strand is walked whole, however long — the stretch may be the
  // biggest circuit there is — but all of them together stay under WALK_CAP.
  const seen = new Set<number>();
  const found: RegrowCircuit[] = [];
  let walked = 0;
  const sorted = [...tiles].sort((a, b) => a - b);
  for (const tile of sorted) {
    const chords = tileChords(field, table, tile);
    for (let c = 0; c < chords.length; c++) {
      if (seen.has(key(tile, c)) || walked >= WALK_CAP) continue;
      const circuit = walkCandidate(field, table, tile, c, WALK_CAP - walked, knobs, blocked);
      walked += circuit.walked.length;
      for (const s of circuit.walked) seen.add(key(s.tile, s.chord));
      if (!circuit.found) continue;
      const seeds = circuit.found.steps.filter((s) => tiles.has(s.tile)).map((s) => key(s.tile, s.chord));
      found.push({ ...circuit.found, seeds });
    }
  }
  // Longest first; ties by price, then by where they are (deterministic).
  found.sort((a, b) => b.length - a.length || b.price - a.price || a.seeds[0] - b.seeds[0]);
  const kept: RegrowCircuit[] = [];
  const skipped: RegrowCircuit[] = [];
  let left = budget;
  for (const q of found) {
    if (q.price <= left) {
      kept.push(q);
      left -= q.price;
    } else skipped.push(q);
  }
  const spent = budget - left;
  // Scoring by tiles, circuits that share a tile hold it once between them.
  const union = (qs: readonly RegrowCircuit[]): number => new Set(qs.flatMap((q) => q.steps.map((s) => s.tile))).size;
  const outcome = knobs.scoreTiles ? union(kept) : spent;
  let cheapest = -1;
  for (let i = 0; i < skipped.length; i++) if (cheapest < 0 || skipped[i].price < skipped[cheapest].price) cheapest = i;
  const over = cheapest >= 0 ? skipped[cheapest] : undefined;
  const held = !over ? 0 : knobs.scoreTiles ? new Set(over.seeds.map((k) => Math.floor(k / 64))).size : over.seeds.length * knobs.pointsPerTile;
  if (!over || held > left) return { budget, kept, skipped, spent, outcome };
  return {
    budget,
    kept,
    skipped: skipped.filter((q) => q !== over),
    stretch: over,
    spent: spent + held,
    outcome: knobs.scoreTiles ? union([...kept, over]) : outcome + over.price,
  };
}

/**
 * The new rule's strand through chord `c` of `tile`, as far as it can be
 * drawn on the board as it stands: a loop, or a line from the field's edge to
 * the edge (both circuits, priced closed); or else a line, from wherever it
 * stops one way to wherever it stops the other — an opponent's tile, a tail —
 * priced by its tiles. `walked` is every chord looked at, so no other seed
 * walks the same stretch again. Nothing when the seed's own tile is blocked,
 * or the strand meets a junction or the walk cap.
 */
function walkCandidate(
  field: Field,
  table: ChordTable,
  tile: number,
  c: number,
  limit: number,
  knobs: Knobs,
  blocked: (tile: number) => boolean,
): { walked: readonly WalkStep[]; found?: Omit<RegrowCircuit, 'seeds'> } {
  if (blocked(tile)) return { walked: [startStep(field, table, tile, c, 1)] };
  const fwd = walk(field, table, tile, c, 1, limit, blocked);
  if (fwd.closed) {
    const steps = fwd.steps;
    const area = polygonArea(steps.map((s) => s.a)) / field.tileArea;
    return { walked: steps, found: priced(knobs, steps, area) };
  }
  const back = walk(field, table, tile, c, 0, limit, blocked);
  const walked = [...fwd.steps, ...back.steps.slice(1)];
  const ends = [fwd.stoppedAt, back.stoppedAt];
  if (ends.includes('junction') || ends.includes('limit') || walked.length > limit) return { walked };
  const steps: WalkStep[] = [
    ...back.steps
      .slice(1)
      .reverse()
      .map((s) => ({ tile: s.tile, chord: s.chord, a: s.b, b: s.a })),
    ...fwd.steps,
  ];
  const first = steps[0];
  const last = steps[steps.length - 1];
  // Both ways off the field's edge: a claim.
  if (ends.every((x) => x === 'dead') && onFieldBoundary(field, first.tile, first.a) && onFieldBoundary(field, last.tile, last.b)) {
    const region = boundaryRegion(field, [...steps.map((s) => s.a), last.b]);
    if (region) {
      const area = polygonArea(region) / field.tileArea;
      return { walked, found: { ...priced(knobs, steps, area), region } };
    }
  }
  return { walked, found: { steps, length: steps.length, area: 0, price: linePrice(knobs, steps), closed: false } };
}

interface Walk {
  readonly steps: readonly WalkStep[];
  readonly closed: boolean;
  readonly stoppedAt: 'closed' | 'dead' | 'junction' | 'limit' | 'blocked';
}

/**
 * `walkStrand`, stopping at the first tile that is `blocked` (the start
 * included): as far as the plan goes, a strand ends where an opponent is.
 */
function walk(
  field: Field,
  table: ChordTable,
  i: number,
  c: number,
  exitEnd: 0 | 1,
  limit: number,
  blocked: (tile: number) => boolean,
): Walk {
  const steps: WalkStep[] = [startStep(field, table, i, c, exitEnd)];
  if (blocked(i)) return { steps, closed: false, stoppedAt: 'blocked' };
  const seen = new Set<number>([i * 64 + c]);
  for (;;) {
    if (steps.length >= limit) return { steps, closed: false, stoppedAt: 'limit' };
    const out = stepForward(field, table, steps[steps.length - 1]);
    if (out.kind === 'dead') return { steps, closed: false, stoppedAt: 'dead' };
    if (out.kind === 'junction') return { steps, closed: false, stoppedAt: 'junction' };
    const s = out.step;
    if (s.tile === i && s.chord === c) return { steps, closed: true, stoppedAt: 'closed' };
    if (blocked(s.tile)) return { steps, closed: false, stoppedAt: 'blocked' };
    const k = s.tile * 64 + s.chord;
    if (seen.has(k)) return { steps, closed: false, stoppedAt: 'dead' };
    seen.add(k);
    steps.push(s);
  }
}

function priced(knobs: Knobs, steps: readonly WalkStep[], area: number): Omit<RegrowCircuit, 'seeds' | 'region'> & { closed: true } {
  const length = steps.length;
  return { steps, length, area, price: linePrice(knobs, steps) + (knobs.scoreTiles ? 0 : circuitBonus(knobs, length, area, knobs.comboStart)), closed: true };
}

/** What a run of steps scores by its tiles: each tile once when scoring by tiles, else a point a step. */
function linePrice(knobs: Knobs, steps: readonly WalkStep[]): number {
  return knobs.scoreTiles ? new Set(steps.map((s) => s.tile)).size : steps.length * knobs.pointsPerTile;
}
