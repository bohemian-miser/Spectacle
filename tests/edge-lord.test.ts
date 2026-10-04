/** The edge lords (#84): round the field's edge clockwise, an edge start at a time. */
import { describe, expect, it } from 'vitest';
import { bridgeRule, clockwise } from '../shared/game/brains/kinds';
import { edgeIndexFor } from '../shared/game/brains/sense';
import { Bots, type BotMix } from '../shared/game/bots';
import { Engine, type Path } from '../shared/game/engine';
import { buildField, fieldOutline, pathPolygon, pointInPolygon, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor } from '../shared/game/strand';
import { isInfiniteLineRule } from '../shared/game/rule';
import type { Pt } from '../shared/tiles';

const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });
fieldOutline(field);

interface LordBrain {
  id: string;
  kind: string;
  at: number;
  dir: number;
}

/** Bots only, `ms` of play; every tap a lord makes is noted with whether it fell inside a circuit of its own. */
function play(mix: BotMix, ms: number, seed = 1) {
  const rng = mulberry32(seed);
  const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
  const bots = new Bots(engine, rng);
  const events: GameEvent[] = [...bots.add(mix, 0)];
  const brains = (bots as unknown as { bots: LordBrain[] }).bots;
  const taps = new Map<string, { inside: boolean }[]>();
  const tap = engine.tap.bind(engine);
  const insideOwn = (id: string, p: Pt) =>
    engine.players.get(id)!.paths.some((q: Path) => q.status === 'closed' && pointInPolygon(p, pathPolygon(q)));
  engine.tap = (id, tile, at, ev) => {
    if (brains.some((b) => b.id === id && b.kind !== 'wanderer')) {
      const list = taps.get(id) ?? [];
      taps.set(id, list);
      list.push({ inside: insideOwn(id, at) });
    }
    return tap(id, tile, at, ev);
  };
  const visits = new Map<string, number[]>();
  const dt = engine.knobs.tickMs;
  for (let now = 0; now < ms; now += dt) {
    const ev = engine.tick(dt);
    bots.update(now, ev);
    events.push(...ev);
    for (const b of brains) {
      if (b.kind === 'wanderer' || b.at < 0) continue;
      const v = visits.get(b.id) ?? [];
      visits.set(b.id, v);
      if (v[v.length - 1] !== b.at) v.push(b.at);
    }
  }
  const lord = (kind: string) => brains.find((b) => b.kind === kind)!;
  return { engine, events, taps, visits, lord };
}

describe('edge lords', () => {
  it("know which way round clockwise as the board is drawn (y down)", () => {
    const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), mulberry32(1));
    const index = edgeIndexFor(field, chordTableFor(field, bridgeRule('hex')));
    index.work(Infinity);
    const n = index.starts.length;
    let cx = 0, cy = 0;
    for (const s of index.starts) {
      const c = tileCenter(field, s.tile);
      cx += c.x / n;
      cy += c.y / n;
    }
    // Turning angle round the middle, going through the index forwards: +2π is clockwise on screen.
    let turn = 0;
    for (let i = 0; i < n; i++) {
      const a = tileCenter(field, index.starts[i].tile);
      const b = tileCenter(field, index.starts[(i + 1) % n].tile);
      let d = Math.atan2(b.y - cy, b.x - cx) - Math.atan2(a.y - cy, a.x - cx);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
    }
    expect(Math.abs(Math.abs(turn) - 2 * Math.PI)).toBeLessThan(1e-6);
    expect(clockwise(engine, index)).toBe(turn > 0);
  });

  it('go round the edge clockwise, a start at a time, laying edge-to-edge claims', () => {
    const { engine, events, visits, lord } = play({ edgelord: 1, lazylord: 1, wanderer: 1 }, 4 * 60_000, 2);
    for (const kind of ['edgelord', 'lazylord']) {
      const b = lord(kind);
      const p = engine.players.get(b.id)!;
      expect(isInfiniteLineRule(p.rule)).toBe(false);
      const index = edgeIndexFor(field, p.table);
      const n = index.starts.length;
      expect(clockwise(engine, index) ? 1 : -1, kind).toBe(b.dir);
      // Every move is on round, clockwise (past starts it has nothing to do at, a turn's worth at most).
      const v = visits.get(b.id)!;
      expect(v.length, kind).toBeGreaterThan(30);
      let round = 0;
      for (let i = 1; i < v.length; i++) {
        const d = ((((v[i] - v[i - 1]) * b.dir) % n) + n) % n;
        expect(d, kind).toBeGreaterThanOrEqual(1);
        expect(d, kind).toBeLessThanOrEqual(64);
        round += d;
      }
      expect(round, kind).toBeGreaterThan(n / 10);
      const claims = events.filter((e) => e.t === 'circuit' && e.owner === b.id && e.region).length;
      expect(claims, kind).toBeGreaterThan(20);
    }
  }, 30_000);

  it('the Edge Lord never taps inside its own claims; the lazy one may', () => {
    const { taps, lord } = play({ edgelord: 1, lazylord: 1 }, 4 * 60_000, 3);
    const edge = taps.get(lord('edgelord').id)!;
    expect(edge.length).toBeGreaterThan(30);
    expect(edge.filter((t) => t.inside).length).toBe(0);
    const lazy = taps.get(lord('lazylord').id)!;
    expect(lazy.length).toBeGreaterThan(30);
    expect(lazy.some((t) => t.inside)).toBe(true);
  }, 30_000);
});
