/**
 * The five kinds of bot, mixed freely (`BotMix`):
 *
 *  - wanderer: a random clean rule; taps somewhere random, sometimes right
 *    beside a rival's line. The original bot, and the easy one.
 *  - rotator: a wanderer that tires of its rule every few minutes
 *    (`rotateMs`) and starts over with another — lines, points and all.
 *  - hunter: picks on the leader. It looks a few dozen steps ahead from the
 *    tiles around the leader's lines and taps where its line would run into
 *    theirs soonest (collisions are mutual: it trades its line for theirs).
 *  - farmer: plays a rule that closes small loops, settles in a quiet corner
 *    and only taps where both ways round would close without touching anyone.
 *  - bridge: plays every edge class with combination all zeros (#81) and
 *    lays edge-to-edge claims, nested: a short one across a corner first,
 *    then the line that spans it, and so on outwards — each tapped from the
 *    middle until it closes (a half that runs off the edge is tapped at its
 *    start to turn it round). It plans with the field's edge index
 *    (`sense.ts`), a slice per tick.
 *
 * The farmer's short-loop rule comes from a scout (`sense.ts`) that tries a
 * spread of clean rules on the field once, a slice per tick. No bot
 * plays an infinite-line (FASS) rule unless `infiniteLines` says it may —
 * those are for players to find.
 *
 * Hot-loaded with the rest of `brains/`: import only *types* from
 * `../bots` (the host), so a build of this directory never carries its own
 * copy of the manager.
 */

import type { Brain, BotContext } from '../bots';
import type { Engine, Path, Player } from '../engine';
import { onFieldBoundary, tileCenter, tileNeighbours } from '../field';
import type { GameEvent } from '../protocol';
import { isInfiniteLineRule, randomCleanRule, ruleFromCombo, ruleKey, type PlayerRule } from '../rule';
import type { Rng } from '../rng';
import { tileChords, walkStrand, type ChordTable, type WalkStep } from '../strand';
import { EdgeWalk, WALK_COST, type EdgeLine, edgeIndexFor, fieldFrame, isBridgeClosed, probe, randomTileWithLine, scoutFor, stepMid, tileNear, type Probe } from './sense';
import { leafOrder, validEdgeSubsets, type Pt, type TileFamilyId } from '../../tiles';

export type BotKind = 'wanderer' | 'rotator' | 'hunter' | 'farmer' | 'bridge';

export const BOT_KINDS: readonly BotKind[] = ['wanderer', 'rotator', 'hunter', 'farmer', 'bridge'];

export const BOT_INFO: Readonly<Record<BotKind, { readonly label: string; readonly blurb: string }>> = {
  wanderer: { label: 'Wanderer', blurb: 'random rule, random taps — the easy one' },
  rotator: { label: 'Rotator', blurb: 'a new rule every few minutes, starting over each time' },
  hunter: { label: 'Hunter', blurb: 'goes after the leader and cuts their lines' },
  farmer: { label: 'Farmer', blurb: 'small safe loops in a quiet corner' },
  bridge: { label: 'Bridge', blurb: 'edge-to-edge claims, small first, then each one round the last' },
};

const NAMES = [
  'hexbot', 'psi', 'mystic', 'delta', 'theta', 'lambda', 'xi', 'sigma', 'phi', 'gamma',
  'tiler', 'weld', 'seam', 'strand', 'fass', 'loop', 'tail', 'chord', 'kernel', 'combo',
];

/** A bot's name: wanderers get one of `NAMES`, the rest their kind's label (numbered after the first). */
export function botName(kind: BotKind, nth: number): string {
  const w = nth - 1;
  return kind === 'wanderer' ? `${NAMES[w % NAMES.length]}${w >= NAMES.length ? w : ''}` : `${BOT_INFO[kind].label}${nth > 1 ? ` ${nth}` : ''}`;
}

export function makeBot(kind: BotKind, id: string, ctx: BotContext): Brain {
  switch (kind) {
    case 'wanderer':
      return new Wanderer(id, kind, ctx);
    case 'rotator':
      return new Rotator(id, kind, ctx);
    case 'hunter':
      return new Hunter(id, kind, ctx);
    case 'farmer':
      return new Farmer(id, kind, ctx);
    case 'bridge':
      return new Bridge(id, kind, ctx);
  }
}

