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
import { EdgeWalk, WALK_COST, edgeIndexFor, fieldFrame, isBridgeClosed, probe, randomTileWithLine, scoutFor, stepMid, tileNear, type Probe } from './sense';
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
/** A bridge still open after this long (someone's line in the way) is passed over for the next one out. */
const BRIDGE_GIVE_UP_MS = 3 * 60_000;

interface BridgePlan {
  readonly steps: readonly WalkStep[];
  /** Edge-index numbers: the bridge runs from one to the other, enclosing the arc of edge from `a` on round to `b`. */
  readonly a: number;
  readonly b: number;
  readonly since: number;
}

/**
 * Bridges from edge to edge, nested outwards (#81). The first is a short
 * line across a corner of the board; once it closes, the next is the line
 * that spans it: from the bridge's far end B the bot walks the edge index on
 * (start C), following each start's line to where it comes out (D), and takes
 * the first whose D lands nearer the near end A than B. Each is tapped until
 * it closes: the gap nearest its middle, and a half that ran off the edge
 * tapped at its start to turn it round, so a finished bridge claims all
 * inside it. Every search runs a slice a tick (`BRIDGE_BUDGET`).
 */
class Bridge extends Bot {
  private plan: BridgePlan | null = null;
  /** The line being walked, as a candidate for the next plan. */
  private walk: EdgeWalk | null = null;
  /** Looking for the line round the last bridge (its a, b), at start `next`; null: looking for a short first one. */
  private nest: { a: number; b: number; next: number } | null = null;
  private tries = 0;

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
    if (isBridgeClosed(this.engine, this.id, plan.steps) || now - plan.since > BRIDGE_GIVE_UP_MS) {
      // Done (or hopeless): the next one out spans it.
      this.plan = null;
      this.nest = { a: plan.a, b: plan.b, next: plan.b + 1 };
      return;
    }
    ev.push(...this.engine.setActive(this.id, 0));
    const field = this.engine.field;
    const onPlan = new Set(plan.steps.map((s) => s.tile * 64 + s.chord));
    // A half that ran off the edge: tap its start (the same spot) to turn it round.
    for (const q of p.paths) {
      if (q.status !== 'stuck' || q.table !== p.table) continue;
      const first = q.steps[0];
      const last = q.steps[q.steps.length - 1];
      if (!onPlan.has(first.tile * 64 + first.chord) || !onFieldBoundary(field, last.tile, last.b)) continue;
      if (this.tapStep(first, ev)) return;
    }
    // Otherwise the gap nearest the middle: a chord of the plan none of its lines holds yet.
    const steps = plan.steps;
    const crossing = new Set<Path>();
    for (const s of steps) for (const q of this.engine.pathsOn(s.tile)) if (q.owner === this.id) crossing.add(q);
    const mine = new Set<number>();
    for (const q of crossing) for (const s of q.steps) mine.add(s.tile * 64 + s.chord);
    const mid = steps.length >> 1;
    let tries = 0;
    for (let d = 0; d <= mid + 1; d++) {
      for (const i of d === 0 ? [mid] : [mid - d, mid + d]) {
        const s = steps[i];
        if (!s || mine.has(s.tile * 64 + s.chord)) continue;
        if (this.tapStep(s, ev) || ++tries >= 6) return;
      }
    }
  }

  /** Spend about `budget` steps on the edge index, then on finding the next bridge. */
  private search(now: number, p: Player, budget: number): void {
    const index = edgeIndexFor(this.engine.field, p.table);
    if (!index.done) {
      index.work(budget);
      return;
    }
    const n = index.starts.length;
    if (n < 2) return;
    while (budget > 0 && !this.plan) {
      if (!this.walk) {
        if (this.nest) {
          // On round from B; back at A, there's nothing left to span: start again small.
          const c = ((this.nest.next % n) + n) % n;
          if (c === this.nest.a) {
            this.nest = null;
            continue;
          }
          this.nest.next = c + 1;
          this.walk = new EdgeWalk(index, c, BRIDGE_LIMIT);
        } else {
          const limit = this.tries++ < FIRST_BRIDGE_TRIES ? FIRST_BRIDGE : BRIDGE_LIMIT;
          this.walk = new EdgeWalk(index, this.rng.int(n), limit);
        }
        budget -= WALK_COST;
      }
      const w = this.walk;
      budget -= w.work(budget);
      if (w.end === undefined) return;
      this.walk = null;
      if (w.end === null) continue;
      const c = w.from;
      const d = w.end;
      if (this.nest) {
        const { a, b } = this.nest;
        const dist = (x: number, y: number): number => Math.min((x - y + n) % n, (y - x + n) % n);
        if (dist(d, a) >= dist(d, b)) continue;
        // It spans the last one: its inside runs from D on round past A and B to C.
        this.plan = { steps: w.steps, a: d, b: c, since: now };
      } else {
        // The first: its inside is the short way round between its ends.
        const short = (d - c + n) % n <= n >> 1;
        this.plan = { steps: w.steps, a: short ? c : d, b: short ? d : c, since: now };
      }
      this.tries = 0;
    }
  }
}
