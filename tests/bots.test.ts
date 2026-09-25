import { describe, expect, it } from 'vitest';
import { isInfiniteLineRule, scoutFor } from '../shared/game/bot-sense';
import { BOT_KINDS, Bots, formatBotMix, parseBotMix, prepareBots, type BotMix } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { fassRule, ruleKey } from '../shared/game/rule';
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

  it('a bridge plays a long-line rule and keeps tapping its plan', () => {
    const { engine, events, byName } = play({ bridge: 1, wanderer: 2 }, 4 * 60_000, 6);
    const bridge = byName('Bridge');
    const scout = scoutFor(field);
    const top = [...scout.reports].filter((r) => !r.infinite).sort((a, b) => b.reach - a.reach).slice(0, 4).map((r) => ruleKey(r.rule));
    expect(top).toContain(ruleKey(bridge.rule));
    // Its line: long, and it has grown a lot of steps over the game.
    const steps = events.filter((e) => e.t === 'step' && e.owner === bridge.id).length;
    expect(steps).toBeGreaterThan(300);
    expect(engine.players.size).toBe(3);
  });

  it('plays an infinite-line rule only when allowed', () => {
    const allowed = play({ bridge: 3 }, 2_000, 7, { infiniteLines: true });
    const banned = play({ bridge: 3 }, 2_000, 7);
    for (const p of banned.engine.players.values()) expect(isInfiniteLineRule(p.rule)).toBe(false);
    // Allowed, the reach ranking puts the FASS family on top on hex.
    expect([...allowed.engine.players.values()].some((p) => isInfiniteLineRule(p.rule))).toBe(true);
  });
});
