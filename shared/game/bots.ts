/**
 * Bots: opposition with a bit of character, so an arena is worth playing
 * when you are the only human in it. Five kinds, mixed freely (`BotMix`):
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
 *  - bridge: plays a rule that draws long thin lines, plans one across the
 *    busiest stretch of board it can find, and keeps tapping the middle of it
 *    — rebuilding whatever gets cut, and cutting whatever is in the way. When
 *    a half runs off the edge it taps the same spot again to turn it round,
 *    so a finished bridge is an edge-to-edge claim.
 *
 * The long-line and short-loop rules come from a scout (`bot-sense.ts`) that
 * tries a spread of clean rules on the field once, a slice per tick. No bot
 * plays an infinite-line (FASS) rule unless `infiniteLines` says it may —
 * those are for players to find.
 */

import { type Engine, type Player } from './engine';
import { onFieldBoundary, tileCenter, tileNeighbours, type Field } from './field';
import type { GameEvent } from './protocol';
import { randomCleanRule, ruleKey, type PlayerRule } from './rule';
import type { Rng } from './rng';
import { tileChords, walkStrand, type ChordTable, type WalkStep } from './strand';
import {
  fieldFrame,
  isInfiniteLineRule,
  probe,
  randomTileWithLine,
  scoutFor,
  stepMid,
  tileNear,
  type Probe,
} from './bot-sense';
import type { Pt } from '../tiles';

// --- which bots ------------------------------------------------------------------

export type BotKind = 'wanderer' | 'rotator' | 'hunter' | 'farmer' | 'bridge';

export const BOT_KINDS: readonly BotKind[] = ['wanderer', 'rotator', 'hunter', 'farmer', 'bridge'];

export const BOT_INFO: Readonly<Record<BotKind, { readonly label: string; readonly blurb: string }>> = {
  wanderer: { label: 'Wanderer', blurb: 'random rule, random taps — the easy one' },
  rotator: { label: 'Rotator', blurb: 'a new rule every few minutes, starting over each time' },
  hunter: { label: 'Hunter', blurb: 'goes after the leader and cuts their lines' },
  farmer: { label: 'Farmer', blurb: 'small safe loops in a quiet corner' },
  bridge: { label: 'Bridge', blurb: 'long lines across the busy middle, rebuilt whenever cut' },
};

/** How many of each kind. */
export type BotMix = Readonly<Partial<Record<BotKind, number>>>;

export function isBotKind(x: unknown): x is BotKind {
  return typeof x === 'string' && (BOT_KINDS as readonly string[]).includes(x);
}

/**
 * `BOTS`-style text into a mix: a bare number is that many wanderers (what
 * `BOTS` always meant); otherwise a list of kinds, each optionally `:count`,
 * split by commas, `+` or spaces — `bridge,hunter:2`, `bridge+hunter:2`
 * (`+` survives `gcloud --set-env-vars`, which splits on commas). Unknown
 * kinds come back in `unknown` rather than throwing.
 */
export function parseBotMix(raw: string | undefined | null): { mix: BotMix; unknown: string[] } {
  const text = (raw ?? '').trim();
  if (text === '') return { mix: {}, unknown: [] };
  if (/^\d+$/.test(text)) return { mix: { wanderer: Number(text) }, unknown: [] };
  const mix: Partial<Record<BotKind, number>> = {};
  const unknown: string[] = [];
  for (const part of text.split(/[,+;\s]+/)) {
    const [rawKind, rawCount] = part.split(/[:=*]/).map((s) => s.trim().toLowerCase());
    if (!rawKind) continue;
    const n = rawCount === undefined || rawCount === '' ? 1 : Number(rawCount);
    if (!isBotKind(rawKind) || !Number.isInteger(n) || n < 0) {
      unknown.push(part.trim());
      continue;
    }
    mix[rawKind] = (mix[rawKind] ?? 0) + n;
  }
  return { mix, unknown };
}

/** The mix as `parseBotMix` reads it back: `bridge,hunter:2` ('none' when empty). */
export function formatBotMix(mix: BotMix): string {
  const parts = BOT_KINDS.filter((k) => (mix[k] ?? 0) > 0).map((k) => (mix[k] === 1 ? k : `${k}:${mix[k]}`));
  return parts.length ? parts.join(',') : 'none';
}

export function botTotal(mix: BotMix): number {
  return BOT_KINDS.reduce((n, k) => n + (mix[k] ?? 0), 0);
}

export interface BotOptions {
  /** Wanderers and rotators: how often a tap aims beside a rival's line. */
  readonly aggression: number;
  /** Rotators: about how long a rule lasts before they start over (±25%). */
  readonly rotateMs: number;
  /** May a bot play an infinite-line (FASS) rule? */
  readonly infiniteLines: boolean;
}

