import { describe, expect, it } from 'vitest';
import { BRIDGE_BUDGET, bridgeRule } from '../shared/game/brains/kinds';
import { EdgeIndex, EdgeWalk, edgeIndexFor, isBridgeClosed, isInfiniteLineRule, scoutFor } from '../shared/game/brains/sense';
import { BOT_KINDS, Bots, formatBotMix, parseBotMix, prepareBots, type BotMix } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { describeRule, fassRule, ruleKey } from '../shared/game/rule';
import { chordTableFor, type WalkStep } from '../shared/game/strand';
import { mulberry32 } from '../shared/game/rng';

const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });
fieldOutline(field);

/** Bots only, `ms` of play at the server's tick. */
function play(mix: BotMix, ms: number, seed = 1, options = {}) {
  const rng = mulberry32(seed);
  const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
  const bots = new Bots(engine, rng, undefined, options);
  const events: GameEvent[] = [...bots.add(mix, 0)];
  const dt = engine.knobs.tickMs;
  for (let now = 0; now < ms; now += dt) {
    const ev = engine.tick(dt);
    bots.update(now, ev);
    events.push(...ev);
  }
  const byName = (name: string) => [...engine.players.values()].find((p) => p.name === name)!;
  return { engine, bots, events, byName };
}

describe('bot mix', () => {
  it('reads BOTS: a bare number is wanderers, else kinds with counts', () => {
    expect(parseBotMix('3')).toEqual({ mix: { wanderer: 3 }, unknown: [] });
    expect(parseBotMix('bridge,hunter:2').mix).toEqual({ bridge: 1, hunter: 2 });
    expect(parseBotMix('bridge+hunter:2 + Farmer').mix).toEqual({ bridge: 1, hunter: 2, farmer: 1 });
    expect(parseBotMix('').mix).toEqual({});
    expect(parseBotMix('bridge,dragon,hunter:x')).toEqual({ mix: { bridge: 1 }, unknown: ['dragon', 'hunter:x'] });
    expect(formatBotMix({ hunter: 2, bridge: 1, farmer: 0 })).toBe('hunter:2,bridge');
    expect(parseBotMix(formatBotMix({ hunter: 2, bridge: 1 })).mix).toEqual({ hunter: 2, bridge: 1 });
    expect(formatBotMix({})).toBe('none');
  });

  it('adds each kind under its own name, wanderers as ever', () => {
    const rng = mulberry32(1);
    const engine = new Engine(field, DEFAULT_KNOBS, rng);
    const bots = new Bots(engine, rng);
    bots.add({ wanderer: 2, bridge: 1, hunter: 2 }, 0);
    expect([...engine.players.values()].map((p) => p.name)).toEqual(['hexbot', 'psi', 'Hunter', 'Hunter 2', 'Bridge']);
    expect(bots.mix()).toEqual({ wanderer: 2, hunter: 2, bridge: 1 });
    expect([...engine.players.values()].every((p) => p.bot)).toBe(true);
    // The old call still means wanderers.
    bots.add(1, 0);
    expect(engine.players.get('bot-6')?.name).toBe('mystic');
  });
});

