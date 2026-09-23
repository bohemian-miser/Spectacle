/**
 * The authoritative game engine — pure, deterministic given its `Rng`, and
 * free of any I/O so it is testable tick by tick.
 *
 * Mechanics (see README "How it plays"):
 *  - a tap picks the chord of that tile nearest the tap point and starts a
 *    path leaving through a random end;
 *  - a growing path advances one chord per step; steps come faster as the
 *    owner's score rises (`stepIntervalMs`);
 *  - each tile entered scores `pointsPerTile`;
 *  - arriving back at the start chord closes a circuit and pays a combo bonus
 *    on length and enclosed area;
 *  - a chord entering a tile where another player's chord crosses it wipes
 *    that player's whole path, and the points it had earned with it (a knob
 *    can hand a fraction of them to the cutter); with `mutualCut` the line
 *    that did the hitting dies too, so a collision costs both sides;
 *  - a tap may not land on a rival's line nor inside a rival's closed
 *    circuit (both knobs);
 *  - a tail (no continuation) leaves the path stuck; tap elsewhere to start
 *    another — every line a player draws stays until it is cut;
 *  - a tap starts on the nearest chord of the tile that no line is on or
 *    crosses (lines block chords, not whole tiles); it may not start on your
 *    own line, with one exception: tapping the
 *    start of a line that ran off the edge of the field turns it round to
 *    grow the other way. A line that runs edge to edge closes like a circuit
 *    and claims the smaller side of the board it cuts off;
 *  - a growing line that runs into another of its owner's lines stops, unless
 *    it meets that line's loose end on the same chord: then they join into one
 *    (the other's steps and points fold in), so two lines that ran off the
 *    edge make one edge-to-edge claim. With `overlapOwnLines` it grows on
 *    over the top instead (joins still happen); taps stay per chord, except
 *    that a line of another of the player's patterns blocks its whole tile;
 *  - a player has at most `maxHeads` growing lines, and losing one in a
 *    collision blocks the next tap for `respawnDelayMs`;
 *  - closing a circuit round a rival's line takes that line's pattern: it
 *    joins your patterns, draws in a colour 2/3 yours and 1/3 theirs, and
 *    you choose which pattern a tap draws with. Holding a captured pattern
 *    lifts your head limit to `headsWithCapture`, and (`headPerCapture`)
 *    each further one adds a head, up to `maxHeadsTotal`;
 *  - (`takeEnclosed`) the lines themselves change hands too: every rival
 *    line wholly inside the circuit — loops, edge-to-edge claims, lines still
 *    growing — becomes yours, drawn with the captured pattern, and its points
 *    come with it (zero-sum: the rival loses them).
 */

import type { Pt, Segment } from '../tiles';
import { mixHsl } from './color';
import { boundaryRegion, onFieldBoundary, pathPolygon, pointInPolygon, polygonArea, tileCenter, type Field } from './field';
import { headLimit, stepIntervalMs, type Knobs } from './knobs';
import type { GameEvent, PathStatus, PathWire, PatternPublic, PlayerPublic } from './protocol';
import type { PlayerRule } from './rule';
import type { Rng } from './rng';
import {
  chordTableFor,
  chordsConflict,
  continuations,
  nearestChord,
  randomJunctionPicker,
  startStep,
  stepForward,
  tileChords,
  worldChord,
  type ChordTable,
  type WalkStep,
} from './strand';

export interface Path {
  readonly id: number;
  /** Changes hands when a rival closes a circuit round it (`takeEnclosed`). */
  owner: string;
  status: PathStatus;
  readonly steps: WalkStep[];
  /** Fractional steps accumulated since the last advance. */
  progress: number;
  /** Points this path has earned; they go with it when it goes. */
  points: number;
  /** An edge-to-edge line's claimed region (line + field outline), once closed. */
  region?: Pt[];
  /** The pattern it grows by — its owner's own rule or one they captured. */
  readonly rule: PlayerRule;
  readonly table: ChordTable;
  /** Index of that pattern in the owner's `patterns`. */
  pattern: number;
}

