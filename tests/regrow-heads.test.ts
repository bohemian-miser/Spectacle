import { describe, expect, it } from 'vitest';
import { Store } from '../client/src/store';
import { Engine, type Path } from '../shared/game/engine';
import { buildField, tileCenter } from '../shared/game/field';
import { DEFAULT_KNOBS, type Knobs } from '../shared/game/knobs';
import type { GameEvent } from '../shared/game/protocol';
import { planRegrow } from '../shared/game/regrow';
import { mulberry32 } from '../shared/game/rng';
import { defaultRule, randomCleanRule, type PlayerRule } from '../shared/game/rule';
import { chordTableFor, tileChords, worldChord, type ChordTable } from '../shared/game/strand';
import { packEvents } from '../shared/game/wire';

const SPEC = { family: 'hex', level: 3, rootTile: 'Delta' } as const;
const HEX = buildField(SPEC);
const NEXT = randomCleanRule('hex', mulberry32(11));

/** Ann's grown-out territory of the default rule. */
function territory(knobs: Knobs): { e: Engine; ev: GameEvent[] } {
  const e = new Engine(HEX, knobs, mulberry32(1));
  const ev: GameEvent[] = [...e.addPlayer('a', 'Ann', defaultRule('hex'))];
  const table = chordTableFor(HEX, defaultRule('hex'));
  for (let i = 0, n = 0; i < HEX.count && n < 40; i += 7) {
    if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
    const r = e.tap('a', i, tileCenter(HEX, i));
    ev.push(...r.events);
    if (r.result.ok) n++;
  }
  for (let t = 0; t < 4000; t++) ev.push(...e.tick(knobs.tickMs));
  return { e, ev };
}

const pieces = (e: Engine): Path[] => e.players.get('a')!.paths.filter((q) => q.status === 'growing');
const chord = (s: { tile: number; chord: number }) => s.tile * 64 + s.chord;

