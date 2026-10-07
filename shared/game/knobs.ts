/**
 * Every tunable in one place. `DEFAULT_KNOBS` is the engine's baseline — what
 * the tests pin. What servers and solo play actually run is
 * `shared/game/brains/tuning.ts` (`TUNING`) on top of it: that file is
 * hot-loaded with the bot brains, so a push that changes only it reaches
 * running rooms without a deploy (`applyTuning`, `retune`). A server's
 * `KNOB_*` env vars win over both. The server sends the live values to
 * clients in the welcome (and a `knobs` event when they change), so the HUD
 * can show what it is playing under. Mechanics first; balance later — but
 * every number that will need balancing is already a knob rather than a
 * literal.
 */

/**
 * How capturing works in an arena.
 * - `normal`: close a circuit round a rival's line and it turns into your own
 *   pattern (your tile type) on those tiles; you never draw with theirs, but
 *   each new kind of rival line you convert still earns you a head.
 * - `conquest` (beta): you take the rival's pattern itself — a new tab to draw
 *   with — and their lines, drawn with it.
 */
export type GameMode = 'normal' | 'conquest';

export const GAME_MODES: readonly GameMode[] = ['normal', 'conquest'];

export const MODE_LABELS: Readonly<Record<GameMode, string>> = { normal: 'Normal', conquest: 'Conquest (beta)' };

export interface Knobs {
  /** Capture rules for this arena (see `GameMode`). */
  mode: GameMode;
  /** Server simulation tick, ms. Growth is integrated per tick. */
  tickMs: number;

  // --- scoring -------------------------------------------------------------
  /**
   * Your score is the number of tiles your lines are on — growing, stuck or
   * closed, each tile once — and nothing else: circuits pay no bonus. Off:
   * the older points scoring below (tiles, circuit bonuses, combo).
   */
  scoreTiles: boolean;
  /** Points for every tile a path grows into (including the tapped one). */
  pointsPerTile: number;
  /** Flat bonus for closing a circuit, before the combo multiplier. */
  circuitBase: number;
  /** Bonus per segment of a closed circuit. */
  circuitLengthWeight: number;
  /** Bonus per tile-area enclosed by a closed circuit. */
  circuitAreaWeight: number;
  /** Multiplier applied to the first circuit of a streak. */
  comboStart: number;
  /** Added to the multiplier for each further circuit without being wiped. */
  comboStep: number;
  comboMax: number;
  /**
   * Zero-sum scoring: a path carries the points it earned, and losing the
   * path (cut, abandoned, capped) loses those points. This fraction of a cut
   * path's points goes to the cutter (0 = the points just vanish).
   */
  stealFraction: number;

  // --- growth --------------------------------------------------------------
  /** Milliseconds per step at score 0, before `speedDivisor` / `speedOffset`. */
  baseStepMs: number;
  /**
   * Speed-up. In tiles per second:
   * speed = (1000 / baseStepMs) × (1 + score × speedPerPoint) / speedDivisor + speedOffset,
   * capped at `maxSpeedFor`.
   */
  speedPerPoint: number;
  /** The raw score-driven speed is divided by this… */
  speedDivisor: number;
  /** …and this many tiles per second added on top. */
  speedOffset: number;
  /**
   * Speed cap in tiles per second on a field of `maxSpeedRefTiles` tiles. The
   * cap scales with the log of the field's tile count: a field of N tiles caps
   * at `maxSpeed × ln N / ln maxSpeedRefTiles` (`maxSpeedFor`).
   */
  maxSpeed: number;
  /** Field size at which the cap is exactly `maxSpeed` (hex level 6 ≈ 242k). */
  maxSpeedRefTiles: number;
  /** Growing lines ("heads") a player may have at once; a tap beyond it is refused (0 = unlimited). */
  maxHeads: number;
  /** Head limit once a player holds a captured pattern (never below `maxHeads`; 0 = unlimited). */
  headsWithCapture: number;
  /**
   * Each further captured pattern (a new kind of rival line) adds one more
   * head on top of `headsWithCapture`, up to `maxHeadsTotal`.
   */
  headPerCapture: boolean;
  /** Ceiling on the head limit that captures can lift you to (0 = no ceiling). */
  maxHeadsTotal: number;
  /** Close a circuit round a rival's line and you take its pattern. */
  captureOnEnclose: boolean;
  /**
   * Close a circuit round a rival's line and the line itself becomes yours
   * (with the points it carries): everything inside the area you close.
   */
  takeEnclosed: boolean;
  /** Captured patterns a player may hold; later captures are ignored (0 = unlimited). */
  maxCapturedPatterns: number;
  /** After losing a head in a collision, how long before a tap may start a new one. */
  respawnDelayMs: number;
  /** Stop growing after this many tiles (0 = unlimited). */
  maxPathLength: number;
  /** At a class-0 junction (three chord ends meet) pick at random, or stop. */
  junctionPolicy: 'random' | 'stop';

