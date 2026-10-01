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
import type { GameMode } from './knobs';
import type { GameEvent } from './protocol';
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

export interface BotOptions {
  /** Wanderers and rotators: how often a tap aims beside a rival's line. */
  readonly aggression: number;
  /** Rotators: about how long a rule lasts before they start over (±25%). */
  readonly rotateMs: number;
  /** May a bot play an infinite-line (FASS) rule? */
  readonly infiniteLines: boolean;
}

export const DEFAULT_BOT_OPTIONS: BotOptions = { aggression: 0.3, rotateMs: 5 * 60_000, infiniteLines: false };

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

// --- the manager -----------------------------------------------------------------

export class Bots {
  private readonly bots: Brain[] = [];
  private readonly options: BotOptions;
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

  /** The brains playing now. */
  get brains(): BrainSet {
    return this.set;
  }

  private get ctx(): BotContext {
    return { engine: this.engine, rng: this.rng, options: this.options };
  }

  /** Add bots: a mix, or (as ever) a number of wanderers. Kinds the brains don't have are skipped. */
  add(mix: BotMix | number, now: number): GameEvent[] {
    const m: BotMix = typeof mix === 'number' ? { wanderer: mix } : mix;
    const ev: GameEvent[] = [];
    for (const kind of this.set.kinds) {
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
   * added or dropped to match it (`reconcile`).
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
    if (mix) ev.push(...this.reconcile(mix, now));
    return ev;
  }

  /** Add or drop bots (newest first) until the room has exactly `mix`. */
  reconcile(mix: BotMix, now: number): GameEvent[] {
    const ev: GameEvent[] = [];
    const have = this.mix();
    for (const kind of Object.keys(have)) {
      let extra = have[kind] - (mix[kind] ?? 0);
      for (let i = this.bots.length - 1; i >= 0 && extra > 0; i--) {
        const b = this.bots[i];
        if (b.kind !== kind) continue;
        ev.push(...this.engine.removePlayer(b.id));
        this.bots.splice(i, 1);
        extra--;
      }
    }
    const missing: Record<string, number> = {};
    for (const kind of this.set.kinds) missing[kind] = Math.max(0, (mix[kind] ?? 0) - (have[kind] ?? 0));
    ev.push(...this.add(missing, now));
    return ev;
  }

  /** Called once per server tick. */
  update(now: number, ev: GameEvent[]): void {
    if (this.bots.some((b) => b.needsScout)) this.guard('scout', () => this.set.work(this.engine.field));
    for (const bot of this.bots) {
      const p = this.engine.players.get(bot.id);
      if (p) this.guard(bot.kind, () => bot.update(now, p, ev));
    }
  }

  private guard(kind: string, f: () => void): void {
    if (!this.onError) return f();
    try {
      f();
    } catch (e) {
      this.onError(kind, e);
    }
  }
}