export const DEFAULT_BOT_OPTIONS: BotOptions = { aggression: 0.3, rotateMs: 5 * 60_000, infiniteLines: false };

const NAMES = [
  'hexbot', 'psi', 'mystic', 'delta', 'theta', 'lambda', 'xi', 'sigma', 'phi', 'gamma',
  'tiler', 'weld', 'seam', 'strand', 'fass', 'loop', 'tail', 'chord', 'kernel', 'combo',
];

/** Steps of scouting per `update` (2–4 µs each): a few ms a tick, for a few seconds. */
const SCOUT_BUDGET = 2500;

/**
 * Do the bots' one-off work on a field up front — the scout (~0.1–0.3 s at
 * hex level 6) and the field's frame — when `mix` has a kind that needs it,
 * so it happens while the field is built rather than in a tick. Skipping
 * this is fine: the bots then scout a slice per tick instead.
 */
export function prepareBots(field: Field, mix: BotMix): void {
  if (!(mix.farmer || mix.bridge)) return;
  fieldFrame(field);
  const scout = scoutFor(field);
  while (!scout.work(1e6));
}

// --- the manager -----------------------------------------------------------------

export class Bots {
  private readonly bots: Bot[] = [];
  private readonly options: BotOptions;
  private made = 0;
  /** Bots of each kind added so far (for names). */
  private readonly counts: Partial<Record<BotKind, number>> = {};

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    aggression = DEFAULT_BOT_OPTIONS.aggression,
    options: Partial<BotOptions> = {},
  ) {
    this.options = { ...DEFAULT_BOT_OPTIONS, aggression, ...options };
  }

  /** Add bots: a mix, or (as ever) a number of wanderers. */
  add(mix: BotMix | number, now: number): GameEvent[] {
    const m: BotMix = typeof mix === 'number' ? { wanderer: mix } : mix;
    const ev: GameEvent[] = [];
    for (const kind of BOT_KINDS) {
      for (let k = 0; k < (m[kind] ?? 0); k++) {
        const i = this.made++;
        const id = `bot-${i + 1}`;
        const nth = (this.counts[kind] = (this.counts[kind] ?? 0) + 1);
        const w = nth - 1;
        const name =
          kind === 'wanderer' ? `${NAMES[w % NAMES.length]}${w >= NAMES.length ? w : ''}` : `${BOT_INFO[kind].label}${nth > 1 ? ` ${nth}` : ''}`;
        const ctx: BotContext = { engine: this.engine, rng: this.rng, options: this.options };
        const bot = makeBot(kind, id, ctx);
        ev.push(...this.engine.addPlayer(id, name, bot.firstRule(), true));
        bot.start(now);
        this.bots.push(bot);
      }
    }
    return ev;
  }

  /** What is playing, for /status. */
  mix(): BotMix {
    const m: Partial<Record<BotKind, number>> = {};
    for (const b of this.bots) m[b.kind] = (m[b.kind] ?? 0) + 1;
    return m;
  }

  /** Called once per server tick. */
  update(now: number, ev: GameEvent[]): void {
    if (this.bots.some((b) => b.needsScout)) {
      const scout = scoutFor(this.engine.field);
      if (!scout.done) scout.work(SCOUT_BUDGET);
    }
    for (const bot of this.bots) {
      const p = this.engine.players.get(bot.id);
      if (p) bot.update(now, p, ev);
    }
  }
}

interface BotContext {
  readonly engine: Engine;
  readonly rng: Rng;
  readonly options: BotOptions;
}

