import type { BotOptions } from '../bots';
import type { Tuning } from '../knobs';

/**
 * The game's live numbers: what every server and solo game plays under.
 * This file is hot-loaded with the bot brains, so a push to main that
 * changes nothing outside `shared/game/brains/` reaches running rooms within
 * a minute or so with no deploy — the "Ship bot brains" workflow builds and
 * uploads it, and each server swaps it in (`server/brains.ts`). What each
 * knob does is documented on `Knobs` in `../knobs.ts`.
 *
 * Applied to running rooms at once, except `scoreTiles`, which a room keeps
 * from when it opened (`ROOM_FIXED_KNOBS`); clients are sent the new values
 * (`knobs` event). A server's `KNOB_*` env vars (e.g. `KNOB_REGROW_DISCOUNT`)
 * win over this file, so leave those unset where this should rule. A value
 * of the wrong type, or a knob that doesn't exist, is ignored and logged.
 *
 * `DEFAULT_KNOBS` (knobs.ts) is the engine's baseline the tests pin; it
 * started out equal to this and needn't stay so. Adding a knob means a
 * line here too (the type insists) — and that push deploys anyway, since
 * it changes knobs.ts.
 */
export const TUNING: Tuning = {
  // --- scoring ---------------------------------------------------------------
  scoreTiles: true,
  pointsPerTile: 1,
  circuitBase: 10,
  circuitLengthWeight: 1,
  circuitAreaWeight: 2,
  comboStart: 1,
  comboStep: 0.5,
  comboMax: 5,
  stealFraction: 0,

  // --- growth and heads ------------------------------------------------------
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

  // --- collisions and your own lines -----------------------------------------
  crossingMode: 'geometric',
  touchCounts: true,
  mutualCut: true,
  tapOntoOthers: false,
  tapInsideRivalCircuits: false,
  overlapOwnLines: true,
  flipOwnLines: true,
  flipPieceHeads: 1,

  // --- the board filling, and changing rule ----------------------------------
  maxCompletedCircuits: 0,
  maxLivePaths: 0,
  resetScoreOnRule: true,
  regrowOnRule: true,
  /** A rule switch's price for a tile not held: this ** (steps along the circuit to your nearest held tile on it). */
  regrowDiscount: 0.99,

  // --- rooms -----------------------------------------------------------------
  maxPlayers: 200,
  maxNameLength: 16,
};

/**
 * The bots' own numbers (`BotOptions`; `BOT_ROTATE_MS` on a server wins).
 * Brains are made with them, so a change reaches live bots with the swap.
 */
export const BOT_TUNING: Pick<BotOptions, 'aggression' | 'rotateMs'> = {
  /** Wanderers and rotators: how often a tap aims beside a rival's line. */
  aggression: 0.3,
  /** Rotators: about how long a rule lasts before they start over (±25%). */
  rotateMs: 5 * 60_000,
};
