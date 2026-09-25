/**
 * What the bots can see and work out: the field's shape, which rules make
 * which kinds of line (a scout, shared by every bot on a field), and a probe
 * that walks a would-be line forward against the live board to see what it
 * runs into. Pure, like the rest of `shared/game`.
 */

import { validEdgeSubsets, type Pt } from '../tiles';
import type { Engine, Path } from './engine';
import { tileAt, tileCenter, type Field } from './field';
import { fassRule, randomMatching, ruleKey, type PlayerRule } from './rule';
import { mulberry32, type Rng } from './rng';
import { chordTableFor, chordsConflict, randomJunctionPicker, startStep, stepForward, tileChords, walkStrand, type ChordTable, type WalkStep } from './strand';

// --- the field's shape -----------------------------------------------------------

export interface FieldFrame {
  readonly centre: Pt;
  readonly width: number;
  readonly height: number;
  /** About one tile across, in world units. */
  readonly unit: number;
}

const frames = new WeakMap<Field, FieldFrame>();

export function fieldFrame(field: Field): FieldFrame {
  const hit = frames.get(field);
  if (hit) return hit;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < field.count; i++) {
    const c = tileCenter(field, i);
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const frame: FieldFrame = {
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width,
    height,
    // The patch is roughly a triangle: half its bounding box, shared out.
    unit: Math.sqrt((width * height) / 2 / Math.max(1, field.count)),
  };
  frames.set(field, frame);
  return frame;
}

/** A tile with a line of `table` on it near `p` (within `r`), or -1. */
export function tileNear(field: Field, table: ChordTable, rng: Rng, p: Pt, r: number, tries = 12): number {
  for (let k = 0; k < tries; k++) {
    const a = rng.next() * Math.PI * 2;
    const d = r * Math.sqrt(rng.next());
    const t = tileAt(field, { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d });
    if (t >= 0 && tileChords(field, table, t).length > 0) return t;
  }
  return -1;
}

export function randomTileWithLine(field: Field, table: ChordTable, rng: Rng, tries = 50): number {
  for (let k = 0; k < tries; k++) {
    const t = rng.int(field.count);
    if (tileChords(field, table, t).length > 0) return t;
  }
  return -1;
}

export function stepMid(s: { readonly a: Pt; readonly b: Pt }): Pt {
  return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
}

// --- the infinite-line rules -------------------------------------------------------

/**
 * The FASS family (hex `128`, spectre `1278`, any matching): the rules that
 * draw an endless line. They are for players to find, so no bot plays one
 * unless it is told it may (`BotOptions.infiniteLines`).
 */
export function isInfiniteLineRule(rule: PlayerRule): boolean {
  const fass = fassRule(rule.family).subset;
  return fass.length === rule.subset.length && fass.every((x, i) => x === rule.subset[i]);
}

// --- the scout ---------------------------------------------------------------------

/** How one rule's lines behave, from a handful of sample walks. */
export interface RuleReport {
  readonly rule: PlayerRule;
  /** Median distance from a walk's start to the farthest point it reached. */
  readonly reach: number;
  /** Share of walks that closed within `SHORT_LOOP` steps. */
  readonly shortLoops: number;
  /** Median length of those short loops. */
  readonly loopLength: number;
  readonly infinite: boolean;
}

const MATCHINGS_PER_SUBSET = 8;
const WALKS_PER_RULE = 10;
const WALK_LIMIT = 1500;
const SHORT_LOOP = 48;

/**
 * Tries a spread of clean rules on a field, a slice at a time (`work`), so a
 * tick never pays for all of it. One per field: every bot shares it.
 */
export class RuleScout {
  readonly reports: RuleReport[] = [];
  private readonly queue: PlayerRule[] = [];
  private readonly rng: Rng;
  private current: { rule: PlayerRule; table: ChordTable; reach: number[]; loops: number[]; walks: number } | null = null;

  constructor(readonly field: Field) {
    this.rng = mulberry32(0x5eed);
    const seen = new Set<string>();
    for (const v of validEdgeSubsets(field.family)) {
      if (v.edges.length === 0) continue;
      for (let m = 0; m < MATCHINGS_PER_SUBSET; m++) {
        const rule: PlayerRule = { family: field.family, subset: v.edges, matching: randomMatching(field.family, v.edges, this.rng) };
        const key = ruleKey(rule);
        if (seen.has(key)) continue;
        seen.add(key);
        this.queue.push(rule);
      }
    }
  }

  get done(): boolean {
    return this.queue.length === 0 && this.current === null;
  }