function makeBot(kind: BotKind, id: string, ctx: BotContext): Bot {
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

abstract class Bot {
  protected nextTapAt = 0;
  /** Waits for the scout before its first tap (and then takes its rule from it). */
  readonly needsScout: boolean = false;

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

  start(now: number): void {
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

  override start(now: number): void {
    super.start(now);
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
  override readonly needsScout = true;
  private ready = false;
  private home: Pt | null = null;
  private rehomeAt = 0;
  private misses = 0;

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

/** Walk each way from a candidate chord this far when planning a bridge. */
const BRIDGE_WALK = 1200;
/** Candidate lines a bridge weighs before settling on one. */
const BRIDGE_CANDIDATES = 12;
/** A standing bridge waits this long before the bot looks for a new one. */
const BRIDGE_HOLD_MS = 90_000;
/** And no bridge is kept longer than this. */
const BRIDGE_MAX_MS = 5 * 60_000;

interface BridgePlan {
  readonly steps: readonly WalkStep[];
  readonly mid: number;
  /** Plan step indices, nearest the middle first. */
  readonly order: readonly number[];
  readonly madeAt: number;
  readonly score: number;
}

/**
 * A long thin line across the busy part of the board, tapped from its
 * middle over and over until it stands (and rebuilt when it's cut).
 */
class Bridge extends Bot {
  override readonly needsScout = true;
  private ready = false;
  private plan: BridgePlan | null = null;
  /** Candidates weighed so far for the next plan. */
  private drafts: BridgePlan[] = [];
  private standingSince = 0;

  override update(now: number, p: Player, ev: GameEvent[]): void {
    if (!this.ready) {
      const scout = scoutFor(this.engine.field);
      if (!scout.done) return;
      this.ready = true;
      const rule = scout.longLineRule(this.rng, this.ctx.options.infiniteLines);
      if (rule) ev.push(...this.engine.setRule(this.id, rule));
    }
    // Planning runs whether or not a head is free.
    if (!this.plan || this.drafts.length > 0 || this.stale(now)) this.draft(now, p);
    super.update(now, p, ev);
  }

  private stale(now: number): boolean {
    const plan = this.plan;
    if (!plan) return true;
    if (now - plan.madeAt > BRIDGE_MAX_MS) return true;
    return this.standingSince > 0 && now - this.standingSince > BRIDGE_HOLD_MS;
  }

  protected think(now: number, p: Player, ev: GameEvent[]): void {
    this.nextTapAt = now + 400 + this.rng.int(600);
    const plan = this.plan;
    if (!plan) return;
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
    // Otherwise the gap nearest the middle.
    const mine = new Set<number>();
    for (const q of p.paths) if (q.table === p.table) for (const s of q.steps) mine.add(s.tile * 64 + s.chord);
    let tries = 0;
    for (const i of plan.order) {
      const s = plan.steps[i];
      if (mine.has(s.tile * 64 + s.chord)) continue;
      this.standingSince = 0;
      if (this.tapStep(s, ev) || ++tries >= 6) return;
    }
    if (tries === 0 && this.standingSince === 0) this.standingSince = now;
  }

  /** Weigh another candidate (one a tick: each is a couple of thousand steps); once there are enough, take the best. */
  private draft(now: number, p: Player): void {
    const d = this.candidate(now, p);
    if (d) this.drafts.push(d);
    if (this.drafts.length < BRIDGE_CANDIDATES) return;
    const best = this.drafts.reduce((a, b) => (b.score > a.score ? b : a));
    this.drafts = [];
    this.plan = best;
    this.standingSince = 0;
  }

  /** A line through a random spot — often right beside someone's line. */
  private candidate(now: number, p: Player): BridgePlan | null {
    const field = this.engine.field;
    const table = p.table;
    let tile = -1;
    const rivals = this.rivals();
    if (rivals.length && this.rng.next() < 0.6) {
      const r = rivals[this.rng.int(rivals.length)];
      const path = r.paths[this.rng.int(r.paths.length)];
      const s = path.steps[this.rng.int(path.steps.length)];
      if (s) tile = tileNear(field, table, this.rng, stepMid(s), fieldFrame(field).unit * 6);
    }
    if (tile < 0) tile = randomTileWithLine(field, table, this.rng);
    if (tile < 0) return null;
    const chord = this.rng.int(tileChords(field, table, tile).length);
    const out = walkStrand(field, table, tile, chord, 0, BRIDGE_WALK, (o) => o[0]);
    let steps: WalkStep[];
    if (out.closed) steps = [...out.steps];
    else {
      const back = walkStrand(field, table, tile, chord, 1, BRIDGE_WALK, (o) => o[0]);
      // Back walk reversed (and flipped, so it runs into the start), then out.
      steps = back.steps
        .slice(1)
        .reverse()
        .map((s) => ({ tile: s.tile, chord: s.chord, a: s.b, b: s.a }));
      steps.push(...out.steps);
    }
    if (steps.length < 8) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let busy = 0;
    for (const s of steps) {
      const m = stepMid(s);
      minX = Math.min(minX, m.x);
      maxX = Math.max(maxX, m.x);
      minY = Math.min(minY, m.y);
      maxY = Math.max(maxY, m.y);
      if (this.engine.pathsOn(s.tile).some((q) => q.owner !== this.id)) busy++;
    }
    const span = Math.hypot(maxX - minX, maxY - minY) / fieldFrame(field).unit;
    const mid = steps.length >> 1;
    const order = steps.map((_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    // Long, and through as much of everyone else as possible.
    return { steps, mid, order, madeAt: now, score: span + 4 * Math.min(busy, 200) };
  }
}
