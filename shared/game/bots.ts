/**
 * Bots: enough opposition to see the mechanics move when you are the only
 * human in the arena. Each bot plays a random clean rule and, whenever it has
 * nothing growing, taps a tile after a short pause — usually somewhere random,
 * sometimes onto a rival's path to cut it.
 */

import type { Engine } from './engine';
import { tileCenter } from './field';
import type { GameEvent } from './protocol';
import { randomCleanRule } from './rule';
import type { Rng } from './rng';
import { chordTableFor, tileChords } from './strand';

const NAMES = [
  'hexbot', 'psi', 'mystic', 'delta', 'theta', 'lambda', 'xi', 'sigma', 'phi', 'gamma',
  'tiler', 'weld', 'seam', 'strand', 'fass', 'loop', 'tail', 'chord', 'kernel', 'combo',
];

interface BotState {
  readonly id: string;
  nextTapAt: number;
}

export class Bots {
  private readonly bots: BotState[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly rng: Rng,
    private readonly aggression = 0.3,
  ) {}

  add(count: number, now: number): GameEvent[] {
    const ev: GameEvent[] = [];
    for (let i = 0; i < count; i++) {
      const id = `bot-${i + 1}`;
      const name = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? i : ''}`;
      ev.push(...this.engine.addPlayer(id, name, randomCleanRule(this.engine.field.family, this.rng), true));
      this.bots.push({ id, nextTapAt: now + 500 + this.rng.int(2000) });
    }
    return ev;
  }

  /** Called once per server tick. */
  update(now: number, ev: GameEvent[]): void {
    for (const bot of this.bots) {
      const p = this.engine.players.get(bot.id);
      if (!p) continue;
      if (p.paths.some((path) => path.status === 'growing')) continue;
      if (now < bot.nextTapAt) continue;
      bot.nextTapAt = now + 1000 + this.rng.int(3000);
      const tile = this.pickTile(bot.id);
      if (tile < 0) continue;
      this.engine.tap(bot.id, tile, tileCenter(this.engine.field, tile), ev);
    }
  }

  private pickTile(id: string): number {
    const field = this.engine.field;
    const me = this.engine.players.get(id)!;
    const table = chordTableFor(field, me.rule);
    if (this.rng.next() < this.aggression) {
      // Find a rival step to land on.
      const rivals = [...this.engine.players.values()].filter((q) => q.id !== id && q.paths.length > 0);
      if (rivals.length) {
        const r = rivals[this.rng.int(rivals.length)];
        const path = r.paths[this.rng.int(r.paths.length)];
        const step = path.steps[this.rng.int(path.steps.length)];
        if (step && tileChords(field, table, step.tile).length > 0) return step.tile;
      }
    }
    for (let tries = 0; tries < 50; tries++) {
      const t = this.rng.int(field.count);
      if (tileChords(field, table, t).length > 0) return t;
    }
    return -1;
  }
}