  /** Walk about `budget` more steps' worth. True once every rule is scouted. */
  work(budget: number): boolean {
    const pick = randomJunctionPicker(this.rng);
    while (budget > 0 && !this.done) {
      if (!this.current) {
        const rule = this.queue.shift()!;
        this.current = { rule, table: chordTableFor(this.field, rule), reach: [], loops: [], walks: 0 };
      }
      const c = this.current;
      const t = randomTileWithLine(this.field, c.table, this.rng);
      if (t >= 0) {
        const chords = tileChords(this.field, c.table, t).length;
        const w = walkStrand(this.field, c.table, t, this.rng.int(chords), this.rng.next() < 0.5 ? 0 : 1, WALK_LIMIT, pick);
        budget -= w.steps.length;
        const a = w.steps[0].a;
        let far = 0;
        for (const s of w.steps) far = Math.max(far, Math.hypot(s.b.x - a.x, s.b.y - a.y));
        c.reach.push(far);
        if (w.closed && w.steps.length <= SHORT_LOOP) c.loops.push(w.steps.length);
      } else budget -= 1;
      if (++c.walks >= WALKS_PER_RULE || t < 0) {
        this.reports.push({
          rule: c.rule,
          reach: median(c.reach),
          shortLoops: c.walks > 0 ? c.loops.length / c.walks : 0,
          loopLength: median(c.loops),
          infinite: isInfiniteLineRule(c.rule),
        });
        this.current = null;
      }
    }
    return this.done;
  }

  /** A rule that draws long lines: one of the few that reach farthest. */
  longLineRule(rng: Rng, infiniteLines: boolean): PlayerRule | null {
    return pickTop(
      this.reports.filter((r) => infiniteLines || !r.infinite),
      (r) => r.reach,
      rng,
    );
  }

  /** A rule that closes small loops reliably (that first), and not the tiniest ones. */
  shortLoopRule(rng: Rng): PlayerRule | null {
    return pickTop(
      this.reports.filter((r) => !r.infinite && r.shortLoops > 0),
      (r) => r.shortLoops * r.shortLoops * Math.sqrt(r.loopLength),
      rng,
    );
  }
}

const scouts = new WeakMap<Field, RuleScout>();

export function scoutFor(field: Field): RuleScout {
  let s = scouts.get(field);
  if (!s) scouts.set(field, (s = new RuleScout(field)));
  return s;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** One of the best four by `score`, the better ones likelier (so bots on one server don't all agree). */
function pickTop(reports: RuleReport[], score: (r: RuleReport) => number, rng: Rng): PlayerRule | null {
  const top = [...reports].sort((a, b) => score(b) - score(a)).slice(0, 4);
  if (top.length === 0) return null;
  const weights = top.map((_, i) => 1 / (i + 1));
  let x = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    x -= weights[i];
    if (x <= 0) return top[i].rule;
  }
  return top[0].rule;
}

// --- looking ahead -----------------------------------------------------------------

export interface Probe {
  readonly steps: readonly WalkStep[];
  /** How the walk ended: back at its start, off the field or a tail, into someone's line, or out of steps. */
  readonly end: 'closed' | 'dead' | 'hit' | 'limit';
  /** The rival line it would run into. */
  readonly hit?: Path;
}

/** The rival line (not `me`'s) that a line on step `s` would collide with, if any. */
export function rivalAt(engine: Engine, me: string, s: WalkStep): Path | undefined {
  const byTile = engine.knobs.crossingMode === 'tile';
  for (const p of engine.pathsOn(s.tile)) {
    if (p.owner === me) continue;
    if (byTile) return p;
    for (const q of p.steps) {
      if (q.tile !== s.tile) continue;
      if (sameChord(q, s) || chordsConflict([s.a, s.b], [q.a, q.b], engine.knobs.touchCounts)) return p;
    }
  }
  return undefined;
}

function sameChord(q: WalkStep, s: WalkStep): boolean {
  return q.chord === s.chord && q.tile === s.tile;
}

/**
 * Walk a line of `table` from chord `chord` of `tile`, leaving through
 * `exitEnd`, against the board as it stands (nothing else moves): at most
 * `max` steps. Junctions take their first option.
 */
export function probe(engine: Engine, me: string, table: ChordTable, tile: number, chord: number, exitEnd: 0 | 1, max: number): Probe {
  const field = engine.field;
  const first = startStep(field, table, tile, chord, exitEnd);
  const steps: WalkStep[] = [first];
  const seen = new Set<number>([tile * 64 + chord]);
  for (;;) {
    if (steps.length >= max) return { steps, end: 'limit' };
    const out = stepForward(field, table, steps[steps.length - 1], (o) => o[0]);
    if (out.kind !== 'step') return { steps, end: 'dead' };
    const s = out.step;
    if (s.tile === tile && s.chord === chord) return { steps, end: 'closed' };
    const k = s.tile * 64 + s.chord;
    if (seen.has(k)) return { steps, end: 'dead' };
    seen.add(k);
    steps.push(s);
    const hit = rivalAt(engine, me, s);
    if (hit) return { steps, end: 'hit', hit };
  }
}
