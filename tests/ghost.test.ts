import { describe, expect, it } from 'vitest';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';

describe('dropped paths', () => {
  it('a line that dies mid-tick takes no further steps (no ghost head left behind)', () => {
    // Fast lines take several steps per tick, so a collision lands mid-tick.
    const field = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });
    const e = new Engine(field, { ...DEFAULT_KNOBS, baseStepMs: 5, minStepMs: 5 }, mulberry32(7));
    const bots = new Bots(e, mulberry32(8), 0.8);
    let now = 0;
    const ev: GameEvent[] = [...bots.add(6, now)];
    for (let t = 0; t < 4000; t++) {
      now += DEFAULT_KNOBS.tickMs;
      const tick = e.tick(DEFAULT_KNOBS.tickMs);
      bots.update(now, tick);
      ev.push(...tick);
    }
    const wiped = new Set<number>();
    let wipes = 0;
    for (const x of ev) {
      if (x.t === 'wipe') {
        wiped.add(x.path);
        wipes++;
      }
      if (x.t === 'step') expect(wiped.has(x.path), `step on wiped path ${x.path}`).toBe(false);
    }
    expect(wipes).toBeGreaterThan(0);
    // Nothing on the board belongs to a path that is gone.
    for (let i = 0; i < field.count; i++) for (const p of e.pathsOn(i)) expect(e.getPath(p.id)).toBe(p);
  });
});
