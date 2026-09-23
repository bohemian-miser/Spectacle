/**
 * Every tunable in one place. The server owns the live values (env overrides
 * below) and sends them to clients in the welcome message, so the HUD can show
 * what it is playing under. Mechanics first; balance later — but every number
 * that will need balancing is already a knob rather than a literal.
 */

export interface Knobs {
  /** Server simulation tick, ms. Growth is integrated per tick. */
  tickMs: number;

  // --- scoring -------------------------------------------------------------
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
  /** Milliseconds per step at score 0. */
  baseStepMs: number;
  /** Speed-up: interval = baseStepMs / (1 + score * speedPerPoint). */
  speedPerPoint: number;
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
  maxPlayers: number;
  maxNameLength: number;
}

export const DEFAULT_KNOBS: Readonly<Knobs> = Object.freeze({
  tickMs: 50,

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
  maxSpeed: 1000,
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
  maxPlayers: 200,
  maxNameLength: 16,
});

/** Top speed (tiles per second) on a field of `fieldTiles` tiles: `maxSpeed`, scaled by log field size. */
export function maxSpeedFor(knobs: Knobs, fieldTiles: number): number {
  const scale = Math.log(Math.max(2, fieldTiles)) / Math.log(Math.max(2, knobs.maxSpeedRefTiles));
  return knobs.maxSpeed * scale;
}

/**
 * Step interval for a player at `score` on a field of `fieldTiles` tiles —
 * the "speed proportional to score" knob, floored by `maxSpeedFor`.
 */
export function stepIntervalMs(knobs: Knobs, score: number, fieldTiles: number): number {
  const ms = knobs.baseStepMs / (1 + Math.max(0, score) * knobs.speedPerPoint);
  return Math.max(1000 / maxSpeedFor(knobs, fieldTiles), ms);
}

/** How many lines a player holding `patterns` patterns may grow at once (0 = unlimited). */
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
    } else if (key === 'crossingMode') {
      if (raw === 'geometric' || raw === 'tile') out.crossingMode = raw;
    }
  }
  return out;
}
