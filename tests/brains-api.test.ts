/**
 * The brains reach the game only through `BoardView` and `BotActions`
 * (`bots.ts`, #87): nothing in `shared/game/brains/` imports the engine, so
 * the board a brain reads can become a mirror on another thread.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bots, type BoardView } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';

const DIR = join(__dirname, '..', 'shared', 'game', 'brains');

describe('brains API', () => {
  it('no brain imports the engine', () => {
    for (const f of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(DIR, f), 'utf8');
      expect(src, f).not.toMatch(/from\s+['"]\.\.\/engine['"]/);
    }
  });

  it('the engine is a board view as it stands', () => {
    const engine = new Engine(buildField({ family: 'hex', level: 3, rootTile: 'Delta' }), DEFAULT_KNOBS, mulberry32(1));
    const board: BoardView = engine;
    expect(board.field).toBe(engine.field);
  });

  it("a bot's moves land in the tick's events, in order", () => {
    const rng = mulberry32(4);
    const engine = new Engine(buildField({ family: 'hex', level: 3, rootTile: 'Delta' }), { ...DEFAULT_KNOBS, mode: 'normal' }, rng);
    const bots = new Bots(engine, rng);
    bots.add({ wanderer: 2, rotator: 1 }, 0);
    let steps = 0;
    for (let now = 0; now < 20_000; now += engine.knobs.tickMs) {
      const ev: GameEvent[] = engine.tick(engine.knobs.tickMs);
      bots.update(now, ev);
      steps += ev.filter((e) => e.t === 'step').length;
    }
    expect(steps).toBeGreaterThan(0);
    for (const p of engine.players.values()) expect(p.paths.length).toBeGreaterThan(0);
  });
});
