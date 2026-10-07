/**
 * Bots, the host half: which bots a room has (`BotMix`), the interface a
 * bot's mind implements (`Brain`, made by a `BrainSet`), and the manager
 * (`Bots`) that keeps a room's bot *players* and drives their brains.
 *
 * The brains themselves — the five kinds, the scout, everything about how a
 * bot plays — live in `brains/` and can be swapped while a game runs
 * (`Bots.setBrains`): the server hot-loads a newer build of that directory
 * (`server/brains.ts`) without a deploy. A swap keeps every bot player as it
 * is (lines, score, patterns, rule) and gives it a fresh brain of its kind.
 * So: anything a bot *decides* belongs in `brains/`; anything the brains and
 * the server must agree on belongs here, and changing it is a full deploy.
 */

import type { Engine, Player } from './engine';
import type { Field } from './field';
import type { GameMode, Tuning } from './knobs';
import type { GameEvent, RoomBots } from './protocol';
import type { PlayerRule } from './rule';
import type { Rng } from './rng';
import { brains as BUILTIN_BRAINS, BOT_INFO, BOT_KINDS, type BotKind } from './brains';

export { BUILTIN_BRAINS, BOT_INFO, BOT_KINDS, type BotKind };

// --- which bots ------------------------------------------------------------------

/** How many of each kind. */
export type BotMix = Readonly<Record<string, number>>;

export function isBotKind(x: unknown, kinds: readonly string[] = BOT_KINDS): x is string {
  return typeof x === 'string' && kinds.includes(x);
}

/**
 * `BOTS`-style text into a mix: a bare number is that many wanderers (what
 * `BOTS` always meant); otherwise a list of kinds, each optionally `:count`,
 * split by commas, `+` or spaces — `bridge,hunter:2`, `bridge+hunter:2`
 * (`+` survives `gcloud --set-env-vars`, which splits on commas). Unknown
 * kinds (not in `kinds`) come back in `unknown` rather than throwing.
 */
export function parseBotMix(raw: string | undefined | null, kinds: readonly string[] = BOT_KINDS): { mix: BotMix; unknown: string[] } {
  const text = (raw ?? '').trim();
  if (text === '') return { mix: {}, unknown: [] };
  if (/^\d+$/.test(text)) return { mix: { wanderer: Number(text) }, unknown: [] };
  const mix: Record<string, number> = {};
  const unknown: string[] = [];
  for (const part of text.split(/[,+;\s]+/)) {
    const [rawKind, rawCount] = part.split(/[:=*]/).map((s) => s.trim().toLowerCase());
    if (!rawKind) continue;
    const n = rawCount === undefined || rawCount === '' ? 1 : Number(rawCount);
    if (!isBotKind(rawKind, kinds) || !Number.isInteger(n) || n < 0) {
      unknown.push(part.trim());
      continue;
    }
    mix[rawKind] = (mix[rawKind] ?? 0) + n;
  }
  return { mix, unknown };
}

/** The mix as `parseBotMix` reads it back: `bridge,hunter:2` ('none' when empty). Known kinds in their order, others after. */
export function formatBotMix(mix: BotMix, kinds: readonly string[] = BOT_KINDS): string {
  const order = [...kinds, ...Object.keys(mix).filter((k) => !kinds.includes(k)).sort()];
  const parts = order.filter((k) => (mix[k] ?? 0) > 0).map((k) => (mix[k] === 1 ? k : `${k}:${mix[k]}`));
  return parts.length ? parts.join(',') : 'none';
}

export function botTotal(mix: BotMix): number {
  return Object.values(mix).reduce((n, k) => n + (k ?? 0), 0);
}

/**
 * A player's ask for a room's bots, checked: only `kinds`, whole numbers
 * from 0 to `maxPerKind`, at most `max` in all. A mix, or why not.
 */