  // --- conflict ------------------------------------------------------------
  /**
   * `geometric`: another player's chord cuts yours only when the two segments
   * properly cross or share a connection point inside the same tile.
   * `tile`: entering a tile that carries any of your steps cuts you.
   */
  crossingMode: 'geometric' | 'tile';
  /** In geometric mode, does sharing a connection point count as a cross? */
  touchCounts: boolean;
  /** A collision kills both lines: the one that was hit and the one that hit it. */
  mutualCut: boolean;
  /** May a tap land on a tile that already carries someone else's path? */
  tapOntoOthers: boolean;
  /** May a tap land inside a rival's closed circuit? */
  tapInsideRivalCircuits: boolean;
  /**
   * What your own lines do to each other. Off: a growing line that runs into
   * another of yours stops there, and a tap may start on any chord of a tile
   * none of your lines is on or crosses. On: it grows on over the top; a tap
   * may start on any chord of a tile your lines of the same pattern are not
   * on, but not on a tile a line of another of your patterns passes through.
   * A rival must cut each layered line.
   */
  overlapOwnLines: boolean;
  /**
   * Your lines of different patterns never share a tile. On: where two of
   * them meet (a line growing in, or a tap), the one started later wins the
   * tile. The loser splits round the tile, the winner's pattern sprouts there
   * as pieces that grow on at your speed without using up a head, and the
   * flip runs on along the loser a tile per step from the gap until all of it
   * is the new pattern. Pieces that reach another of your older patterns flip
   * that too. Off: `overlapOwnLines` decides, as before.
   */
  flipOwnLines: boolean;
  /**
   * A flip's pieces share this many heads' worth of growth between them,
   * taking turns (0: every piece grows at full speed on its own).
   */
  flipPieceHeads: number;

  // --- housekeeping --------------------------------------------------------
  /** Closed circuits a player keeps on the board, oldest dropped first (0 = unlimited). */
  maxCompletedCircuits: number;
  /** Growing or stuck lines a player may have at once, oldest dropped first (0 = unlimited). */
  maxLivePaths: number;
  /** Choosing a new rule wipes your paths; does it also reset the score? */
  resetScoreOnRule: boolean;
  /**
   * A new rule keeps what you built, as far as it can: the old lines' points
   * buy the new rule's circuits through the tiles they held (longest first,
   * each at what it scores closed), which start on those tiles and grow on to
   * close — on an untouched board, back to the score you paid.
   */
  regrowOnRule: boolean;
  /**
   * What a tile you don't hold yet costs a regrow plan: `regrowDiscount ** d`,
   * where `d` is how many steps of growth it is from your nearest held tile
   * along the strand (held tiles cost full price). Below 1, far tiles are
   * cheap — a circuit of any size costs at most its held tiles plus about
   * `2 / (1 - regrowDiscount)` per gap between them — so a switch can buy
   * circuits bigger than the score it spends. 1 = no discount.
   */
  regrowDiscount: number;
  maxPlayers: number;
  maxNameLength: number;

