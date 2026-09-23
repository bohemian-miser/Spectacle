/**
 * Bots: enough opposition to see the mechanics move when you are the only
 * human in the arena. Each bot plays a random clean rule and, whenever it has
 * a head to spare, taps a tile after a short pause — usually somewhere random,
 * sometimes onto a rival's path to cut it.
 */

import type { Engine } from './engine';
import { tileCenter, tileNeighbours } from './field';
import type { GameEvent } from './protocol';
import { randomCleanRule } from './rule';
import type { Rng } from './rng';
import { tileChords } from './strand';

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
      const heads = this.engine.headLimit(p);
      if (heads > 0 && p.paths.filter((path) => path.status === 'growing').length >= heads) continue;
      if (now < bot.nextTapAt) continue;
      bot.nextTapAt = now + 1000 + this.rng.int(3000);
      // A bot holding captured patterns draws with any of them.
      if (p.patterns.length > 1) ev.push(...this.engine.setActive(bot.id, this.rng.int(p.patterns.length)));
      const tile = this.pickTile(bot.id);
      if (tile < 0) continue;
      this.engine.tap(bot.id, tile, tileCenter(this.engine.field, tile), ev);
    }
  }

  private pickTile(id: string): number {
    const field = this.engine.field;
    const me = this.engine.players.get(id)!;
    const table = (me.patterns[me.active] ?? me.patterns[0]).table;
    if (this.rng.next() < this.aggression) {
      // Find a rival step to land on.
      const rivals = [...this.engine.players.values()].filter((q) => q.id !== id && q.paths.length > 0);
      if (rivals.length) {
        const r = rivals[this.rng.int(rivals.length)];
        const path = r.paths[this.rng.int(r.paths.length)];
        const step = path.steps[this.rng.int(path.steps.length)];
        if (step) {
          // Next to the rival's line (a tap on it is refused), on a free tile.
          const nbrs = tileNeighbours(field, step.tile);
          for (let k = 0; k < nbrs.length; k++) {
            const t = nbrs[(k + this.rng.int(nbrs.length)) % nbrs.length];
            if (tileChords(field, table, t).length > 0 && this.engine.pathsOn(t).length === 0) return t;
          }
        }
      }
    }
    for (let tries = 0; tries < 50; tries++) {
      const t = this.rng.int(field.count);
      if (tileChords(field, table, t).length > 0) return t;
    }
    return -1;
  }
}
