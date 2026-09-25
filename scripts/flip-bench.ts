/**
 * Conquest flip load: bots holding several patterns draw with any of them, so
 * their lines flip all the time. Prints engine tick time, how many flip pieces
 * sit "growing" (each a pulsing head on every client) and how the game went
 * (top score, circuits) — the pace to keep when touching flips.
 *
 *   npx tsx scripts/flip-bench.ts [family] [level] [bots] [ticks] [seed]
 */
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';

const family = process.argv[2] === 'spectre' ? 'spectre' : 'hex';
const level = Number(process.argv[3] ?? 4);
const nBots = Number(process.argv[4] ?? 6);
const ticks = Number(process.argv[5] ?? 4000);
const seed = Number(process.argv[6] ?? 3);
const field = buildField({ family, level, rootTile: 'Delta' });
fieldOutline(field); // as the server does at startup, so the first claim doesn't stall a tick
const knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
const e = new Engine(field, knobs, mulberry32(seed));
const rng = mulberry32(seed + 1);
const bots = new Bots(e, mulberry32(seed + 2), 0.1);
bots.add(nBots, 0);
for (const p of e.players.values()) {
  for (let k = 0; k < 3; k++) {
    const rule = randomCleanRule(family, rng);
    p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
  }
}
let now = 0;
let tickMs = 0;
let worst = 0;
let events = 0;
let circuits = 0;
let pieceTicks = 0;
let peakPieces = 0;
for (let t = 0; t < ticks; t++) {
  now += knobs.tickMs;
  const ev: GameEvent[] = [];
  bots.update(now, ev);
  const t0 = performance.now();
  ev.push(...e.tick(knobs.tickMs));
  const dt = performance.now() - t0;
  tickMs += dt;
  worst = Math.max(worst, dt);
  events += ev.length;
  for (const x of ev) if (x.t === 'circuit') circuits++;
  let pieces = 0;
  for (const p of e.players.values()) for (const q of p.paths) if (q.spawned && q.status === 'growing') pieces++;
  pieceTicks += pieces;
  peakPieces = Math.max(peakPieces, pieces);
}
let top = 0;
for (const p of e.players.values()) top = Math.max(top, p.score);
console.log(
  `${family} L${level}, ${nBots} bots, ${ticks} ticks, seed ${seed}: tick avg ${(tickMs / ticks).toFixed(3)} ms, worst ${worst.toFixed(1)} ms; ` +
    `growing pieces avg ${(pieceTicks / ticks).toFixed(1)}, peak ${peakPieces}; events ${events}, circuits ${circuits}, top score ${top}`,
);