  // --- the end of a round ----------------------------------------------------
  /**
   * A player whose lines are on this fraction of the board's tiles wins the
   * round (0 = no winning: the board just plays on). Play stops, everyone
   * sees the win, and after `winCelebrateMs` the board starts again empty —
   * same players, same rules, scores at 0.
   */
  winFraction: number;
  /** How long the board holds still after a win before it starts again, ms. */
  winCelebrateMs: number;
}

export const DEFAULT_KNOBS: Readonly<Knobs> = Object.freeze({
  // The engine's own default; the server and the lobby start players in 'normal'.
  mode: 'conquest',
  tickMs: 50,

  scoreTiles: true,
  pointsPerTile: 1,
  circuitBase: 10,
  circuitLengthWeight: 1,
  circuitAreaWeight: 2,
  comboStart: 1,
  comboStep: 0.5,
  comboMax: 5,
  stealFraction: 0,

  baseStepMs: 200,
  speedPerPoint: 0.015,
  speedDivisor: 10,
  speedOffset: 5,
  maxSpeed: 500,
  maxSpeedRefTiles: 242_000,
  maxHeads: 1,
  headsWithCapture: 2,
  headPerCapture: true,
  maxHeadsTotal: 12,
  captureOnEnclose: true,
  takeEnclosed: true,
  maxCapturedPatterns: 11,
  respawnDelayMs: 500,
  maxPathLength: 0,
  junctionPolicy: 'random',

  crossingMode: 'geometric',
  touchCounts: true,
  mutualCut: true,
  tapOntoOthers: false,
  tapInsideRivalCircuits: false,
  overlapOwnLines: true,
  flipOwnLines: true,
  flipPieceHeads: 1,

  maxCompletedCircuits: 0,
  maxLivePaths: 0,
  resetScoreOnRule: true,
  regrowOnRule: true,
  regrowDiscount: 0.99,
  maxPlayers: 200,
  maxNameLength: 16,
  winFraction: 0.9,
  winCelebrateMs: 7000,
});

/** Top speed (tiles per second) on a field of `fieldTiles` tiles: `maxSpeed`, scaled by log field size. */
export function maxSpeedFor(knobs: Knobs, fieldTiles: number): number {
  const scale = Math.log(Math.max(2, fieldTiles)) / Math.log(Math.max(2, knobs.maxSpeedRefTiles));
  return knobs.maxSpeed * scale;
}

/** Growth speed in tiles per second for a player at `score` (see `speedPerPoint`), capped by `maxSpeedFor`. */
export function speedFor(knobs: Knobs, score: number, fieldTiles: number): number {
  const raw = (1000 / knobs.baseStepMs) * (1 + Math.max(0, score) * knobs.speedPerPoint);
  const speed = raw / Math.max(1e-9, knobs.speedDivisor) + knobs.speedOffset;
  return Math.max(1e-3, Math.min(maxSpeedFor(knobs, fieldTiles), speed));
}

/**
 * Step interval for a player at `score` on a field of `fieldTiles` tiles —
 * the "speed proportional to score" knob, floored by `maxSpeedFor`.
 */
export function stepIntervalMs(knobs: Knobs, score: number, fieldTiles: number): number {
  return 1000 / speedFor(knobs, score, fieldTiles);
}

/** `base` playing under `mode`. */
export function knobsForMode(base: Knobs, mode: GameMode): Knobs {
  return { ...base, mode };
}

export function isGameMode(x: unknown): x is GameMode {
  return typeof x === 'string' && (GAME_MODES as readonly string[]).includes(x);
}

/**
 * How many lines a player holding `patterns` patterns may grow at once (0 =
 * unlimited). In normal mode nothing is added to `patterns`; pass 1 + the
 * kinds of rival line they have converted instead — the same heads.
 */
