import { describe, expect, it } from 'vitest';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor, continuations } from '../shared/game/strand';

describe('flip pieces settle', () => {
  it('a piece whose next chord its pattern already holds does not linger as a growing head', () => {
    const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });
    const knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const e = new Engine(field, knobs, mulberry32(3));
    const rng = mulberry32(4);
    const bots = new Bots(e, mulberry32(5), 0.1);
    bots.add(6, 0);
    for (const p of e.players.values()) {
      for (let k = 0; k < 3; k++) {
        const rule = randomCleanRule('hex', rng);
        p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
      }
    }
    let growing = 0;
    let done = 0;
    let now = 0;
    for (let t = 0; t < 2500; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      e.tick(knobs.tickMs);
      if (t % 10 !== 0) continue;
      for (const p of e.players.values()) {
        const held = new Map<string, Set<number>>();
        for (const q of p.paths) {
          const k = JSON.stringify(q.rule);
          let s = held.get(k);
          if (!s) held.set(k, (s = new Set()));
          for (const x of q.steps) s.add(x.tile * 64 + x.chord);
        }
        for (const q of p.paths) {
          if (!q.spawned || q.status !== 'growing') continue;
          growing++;
          const last = q.steps[q.steps.length - 1];
          const next = continuations(field, q.table, last.tile, last.chord, last.b);
          if (next.length === 1 && held.get(JSON.stringify(q.rule))!.has(next[0].tile * 64 + next[0].chord)) done++;
        }
      }
    }
    expect(growing).toBeGreaterThan(100);
    expect(done / growing).toBeLessThan(0.2);
  });
});
