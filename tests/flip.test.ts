import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';

describe('flipOwnLines', () => {
  it('a client applying the event stream ends up with exactly the engine’s lines (splits, burns, folds)', () => {
    // Bots holding several patterns, drawing with any of them: plenty of flips.
    const spec = { family: 'spectre', level: 3, rootTile: 'Delta' } as const;
    const field = buildField(spec);
    const knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const e = new Engine(field, knobs, mulberry32(3));
    const rng = mulberry32(4);
    const bots = new Bots(e, mulberry32(5), 0.1);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs, players: [], paths: [] });
    store.handle({ t: 'events', ev: bots.add(4, 0) });
    for (const p of e.players.values()) {
      for (let k = 0; k < 3; k++) {
        const rule = randomCleanRule('spectre', rng);
        p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
      }
    }
    let splits = 0;
    let spawned = 0;
    let now = 0;
    for (let t = 0; t < 3000; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      for (const x of ev) {
        if (x.t === 'split') splits++;
        if (x.t === 'step' && x.spawned) spawned++;
      }
      store.handle({ t: 'events', ev });
    }
    expect(splits).toBeGreaterThan(0);
    expect(spawned).toBeGreaterThan(0);

    const engine = new Map<number, string>();
    const key = (owner: string, status: string, steps: readonly { tile: number; chord: number; a: { x: number; y: number } }[]) =>
      `${owner} ${status} ${steps.map((s) => `${s.tile}.${s.chord}@${s.a.x.toFixed(3)},${s.a.y.toFixed(3)}`).join(' ')}`;
    for (const p of e.players.values()) for (const q of p.paths) engine.set(q.id, key(q.owner, q.status, q.steps));
    const client = new Map<number, string>();
    for (const q of store.paths.values()) client.set(q.id, key(q.owner, q.status, q.steps));
    expect(client.size).toBe(engine.size);
    for (const [id, k] of engine) expect(client.get(id), `path ${id}`).toBe(k);
  });
});