export function headLimit(knobs: Knobs, patterns: number): number {
  if (patterns < 2) return knobs.maxHeads;
  if (knobs.maxHeads === 0 || knobs.headsWithCapture === 0) return 0;
  const first = Math.max(knobs.maxHeads, knobs.headsWithCapture);
  if (!knobs.headPerCapture) return first;
  const n = first + (patterns - 2);
  return knobs.maxHeadsTotal > 0 ? Math.max(first, Math.min(knobs.maxHeadsTotal, n)) : n;
}

/**
 * Apply `KNOB_<NAME>` environment overrides (e.g. `KNOB_BASE_STEP_MS=200`).
 * Numbers and booleans are parsed; enum knobs are validated against their
 * allowed values; anything unparseable is ignored with a warning.
 */
export function knobsFromEnv(env: Record<string, string | undefined>, base: Knobs = DEFAULT_KNOBS): Knobs {
  const out: Knobs = { ...base };
  const rec = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof Knobs)[]) {
    const envKey = `KNOB_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    const raw = env[envKey];
    if (raw === undefined) continue;
    const current = rec[key];
    if (typeof current === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) rec[key] = n;
      else console.warn(`[knobs] ignoring ${envKey}=${raw} (not a number)`);
    } else if (typeof current === 'boolean') {
      rec[key] = raw === '1' || raw.toLowerCase() === 'true';
    } else if (key === 'junctionPolicy') {
      if (raw === 'random' || raw === 'stop') out.junctionPolicy = raw;
    } else if (key === 'mode') {
      if (isGameMode(raw)) out.mode = raw;
    } else if (key === 'crossingMode') {
      if (raw === 'geometric' || raw === 'tile') out.crossingMode = raw;
    }
  }
  return out;
}

/**
 * The knobs `tuning.ts` sets: all of them but the arena's `mode` (per room)
 * and `tickMs` (the server's loop, fixed at start).
 */
export type Tuning = Omit<Knobs, 'mode' | 'tickMs'>;

/** Knobs a running room keeps from when it opened: a new value reaches only rooms opened after it. */
export const ROOM_FIXED_KNOBS: readonly (keyof Knobs)[] = ['mode', 'tickMs', 'scoreTiles'];

const ENUM_KNOBS: Partial<Record<keyof Knobs, readonly string[]>> = {
  junctionPolicy: ['random', 'stop'],
  crossingMode: ['geometric', 'tile'],
};

/**
 * `base` with `tuning` laid over it — only known knobs (not `mode` or
 * `tickMs`), each of the same type as in `base` (a finite number, a boolean,
 * one of an enum's values). Anything else is left as it was and named in
 * `ignored`: a hot-loaded build is checked, not trusted.
 */
export function applyTuning(base: Knobs, tuning: unknown): { knobs: Knobs; ignored: string[] } {
  const out: Knobs = { ...base };
  const rec = out as unknown as Record<string, unknown>;
  const ignored: string[] = [];
  if (!tuning || typeof tuning !== 'object')
    return {
      knobs: out,
      ignored: tuning === undefined ? [] : ['(not an object)'],
    };
  for (const [key, value] of Object.entries(tuning as Record<string, unknown>)) {
    const k = key as keyof Knobs;
    const current = rec[key];
    const ok =
      key !== 'mode' &&
      key !== 'tickMs' &&
      Object.prototype.hasOwnProperty.call(base, key) &&
      (typeof current === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : typeof current === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && (ENUM_KNOBS[k] ?? []).includes(value));
    if (ok) rec[key] = value;
    else ignored.push(key);
  }
  return { knobs: out, ignored };
}

/** `next` for a room already running under `current`: the `ROOM_FIXED_KNOBS` stay as they are. */
export function retune(current: Knobs, next: Knobs): Knobs {
  const out = { ...next } as Record<string, unknown>;
  for (const k of ROOM_FIXED_KNOBS) out[k] = current[k];
  return out as unknown as Knobs;
}

/** The knobs whose values differ between `a` and `b`. */
export function knobsChanged(a: Knobs, b: Knobs): (keyof Knobs)[] {
  return (Object.keys(b) as (keyof Knobs)[]).filter((k) => a[k] !== b[k]);
}