describe('the scout', () => {
  it('finds long-line and short-loop rules, and knows the infinite-line family', () => {
    prepareBots(field, { bridge: 1 });
    const scout = scoutFor(field);
    expect(scout.done).toBe(true);
    expect(isInfiniteLineRule(fassRule('hex'))).toBe(true);
    expect(isInfiniteLineRule(fassRule('spectre'))).toBe(true);
    const rng = mulberry32(2);
    const reach = (rule: { subset: readonly number[]; matching: readonly number[] } | null) =>
      scout.reports.find((r) => rule && ruleKey(r.rule as never) === ruleKey(rule as never))!.reach;
    const loops = scout.reports.filter((r) => !r.infinite);
    const medianReach = [...loops].sort((a, b) => a.reach - b.reach)[loops.length >> 1].reach;
    for (let k = 0; k < 10; k++) {
      const long = scout.longLineRule(rng, false);
      expect(long && isInfiniteLineRule(long)).toBe(false);
      expect(reach(long)).toBeGreaterThan(medianReach);
      const short = scout.shortLoopRule(rng)!;
      expect(scout.reports.find((r) => ruleKey(r.rule) === ruleKey(short))!.shortLoops).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('bots at play', () => {
  it('every kind plays: lines, points, and nothing throws', () => {
    const { engine } = play(Object.fromEntries(BOT_KINDS.map((k) => [k, 1])), 3 * 60_000);
    for (const p of engine.players.values()) {
      expect(p.paths.length + p.score, p.name).toBeGreaterThan(0);
      expect(isInfiniteLineRule(p.rule), p.name).toBe(false);
    }
  });

  it('a rotator starts over with a new rule every rotateMs or so', () => {
    const { events, byName } = play({ rotator: 1, wanderer: 1 }, 5 * 60_000, 3, { rotateMs: 60_000 });
    const id = byName('Rotator').id;
    const rules = events.filter((e) => e.t === 'rule' && e.id === id).map((e) => (e.t === 'rule' ? ruleKey(e.rule) : ''));
    // 5 min at 45–75 s a rule.
    expect(rules.length).toBeGreaterThanOrEqual(3);
    expect(rules.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < rules.length; i++) expect(rules[i]).not.toBe(rules[i - 1]);
  });

  it('a farmer closes more circuits than a wanderer', () => {
    const { events, byName } = play({ farmer: 1, wanderer: 2 }, 4 * 60_000, 4);
    const circuits = (name: string) => events.filter((e) => e.t === 'circuit' && e.owner === byName(name).id).length;
    expect(circuits('Farmer')).toBeGreaterThan(20);
    expect(circuits('Farmer')).toBeGreaterThan(circuits('hexbot'));
    expect(circuits('Farmer')).toBeGreaterThan(circuits('psi'));
  });

  it('a hunter runs into the leader', () => {
    const { events, byName } = play({ hunter: 1, farmer: 1 }, 4 * 60_000, 5);
    const hunter = byName('Hunter').id;
    const farmer = byName('Farmer').id;
    const cuts = events.filter((e) => e.t === 'wipe' && e.owner === farmer && e.by === hunter).length;
    expect(cuts).toBeGreaterThan(3);
  });

  it('a bridge plays every edge class with combination all zeros, and lays edge-to-edge claims: a short one, then wider', () => {
    const { engine, events, byName } = play({ bridge: 1, wanderer: 2 }, 4 * 60_000, 6);
    const bridge = byName('Bridge');
    expect(describeRule(bridge.rule)).toBe('01234568 · 000000000');
    expect(ruleKey(bridge.rule)).toBe(ruleKey(bridgeRule('hex')));
    const steps = events.filter((e) => e.t === 'step' && e.owner === bridge.id).length;
    expect(steps).toBeGreaterThan(300);
    // Claims against the edge, the first short (#81) and later ones round it.
    const claims = events.flatMap((e) => (e.t === 'circuit' && e.owner === bridge.id && e.region ? [e.length] : []));
    expect(claims.length).toBeGreaterThanOrEqual(4);
    expect(claims[0]).toBeLessThan(20);
    expect(Math.max(...claims)).toBeGreaterThan(2 * claims[0]);
    expect(engine.players.size).toBe(3);
  });

  it('a bridge finishes what it starts, and each next one spans the last or carries on round the edge from it — never back across the board', () => {
    const rng = mulberry32(3);
    const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
    const bots = new Bots(engine, rng);
    bots.add({ bridge: 1, wanderer: 2 }, 0);
    // The brain's own plan, looked at from outside: its arc of the edge index, and whether it closed.
    const brain = (bots as unknown as { bots: { id: string; kind: string; plan: { a: number; b: number; steps: WalkStep[] } | null }[] }).bots.find((b) => b.kind === 'bridge')!;
    const plans: { a: number; b: number; closed: boolean }[] = [];
    let last: (typeof brain)['plan'] = null;
    const dt = engine.knobs.tickMs;
    for (let now = 0; now < 8 * 60_000; now += dt) {
      const ev = engine.tick(dt);
      bots.update(now, ev);
      if (brain.plan !== last) {
        if (last) plans[plans.length - 1].closed = isBridgeClosed(engine, brain.id, last.steps);
        last = brain.plan;
        if (last) plans.push({ a: last.a, b: last.b, closed: false });
      }
    }
    expect(plans.length).toBeGreaterThan(10);
    const n = edgeIndexFor(field, chordTableFor(field, bridgeRule('hex'))).starts.length;
    expect(n).toBeGreaterThan(100);
    const fwd = (x: number, y: number) => (((y - x) % n) + n) % n;
    const holds = (o: { a: number; b: number }, i: { a: number; b: number }) => fwd(o.a, i.a) <= fwd(o.a, i.b) && fwd(o.a, i.b) <= fwd(o.a, o.b);
    // Round the last (or something laid already), else on round the edge from it — past what it holds
    // there already — never back across the board. (Before, it went on from a random start.)
    for (let i = 1; i < plans.length; i++) {
      const [prev, next] = [plans[i - 1], plans[i]];
      if (plans.slice(0, i).some((q) => holds(next, q))) continue;
      expect(fwd(prev.b, next.a)).toBeLessThan(n >> 1);
    }
    // Given up rarely: no bridge planned where it can't be tapped.
    expect(plans.filter((q) => q.closed).length).toBeGreaterThanOrEqual(0.8 * plans.length);
  }, 30_000);

  it("a bridge's planning keeps to its budget every tick (and lays lines on the spectre board too)", () => {
    // A board no other test has traced, so the edge index is built here, a slice a tick.
    const spectre = buildField({ family: 'spectre', level: 4, rootTile: 'Delta' });
    const rng = mulberry32(4);
    const engine = new Engine(spectre, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
    const bots = new Bots(engine, rng);
    bots.add({ bridge: 2 }, 0);
    let walked = 0;
    let traces = 0;
    let traceBudget = 0;
    const walk = EdgeWalk.prototype.work;
    const trace = EdgeIndex.prototype.work;
    EdgeWalk.prototype.work = function (budget: number) {
      const n = walk.call(this, budget);
      walked += n;
      return n;
    };
    EdgeIndex.prototype.work = function (budget: number) {
      traces++;
      traceBudget = Math.max(traceBudget, budget);
      return trace.call(this, budget);
    };
    let mostWalked = 0;
    let mostTraces = 0;
    let slowest = 0;
    let total = 0;
    const dt = engine.knobs.tickMs;
    const ticks = (2 * 60_000) / dt;
    try {
      for (let now = 0; now < ticks * dt; now += dt) {
        const ev = engine.tick(dt);
        walked = traces = 0;
        const t0 = performance.now();
        bots.update(now, ev);
        const took = performance.now() - t0;
        slowest = Math.max(slowest, took);
        total += took;
        mostWalked = Math.max(mostWalked, walked);
        mostTraces = Math.max(mostTraces, traces);
      }
    } finally {
      EdgeWalk.prototype.work = walk;
      EdgeIndex.prototype.work = trace;
    }
    // Each bridge: at most one slice of tracing or BRIDGE_BUDGET steps of walking a tick.
    expect(mostWalked).toBeLessThanOrEqual(2 * BRIDGE_BUDGET);
    expect(mostTraces).toBeLessThanOrEqual(2);
    expect(traceBudget).toBeLessThanOrEqual(BRIDGE_BUDGET);
    expect(edgeIndexFor(spectre, chordTableFor(spectre, bridgeRule('spectre'))).done).toBe(true);
    // Wall clock, loosely (a loaded CI box): the bug this pins took ~25 s in one tick on a board this size.
    expect(slowest).toBeLessThan(250);
    expect(total / ticks).toBeLessThan(5);
    for (const p of engine.players.values()) expect(p.paths.reduce((n, q) => n + q.steps.length, 0)).toBeGreaterThan(20);
  }, 30_000);
});
