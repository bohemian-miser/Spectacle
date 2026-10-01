import type { BotMix } from '../bots';
import type { GameMode } from '../knobs';

/**
 * The bots every live room should have, per mode — set here to add (or
 * drop) bots in running games with a push, no deploy. It overrides the
 * server's `BOTS` / `BOTS_<MODE>` for the modes it names; a mode left out
 * keeps the server's setting. Empty: the servers decide, as ever.
 *
 *   export const LIVE_MIX = { normal: { wanderer: 1, hunter: 1 } };
 *
 * Kinds are `BOT_KINDS` in `kinds.ts`. Bots added this way join
 * mid-game; dropped ones leave like any player (their lines go).
 */
export const LIVE_MIX: Readonly<Partial<Record<GameMode, BotMix>>> = {};