/** A rule a player can draw with, and the colour its lines take. */
export interface Pattern {
  readonly rule: PlayerRule;
  readonly table: ChordTable;
  readonly color: string;
  readonly from?: string;
  readonly fromName?: string;
}


export interface Player {
  readonly id: string;
  name: string;
  color: string;
  rule: PlayerRule;
  table: ChordTable;
  score: number;
  /** Current streak multiplier applied to the next circuit. */
  combo: number;
  readonly paths: Path[];
  readonly bot: boolean;
  /** Engine time before which a tap may not start a new head (collision cooldown). */
  respawnAt: number;
  /** `patterns[0]` is `rule`/`table`; captured patterns follow. */
  readonly patterns: Pattern[];
  /** The pattern a tap draws with. */
  active: number;
}

export type TapResult = { ok: true; path: number } | { ok: false; reason: string };

/** Evenly spread, saturated player colours (golden-angle hue walk). */
export function playerColor(index: number): string {
  const h = (index * 137.50776405003785) % 360;
  return `hsl(${h.toFixed(1)}, 90%, 62%)`;
}

function sameRule(a: PlayerRule, b: PlayerRule): boolean {
  return (
    a.family === b.family &&
    a.subset.length === b.subset.length &&
    a.subset.every((x, i) => x === b.subset[i]) &&
    a.matching.length === b.matching.length &&
    a.matching.every((x, i) => x === b.matching[i])
  );
}

function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/** Where a step sits on the board: its chord's midpoint (rounded, it goes on the wire). */
function chordMid(s: WalkStep): Pt {
  return { x: Math.round((s.a.x + s.b.x) * 500) / 1000, y: Math.round((s.a.y + s.b.y) * 500) / 1000 };
}

function sameSeg(a: Segment, b: Segment): boolean {
  return (samePt(a[0], b[0]) && samePt(a[1], b[1])) || (samePt(a[0], b[1]) && samePt(a[1], b[0]));
}

export class Engine {
  readonly players = new Map<string, Player>();
  private readonly pathsById = new Map<number, Path>();
  /** tile → paths that have a step on it. */
  private readonly occupancy = new Map<number, Set<Path>>();
  private nextPathId = 1;
  /** Engine clock: the sum of every `tick` dt, ms. */
  private now = 0;
  private colorIndex = 0;
  private readonly pickJunction: (options: readonly import('./strand').ChordEnd[]) => import('./strand').ChordEnd;

  constructor(
    readonly field: Field,
    readonly knobs: Knobs,
    private readonly rng: Rng,
  ) {
    this.pickJunction = randomJunctionPicker(rng);
  }

  // --- players -------------------------------------------------------------

  addPlayer(id: string, name: string, rule: PlayerRule, bot = false): GameEvent[] {
    if (this.players.has(id)) return [];
    const color = playerColor(this.colorIndex++);
    const table = chordTableFor(this.field, rule);
    const player: Player = {
      id,
      name,
      color,
      rule,
      table,
      score: 0,
      combo: this.knobs.comboStart,
      paths: [],
      bot,
      respawnAt: 0,
      patterns: [{ rule, table, color }],
      active: 0,
    };
    this.players.set(id, player);
    return [{ t: 'join', player: this.publicOf(player) }];
  }

  removePlayer(id: string): GameEvent[] {
    const p = this.players.get(id);
    if (!p) return [];
    const ev: GameEvent[] = [];
    for (const path of [...p.paths]) this.dropPath(path, undefined, ev);
    this.players.delete(id);
    ev.push({ t: 'leave', id });
    return ev;
  }

  /** New rule = restart: paths gone, score optionally reset. */
  setRule(id: string, rule: PlayerRule): GameEvent[] {
    const p = this.players.get(id);
    if (!p) return [];
    const ev: GameEvent[] = [];
    for (const path of [...p.paths]) this.dropPath(path, undefined, ev);
    p.rule = rule;
    p.table = chordTableFor(this.field, rule);
    p.patterns.length = 0;
    p.patterns.push({ rule, table: p.table, color: p.color });
    p.active = 0;
    if (this.knobs.resetScoreOnRule) p.score = 0;
    p.combo = this.knobs.comboStart;
    ev.push({ t: 'rule', id, rule, score: p.score, combo: p.combo });
    return ev;
  }

