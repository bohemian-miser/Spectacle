/**
 * The bots' brains: how each kind of bot plays — and the game's live
 * numbers (`tuning.ts`). This directory is what the
 * server hot-loads — CI builds it into one module (`npm run brains -- build`)
 * whenever a push to main touches only `shared/game/brains/`, and running
 * servers swap it in within a minute or so, keeping the board and every bot
 * player as they are (see `server/brains.ts`, and README's "Bots without a
 * deploy"). The server also carries the build that shipped with it, which is
 * what solo play and the tests use.
 *
 * Rules for code in here:
 *  - Import anything from the rest of `shared/`, but only *types* from
 *    `../bots` (the host side). A build is only loaded by a server made from
 *    the same `shared/` source outside this directory, so the engine it sees
 *    is the one it was compiled against.
 *  - A brain plays through the engine it is handed, for its own player id —
 *    the same calls a client's messages make (`tap`, `setRule`, `setActive`,
 *    `swapPattern`) — and reads whatever it likes. It must not change engine
 *    state any other way.
 *  - Keep each tick's work small: every room on the server waits for it.
 *  - `tuning.ts` is the game's live numbers (every knob), shipped the same
 *    way: retuning running games is a push here, not a deploy.
 *  - A new kind: add its class to `kinds.ts` (or a file of its own) and
 *    register it there (`BOT_KINDS`, `BOT_INFO`, `makeBot`); `mix.ts` puts
 *    it into live rooms.
 */

import type { BotContext, BotMix, BrainSet } from '../bots';
import type { Field } from '../field';
import { chordTableFor } from '../strand';
import { BOT_INFO, BOT_KINDS, botName, bridgeRule, makeBot, type BotKind } from './kinds';
import { LIVE_MIX } from './mix';
import { edgeIndexFor, fieldFrame, scoutFor } from './sense';
import { BOT_TUNING, TUNING } from './tuning';

export { BOT_INFO, BOT_KINDS, BOT_TUNING, TUNING, type BotKind };

/** Steps of scouting per `work` (2–4 µs each): a few ms a tick, for a few seconds. */
const SCOUT_BUDGET = 2500;

function isKind(kind: string): kind is BotKind {
  return (BOT_KINDS as readonly string[]).includes(kind);
}

export const brains: BrainSet = {
  kinds: BOT_KINDS,
  info: BOT_INFO,
  mix: LIVE_MIX,
  tuning: TUNING,
  botTuning: BOT_TUNING,
  name: (kind, nth) => (isKind(kind) ? botName(kind, nth) : `${kind} ${nth}`),
  make(kind: string, id: string, ctx: BotContext) {
    if (!isKind(kind)) throw new Error(`no such bot kind: ${kind}`);
    return makeBot(kind, id, ctx);
  },
  prepare(field: Field, mix: BotMix) {
    // A bridge's edge index (well under a second at hex level 6); bridges added later trace it a slice a tick.
    if (mix.bridge) edgeIndexFor(field, chordTableFor(field, bridgeRule(field.family))).work(Infinity);
    if (!(mix.farmer || mix.bridge)) return;
    fieldFrame(field);
    const scout = scoutFor(field);
    while (!scout.work(1e6));
  },
  work(field: Field) {
    const scout = scoutFor(field);
    if (!scout.done) scout.work(SCOUT_BUDGET);
  },
};
