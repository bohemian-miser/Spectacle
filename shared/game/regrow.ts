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
 * Only the tiles you held change hands: the engine lays the bought circuits'
 * chords there and lets them grow the rest of the way, scoring as they go, so
 * on a board nobody touches you end with exactly `outcome`: what you paid,
 * plus whatever the stretch circuit is worth beyond its tiles. A circuit that
 * gets cut on the way is lost like any other line; one that closes round a
 * rival's lines captures them as usual — a bonus the price doesn't include.
 *
 * Pure: a function of the field, the new rule's table, the tiles and budget.
 */

import type { Pt } from '../tiles';
import { boundaryRegion, onFieldBoundary, polygonArea, type Field } from './field';
import type { Knobs } from './knobs';
import { tileChords, walkStrand, type ChordTable, type WalkStep } from './strand';

/** A circuit the new rule would draw through tiles you hold. */
export interface RegrowCircuit {
  /** The whole circuit, in walking order (a claim runs edge to edge). */
  readonly steps: readonly WalkStep[];
  /** Its region against the field's edge, when it is an edge-to-edge claim. */
  readonly region?: Pt[];
  readonly length: number;
  /** Enclosed area in tiles (as `closeCircuit` counts it). */
  readonly area: number;
  /** What it scores once closed: tiles plus the bonus at `comboStart`. */
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

export function planRegrow(field: Field, table: ChordTable, tiles: ReadonlySet<number>, budget: number, knobs: Knobs): RegrowPlan {
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
      const circuit = walkCircuit(field, table, tile, c, WALK_CAP - walked, knobs);
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
  const outcome = spent;
  let cheapest = -1;
  for (let i = 0; i < skipped.length; i++) if (cheapest < 0 || skipped[i].price < skipped[cheapest].price) cheapest = i;
  const over = cheapest >= 0 ? skipped[cheapest] : undefined;
  const held = over ? over.seeds.length * knobs.pointsPerTile : 0;
  if (!over || held > left) return { budget, kept, skipped, spent, outcome };
  return {
    budget,
    kept,
    skipped: skipped.filter((q) => q !== over),
    stretch: over,
    spent: spent + held,
    outcome: outcome + over.price,
  };
}

/**
 * The new rule's strand through chord `c` of `tile`, when it is a circuit: a
 * loop, or a line from the field's edge to the edge. `walked` is every chord
 * looked at, circuit or not, so no other seed walks the same strand again.
 */
function walkCircuit(
  field: Field,
  table: ChordTable,
  tile: number,
  c: number,
  limit: number,
  knobs: Knobs,
): { walked: readonly WalkStep[]; found?: Omit<RegrowCircuit, 'seeds'> } {
  const fwd = walkStrand(field, table, tile, c, 1, limit);
  if (fwd.closed) {
    const steps = fwd.steps;
    const area = polygonArea(steps.map((s) => s.a)) / field.tileArea;
    return { walked: steps, found: priced(knobs, steps, area) };
  }
  const back = walkStrand(field, table, tile, c, 0, limit);
  const walked = [...fwd.steps, ...back.steps.slice(1)];
  if (fwd.stoppedAt !== 'dead' || back.stoppedAt !== 'dead') return { walked };
  // Both ways dead: a claim when both ends are on the field's edge.
  const steps: WalkStep[] = [
    ...back.steps
      .slice(1)
      .reverse()
      .map((s) => ({ tile: s.tile, chord: s.chord, a: s.b, b: s.a })),
    ...fwd.steps,
  ];
  if (steps.length > limit) return { walked };
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!onFieldBoundary(field, first.tile, first.a) || !onFieldBoundary(field, last.tile, last.b)) return { walked };
  const region = boundaryRegion(field, [...steps.map((s) => s.a), last.b]);
  if (!region) return { walked };
  const area = polygonArea(region) / field.tileArea;
  return { walked, found: { ...priced(knobs, steps, area), region } };
}

function priced(knobs: Knobs, steps: readonly WalkStep[], area: number): Omit<RegrowCircuit, 'seeds' | 'region'> {
  const length = steps.length;
  return { steps, length, area, price: length * knobs.pointsPerTile + circuitBonus(knobs, length, area, knobs.comboStart) };
}
