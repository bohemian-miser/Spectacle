import { describe, expect, it } from 'vitest';
import { Renderer } from '../client/src/render';
import { Store } from '../client/src/store';
import { Bots } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { randomCleanRule } from '../shared/game/rule';
import { chordTableFor } from '../shared/game/strand';

/** A renderer on a stub overlay whose tile layer just records the tints. */
function recorder(store: Store, field: ReturnType<typeof buildField>) {
  const tints = new Map<number, string>();
  let clears = 0;
  const ctx = new Proxy({}, { get: () => () => undefined });
  const overlay = { getContext: () => ctx } as unknown as HTMLCanvasElement;
  const r = new Renderer({} as HTMLCanvasElement, overlay, store) as unknown as {
    tiles: unknown;
    field: unknown;
    syncTints(now: number): void;
  };
  r.tiles = {
    kind: 'webgl',
    clearTints: () => {
      clears++;
      tints.clear();
    },
    setTint: (tile: number, red: number, g: number, b: number, a: number) => {
      if (a <= 0) tints.delete(tile);
      else tints.set(tile, [red, g, b, a].map((x) => Math.round(x)).join(','));
    },
    draw() {},
    resize() {},
    setArrows() {},
    setTheme() {},
    dispose() {},
  };
  r.field = field;
  return { tints, sync: (now: number) => r.syncTints(now), clears: () => clears };
}

describe('tile tints', () => {
  // Normal mode changes nobody's patterns mid-game, so every pass after the
  // first is an incremental one — the thing under test. Conquest adds takes
  // (and captures, which re-tint everything).
  it.each(['normal', 'conquest'] as const)('%s: re-tinting only the touched tiles matches a full rebuild all game long', (mode) => {
    const spec = { family: 'hex', level: 3, rootTile: 'Delta' } as const;
    const field = buildField(spec);
    // Geometric: this seeded game is pinned to reliably reach a convert/take
    // (exercising those tint paths) within the tick budget; tile mode cuts
    // rivals sooner and this one never does. Not a crossingMode test — the
    // tint sync is.
    const knobs = { ...DEFAULT_KNOBS, mode, maxHeads: 0, crossingMode: 'geometric' as const };
    const e = new Engine(field, knobs, mulberry32(11));
    const rng = mulberry32(12);
    const bots = new Bots(e, mulberry32(13), 0.1);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'viewer', token: '', field: spec, knobs, players: [], paths: [] });
    store.handle({ t: 'events', ev: bots.add(4, 0) });
    // Watch as one of the bots, so "yours first" and your washes are exercised.
    store.you = [...e.players.keys()][0];
    for (const p of e.players.values()) {
      for (let k = 0; k < 2; k++) {
        const rule = randomCleanRule('hex', rng);
        p.patterns.push({ rule, table: chordTableFor(field, rule), color: p.color });
      }
    }
    const live = recorder(store, field);
    const seen = new Set<string>();
    let now = 0;
    // The tint passes' own clock: a tick apart, so the throttle skips some
    // (their tiles wait for the next pass), with a forced pass at each check.
    let clock = 0;
    let checks = 0;
    for (let t = 1; t <= 2500; t++) {
      now += knobs.tickMs;
      const ev: GameEvent[] = [];
      bots.update(now, ev);
      ev.push(...e.tick(knobs.tickMs));
      for (const x of ev) seen.add(x.t);
      store.handle({ t: 'events', ev });
      live.sync((clock += knobs.tickMs));
      if (t % 50 !== 0) continue;
      live.sync((clock += 1000));
      const fresh = recorder(store, field);
      fresh.sync(0);
      expect(live.tints.size, `tick ${t}`).toBe(fresh.tints.size);
      for (const [tile, tint] of fresh.tints) expect(live.tints.get(tile), `tick ${t} tile ${tile}`).toBe(tint);
      if (fresh.tints.size > 0) checks++;
    }
    expect(checks).toBeGreaterThan(40);
    expect(seen).toContain('circuit');
    expect(seen).toContain('wipe');
    expect(seen).toContain('split');
    if (mode === 'normal') {
      expect(seen).toContain('convert');
      expect(live.clears()).toBe(1);
    } else expect(seen).toContain('take');
  });
});