// --- the kinds -------------------------------------------------------------------

abstract class Bot implements Brain {
  protected nextTapAt = 0;
  /** Waits for the scout before its first tap (and then takes its rule from it). */
  get needsScout(): boolean {
    return false;
  }

  constructor(
    readonly id: string,
    readonly kind: BotKind,
    protected readonly ctx: BotContext,
  ) {}

  protected get engine(): Engine {
    return this.ctx.engine;
  }

  protected get rng(): Rng {
    return this.ctx.rng;
  }

  firstRule(): PlayerRule {
    return this.cleanRule();
  }

  start(now: number, _resumed: boolean): void {
    this.nextTapAt = now + 500 + this.rng.int(2000);
  }

  update(now: number, p: Player, ev: GameEvent[]): void {
    const heads = this.engine.headLimit(p);
    if (heads > 0 && this.engine.headsInUse(p) >= heads) return;
    if (now < this.nextTapAt) return;
    this.think(now, p, ev);
  }

  /** A free head and the pause is over: tap (or decide not to). */
  protected abstract think(now: number, p: Player, ev: GameEvent[]): void;

  /** A random clean rule, never an infinite-line one unless allowed. */
  protected cleanRule(unlike?: PlayerRule): PlayerRule {
    const family = this.engine.field.family;
    let rule = randomCleanRule(family, this.rng);
    for (let k = 0; k < 20; k++) {
      const bad = (!this.ctx.options.infiniteLines && isInfiniteLineRule(rule)) || (unlike && ruleKey(rule) === ruleKey(unlike));
      if (!bad) break;
      rule = randomCleanRule(family, this.rng);
    }
    return rule;
  }

  protected tapStep(s: { tile: number; a: Pt; b: Pt }, ev: GameEvent[]): boolean {
    return this.engine.tap(this.id, s.tile, stepMid(s), ev).result.ok;
  }

  protected tapTile(tile: number, ev: GameEvent[]): boolean {
    return this.engine.tap(this.id, tile, tileCenter(this.engine.field, tile), ev).result.ok;
  }

  protected tableOf(p: Player): ChordTable {
    return (p.patterns[p.active] ?? p.patterns[0]).table;
  }

  /** Every other player with a line on the board. */
  protected rivals(): Player[] {
    return [...this.engine.players.values()].filter((q) => q.id !== this.id && q.paths.length > 0);
  }

  /** Tiles with a line of `table` next to `tile`. */
  protected around(tile: number, table: ChordTable): number[] {
    const field = this.engine.field;
    const out: number[] = [];
    for (const t of tileNeighbours(field, tile)) if (tileChords(field, table, t).length > 0) out.push(t);
    return out;
  }
}

/** Random rule, random taps, sometimes beside a rival's line. */
class Wanderer extends Bot {
  protected think(now: number, p: Player, ev: GameEvent[]): void {
    this.nextTapAt = now + 1000 + this.rng.int(3000);
    // A bot holding captured patterns draws with any of them.
    if (p.patterns.length > 1) ev.push(...this.engine.setActive(this.id, this.rng.int(p.patterns.length)));
    const tile = this.pickTile(p);
    if (tile < 0) return;
    this.tapTile(tile, ev);
  }

  private pickTile(me: Player): number {
    const field = this.engine.field;
    const table = this.tableOf(me);
    if (this.rng.next() < this.ctx.options.aggression) {
      // Find a rival step to land on.
      const rivals = this.rivals();
      if (rivals.length) {
        const r = rivals[this.rng.int(rivals.length)];
        const path = r.paths[this.rng.int(r.paths.length)];
        const step = path.steps[this.rng.int(path.steps.length)];
        if (step) {
          // Next to the rival's line (a tap on it is refused), on a free tile.
          const nbrs = tileNeighbours(field, step.tile);
          for (let k = 0; k < nbrs.length; k++) {
            const t = nbrs[(k + this.rng.int(nbrs.length)) % nbrs.length];
            if (tileChords(field, table, t).length > 0 && this.engine.pathsOn(t).length === 0) return t;
          }
        }
      }
    }
    return randomTileWithLine(field, table, this.rng);
  }
}