/** The world midpoint of chord `c` of `tile`: where to tap for exactly that chord. */
function worldMid(tb: ChordTable, tile: number, c: number) {
  const [a, b] = worldChord(HEX, tb, tile, c);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Tap chord `c` of `tile` of `rule`, exactly. */
function tapChord(e: Engine, rule: PlayerRule, tile: number, c: number) {
  return e.tap('a', tile, worldMid(chordTableFor(HEX, rule), tile, c));
}

describe('rule change: heads carry over, and a head takes over slow regrowth', () => {
  it('the heads you had growing drive regrowth pieces at a head’s speed', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    const { e } = territory(knobs);
    const a = e.players.get('a')!;
    // Three fresh lines growing at the moment of the switch.
    const table = chordTableFor(HEX, defaultRule('hex'));
    let started = 0;
    for (let i = 3; i < HEX.count && started < 3; i += 11) {
      if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
      if (e.tap('a', i, tileCenter(HEX, i)).result.ok) started++;
    }
    e.tick(knobs.tickMs);
    const heads = a.paths.filter((q) => q.status === 'growing' && !q.spawned).length;
    expect(heads).toBe(3);
    const ev = e.setRule('a', NEXT);
    const promoted = ev.filter((x) => x.t === 'promote');
    expect(promoted).toHaveLength(3);
    const growing = pieces(e);
    expect(growing.length).toBeGreaterThan(3);
    const fast = growing.filter((q) => !q.spawned);
    expect(fast.map((q) => q.id).sort()).toEqual(promoted.map((x) => (x.t === 'promote' ? x.path : -1)).sort());
    expect(e.headsInUse(a)).toBe(3);
    // Each head lays a step every step interval; the slow pieces share one head's worth between them all.
    const before = new Map(growing.map((q) => [q.id, q.steps.length]));
    for (let t = 0; t < 10; t++) e.tick(knobs.tickMs);
    const gained = (q: Path) => q.steps.length - (before.get(q.id) ?? 0);
    const stillFast = fast.filter((q) => e.getPath(q.id) === q && q.status === 'growing');
    const slow = growing.filter((q) => q.spawned && e.getPath(q.id) === q);
    expect(stillFast.length).toBeGreaterThan(0);
    expect(Math.min(...stillFast.map(gained))).toBeGreaterThan(0);
    expect(slow.reduce((n, q) => n + gained(q), 0)).toBeLessThan(stillFast.reduce((n, q) => n + gained(q), 0) + 3);
  });

  it('no heads growing, none carried: regrowth is all slow pieces', () => {
    const { e } = territory({ ...DEFAULT_KNOBS, maxHeads: 0 });
    const ev = e.setRule('a', NEXT);
    expect(ev.some((x) => x.t === 'promote')).toBe(false);
    expect(pieces(e).every((q) => q.spawned)).toBe(true);
  });

  it('tapping a slow piece makes it a head that carries on from where it is', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS };
    const { e } = territory({ ...knobs, maxHeads: 0 });
    // One head, as a player has.
    (e as unknown as { knobs: Knobs }).knobs.maxHeads = 1;
    e.setRule('a', NEXT);
    const a = e.players.get('a')!;
    const slow = pieces(e).find((q) => q.spawned && q.steps.length > 1)!;
    expect(slow).toBeDefined();
    const laid = slow.steps.map(chord);
    const s = slow.steps[Math.floor(slow.steps.length / 2)];
    const r = e.tap('a', s.tile, worldMid(slow.table, s.tile, s.chord));
    expect(r.result).toEqual({ ok: true, path: slow.id });
    expect(r.events.filter((x) => x.t === 'promote')).toEqual([{ t: 'promote', path: slow.id }]);
    expect(slow.spawned).toBeUndefined();
    expect(e.headsInUse(a)).toBe(1);
    // Nothing it had laid is redrawn: it carries on from its head.
    expect(slow.steps.map(chord)).toEqual(laid);
    for (let t = 0; t < 5; t++) e.tick(knobs.tickMs);
    const now = e.getPath(slow.id) ?? a.paths.find((q) => laid.every((k) => q.steps.some((x) => chord(x) === k)));
    expect(now).toBeDefined();
    expect(now!.steps.length).toBeGreaterThan(laid.length);
    // With the one head taken, a tap on another slow piece is not a takeover.
    const other = pieces(e).find((q) => q.spawned && q.steps.length > 0);
    if (other) {
      const o = other.steps[0];
      const r2 = e.tap('a', o.tile, worldMid(other.table, o.tile, o.chord));
      expect(r2.events.some((x) => x.t === 'promote')).toBe(false);
      expect(other.spawned).toBe(true);
    }
  });

  it('a head that reaches a slow piece jumps over what it laid and closes the circuit sooner', () => {
    const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
    // Same game twice: once left to the slow pieces, once with a tap on a bare stretch of a circuit.
    const run = (tap: boolean) => {
      const { e } = territory(knobs);
      (e as unknown as { knobs: Knobs }).knobs.maxHeads = 1;
      const a = e.players.get('a')!;
      const held = new Set(a.paths.flatMap((q) => q.steps.map((s) => s.tile)));
      const plan = planRegrow(HEX, chordTableFor(HEX, NEXT), held, a.score, e.knobs);
      e.setRule('a', NEXT);
      // The longest bought circuit (loop or claim) with a chord nobody has laid.
      const loop = [...plan.kept, ...(plan.stretch ? [plan.stretch] : [])]
        .filter((q) => q.closed && q.steps.some((s) => e.pathsOn(s.tile).length === 0))
        .sort((x, y) => y.length - x.length)[0];
      expect(loop).toBeDefined();
      const bare = loop.steps.find((s) => e.pathsOn(s.tile).length === 0)!;
      if (tap) {
        const r = tapChord(e, NEXT, bare.tile, bare.chord);
        expect(r.result.ok).toBe(true);
      }
      const want = new Set(loop.steps.map(chord));
      for (let t = 1; t < 20_000; t++) {
        e.tick(knobs.tickMs);
        const done = a.paths.find((q) => q.status === 'closed' && q.steps.length === want.size && q.steps.every((s) => want.has(chord(s))));
        if (done) return { t, done, e };
      }
      throw new Error('never closed');
    };
    const slow = run(false);
    const fast = run(true);
    // The tapped head took the pieces in (jumping over their chords) and closed it itself.
    expect(fast.done.spawned).toBeUndefined();
    expect(fast.t).toBeLessThan(slow.t);
    // No chord was laid twice.
    expect(new Set(fast.done.steps.map(chord)).size).toBe(fast.done.steps.length);
  });

  for (const packed of [false, true]) {
    it(`a client following the switch and the takeovers keeps exactly the engine’s lines (${packed ? 'packed' : 'plain'})`, () => {
      const knobs: Knobs = { ...DEFAULT_KNOBS, maxHeads: 0 };
      const { e, ev } = territory(knobs);
      const store = new Store();
      store.handle({ t: 'welcome', you: 'viewer', token: '', field: SPEC, knobs, players: [], paths: [] });
      const send = (x: GameEvent[]) =>
        store.handle({ t: 'events', ev: packed ? packEvents(HEX, x, (o, p) => e.players.get(o)?.patterns[p]?.table) : x });
      send(ev);
      const table = chordTableFor(HEX, defaultRule('hex'));
      const out: GameEvent[] = [];
      for (let i = 3, n = 0; i < HEX.count && n < 2; i += 11) {
        if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
        const r = e.tap('a', i, tileCenter(HEX, i));
        out.push(...r.events);
        if (r.result.ok) n++;
      }
      out.push(...e.tick(knobs.tickMs));
      send(out);
      send(e.setRule('a', NEXT));
      for (let t = 0; t < 400; t++) {
        const batch: GameEvent[] = [];
        if (t % 40 === 0) {
          const slow = pieces(e).find((q) => q.spawned && q.steps.length > 0);
          if (slow) batch.push(...e.tap('a', slow.steps[0].tile, worldMid(slow.table, slow.steps[0].tile, slow.steps[0].chord)).events);
        }
        batch.push(...e.tick(knobs.tickMs));
        send(batch);
      }
      const key = (q: { owner: string; status: string; spawned?: boolean; steps: readonly { tile: number; chord: number }[] }) =>
        `${q.owner} ${q.status} ${q.spawned ? 's' : 'h'} ${q.steps.map((s) => `${s.tile}.${s.chord}`).join(' ')}`;
      const engine = new Map([...e.players.get('a')!.paths].map((q) => [q.id, key(q)]));
      const client = new Map([...store.paths.values()].map((q) => [q.id, key(q)]));
      expect(client).toEqual(engine);
      expect(store.players.get('a')!.score).toBe(e.players.get('a')!.score);
    });
  }
});