export function cleanBotMix(raw: unknown, kinds: readonly string[], maxPerKind: number, max: number): { mix: BotMix } | { refused: string } {
  if (!raw || typeof raw !== 'object') return { refused: 'no bots given' };
  const mix: Record<string, number> = {};
  for (const [kind, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!kinds.includes(kind)) return { refused: `no such bot: ${kind}` };
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { refused: `bad count for ${kind}` };
    if (n > maxPerKind) return { refused: `at most ${maxPerKind} of a kind` };
    if (n > 0) mix[kind] = n;
  }
  if (botTotal(mix) > max) return { refused: `at most ${max} bots in a room` };
  return { mix };
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

/**
 * A brain set's `botTuning`, checked (a hot-loaded build isn't trusted):
 * `aggression` in [0, 1], `rotateMs` a positive number; anything else dropped.
 */
export function botTuningOf(set: Pick<BrainSet, 'botTuning'>): Partial<BotOptions> {
  const t = set.botTuning as Record<string, unknown> | undefined;
  const out: { -readonly [K in keyof BotOptions]?: BotOptions[K] } = {};
  if (!t || typeof t !== 'object') return out;
  if (typeof t.aggression === 'number' && t.aggression >= 0 && t.aggression <= 1) out.aggression = t.aggression;
  if (typeof t.rotateMs === 'number' && Number.isFinite(t.rotateMs) && t.rotateMs > 0) out.rotateMs = t.rotateMs;
  return out;
}

// --- the brain interface ----------------------------------------------------------
//
// What a hot-loaded build of `brains/` must provide. The server only loads a
// build made from the same `shared/` source as itself, everything but
// `brains/` (`server/brains.ts`'s source key), so these types — and the
// engine's — are always the ones the build was compiled against.

/** What a brain is handed: the room's engine (read it, call its player methods for its own id), a random source, the options. */
export interface BotContext {
  readonly engine: Engine;
  readonly rng: Rng;
  readonly options: BotOptions;
}

/** One bot's mind. Its player lives in the engine under `id`; the brain only decides. */
export interface Brain {
  readonly id: string;
  readonly kind: string;
  /** Waiting for the set's shared one-off work (`BrainSet.work`) before it can play. */
  readonly needsScout: boolean;
  /** The rule a new bot joins with. */
  firstRule(): PlayerRule;
  /**
   * About to play. `resumed`: the player was already on the board under an
   * earlier brain (a hot swap) — carry on with what it has rather than start over.
   */
  start(now: number, resumed: boolean): void;
  /** Once a tick: act for `p` (this brain's player), pushing what the engine returns onto `ev`. */
  update(now: number, p: Player, ev: GameEvent[]): void;
}

/** Every kind of brain a build offers. `brains/index.ts` exports one as `brains`. */
export interface BrainSet {
  /** The kinds, in the order a mix lists them. */
  readonly kinds: readonly string[];
  readonly info: Readonly<Record<string, { readonly label: string; readonly blurb: string }>>;
  /**
   * The bots every live room of a mode should have, overriding `BOTS` /
   * `BOTS_<MODE>` — a way to add bots to running games with a push. A mode
   * left out keeps the server's own setting.
   */
  readonly mix?: Readonly<Partial<Record<GameMode, BotMix>>>;
  /**
   * The game's knobs (`brains/tuning.ts`), laid over `DEFAULT_KNOBS` by the
   * server and solo play (`applyTuning`) — a way to retune running games
   * with a push. Checked, not trusted: unknown or ill-typed knobs are ignored.
   */
  readonly tuning?: Readonly<Partial<Tuning>>;
  /** The bots' own numbers (`BOT_TUNING`), over `DEFAULT_BOT_OPTIONS`. */
  readonly botTuning?: Readonly<Partial<Pick<BotOptions, 'aggression' | 'rotateMs'>>>;
  /** A new bot's name: the `nth` (from 1) of its kind in the room. */
  name(kind: string, nth: number): string;
  make(kind: string, id: string, ctx: BotContext): Brain;
  /** One-off work for `mix` on a field, done up front (optional: `work` does it a slice at a time otherwise). */
  prepare(field: Field, mix: BotMix): void;
  /** A slice of that work, once a tick while a brain `needsScout`. */
  work(field: Field): void;
}

/** True when `x` has the shape of a `BrainSet` (a hot-loaded build is checked before use). */
export function isBrainSet(x: unknown): x is BrainSet {
  const s = x as Partial<BrainSet> | null;
  return (
    !!s &&
    Array.isArray(s.kinds) &&
    s.kinds.length > 0 &&
    s.kinds.every((k) => typeof k === 'string' && typeof s.info?.[k]?.label === 'string') &&
    typeof s.name === 'function' &&
    typeof s.make === 'function' &&
    typeof s.prepare === 'function' &&
    typeof s.work === 'function'
  );
}

/**
 * Do the bots' one-off work on a field up front — the scout (~0.1–0.3 s at
 * hex level 6) and the field's frame — when `mix` has a kind that needs it,
 * so it happens while the field is built rather than in a tick. Skipping
 * this is fine: the bots then scout a slice per tick instead.
 */
export function prepareBots(field: Field, mix: BotMix, set: BrainSet = BUILTIN_BRAINS): void {
  set.prepare(field, mix);
}

// --- the watchdog ----------------------------------------------------------------
//
// The server ticks every room in one 50 ms loop on one thread, so a brain
// that computes for half a second stalls every game on the server for half a
// second (2026-10-03: a bridge bot's first decision ran for minutes, and each
// one after it took ~0.5 s). JavaScript can't interrupt a synchronous call
// from the thread it runs on, so the watchdog can't stop a slow update while
// it runs: it times each one, and once it has returned too slow, makes sure
// that brain doesn't get to do it again here. Its kind is *benched* in this
// room — its bot players leave, and `add` / `reconcile` skip the kind until
// new brains arrive (`setBrains`) — and reported (`Bots.onSlow`). An update
// that never returns (an infinite loop) still hangs the process; only moving
// the bots off the loop's thread (a worker) would fix that.
//
// Off unless set (`Bots.watchdog`): the server and solo play set it. With it
// on, a game depends on how fast the machine is, so tests and benches that
// want the same game everywhere leave it off (or give it a fake `clock`).
//
// An update in which the bot changed its rule is not held to `hardMs`: it
// paid for the engine's regrow plan (`setRule`), as a human's switch does on
// the message handler — a rotator's, at hex level 6 with a big score, takes
// a second or more. It still counts as a strike when over `softMs`. The
// brain set's shared scout (`BrainSet.work`) is the other way round: held to
// `hardMs` only — it is finite (a few seconds of slices, once per field) and
// budgeted at a few ms a slice, which a busy machine stretches past `softMs`.

export interface WatchdogOptions {
  /** One update (or scout slice) taking longer than this benches the kind at once, ms (a rule switch aside). */
  readonly hardMs: number;
  /** An update (not a scout slice) longer than this is a strike, ms… */
  readonly softMs: number;
  /** …and this many strikes by one bot within the last `window` ticks bench its kind. */
  readonly strikes: number;
  readonly window: number;
}

/**
 * Bot work per tick is meant to stay in single-digit ms at hex level 6, and
 * the loop has 50 ms for every room. So: one update over 200 ms — four ticks
 * of every room on the server — or ten over 20 ms in ten seconds (200
 * ticks), and the kind is benched. Measured at hex 6 on a Raspberry Pi 5 at
 * load 13 (wall times ~3× CPU): built-in kinds' updates average 0.01–0.4 ms,
 * the slowest single one was ~100 ms (a farmer), and none had more than five
 * over 20 ms in any 200 ticks; a rotator's rule switch (regrow) took up to
 * 2.6 s, which is why switches are held to the soft budget only.
 */
export const DEFAULT_WATCHDOG: WatchdogOptions = { hardMs: 200, softMs: 20, strikes: 10, window: 200 };

/** What `Bots.onSlow` hears when the watchdog benches a kind. */
export interface BotTrip {
  readonly kind: string;
  /** How long the call that tripped it took, ms. */
  readonly ms: number;
  /** `hard`: one call over `hardMs`; `soft`: `strikes` calls over `softMs` within `window` ticks. */
  readonly why: 'hard' | 'soft';
  /** Which call: a bot's `update`, or the brain set's shared `work` (the scout) its kind was waiting on. */
  readonly source: 'update' | 'scout';
  /** Bot players of the kind taken out of the game. */
  readonly removed: number;
}

/** One bot's (or the scout's) record with the watchdog. */
interface Watch {
  /** Its slowest call so far, ms. */
  worstMs: number;
  /** The ticks of its recent strikes. */
  strikes: number[];
}

/** The scout's record, beside the bots' (keyed by player id). */
const SCOUT = '';

// --- the manager -----------------------------------------------------------------

export class Bots {
  private readonly bots: Brain[] = [];
  private options: BotOptions;
  private set: BrainSet;
  private made = 0;
  /** Bots of each kind added so far (for names). */
  private readonly counts: Record<string, number> = {};
  /**
   * Set to catch a brain's exception (that bot skips the tick; the others
   * play on) instead of letting it out of `update`. The server sets it, to
   * log and to drop a hot-loaded build that keeps throwing.
   */
  onError: ((kind: string, e: unknown) => void) | null = null;
  /** The watchdog's limits (`DEFAULT_WATCHDOG`, say), or null: off, nothing timed. */
  watchdog: WatchdogOptions | null = null;
  /**
   * Told whenever the watchdog benches a kind, after its bots have left
   * (their `leave` events are in that `update`'s events). The server logs
   * and counts it, and drops a hot-loaded build that keeps tripping it.
   */
  onSlow: ((trip: BotTrip) => void) | null = null;
  /** What the watchdog times calls with, ms (tests hand it a fake). */
  clock: () => number = () => performance.now();
  /** Kinds the watchdog has taken out of this game, until new brains come (`setBrains`). */
  private readonly bench = new Map<string, BotTrip>();
  private readonly watches = new Map<string, Watch>();
  private ticks = 0;

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    aggression = DEFAULT_BOT_OPTIONS.aggression,
    options: Partial<BotOptions> = {},
    set: BrainSet = BUILTIN_BRAINS,
  ) {
    this.options = { ...DEFAULT_BOT_OPTIONS, aggression, ...options };
    this.set = set;
  }

  /** New options for the brains made from now on (`setBrains` remakes them all). */
  setOptions(options: Partial<BotOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** The brains playing now. */
  get brains(): BrainSet {
    return this.set;
  }

  private get ctx(): BotContext {
    return { engine: this.engine, rng: this.rng, options: this.options };
  }

  /** Add bots: a mix, or (as ever) a number of wanderers. Kinds the brains don't have, or the watchdog benched, are skipped. */
  add(mix: BotMix | number, now: number): GameEvent[] {
    const m: BotMix = typeof mix === 'number' ? { wanderer: mix } : mix;
    const ev: GameEvent[] = [];
    for (const kind of this.set.kinds) {
      if (this.bench.has(kind)) continue;
      for (let k = 0; k < (m[kind] ?? 0); k++) {
        const id = `bot-${++this.made}`;
        const nth = (this.counts[kind] = (this.counts[kind] ?? 0) + 1);
        const bot = this.set.make(kind, id, this.ctx);
        ev.push(...this.engine.addPlayer(id, this.set.name(kind, nth), bot.firstRule(), true));
        bot.start(now, false);
        this.bots.push(bot);
      }
    }
    return ev;
  }

  /** The kinds this game offers: the brains' own, less any the watchdog benched. */
  kinds(): readonly string[] {
    return this.bench.size ? this.set.kinds.filter((k) => !this.bench.has(k)) : this.set.kinds;
  }

  /** The kinds the watchdog benched, and why (for /status). */
  benched(): BotTrip[] {
    return [...this.bench.values()];
  }

  /** Each bot's slowest call so far, ms (`scripts/bot-arena.ts`). */
  timings(): { id: string; kind: string; worstMs: number }[] {
    return this.bots.map((b) => ({ id: b.id, kind: b.kind, worstMs: this.watches.get(b.id)?.worstMs ?? 0 }));
  }

  /** What a room's players see of its bots (`welcome.bots`, the `bots` event): benched kinds aren't offered. */
  roomBots(maxPerKind: number, max: number): RoomBots {
    const kinds = this.kinds().map((kind) => ({ kind, label: this.set.info[kind]?.label ?? kind, blurb: this.set.info[kind]?.blurb ?? '' }));
    return { kinds, mix: this.mix(), maxPerKind, max };
  }

  /** What is playing, for /status. */
  mix(): BotMix {
    const m: Record<string, number> = {};
    for (const b of this.bots) m[b.kind] = (m[b.kind] ?? 0) + 1;
    return m;
  }

  /** Each bot's player id and kind. */
  list(): { id: string; kind: string }[] {
    return this.bots.map((b) => ({ id: b.id, kind: b.kind }));
  }

  /**
   * Swap every bot's brain for one of `set`, live: each bot player stays on
   * the board as it is (lines, score, patterns, rule) and plays on under a
   * new brain of its kind. A bot whose kind `set` lacks leaves the game
   * (its lines go, as when any player leaves). Then, given a `mix`, bots are
   * added or dropped to match it (`reconcile`). New brains start with a
   * clean slate: kinds the watchdog benched may play again.
   */
  setBrains(set: BrainSet, now: number, mix?: BotMix): GameEvent[] {
    const ev: GameEvent[] = [];
    const kept: Brain[] = [];
    for (const old of this.bots) {
      if (!set.kinds.includes(old.kind)) {
        ev.push(...this.engine.removePlayer(old.id));
        continue;
      }
      const bot = set.make(old.kind, old.id, this.ctx);
      bot.start(now, true);
      kept.push(bot);
    }
    this.bots.splice(0, this.bots.length, ...kept);
    this.set = set;
    this.bench.clear();
    this.watches.clear();
    if (mix) ev.push(...this.reconcile(mix, now));
    return ev;
  }

  /** Add or drop bots (newest first) until the room has exactly `mix` — less any kind the watchdog benched. */
  reconcile(mix: BotMix, now: number): GameEvent[] {
    const ev: GameEvent[] = [];
    const have = this.mix();
    for (const kind of Object.keys(have)) {
      let extra = have[kind] - (mix[kind] ?? 0);
      for (let i = this.bots.length - 1; i >= 0 && extra > 0; i--) {
        if (this.bots[i].kind !== kind) continue;
        ev.push(...this.remove(i));
        extra--;
      }
    }
    const missing: Record<string, number> = {};
    for (const kind of this.set.kinds) missing[kind] = Math.max(0, (mix[kind] ?? 0) - (have[kind] ?? 0));
    ev.push(...this.add(missing, now));
    return ev;
  }

  /** Called once per server tick. With the watchdog on, each brain's call is timed (see `WatchdogOptions`). */
  update(now: number, ev: GameEvent[]): void {
    // A won round holds still until it restarts: nothing to play.
    if (this.engine.winner) return;
    this.ticks++;
    // Made only when something trips: the usual tick allocates nothing here.
    let trips: { kind: string; ms: number; why: 'hard' | 'soft'; source: 'update' | 'scout' }[] | null = null;
    const tripped = (kind: string): boolean => trips !== null && trips.some((t) => t.kind === kind);
    if (this.bots.some((b) => b.needsScout)) {
      const ms = this.timed('scout', () => this.set.work(this.engine.field));
      const why = this.judge(SCOUT, ms, false, true);
      // The shared work is no one bot's: the kinds waiting on it go.
      if (why) for (const b of this.bots) if (b.needsScout && !tripped(b.kind)) (trips ??= []).push({ kind: b.kind, ms, why, source: 'scout' });
    }
    for (const bot of this.bots) {
      if (tripped(bot.kind)) continue;
      const p = this.engine.players.get(bot.id);
      if (!p) continue;
      const rule = p.rule;
      const ms = this.timed(bot.kind, () => bot.update(now, p, ev));
      const why = this.judge(bot.id, ms, p.rule !== rule);
      if (why) (trips ??= []).push({ kind: bot.kind, ms, why, source: 'update' });
    }
    if (trips === null) return;
    // Every bot of a tripped kind leaves, before anyone is told: `onSlow` may swap the brains.
    const report: BotTrip[] = [];
    for (const t of trips) {
      let removed = 0;
      for (let i = this.bots.length - 1; i >= 0; i--) {
        if (this.bots[i].kind !== t.kind) continue;
        ev.push(...this.remove(i));
        removed++;
      }
      const trip: BotTrip = { ...t, removed };
      this.bench.set(t.kind, trip);
      report.push(trip);
    }
    for (const trip of report) this.onSlow?.(trip);
  }

  /** Take the `i`th bot out of the game. */
  private remove(i: number): GameEvent[] {
    const [b] = this.bots.splice(i, 1);
    this.watches.delete(b.id);
    return this.engine.removePlayer(b.id);
  }

  /** Run a brain's call (through `onError`, if set) and say how long it took, ms (0 with the watchdog off). */
  private timed(kind: string, f: () => void): number {
    const t0 = this.watchdog ? this.clock() : 0;
    if (!this.onError) f();
    else {
      try {
        f();
      } catch (e) {
        this.onError(kind, e);
      }
    }
    return this.watchdog ? this.clock() - t0 : 0;
  }

  /**
   * Note a call that took `ms` (`switched`: the bot changed its rule in it;
   * `hardOnly`: the scout); was it too slow, once or once too often?
   */
  private judge(key: string, ms: number, switched = false, hardOnly = false): 'hard' | 'soft' | null {
    if (!this.watchdog) return null;
    let w = this.watches.get(key);
    if (!w) this.watches.set(key, (w = { worstMs: 0, strikes: [] }));
    if (ms > w.worstMs) w.worstMs = ms;
    const { hardMs, softMs, strikes, window } = this.watchdog;
    if (ms > hardMs && !switched) return 'hard';
    if (ms <= softMs || hardOnly) return null;
    w.strikes = w.strikes.filter((t) => t > this.ticks - window);
    w.strikes.push(this.ticks);
    return w.strikes.length >= strikes ? 'soft' : null;
  }
}
