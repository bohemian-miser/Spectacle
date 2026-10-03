/**
 * Bots against bots, headless and faster than real time: how each kind
 * scores, what the bots cost per tick, each kind's slowest single update,
 * and whether any of them tripped the watchdog (`DEFAULT_WATCHDOG` in
 * shared/game/bots.ts — a kind that trips it is benched, as on the server).
 *
 *   npx tsx scripts/bot-arena.ts [mix] [minutes] [level] [family] [mode] [seed]
 *   npx tsx scripts/bot-arena.ts wanderer,rotator,hunter,farmer,bridge 5 5 hex normal
 */

import { Bots, DEFAULT_WATCHDOG, formatBotMix, parseBotMix, prepareBots, type BotTrip } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS, isGameMode, knobsForMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { describeRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import type { TileFamilyId } from '../shared/tiles';

const [rawMix = 'wanderer,rotator,hunter,farmer,bridge', rawMin = '5', rawLevel = '5', family = 'hex', rawMode = 'normal', rawSeed = '1'] =
  process.argv.slice(2);
const { mix, unknown } = parseBotMix(rawMix);
if (unknown.length) throw new Error(`unknown bots: ${unknown.join(', ')}`);
const mode = isGameMode(rawMode) ? rawMode : 'normal';

const field = buildField({ family: family as TileFamilyId, level: Number(rawLevel), rootTile: 'Delta' });
fieldOutline(field);
const rng = mulberry32(Number(rawSeed));
const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, mode), rng);
const bots = new Bots(engine, rng);
prepareBots(field, mix);
bots.add(mix, 0);
const trips: { at: number; trip: BotTrip }[] = [];
let tickNow = 0;
bots.watchdog = DEFAULT_WATCHDOG;
bots.onSlow = (trip) => trips.push({ at: tickNow, trip });
/** Each kind's slowest update, ms (kept here: a benched bot's record goes with it). */
const slowest = new Map<string, number>();

const crashes = new Map<string, number>();
const circuits = new Map<string, number>();
const peak = new Map<string, number>();
const bump = (m: Map<string, number>, k: string, n = 1): void => void m.set(k, (m.get(k) ?? 0) + n);

const dt = engine.knobs.tickMs;
const end = Number(rawMin) * 60_000;
let botMs = 0;
let worst = 0;
const t0 = Date.now();
for (let now = 0; now < end; now += dt) {
  tickNow = now;
  const ev: GameEvent[] = engine.tick(dt);
  const b0 = performance.now();
  bots.update(now, ev);
  const took = performance.now() - b0;
  botMs += took;
  worst = Math.max(worst, took);
  for (const b of bots.timings()) slowest.set(b.kind, Math.max(slowest.get(b.kind) ?? 0, b.worstMs));
  for (const e of ev) {
    // Collisions are mutual: both lines go, each wiped `by` the other.
    if (e.t === 'wipe' && e.by !== undefined) bump(crashes, e.owner);
    else if (e.t === 'circuit') bump(circuits, e.owner);
  }
  for (const p of engine.players.values()) peak.set(p.id, Math.max(peak.get(p.id) ?? 0, p.score));
}

console.log(`${formatBotMix(mix)} · ${family} level ${rawLevel} (${field.count} tiles) · ${mode} · ${rawMin} min in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`bots: ${(botMs / (end / dt)).toFixed(2)} ms per tick on average, ${worst.toFixed(1)} ms at worst`);
console.log(`slowest update: ${[...slowest].map(([k, ms]) => `${k} ${ms.toFixed(1)} ms`).join(', ')}`);
const w = DEFAULT_WATCHDOG;
console.log(
  trips.length
    ? `watchdog (${w.hardMs} ms once, or ${w.strikes} × ${w.softMs} ms in ${w.window} ticks) benched: ${trips.map(({ at, trip }) => `${trip.kind} at ${(at / 1000).toFixed(1)} s (${trip.why}, ${trip.source} took ${trip.ms.toFixed(0)} ms)`).join('; ')}`
    : `watchdog (${w.hardMs} ms once, or ${w.strikes} × ${w.softMs} ms in ${w.window} ticks): no trips`,
);
console.table(
  [...engine.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({
      name: p.name,
      rule: describeRule(p.rule),
      score: p.score,
      peak: peak.get(p.id) ?? 0,
      lines: p.paths.length,
      steps: p.paths.reduce((n, q) => n + q.steps.length, 0),
      circuits: circuits.get(p.id) ?? 0,
      collisions: crashes.get(p.id) ?? 0,
    })),
);