/** A wanderer that starts over with a new rule every `rotateMs` or so. */
class Rotator extends Wanderer {
  private rotateAt = 0;

  override start(now: number, resumed: boolean): void {
    super.start(now, resumed);
    this.rotateAt = now + this.span();
  }

  override update(now: number, p: Player, ev: GameEvent[]): void {
    if (now >= this.rotateAt) {
      this.rotateAt = now + this.span();
      ev.push(...this.engine.setRule(this.id, this.cleanRule(p.rule)));
      this.nextTapAt = now + 1000;
      return;
    }
    super.update(now, p, ev);
  }

  private span(): number {
    return this.ctx.options.rotateMs * (0.75 + 0.5 * this.rng.next());
  }
}

/** Probes a hunter or a farmer may run per tap (each up to ~60 steps). */
const PROBES_PER_TAP = 48;

/** Goes after the leader: taps where its line would run into theirs soonest. */
class Hunter extends Bot {
  private target: string | null = null;
  private retargetAt = 0;

  protected think(now: number, p: Player, ev: GameEvent[]): void {
    this.nextTapAt = now + 700 + this.rng.int(1300);
    if (now >= this.retargetAt || !this.engine.players.get(this.target ?? '')?.paths.length) {
      this.target = this.pickTarget();
      this.retargetAt = now + 8000 + this.rng.int(6000);
    }
    const target = this.target ? this.engine.players.get(this.target) : undefined;
    // With captured patterns, try each: the one whose line strikes best wins.
    const patterns = p.patterns.map((_, i) => i);
    let best: { tile: number; step: WalkStep; score: number; pattern: number } | null = null;
    if (target) {
      for (const i of patterns.length > 3 ? [p.active, this.rng.int(patterns.length)] : patterns) {
        const hit = this.bestStrike(target, p.patterns[i].table, Math.ceil(PROBES_PER_TAP / Math.min(3, patterns.length)));
        if (hit && (!best || hit.score > best.score)) best = { ...hit, pattern: i };
      }
    }
    if (best) {
      ev.push(...this.engine.setActive(this.id, best.pattern));
      if (this.tapStep(best.step, ev)) return;
    }
    // Nothing to strike at: take ground somewhere, like anyone else.
    const t = randomTileWithLine(this.engine.field, this.tableOf(p), this.rng);
    if (t >= 0) this.tapTile(t, ev);
  }

  /** Mostly the leader; now and then whoever else is on the board. */
  private pickTarget(): string | null {
    const rivals = this.rivals().sort((a, b) => b.score - a.score);
    if (rivals.length === 0) return null;
    return (this.rng.next() < 0.75 ? rivals[0] : rivals[this.rng.int(rivals.length)]).id;
  }

  private bestStrike(target: Player, table: ChordTable, budget: number): { tile: number; step: WalkStep; score: number } | null {
    const field = this.engine.field;
    // Growing lines first (cut one and it stops earning), then the richest.
    const weighted = target.paths.map((q) => ({ q, w: (q.status === 'growing' ? 40 : 1) + q.points + q.steps.length / 10 }));
    const total = weighted.reduce((n, x) => n + x.w, 0);
    let best: { tile: number; step: WalkStep; score: number } | null = null;
    const tried = new Set<number>();
    for (let sample = 0; sample < 8 && budget > 0; sample++) {
      let x = this.rng.next() * total;
      const path = (weighted.find((y) => (x -= y.w) <= 0) ?? weighted[0]).q;
      // Near the head of a growing line: that's where it is going.
      const n = path.steps.length;
      const from = path.status === 'growing' ? Math.max(0, n - 12) : 0;
      const s = path.steps[from + this.rng.int(n - from)];
      if (!s) continue;
      for (const t of this.around(s.tile, table)) {
        if (tried.has(t) || budget <= 0) continue;
        tried.add(t);
        const chords = tileChords(field, table, t).length;
        for (let c = 0; c < chords && budget > 0; c++) {
          budget -= 2;
          const a = probe(this.engine, this.id, table, t, c, 0, 40);
          const b = probe(this.engine, this.id, table, t, c, 1, 40);
          // The tap picks its way out at random: count both.
          const score = (this.strike(a, target.id) + this.strike(b, target.id)) / 2;
          if (!best || score > best.score) best = { tile: t, step: a.steps[0], score };
        }
      }
    }
    return best && best.score > 5 ? best : null;
  }