describe('rule change: the head limit carries over', () => {
  const knobs: Knobs = { ...DEFAULT_KNOBS };
  const capture = (e: Engine, n: number) => {
    const a = e.players.get('a')!;
    for (let k = 0; k < n; k++) {
      const rule = randomCleanRule('hex', mulberry32(100 + a.patterns.length + k));
      a.patterns.push({ rule, table: chordTableFor(HEX, rule), color: a.color });
    }
  };

  it('keeps the heads captured patterns gave, and adds to them after', () => {
    const e = new Engine(HEX, knobs, mulberry32(1));
    e.addPlayer('a', 'Ann', defaultRule('hex'));
    const a = e.players.get('a')!;
    expect(e.headLimit(a)).toBe(1);
    capture(e, 3);
    const before = e.headLimit(a);
    expect(before).toBe(4);
    const store = new Store();
    store.handle({ t: 'welcome', you: 'a', token: '', field: SPEC, knobs, players: [e.publicOf(a)], paths: [] });
    expect(store.heads().total).toBe(before);

    store.handle({ t: 'events', ev: e.setRule('a', NEXT) });
    expect(a.patterns.length).toBe(1);
    expect(e.headLimit(a)).toBe(before);
    expect(store.heads().total).toBe(before);
    // A capture on the new rule still earns a head on top.
    capture(e, 1);
    expect(e.headLimit(a)).toBe(before + 1);
    // …and a second switch keeps that too, as does a fresh join's view of it.
    store.handle({ t: 'events', ev: e.setRule('a', defaultRule('hex')) });
    expect(e.headLimit(a)).toBe(before + 1);
    expect(store.heads().total).toBe(before + 1);
    const late = new Store();
    late.handle({ t: 'welcome', you: 'a', token: '', field: SPEC, knobs, players: [e.publicOf(a)], paths: [] });
    expect(late.heads().total).toBe(before + 1);
  });

  it('lets you start that many lines on the new rule', () => {
    const e = new Engine(HEX, knobs, mulberry32(1));
    e.addPlayer('a', 'Ann', defaultRule('hex'));
    capture(e, 2);
    const limit = e.headLimit(e.players.get('a')!);
    e.setRule('a', NEXT);
    const table = chordTableFor(HEX, NEXT);
    let ok = 0;
    let refused = 0;
    for (let i = 5; i < HEX.count && ok + refused < limit + 1; i += 13) {
      if (tileChords(HEX, table, i).length === 0 || e.pathsOn(i).length > 0) continue;
      if (e.tap('a', i, tileCenter(HEX, i)).result.ok) ok++;
      else refused++;
    }
    expect(ok).toBe(limit);
    expect(refused).toBe(1);
  });
});
