/**
 * What the bots can see and work out: the field's shape, which rules make
 * which kinds of line (a scout, shared by every bot on a field), and a probe
 * that walks a would-be line forward against the live board to see what it
 * runs into. Pure, like the rest of `shared/game`. Part of the hot-loaded
 * brains (see `index.ts`).
 */

import { validEdgeSubsets, type Pt } from '../../tiles';
import type { BoardView, PathView } from '../bots';
import { onFieldBoundary, pointSegDist2, tileAt, tileCenter, tileNeighbours, tilePolygon, type Field } from '../field';
import { isInfiniteLineRule, randomMatching, ruleKey, type PlayerRule } from '../rule';
import { mulberry32, type Rng } from '../rng';
import { chordTableFor, chordsConflict, continuations, randomJunctionPicker, startStep, stepForward, tileChords, walkStrand, worldChord, type ChordTable, type WalkStep } from '../strand';

export { isInfiniteLineRule };

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
  readonly hit?: PathView;
}

/** The rival line (not `me`'s) that a line on step `s` would collide with, if any. */
export function rivalAt(board: BoardView, me: string, s: WalkStep): PathView | undefined {
  const byTile = board.knobs.crossingMode === 'tile';
  for (const p of board.pathsOn(s.tile)) {
    if (p.owner === me) continue;
    if (byTile) return p;
    for (const q of p.steps) {
      if (q.tile !== s.tile) continue;
      if (sameChord(q, s) || chordsConflict([s.a, s.b], [q.a, q.b], board.knobs.touchCounts)) return p;
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
export function probe(board: BoardView, me: string, table: ChordTable, tile: number, chord: number, exitEnd: 0 | 1, max: number): Probe {
  const field = board.field;
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
    const hit = rivalAt(board, me, s);
    if (hit) return { steps, end: 'hit', hit };
  }
}

// --- the field's edge, for bridges -------------------------------------------------

/**
 * A chord end on the field's edge with nothing behind it: a line started
 * there runs inward, leaving by `exitEnd`, and a line that reaches it has run
 * off the board — the engine's edge-to-edge claim (`startsAtEdge`).
 */
export interface EdgeStart {
  readonly tile: number;
  readonly chord: number;
  readonly exitEnd: 0 | 1;
}

/** What tracing one tile edge of the field's outline costs, in walk steps. */
const EDGE_COST = 8;
/** And starting a walk, in steps. */
export const WALK_COST = 4;

function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4;
}

interface EdgeAt {
  readonly tile: number;
  /** Edge `k` of the tile's polygon, traced from `from` to `to`. */
  readonly k: number;
  readonly from: Pt;
  readonly to: Pt;
}

/**
 * The edge index: every edge start of one rule, numbered in order round the
 * field's edge, and the number of a chord end (`numberOf`). Traced along the
 * outline a tile edge at a time, `work(budget)` a slice — a level-6 board's
 * edge is ~29k tile edges, a second or more all told, so no tick pays for it
 * (and nothing here leans on `fieldOutline`, whose cache a hot-loaded build
 * can't share). One per field and rule: every bot shares it (`edgeIndexFor`).
 */
export class EdgeIndex {
  readonly starts: EdgeStart[] = [];
  private readonly numbers = new Map<number, number>();
  /** Every line walked from a start so far (`EdgeWalk`), by its start: the rule's lines never change. */
  private readonly lines = new Map<number, EdgeLine>();
  private first: EdgeAt | null = null;
  private cur: EdgeAt | null = null;
  private traced = 0;
  private finished = false;
  /** Outlines of the tiles round the last few edges traced: the next edge's are mostly the same. */
  private readonly polys = new Map<number, readonly Pt[]>();

  constructor(
    readonly field: Field,
    readonly table: ChordTable,
  ) {}

  get done(): boolean {
    return this.finished;
  }

  /** The number of the start at end `end` of chord `chord` of `tile`, or -1 (that end isn't on the edge). */
  numberOf(tile: number, chord: number, end: 0 | 1): number {
    return this.numbers.get((tile * 64 + chord) * 2 + end) ?? -1;
  }

  /**
   * The line from start `from` if one walked it before, or undefined: then
   * walk it (`EdgeWalk`). Past `limit` steps it counts as no bridge (`end`
   * null), as a walk with that limit would.
   */
  lineFrom(from: number, limit: number): EdgeLine | undefined {
    const line = this.lines.get(from);
    if (!line) return undefined;
    if (line.capped) return limit <= line.length ? line : undefined;
    return line.length <= limit ? line : { ...line, end: null };
  }

  /** What a walk found (both ways round, for a bridge). */
  noteLine(from: number, line: EdgeLine): void {
    const had = this.lines.get(from);
    if (had && !had.capped) return;
    if (this.lines.size > 4 * this.starts.length + 64) this.lines.clear();
    this.lines.set(from, line);
    if (line.end !== null) this.lines.set(line.end, { ...line, end: from, first: line.last, last: line.first });
  }

  /** Trace about `budget` walk steps' worth more. True once the whole edge is indexed. */
  work(budget: number): boolean {
    while (budget > 0 && !this.finished) {
      if (!this.cur) {
        this.cur = this.first = this.firstEdge();
        budget -= this.field.count >> 10;
        if (!this.cur) this.finished = true;
        continue;
      }
      this.collect(this.cur);
      budget -= EDGE_COST;
      const next = this.nextEdge(this.cur);
      if (!next || (next.tile === this.first!.tile && next.k === this.first!.k) || ++this.traced > this.field.count * 8) {
        this.finished = true;
        this.cur = null;
      } else this.cur = next;
    }
    return this.finished;
  }

  /** An outline edge of the leftmost tile (nothing lies left of it). */
  private firstEdge(): EdgeAt | null {
    const field = this.field;
    let left = -1;
    let minX = Infinity;
    for (let i = 0; i < field.count; i++) {
      const x = field.centers[i * 2];
      if (x < minX) {
        minX = x;
        left = i;
      }
    }
    if (left < 0) return null;
    const poly = tilePolygon(field, left);
    for (let k = 0; k < poly.length; k++) {
      const next = this.edgeFrom(left, poly[k], -1);
      if (next) return next;
    }
    return null;
  }

  /** The outline edge that carries on from `e`'s far end. */
  private nextEdge(e: EdgeAt): EdgeAt | null {
    return this.edgeFrom(e.tile, e.to, e.k);
  }

  /**
   * An outline edge at corner `q` of tile `tile` other than that tile's edge
   * `skip` — one no other tile shares — the same way round as the tile's
   * own edges where there's a choice. Every tile at `q` is `tile` or a
   * (vertex) neighbour of it.
   */
  private edgeFrom(tile: number, q: Pt, skip: number): EdgeAt | null {
    const field = this.field;
    const at: { tile: number; k: number; other: Pt; forward: boolean }[] = [];
    if (this.polys.size > 256) this.polys.clear();
    const scan = (t: number): void => {
      let poly = this.polys.get(t);
      if (!poly) this.polys.set(t, (poly = tilePolygon(field, t)));
      const m = poly.length;
      for (let k = 0; k < m; k++) {
        const u = poly[k];
        const v = poly[(k + 1) % m];
        if (samePt(u, q)) at.push({ tile: t, k, other: v, forward: true });
        else if (samePt(v, q)) at.push({ tile: t, k, other: u, forward: false });
      }
    };
    scan(tile);
    for (const n of tileNeighbours(field, tile)) scan(n);
    let fallback: EdgeAt | null = null;
    for (const x of at) {
      if (x.tile === tile && x.k === skip) continue;
      if (at.some((y) => y.tile !== x.tile && samePt(y.other, x.other))) continue;
      const next = { tile: x.tile, k: x.k, from: q, to: x.other };
      if (x.forward) return next;
      fallback ??= next;
    }
    return fallback;
  }

  /** Number the edge starts on `e`, in order along it. */
  private collect(e: EdgeAt): void {
    const { field, table } = this;
    const found: { key: number; along: number; start: EdgeStart }[] = [];
    const dx = e.to.x - e.from.x;
    const dy = e.to.y - e.from.y;
    const chords = tileChords(field, table, e.tile).length;
    for (let c = 0; c < chords; c++) {
      const w = worldChord(field, table, e.tile, c);
      for (const end of [0, 1] as const) {
        const p = w[end];
        const key = (e.tile * 64 + c) * 2 + end;
        if (this.numbers.has(key) || pointSegDist2(p, e.from, e.to) > 1e-6) continue;
        if (!onFieldBoundary(field, e.tile, p) || continuations(field, table, e.tile, c, p).length > 0) continue;
        found.push({ key, along: (p.x - e.from.x) * dx + (p.y - e.from.y) * dy, start: { tile: e.tile, chord: c, exitEnd: end === 0 ? 1 : 0 } });
      }
    }
    found.sort((a, b) => a.along - b.along);
    for (const f of found) {
      this.numbers.set(f.key, this.starts.length);
      this.starts.push(f.start);
    }
  }
}

const edgeIndexes = new WeakMap<Field, Map<string, EdgeIndex>>();

/** The field's edge index for `table` (shared; it may not be `done` yet — `work` it). */
export function edgeIndexFor(field: Field, table: ChordTable): EdgeIndex {
  let byRule = edgeIndexes.get(field);
  if (!byRule) edgeIndexes.set(field, (byRule = new Map()));
  let index = byRule.get(table.key);
  if (!index) byRule.set(table.key, (index = new EdgeIndex(field, table)));
  return index;
}

/**
 * The line from edge start `from` walked to where it meets the edge again, a
 * slice at a time (`work`). `end` is that start's number in the index; null
 * when the line isn't a bridge (it closes on itself, forks, or runs past
 * `limit` steps); undefined while still walking.
 */
/** A line from an edge start, as walked: where it comes out, and three of its steps (enough to judge it by). */
export interface EdgeLine {
  /** The start it comes out at; null: no bridge (it closes, forks, or ran past the walk's limit). */
  readonly end: number | null;
  readonly length: number;
  /** It ran past the walk's limit: a longer walk may still find its end. */
  readonly capped: boolean;
  readonly first: WalkStep;
  readonly mid: WalkStep;
  readonly last: WalkStep;
}

export class EdgeWalk {
  readonly steps: WalkStep[] = [];
  end: number | null | undefined = undefined;
  private readonly seen = new Set<number>();

  constructor(
    private readonly index: EdgeIndex,
    readonly from: number,
    private readonly limit: number,
  ) {
    const s = index.starts[from];
    if (!s) {
      this.end = null;
      return;
    }
    this.steps.push(startStep(index.field, index.table, s.tile, s.chord, s.exitEnd));
    this.seen.add(s.tile * 64 + s.chord);
  }

  /** Walk up to `budget` more steps; returns how many it took. */
  work(budget: number): number {
    const { field, table } = this.index;
    let n = 0;
    while (this.end === undefined && n < budget) {
      n++;
      const cur = this.steps[this.steps.length - 1];
      const out = stepForward(field, table, cur);
      if (out.kind === 'dead') {
        const w = worldChord(field, table, cur.tile, cur.chord);
        const at = this.index.numberOf(cur.tile, cur.chord, samePt(w[0], cur.b) ? 0 : 1);
        this.finish(at >= 0 && at !== this.from ? at : null, false);
      } else if (out.kind === 'junction') this.finish(null, false);
      else if (this.steps.length >= this.limit) this.finish(null, true);
      else {
        const k = out.step.tile * 64 + out.step.chord;
        if (this.seen.has(k)) this.finish(null, false);
        else {
          this.seen.add(k);
          this.steps.push(out.step);
        }
      }
    }
    return n;
  }

  private finish(end: number | null, capped: boolean): void {
    this.end = end;
    const steps = this.steps;
    this.index.noteLine(this.from, { end, length: steps.length, capped, first: steps[0], mid: steps[steps.length >> 1], last: steps[steps.length - 1] });
  }
}

/** Has `me` closed a line along the whole of `steps` (it holds both its end chords)? */
export function isBridgeClosed(board: BoardView, me: string, steps: readonly WalkStep[]): boolean {
  if (steps.length === 0) return false;
  const first = steps[0];
  const last = steps[steps.length - 1];
  for (const q of board.pathsOn(first.tile)) {
    if (q.owner !== me || q.status !== 'closed') continue;
    let a = false;
    let b = false;
    for (const s of q.steps) {
      if (s.tile === first.tile && s.chord === first.chord) a = true;
      if (s.tile === last.tile && s.chord === last.chord) b = true;
    }
    if (a && b) return true;
  }
  return false;
}

// --- how far a rule's lines can go ------------------------------------------------

/**
 * The longest strand (circuit, tail or edge-to-edge line) of `table` on the
 * whole field, in steps — or the first length found over `cap`, as soon as
 * one is (so a rule with long lines costs little). Walks every chord once:
 * for `scripts/small-rules.ts` and its test, never in a tick.
 */
export function longestStrand(field: Field, table: ChordTable, cap = Infinity): number {
  const seen = new Uint8Array(field.count * 64);
  let longest = 0;
  for (let t = 0; t < field.count; t++) {
    const n = tileChords(field, table, t).length;
    for (let c = 0; c < n; c++) {
      if (seen[t * 64 + c]) continue;
      seen[t * 64 + c] = 1;
      let len = 1;
      let closed = false;
      for (const exit of [1, 0] as const) {
        let cur = startStep(field, table, t, c, exit);
        for (;;) {
          const out = stepForward(field, table, cur);
          if (out.kind !== 'step') break;
          if (out.step.tile === t && out.step.chord === c) {
            closed = true;
            break;
          }
          const k = out.step.tile * 64 + out.step.chord;
          if (seen[k]) break;
          seen[k] = 1;
          len++;
          cur = out.step;
        }
        if (closed) break;
      }
      if (len > longest) longest = len;
      if (longest > cap) return longest;
    }
  }
  return longest;
}