  private strike(pr: Probe, target: string): number {
    if (pr.end === 'hit' && pr.hit) {
      const worth = Math.min(40, pr.hit.points / 5);
      return (pr.hit.owner === target ? 60 : 25) + worth - pr.steps.length;
    }
    return pr.end === 'closed' ? 8 : 0;
  }
}

/** Small safe loops round a quiet home, spreading outwards. */
class Farmer extends Bot {
  private ready = false;
  private home: Pt | null = null;
  private rehomeAt = 0;
  private misses = 0;

  override get needsScout(): boolean {
    return !this.ready;
  }

  /** Taken over from an earlier brain: keep the rule it has rather than wait for the scout's. */
  override start(now: number, resumed: boolean): void {
    super.start(now, resumed);
    if (resumed) this.ready = true;
  }

  override update(now: number, p: Player, ev: GameEvent[]): void {
    if (!this.ready) {
      const scout = scoutFor(this.engine.field);
      if (!scout.done) return;
      this.ready = true;
      const rule = scout.shortLoopRule(this.rng);
      if (rule) ev.push(...this.engine.setRule(this.id, rule));
    }
    super.update(now, p, ev);
  }

  protected think(now: number, p: Player, ev: GameEvent[]): void {
    this.nextTapAt = now + 600 + this.rng.int(1200);
    // Farm with the own rule: it's the one picked for loops.
    ev.push(...this.engine.setActive(this.id, 0));
    const frame = fieldFrame(this.engine.field);
    const own = p.paths.reduce((n, q) => n + q.steps.length, 0);
    const radius = frame.unit * (4 + Math.sqrt(own) * 0.9 + this.misses * 2);
    if (!this.home || now >= this.rehomeAt || this.crowded(this.home, radius)) {
      this.home = this.pickHome(radius);
      this.rehomeAt = now + 90_000;
      this.misses = 0;
    }
    const table = p.table;
    const field = this.engine.field;
    let best: { step: WalkStep; score: number } | null = null;
    let budget = PROBES_PER_TAP;
    for (let k = 0; k < 16 && budget > 0; k++) {
      const t = tileNear(field, table, this.rng, this.home, radius);
      if (t < 0) continue;
      const beside = this.engine.pathsOn(t).length > 0 || this.around(t, table).some((u) => this.engine.pathsOn(u).some((q) => q.owner === this.id));
      for (let c = 0; c < tileChords(field, table, t).length && budget > 0; c++) {
        budget -= 2;
        const a = probe(this.engine, this.id, table, t, c, 0, 60);
        const b = probe(this.engine, this.id, table, t, c, 1, 60);
        // Careful: whichever way the tap goes has to be safe.
        const score = Math.min(this.safety(a), this.safety(b)) + (beside ? 6 : 0);
        if (!best || score > best.score) best = { step: a.steps[0], score };
      }
    }
    if (best && best.score > 0 && this.tapStep(best.step, ev)) {
      this.misses = 0;
      return;
    }
    // Nowhere safe here: look further out next time.
    this.misses = Math.min(10, this.misses + 1);
  }

  private safety(pr: Probe): number {
    if (pr.end === 'closed') return 10 + Math.min(30, pr.steps.length);
    if (pr.end === 'dead') return 1;
    return -100;
  }

  /** Where rivals' lines are: a sample of their steps' midpoints. */
  private rivalPoints(max = 400): Pt[] {
    const pts: Pt[] = [];
    const all = this.rivals().flatMap((r) => r.paths);
    const total = all.reduce((n, q) => n + q.steps.length, 0);
    const every = Math.max(1, Math.floor(total / max));
    let k = 0;
    for (const q of all) for (const s of q.steps) if (k++ % every === 0) pts.push(stepMid(s));
    return pts;
  }

  private crowded(home: Pt, radius: number): boolean {
    let n = 0;
    for (const q of this.rivalPoints(200)) if (Math.hypot(q.x - home.x, q.y - home.y) < radius * 0.6 && ++n > 3) return true;
    return false;
  }