  publicOf(p: Player): PlayerPublic {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      rule: p.rule,
      score: p.score,
      combo: p.combo,
      bot: p.bot,
      patterns: p.patterns.map(patternPublic),
      active: p.active,
    };
  }

  /** How many lines `p` may have growing at once (0 = unlimited). */
  headLimit(p: Player): number {
    return headLimit(this.knobs, p.patterns.length);
  }

  /** Choose which pattern `id`'s taps draw with. */
  setActive(id: string, index: number): GameEvent[] {
    const p = this.players.get(id);
    if (!p || !Number.isInteger(index) || index < 0 || index >= p.patterns.length || index === p.active) return [];
    p.active = index;
    return [{ t: 'active', id, active: index }];
  }

  snapshot(): { players: PlayerPublic[]; paths: PathWire[] } {
    const players = [...this.players.values()].map((p) => this.publicOf(p));
    const paths: PathWire[] = [];
    for (const p of this.players.values()) {
      for (const path of p.paths) {
        const wire: { -readonly [K in keyof PathWire]: PathWire[K] } = { id: path.id, owner: path.owner, status: path.status, steps: path.steps };
        if (path.region) wire.region = path.region;
        if (path.pattern !== 0) wire.pattern = path.pattern;
        paths.push(wire);
      }
    }
    return { players, paths };
  }

  // --- taps ----------------------------------------------------------------

  tap(id: string, tile: number, at: Pt, ev: GameEvent[] = []): { result: TapResult; events: GameEvent[] } {
    const p = this.players.get(id);
    if (!p) return { result: { ok: false, reason: 'not in the arena' }, events: ev };
    if (this.now < p.respawnAt) {
      return { result: { ok: false, reason: 'still recovering from that collision' }, events: ev };
    }
    const heads = this.headLimit(p);
    if (heads > 0 && p.paths.filter((q) => q.status === 'growing').length >= heads) {
      return { result: { ok: false, reason: heads > 1 ? 'your lines are still growing' : 'your line is still growing' }, events: ev };
    }
    if (!Number.isInteger(tile) || tile < 0 || tile >= this.field.count) {
      return { result: { ok: false, reason: 'no such tile' }, events: ev };
    }
    // Turning round is per chord too: the tap has to be nearest the line's first chord.
    const turn = p.paths.find(
      (q) =>
        q.status === 'stuck' &&
        q.steps[0].tile === tile &&
        nearestChord(this.field, q.table, tile, at) === q.steps[0].chord &&
        this.canTurn(q),
    );
    if (turn) {
      this.turnRound(turn, ev);
      return { result: { ok: true, path: turn.id }, events: ev };
    }
    const pattern = p.patterns[p.active] ?? p.patterns[0];
    if (tileChords(this.field, pattern.table, tile).length === 0) {
      return {
        result: { ok: false, reason: p.active === 0 ? 'your rule draws no line on this tile' : 'that pattern draws no line on this tile' },
        events: ev,
      };
    }
    // Lines block chords, not tiles: a tap on a tile some line already runs
    // through starts on the nearest chord of it that no line is on or crosses.
    const chord = this.freeChord(id, pattern, tile, at);
    if (typeof chord === 'string') return { result: { ok: false, reason: chord }, events: ev };
    if (!this.knobs.tapInsideRivalCircuits && this.insideRivalCircuit(id, tileCenter(this.field, tile))) {
      return { result: { ok: false, reason: "that's inside someone else's circuit" }, events: ev };
    }
    const exitEnd: 0 | 1 = this.rng.next() < 0.5 ? 0 : 1;

    // Every tap starts another line; the old ones sit stuck or closed (or keep
    // growing, under a looser `maxHeads`) until they are cut. A cap on live
    // lines, if set, drops the oldest.
    if (this.knobs.maxLivePaths > 0) {
      const live = p.paths.filter((q) => q.status !== 'closed');
      while (live.length >= this.knobs.maxLivePaths) this.dropPath(live.shift()!, undefined, ev);
    }

    const path: Path = {
      id: this.nextPathId++,
      owner: id,
      status: 'growing',
      steps: [],
      progress: 0,
      points: 0,
      rule: pattern.rule,
      table: pattern.table,
      pattern: p.patterns.indexOf(pattern),
    };
    p.paths.push(path);
    this.pathsById.set(path.id, path);
    this.addStep(p, path, startStep(this.field, pattern.table, tile, chord, exitEnd), ev);
    return { result: { ok: true, path: path.id }, events: ev };
  }

  /**
   * The chord of `tile` nearest `at` that player `id` may start on with
   * `pattern`: none of their own lines on it or crossing it (with
   * `overlapOwnLines`, none of their lines of the same pattern on it, and none
   * of another pattern on the tile at all), nor a rival's unless
   * `tapOntoOthers`. When every chord is blocked, the reason (for the chord
   * nearest `at`).
   */
  private freeChord(id: string, pattern: { rule: PlayerRule; table: ChordTable }, tile: number, at: Pt): number | string {
    const table = pattern.table;
    // Nearest first: the chord under the finger, then the rest by midpoint.
    const near = nearestChord(this.field, table, tile, at);
    const dist = (c: number): number => {
      if (c === near) return -1;
      const [a, b] = worldChord(this.field, table, tile, c);
      return Math.hypot((a.x + b.x) / 2 - at.x, (a.y + b.y) / 2 - at.y);
    };
    const order = tileChords(this.field, table, tile).map((_, c) => c).sort((x, y) => dist(x) - dist(y));
    let reason: string | null = null;
    for (const c of order) {
      const why = this.chordBlocked(id, pattern.rule, tile, worldChord(this.field, table, tile, c));
      if (why === null) return c;
      reason ??= why;
    }
    return reason ?? 'no free line on this tile';
  }

  /**
   * Why player `id` may not start a `rule` line on segment `seg` of `tile`, or
   * null when they may.
   */
  private chordBlocked(id: string, rule: PlayerRule, tile: number, seg: Segment): string | null {
    const occ = this.occupancy.get(tile);
    if (!occ) return null;
    let rival = false;
    for (const other of occ) {
      const mine = other.owner === id;
      if (mine && this.knobs.overlapOwnLines) {
        // Your lines of the same pattern block only the chord they are on;
        // one of another pattern keeps the whole tile.
        if (!sameRule(other.rule, rule)) return 'another of your patterns runs through this tile';
        if (other.steps.some((q) => q.tile === tile && sameSeg(seg, worldChord(this.field, other.table, tile, q.chord)))) {
          return "that's your own line";
        }
        continue;
      }
      if (!mine && this.knobs.tapOntoOthers) continue;
      if (!this.pathMeets(other, tile, seg)) continue;
      if (mine) return "that's your own line";
      rival = true;
    }
    return rival ? "that's someone else's line" : null;
  }

  /** Does `path` run along or conflict with segment `seg` on `tile`? */
  private pathMeets(path: Path, tile: number, seg: Segment): boolean {
    if (this.knobs.crossingMode === 'tile') return true;
    for (const q of path.steps) {
      if (q.tile !== tile) continue;
      const other = worldChord(this.field, path.table, q.tile, q.chord);
      if (sameSeg(seg, other) || chordsConflict(seg, other, this.knobs.touchCounts)) return true;
    }
    return false;
  }

  // --- time ----------------------------------------------------------------

  tick(dtMs: number): GameEvent[] {
    const ev: GameEvent[] = [];
    this.now += dtMs;
    for (const p of this.players.values()) {
      for (const path of [...p.paths]) {
        if (path.status !== 'growing') continue;
        path.progress += dtMs / stepIntervalMs(this.knobs, p.score);
        // Guard: a huge dt must not spin for thousands of steps in one tick.
        let budget = 64;
        while (path.progress >= 1 && path.status === 'growing' && budget-- > 0) {
          path.progress -= 1;
          this.advance(p, path, ev);
        }
        if (path.status !== 'growing') path.progress = 0;
      }
    }
    return ev;
  }

  // --- internals -----------------------------------------------------------

  private advance(p: Player, path: Path, ev: GameEvent[]): void {
    const cur = path.steps[path.steps.length - 1];
    const out = stepForward(
      this.field,
      path.table,
      cur,
      this.knobs.junctionPolicy === 'random' ? this.pickJunction : undefined,
    );
    if (out.kind === 'dead' && onFieldBoundary(this.field, cur.tile, cur.b) && this.startsAtEdge(path)) {
      // Edge to edge: the line cuts the board in two and claims the smaller side.
      const line = [...path.steps.map((q) => q.a), cur.b];
      const region = boundaryRegion(this.field, line);
      if (region) {
        this.closeCircuit(p, path, ev, region);
        return;
      }
    }
    if (out.kind === 'dead' && this.joinBehind(p, path, ev)) return;
    if (out.kind === 'dead' || out.kind === 'junction') {
      this.setStatus(path, 'stuck', ev);
      return;
    }
    const s = out.step;
    const first = path.steps[0];
    if (s.tile === first.tile && s.chord === first.chord) {
      this.closeCircuit(p, path, ev);
      return;
    }
    if (path.steps.some((q) => q.tile === s.tile && q.chord === s.chord)) {
      // Re-entered the middle of ourselves (only possible via a junction).
      this.setStatus(path, 'stuck', ev);
      return;
    }
    const own = this.meetOwn(p, path, s);
    if (own === 'stop') {
      this.setStatus(path, 'stuck', ev);
      return;
    }
    if (own) this.join(p, path, own, ev);
    else if (!this.addStep(p, path, s, ev)) return; // died in a collision
    if (this.knobs.maxPathLength > 0 && path.steps.length >= this.knobs.maxPathLength) {
      this.setStatus(path, 'stuck', ev);
    }
  }

  /**
   * Does step `s` of `path` run into another of its owner's lines? Null when
   * the way is clear. When `s` is the loose end of a line of the same pattern
   * (the same chord, entered from outside), the two join: returns that line,
   * with its steps oriented to carry on from `s`. Any other meeting — a
   * crossing, a touch, the middle of a line — stops the path ('stop'), unless
   * `overlapOwnLines` lets it grow on over the top (null).
   */
  private meetOwn(p: Player, path: Path, s: WalkStep): { other: Path; tail: WalkStep[] } | 'stop' | null {
    const occ = this.occupancy.get(s.tile);
    if (!occ) return null;
    const mine: [Pt, Pt] = [s.a, s.b];
    for (const other of occ) {
      if (other.owner !== p.id || other === path) continue;
      if (other.status !== 'closed' && sameRule(other.rule, path.rule)) {
        const first = other.steps[0];
        const last = other.steps[other.steps.length - 1];
        let tail: WalkStep[] | null = null;
        if (first.tile === s.tile && first.chord === s.chord && samePt(first.a, s.a)) tail = other.steps.slice();
        else if (last.tile === s.tile && last.chord === s.chord && samePt(last.b, s.a)) {
          tail = other.steps.map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })).reverse();
        }
        // Joining must not run back over the path itself.
        if (tail && !tail.some((t) => path.steps.some((q) => q.tile === t.tile && q.chord === t.chord))) {
          return { other, tail };
        }
      }
      if (!this.knobs.overlapOwnLines && this.pathMeets(other, s.tile, mine)) return 'stop';
    }
    return null;
  }

  /**
   * Two of a player's lines meet end to end: `other` is folded into `path`
   * (its steps appended, its points carried over — nothing is scored twice) and
   * leaves the board. The joined line grows on from `other`'s far end, so two
   * lines that each ran off the edge become one edge-to-edge claim.
   */
  private join(p: Player, path: Path, meet: { other: Path; tail: WalkStep[] }, ev: GameEvent[]): void {
    const { other, tail } = meet;
    const i = p.paths.indexOf(other);
    if (i >= 0) p.paths.splice(i, 1);
    this.pathsById.delete(other.id);
    for (const q of other.steps) {
      const occ = this.occupancy.get(q.tile);
      if (!occ) continue;
      occ.delete(other);
      if (occ.size === 0) this.occupancy.delete(q.tile);
    }
    other.status = 'stuck';
    other.progress = 0;
    ev.push({ t: 'wipe', path: other.id, owner: other.owner });
    for (const q of tail) {
      ev.push(this.stepEvent(p, path, q));
      path.steps.push(q);
      let occ = this.occupancy.get(q.tile);
      if (!occ) {
        occ = new Set();
        this.occupancy.set(q.tile, occ);
      }
      occ.add(path);
    }
    path.points += other.points;
  }

  /** Extend `path` by one step. Returns false when the step was a fatal collision. */
  private addStep(p: Player, path: Path, s: WalkStep, ev: GameEvent[]): boolean {
    const hitOwner = this.cutRivals(p, s, ev);
    if (hitOwner !== null && this.knobs.mutualCut) {
      // The collision is drawn (so both players see where it happened), then
      // the line that caused it goes too, with everything it had earned.
      ev.push(this.stepEvent(p, path, s));
      path.steps.push(s);
      p.combo = this.knobs.comboStart;
      this.dropPath(path, hitOwner, ev, chordMid(s));
      return false;
    }
    const stepEv = this.stepEvent(p, path, s);
    path.steps.push(s);
    let occ = this.occupancy.get(s.tile);
    if (!occ) {
      occ = new Set();
      this.occupancy.set(s.tile, occ);
    }
    occ.add(path);
    ev.push(stepEv);
    path.points += this.knobs.pointsPerTile;
    this.addScore(p, this.knobs.pointsPerTile, ev);
    return true;
  }

  /** A path's step event; the first one says which pattern drew it. */
  private stepEvent(p: Player, path: Path, s: WalkStep): GameEvent {
    return path.steps.length === 0 && path.pattern !== 0
      ? { t: 'step', path: path.id, owner: p.id, step: s, pattern: path.pattern }
      : { t: 'step', path: path.id, owner: p.id, step: s };
  }

  /**
   * Wipe every rival path whose chord on this tile conflicts with `s`.
   * Returns the owner of the last path cut, or null when nothing was hit.
   */
  private cutRivals(p: Player, s: WalkStep, ev: GameEvent[]): string | null {
    const occ = this.occupancy.get(s.tile);
    if (!occ) return null;
    let hitOwner: string | null = null;
    const mine: [Pt, Pt] = [s.a, s.b];
    for (const other of [...occ]) {
      if (other.owner === p.id) continue;
      let hit = this.knobs.crossingMode === 'tile';
      if (!hit) {
        for (const q of other.steps) {
          if (q.tile !== s.tile) continue;
          const seg = worldChord(this.field, other.table, q.tile, q.chord);
          if (chordsConflict(mine, seg, this.knobs.touchCounts)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        const rival = this.players.get(other.owner);
        if (rival) rival.combo = this.knobs.comboStart;
        this.dropPath(other, p.id, ev, chordMid(s));
        hitOwner = other.owner;
      }
    }
    return hitOwner;
  }

  /** Does the line's start sit on the field's edge, with nowhere to go behind it? */
  private startsAtEdge(path: Path): boolean {
    const s = path.steps[0];
    return continuations(this.field, path.table, s.tile, s.chord, s.a).length === 0 && onFieldBoundary(this.field, s.tile, s.a);
  }

  /** A stuck line that ran off the edge, whose start still has somewhere to go. */
  private canTurn(path: Path): boolean {
    const last = path.steps[path.steps.length - 1];
    if (continuations(this.field, path.table, last.tile, last.chord, last.b).length > 0) return false;
    if (!onFieldBoundary(this.field, last.tile, last.b)) return false;
    const s = path.steps[0];
    return continuations(this.field, path.table, s.tile, s.chord, s.a).length > 0;
  }

  /**
   * A line that just ran off the edge, whose start abuts the loose end of
   * another of its owner's lines, turns round and joins it straight away —
   * the same as tapping its start, which is all the player could do next.
   * Returns true when it did (the path is growing again).
   */
  private joinBehind(p: Player, path: Path, ev: GameEvent[]): boolean {
    if (!this.canTurn(path)) return false;
    const first = path.steps[0];
    const back = stepForward(this.field, path.table, { tile: first.tile, chord: first.chord, a: first.b, b: first.a });
    if (back.kind !== 'step') return false;
    const meet = this.meetOwn(p, path, back.step);
    if (meet === null || meet === 'stop') return false;
    this.turnRound(path, ev);
    this.join(p, path, meet, ev);
    return true;
  }

  /** Run the line's steps the other way and let it grow again from its old start. */
  private turnRound(path: Path, ev: GameEvent[]): void {
    const turned = path.steps.map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })).reverse();
    path.steps.length = 0;
    path.steps.push(...turned);
    path.status = 'growing';
    path.progress = 0;
    ev.push({ t: 'reverse', path: path.id });
  }

  private closeCircuit(p: Player, path: Path, ev: GameEvent[], region?: Pt[]): void {
    const k = this.knobs;
    const length = path.steps.length;
    const polygon = region ?? path.steps.map((s) => s.a);
    const area = polygonArea(polygon) / this.field.tileArea;
    const combo = p.combo;
    const bonus = Math.round(
      combo * (k.circuitBase + k.circuitLengthWeight * length + k.circuitAreaWeight * area),
    );
    path.status = 'closed';
    path.progress = 0;
    if (region) path.region = region;
    ev.push(
      region
        ? { t: 'circuit', path: path.id, owner: p.id, length, area, bonus, combo, region }
        : { t: 'circuit', path: path.id, owner: p.id, length, area, bonus, combo },
    );
    p.combo = Math.min(k.comboMax, p.combo + k.comboStep);
    path.points += bonus;
    this.addScore(p, bonus, ev);
    this.captureEnclosed(p, polygon, ev);
    // Trim old trophies only when a cap is set.
    if (k.maxCompletedCircuits > 0) {
      const closed = p.paths.filter((q) => q.status === 'closed');
      while (closed.length > k.maxCompletedCircuits) this.dropPath(closed.shift()!, undefined, ev);
    }
  }

  /**
   * Every rival line wholly inside `polygon` (a circuit `p` just closed):
   * take its pattern if `p` does not already hold it (`captureOnEnclose`), and
   * with `takeEnclosed` take the line itself — owner, pattern index and the
   * points it carries. A line whose pattern `p` cannot hold (the cap) stays put.
   */
  private captureEnclosed(p: Player, polygon: readonly Pt[], ev: GameEvent[]): void {
    const k = this.knobs;
    if (polygon.length < 3 || (!k.captureOnEnclose && !k.takeEnclosed)) return;
    const cap = k.maxCapturedPatterns;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of polygon) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    const inside = (q: Pt): boolean =>
      q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY && pointInPolygon(q, polygon as Pt[]);
    for (const rival of [...this.players.values()]) {
      if (rival.id === p.id) continue;
      for (const other of [...rival.paths]) {
        if (other.steps.length === 0) continue;
        const enclosed = other.steps.every((s) => inside({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }));
        if (!enclosed) continue;
        let index = p.patterns.findIndex((q) => sameRule(q.rule, other.rule));
        if (index < 0 && k.captureOnEnclose && !(cap > 0 && p.patterns.length - 1 >= cap)) {
          const pattern: Pattern = {
            rule: other.rule,
            table: other.table,
            color: mixHsl(p.color, rival.color, 1 / 3),
            from: rival.id,
            fromName: rival.name,
          };
          index = p.patterns.push(pattern) - 1;
          ev.push({ t: 'capture', id: p.id, pattern: patternPublic(pattern) });
        }
        if (k.takeEnclosed && index >= 0) this.takePath(other, rival, p, index, ev);
      }
    }
  }

  /** Hand `path` from `from` to `to`, drawn with `to`'s pattern `index`; its points go with it. */
  private takePath(path: Path, from: Player, to: Player, index: number, ev: GameEvent[]): void {
    const i = from.paths.indexOf(path);
    if (i >= 0) from.paths.splice(i, 1);
    to.paths.push(path);
    path.owner = to.id;
    path.pattern = index;
    ev.push({ t: 'take', path: path.id, from: from.id, owner: to.id, pattern: index });
    if (path.points > 0) {
      this.addScore(from, -path.points, ev);
      this.addScore(to, path.points, ev);
    }
  }

  private setStatus(path: Path, status: PathStatus, ev: GameEvent[]): void {
    if (path.status === status) return;
    path.status = status;
    ev.push({ t: 'status', path: path.id, status });
  }

  /** Is `p` strictly inside a closed circuit belonging to anyone but `id`? */
  insideRivalCircuit(id: string, p: Pt): boolean {
    for (const rival of this.players.values()) {
      if (rival.id === id) continue;
      for (const path of rival.paths) {
        if (path.status !== 'closed') continue;
        const poly = pathPolygon(path);
        if (poly.length < 3) continue;
        // Cheap bounding-box reject before the polygon test.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of poly) {
          if (q.x < minX) minX = q.x;
          if (q.x > maxX) maxX = q.x;
          if (q.y < minY) minY = q.y;
          if (q.y > maxY) maxY = q.y;
        }
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        if (pointInPolygon(p, poly)) return true;
      }
    }
    return false;
  }

  /**
   * Remove a path from the board. Its points leave with it: the owner loses
   * them, and a cutter (`by`) receives `stealFraction` of them. `at` is where
   * the collision happened (the clients spark there).
   */
  private dropPath(path: Path, by: string | undefined, ev: GameEvent[], at?: Pt): void {
    const p = this.players.get(path.owner);
    // A head lost in a collision (either side of it) costs a moment before the next.
    if (p && by !== undefined && path.status === 'growing') p.respawnAt = this.now + this.knobs.respawnDelayMs;
    // A dropped path must not grow again: `tick` may be mid-way through its
    // steps for this tick, and one more would resurrect it as a ghost.
    path.status = 'stuck';
    path.progress = 0;
    if (p) {
      const i = p.paths.indexOf(path);
      if (i >= 0) p.paths.splice(i, 1);
    }
    this.pathsById.delete(path.id);
    for (const s of path.steps) {
      const occ = this.occupancy.get(s.tile);
      if (!occ) continue;
      occ.delete(path);
      if (occ.size === 0) this.occupancy.delete(s.tile);
    }
    ev.push(
      by === undefined
        ? { t: 'wipe', path: path.id, owner: path.owner }
        : at === undefined
          ? { t: 'wipe', path: path.id, owner: path.owner, by }
          : { t: 'wipe', path: path.id, owner: path.owner, by, at },
    );
    if (path.points > 0) {
      if (p) this.addScore(p, -path.points, ev);
      const cutter = by !== undefined ? this.players.get(by) : undefined;
      if (cutter && this.knobs.stealFraction > 0) {
        this.addScore(cutter, Math.floor(path.points * this.knobs.stealFraction), ev);
      }
    }
  }

  private addScore(p: Player, delta: number, ev: GameEvent[]): void {
    p.score = Math.max(0, p.score + delta);
    ev.push({ t: 'score', id: p.id, score: p.score, combo: p.combo });
  }

  /** Test/HUD helper. */
  pathsOn(tile: number): readonly Path[] {
    return [...(this.occupancy.get(tile) ?? [])];
  }

  getPath(id: number): Path | undefined {
    return this.pathsById.get(id);
  }
}

function patternPublic(q: Pattern): PatternPublic {
  return q.from === undefined
    ? { rule: q.rule, color: q.color }
    : { rule: q.rule, color: q.color, from: q.from, fromName: q.fromName ?? '' };
}
