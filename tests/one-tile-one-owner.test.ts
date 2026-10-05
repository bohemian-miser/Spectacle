import { describe, expect, it } from 'vitest';
import { Bots } from '../shared/game/bots';
import { TUNING } from '../shared/game/brains/tuning';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { applyTuning, DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';

const FIELD = buildField({ family: 'hex', level: 3, rootTile: 'Delta' });

describe('no two players on one tile', () => {
  for (const mode of ['normal', 'conquest'] as const) {
    it(`a busy bot game never shares a tile between players (crossingMode tile, ${mode})`, () => {
      const knobs: Knobs = { ...DEFAULT_KNOBS, crossingMode: 'tile', mode };
      const e = new Engine(FIELD, knobs, mulberry32(7));
      const bots = new Bots(e, mulberry32(8), 0.1);
      bots.add(5, 0);
      let now = 0;
      let cuts = 0;
      for (let t = 0; t < 2000; t++) {
        now += knobs.tickMs;
        const ev: GameEvent[] = [];
        bots.update(now, ev);
        ev.push(...e.tick(knobs.tickMs));
        for (const x of ev) if (x.t === 'wipe' && x.by) cuts++;
        const owner = new Map<number, string>();
        for (const p of e.players.values()) {
          for (const q of p.paths) {
            for (const s of q.steps) {
              const o = owner.get(s.tile);
              if (o !== undefined) expect(o, `tile ${s.tile} at tick ${t}`).toBe(p.id);
              owner.set(s.tile, p.id);
            }
          }
        }
      }
      expect(cuts).toBeGreaterThan(0);
    });
  }

  it('is what the live tuning plays', () => {
    expect(applyTuning(DEFAULT_KNOBS, TUNING).knobs.crossingMode).toBe('tile');
  });
});