  /** The candidate tile farthest from anyone else's lines. */
  private pickHome(radius: number): Pt {
    const field = this.engine.field;
    const table = this.engine.players.get(this.id)!.table;
    const rivals = this.rivalPoints();
    let best: Pt = tileCenter(field, Math.max(0, randomTileWithLine(field, table, this.rng)));
    let bestD = -1;
    for (let k = 0; k < 24; k++) {
      const t = randomTileWithLine(field, table, this.rng);
      if (t < 0) continue;
      const c = tileCenter(field, t);
      let d = Infinity;
      for (const q of rivals) d = Math.min(d, Math.hypot(q.x - c.x, q.y - c.y));
      d = Math.min(d, radius * 6);
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}

/** The bridge's rule (#81): every edge class on that keeps the rule clean (all of them, on hex), every combination digit 0. */
export function bridgeRule(family: TileFamilyId): PlayerRule {
  const widest = validEdgeSubsets(family).reduce((a, b) => (b.edges.length > a.edges.length ? b : a));
  return ruleFromCombo(family, widest.edges.join(''), '0'.repeat(leafOrder(family).length));
}

/** A bridge's planning per tick, in walk steps (3–15 µs each): a few ms at most, at any board size. */
export const BRIDGE_BUDGET = 300;
/** The first bridge is a line from edge to edge shorter than this (#81)… */
const FIRST_BRIDGE = 20;
/** …unless none turns up in this many tries; then any length will do. */
const FIRST_BRIDGE_TRIES = 400;
/** No bridge is planned longer than this. */
const BRIDGE_LIMIT = 20_000;
/** A bridge none of whose gaps has filled for this long (someone's line in the way) is passed over for the next one out. */
const BRIDGE_GIVE_UP_MS = 90_000;
/** …and one where this many turns in a row land no tap (inside a rival's circuit, say) much sooner. */
const BRIDGE_IDLE_TURNS = 8;
/** A bridge given up isn't planned again for this long. */
const BRIDGE_RETRY_MS = 5 * 60_000;

/** A stretch of the field's edge, in edge-index numbers: from `a` on round to `b`. */
interface Arc {
  readonly a: number;
  readonly b: number;
}

interface BridgePlan extends Arc {
  readonly steps: readonly WalkStep[];
  /** Where it starts (C): if it's given up, the search goes on from the next start. */
  readonly from: number;
  readonly since: number;
  /** How many of its chords our lines held when last looked at, and since when. */
  held: number;
  heldSince: number;
}

/**
 * Bridges from edge to edge, nested outwards (#81). A bridge claims the
 * smaller side of the board, as the engine does: its arc is the shorter way
 * round the edge between its ends. The first is a short line across a
 * corner; once it closes, the next is the line that spans it: from the
 * bridge's far end B the bot walks the edge index on (start C), following
 * each start's line to where it comes out (D), and takes the first whose arc
 * holds the last one's. Each is tapped until it closes: the gap nearest its
 * middle, and a half that ran off the edge tapped at its start to turn it
 * round, so a finished bridge claims all inside it. A bridge already laid is
 * stepped over (the search goes on round it); one whose middle is inside a
 * rival's circuit or on a rival's line isn't planned; one that can't be
 * tapped for a while, or makes no headway for too long, is given up, and the search
 * goes on round the last that closed. Once nothing spans the last (that
 * would take more than half the edge), it starts small
 * again just past it — growing on round from where it is, never jumping
 * across the board. Every search runs a slice a tick
 * (`BRIDGE_BUDGET`).
 */
class Bridge extends Bot {
  private plan: BridgePlan | null = null;
  /** The line being walked: a candidate for the next plan, or (`chosen`) the next plan's steps. */
  private walk: EdgeWalk | null = null;
  private chosen: Arc | null = null;
  /** Looking for the line round the last bridge that closed (its arc), at start `next`; null: looking for a short first one. */
  private nest: { arc: Arc; next: number } | null = null;
  /** The last bridge that closed. */
  private closed: Arc | null = null;
  /** Where a search for a short first one walks from (on round, a start at a time); null: anywhere. */
  private near: number | null = null;
  private tries = 0;
  /** Turns in a row with no tap landing on the plan. */
  private idle = 0;
  /** Ends of bridges given up, and when. */
  private readonly failed = new Map<number, number>();

  override firstRule(): PlayerRule {
    return bridgeRule(this.engine.field.family);
  }

  override update(now: number, p: Player, ev: GameEvent[]): void {
    // Planning runs whether or not a head is free.
    if (!this.plan) this.search(now, p, BRIDGE_BUDGET);
    super.update(now, p, ev);
  }

  protected think(now: number, p: Player, ev: GameEvent[]): void {
    this.nextTapAt = now + 400 + this.rng.int(600);
    const plan = this.plan;
    if (!plan) return;
    if (isBridgeClosed(this.engine, this.id, plan.steps)) {
      // Done: the next one out spans it.
      this.done(plan, true);
      return;
    }
    const mine = this.ours(plan.steps);
    let held = 0;
    for (const s of plan.steps) if (mine.has(s.tile * 64 + s.chord)) held++;
    if (held > plan.held) {
      plan.held = held;
      plan.heldSince = now;
    }
    if (now - plan.heldSince > BRIDGE_GIVE_UP_MS || this.idle >= BRIDGE_IDLE_TURNS) {
      this.done(plan, false);
      return;
    }
    if (this.tapPlan(plan, p, mine, ev)) this.idle = 0;
    else this.idle++;
  }

  /** The chords our lines on these steps' tiles hold (tile × 64 + chord). */
  private ours(steps: readonly WalkStep[]): Set<number> {
    const crossing = new Set<Path>();
    for (const s of steps) for (const q of this.engine.pathsOn(s.tile)) if (q.owner === this.id) crossing.add(q);
    const mine = new Set<number>();
    for (const q of crossing) for (const s of q.steps) mine.add(s.tile * 64 + s.chord);
    return mine;
  }

  /** Drop the plan: the search goes on round the last bridge that closed (this one, if it did). */
  private done(plan: BridgePlan, closed: boolean): void {
    this.plan = null;
    this.idle = 0;
    if (closed) this.closed = { a: plan.a, b: plan.b };
    else {
      this.failed.set(plan.a, plan.since);
      this.failed.set(plan.b, plan.since);
    }
    const last = this.closed;
    if (last && (closed || this.nest)) this.nest = { arc: last, next: closed ? last.b + 1 : plan.from + 1 };
    else this.startSmall(plan.from + 1);
  }

  /** Look for a short first one, walking round from start `near`. */
  private startSmall(near: number): void {
    this.nest = null;
    this.near = near;
    this.tries = 0;
  }

  /** One tap towards closing the plan; false if none landed. */
  private tapPlan(plan: BridgePlan, p: Player, mine: ReadonlySet<number>, ev: GameEvent[]): boolean {
    ev.push(...this.engine.setActive(this.id, 0));
    const field = this.engine.field;
    const onPlan = new Set(plan.steps.map((s) => s.tile * 64 + s.chord));
    // A half that ran off the edge: tap its start (the same spot) to turn it round.
    for (const q of p.paths) {
      if (q.status !== 'stuck' || q.table !== p.table) continue;
      const first = q.steps[0];
      const last = q.steps[q.steps.length - 1];
      if (!onPlan.has(first.tile * 64 + first.chord) || !onFieldBoundary(field, last.tile, last.b)) continue;
      if (this.tapStep(first, ev)) return true;
    }
    // Otherwise the gap nearest the middle: a chord of the plan none of its lines holds yet.
    const steps = plan.steps;
    const mid = steps.length >> 1;
    let tries = 0;
    for (let d = 0; d <= mid + 1; d++) {
      for (const i of d === 0 ? [mid] : [mid - d, mid + d]) {
        const s = steps[i];
        if (!s || mine.has(s.tile * 64 + s.chord)) continue;
        if (this.tapStep(s, ev)) return true;
        if (++tries >= 6) return false;
      }
    }
    return false;
  }

  /**
   * Not worth planning: given up on lately, or its middle — where it's tapped
   * first — is inside a rival's circuit or on a rival's line, where no tap lands.
   */
  private unplayable(now: number, c: number, d: number, mid: WalkStep): boolean {
    for (const k of [c, d]) {
      const at = this.failed.get(k);
      if (at === undefined) continue;
      if (now - at < BRIDGE_RETRY_MS) return true;
      this.failed.delete(k);
    }
    for (const q of this.engine.pathsOn(mid.tile)) if (q.owner !== this.id) return true;
    return this.engine.insideRivalCircuit(this.id, stepMid(mid));
  }

  /**
   * Spend about `budget` steps on the edge index, then on finding the next
   * bridge. A line walked once is known from then on (`lineFrom`), so going
   * round past lines already judged costs next to nothing; only the plan's
   * own steps are walked again.
   */
  private search(now: number, p: Player, budget: number): void {
    const index = edgeIndexFor(this.engine.field, p.table);
    if (!index.done) {
      index.work(budget);
      return;
    }
    const n = index.starts.length;
    if (n < 2) return;
    while (budget > 0 && !this.plan) {
      if (this.walk) {
        // A line being walked: to judge it, or for the steps of the one chosen.
        const w = this.walk;
        budget -= w.work(budget);
        if (w.end === undefined) return;
        this.walk = null;
        const chosen = this.chosen;
        this.chosen = null;
        if (chosen) {
          if (w.end !== null) this.setPlan(now, chosen, w.from, w.steps);
          continue;
        }
        const line = index.lineFrom(w.from, w.steps.length);
        const arc = line && this.judge(now, n, w.from, line);
        if (arc) this.setPlan(now, arc, w.from, w.steps);
        continue;
      }
      // The next start to try.
      let c: number;
      let limit = BRIDGE_LIMIT;
      if (this.nest) {
        // On round from B. A line from C that spans the last arc has A to C on its side: past half the edge
        // (where the engine would claim the other side) nothing will, so start again small, just past it.
        const { a, b } = this.nest.arc;
        c = mod(this.nest.next, n);
        if (fwd(a, c, n) > n >> 1) {
          this.startSmall(b + 1);
          continue;
        }
        this.nest.next = c + 1;
      } else {
        const short = this.tries++ < FIRST_BRIDGE_TRIES;
        c = short && this.near !== null ? mod(this.near + this.tries - 1, n) : this.rng.int(n);
        if (short) limit = FIRST_BRIDGE;
      }
      const line = index.lineFrom(c, limit);
      if (!line) {
        budget -= WALK_COST;
        this.walk = new EdgeWalk(index, c, limit);
        continue;
      }
      budget--;
      const arc = this.judge(now, n, c, line);
      if (arc) {
        this.chosen = arc;
        this.walk = new EdgeWalk(index, c, line.length);
      }
    }
  }

  private setPlan(now: number, arc: Arc, from: number, steps: readonly WalkStep[]): void {
    this.plan = { steps, a: arc.a, b: arc.b, from, since: now, held: 0, heldSince: now };
    this.tries = 0;
    this.idle = 0;
  }

  /** The arc of the line from start `c` if it's the next bridge to lay; null if not (and stepping over one laid already). */
  private judge(now: number, n: number, c: number, line: EdgeLine): Arc | null {
    const d = line.end;
    if (d === null) return null;
    // A bridge claims the shorter way round between its ends, as the engine does.
    const arc = fwd(c, d, n) <= n >> 1 ? { a: c, b: d } : { a: d, b: c };
    const laid = isBridgeClosed(this.engine, this.id, [line.first, line.last]);
    if (this.nest) {
      // It spans the last one if its arc holds the last's (else it's a bump beside it).
      const last = this.nest.arc;
      if (fwd(arc.a, last.a, n) > fwd(arc.a, last.b, n) || fwd(arc.a, last.b, n) > fwd(arc.a, arc.b, n)) return null;
      if (laid) {
        // Laid already: the next one out spans it.
        this.closed = arc;
        this.nest = { arc, next: arc.b + 1 };
        return null;
      }
    } else if (laid) return null;
    return this.unplayable(now, c, d, line.mid) ? null : arc;
  }
}

function mod(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/** Edge starts from `x` on round to `y`, of `n`. */
function fwd(x: number, y: number, n: number): number {
  return mod(y - x, n);
}
