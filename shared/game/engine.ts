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
 *  - a tap may not land on your own line, with one exception: tapping the
 *    start of a line that ran off the edge of the field turns it round to
 *    grow the other way. A line that runs edge to edge closes like a circuit
 *    and claims the smaller side of the board it cuts off;
 *  - a player has at most `maxHeads` growing lines, and losing one in a
 *    collision blocks the next tap for `respawnDelayMs`.
 */

import type { Pt } from '../tiles';
import { boundaryRegion, onFieldBoundary, pathPolygon, pointInPolygon, polygonArea, tileCenter, type Field } from './field';
import { stepIntervalMs, type Knobs } from './knobs';
import type { GameEvent, PathStatus, PathWire, PlayerPublic } from './protocol';
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
  readonly owner: string;
  status: PathStatus;
  readonly steps: WalkStep[];
  /** Fractional steps accumulated since the last advance. */
  progress: number;
  /** Points this path has earned; they go with it when it goes. */
  points: number;
  /** An edge-to-edge line's claimed region (line + field outline), once closed. */
  region?: Pt[];
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
}

export type TapResult = { ok: true; path: number } | { ok: false; reason: string };

/** Evenly spread, saturated player colours (golden-angle hue walk). */
export function playerColor(index: number): string {
  const h = (index * 137.50776405003785) % 360;
  return `hsl(${h.toFixed(1)}, 90%, 62%)`;
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
    const player: Player = {
      id,
      name,
      color: playerColor(this.colorIndex++),
      rule,
      table: chordTableFor(this.field, rule),
      score: 0,
      combo: this.knobs.comboStart,
      paths: [],
      bot,
      respawnAt: 0,
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
    if (this.knobs.resetScoreOnRule) p.score = 0;
    p.combo = this.knobs.comboStart;
    ev.push({ t: 'rule', id, rule, score: p.score, combo: p.combo });
    return ev;
  }

  publicOf(p: Player): PlayerPublic {
    return { id: p.id, name: p.name, color: p.color, rule: p.rule, score: p.score, combo: p.combo, bot: p.bot };
  }

  snapshot(): { players: PlayerPublic[]; paths: PathWire[] } {
    const players = [...this.players.values()].map((p) => this.publicOf(p));
    const paths: PathWire[] = [];
    for (const p of this.players.values()) {
      for (const path of p.paths) {
        paths.push(
          path.region
            ? { id: path.id, owner: path.owner, status: path.status, steps: path.steps, region: path.region }
            : { id: path.id, owner: path.owner, status: path.status, steps: path.steps },
        );
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
    if (this.knobs.maxHeads > 0 && p.paths.filter((q) => q.status === 'growing').length >= this.knobs.maxHeads) {
      return { result: { ok: false, reason: 'your line is still growing' }, events: ev };
    }
    if (!Number.isInteger(tile) || tile < 0 || tile >= this.field.count) {
      return { result: { ok: false, reason: 'no such tile' }, events: ev };
    }
    const turn = p.paths.find((q) => q.status === 'stuck' && q.steps[0].tile === tile && this.canTurn(p, q));
    if (turn) {
      this.turnRound(turn, ev);
      return { result: { ok: true, path: turn.id }, events: ev };
    }
    if (this.occupancy.get(tile) && [...this.occupancy.get(tile)!].some((path) => path.owner === id)) {
      return { result: { ok: false, reason: "that's your own line" }, events: ev };
    }
    if (tileChords(this.field, p.table, tile).length === 0) {
      return { result: { ok: false, reason: 'your rule draws no line on this tile' }, events: ev };
    }
    if (!this.knobs.tapOntoOthers) {
      const occ = this.occupancy.get(tile);
      if (occ && [...occ].some((path) => path.owner !== id)) {
        return { result: { ok: false, reason: "that's someone else's line" }, events: ev };
      }
    }
    if (!this.knobs.tapInsideRivalCircuits && this.insideRivalCircuit(id, tileCenter(this.field, tile))) {
      return { result: { ok: false, reason: "that's inside someone else's circuit" }, events: ev };
    }
    const chord = nearestChord(this.field, p.table, tile, at);
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
    };
    p.paths.push(path);
    this.pathsById.set(path.id, path);
    this.addStep(p, path, startStep(this.field, p.table, tile, chord, exitEnd), ev);
    return { result: { ok: true, path: path.id }, events: ev };
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
      p.table,
      cur,
      this.knobs.junctionPolicy === 'random' ? this.pickJunction : undefined,
    );
    if (out.kind === 'dead' && onFieldBoundary(this.field, cur.tile, cur.b) && this.startsAtEdge(p, path)) {
      // Edge to edge: the line cuts the board in two and claims the smaller side.
      const line = [...path.steps.map((q) => q.a), cur.b];
      const region = boundaryRegion(this.field, line);
      if (region) {
        this.closeCircuit(p, path, ev, region);
        return;
      }
    }
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
    if (!this.addStep(p, path, s, ev)) return; // died in a collision
    if (this.knobs.maxPathLength > 0 && path.steps.length >= this.knobs.maxPathLength) {
      this.setStatus(path, 'stuck', ev);
    }
  }

  /** Extend `path` by one step. Returns false when the step was a fatal collision. */
  private addStep(p: Player, path: Path, s: WalkStep, ev: GameEvent[]): boolean {
    const hitOwner = this.cutRivals(p, s, ev);
    if (hitOwner !== null && this.knobs.mutualCut) {
      // The collision is drawn (so both players see where it happened), then
      // the line that caused it goes too, with everything it had earned.
      path.steps.push(s);
      ev.push({ t: 'step', path: path.id, owner: p.id, step: s });
      p.combo = this.knobs.comboStart;
      this.dropPath(path, hitOwner, ev);
      return false;
    }
    path.steps.push(s);
    let occ = this.occupancy.get(s.tile);
    if (!occ) {
      occ = new Set();
      this.occupancy.set(s.tile, occ);
    }
    occ.add(path);
    ev.push({ t: 'step', path: path.id, owner: p.id, step: s });
    path.points += this.knobs.pointsPerTile;
    this.addScore(p, this.knobs.pointsPerTile, ev);
    return true;
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
        const rival = this.players.get(other.owner);
        if (!rival) continue;
        for (const q of other.steps) {
          if (q.tile !== s.tile) continue;
          const seg = worldChord(this.field, rival.table, q.tile, q.chord);
          if (chordsConflict(mine, seg, this.knobs.touchCounts)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        const rival = this.players.get(other.owner);
        if (rival) rival.combo = this.knobs.comboStart;
        this.dropPath(other, p.id, ev);
        hitOwner = other.owner;
      }
    }
    return hitOwner;
  }

  /** Does the line's start sit on the field's edge, with nowhere to go behind it? */
  private startsAtEdge(p: Player, path: Path): boolean {
    const s = path.steps[0];
    return continuations(this.field, p.table, s.tile, s.chord, s.a).length === 0 && onFieldBoundary(this.field, s.tile, s.a);
  }

  /** A stuck line that ran off the edge, whose start still has somewhere to go. */
  private canTurn(p: Player, path: Path): boolean {
    const last = path.steps[path.steps.length - 1];
    if (continuations(this.field, p.table, last.tile, last.chord, last.b).length > 0) return false;
    if (!onFieldBoundary(this.field, last.tile, last.b)) return false;
    const s = path.steps[0];
    return continuations(this.field, p.table, s.tile, s.chord, s.a).length > 0;
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
    const area = polygonArea(region ?? path.steps.map((s) => s.a)) / this.field.tileArea;
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
    // Trim old trophies only when a cap is set.
    if (k.maxCompletedCircuits > 0) {
      const closed = p.paths.filter((q) => q.status === 'closed');
      while (closed.length > k.maxCompletedCircuits) this.dropPath(closed.shift()!, undefined, ev);
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
   * them, and a cutter (`by`) receives `stealFraction` of them.
   */
  private dropPath(path: Path, by: string | undefined, ev: GameEvent[]): void {
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
    ev.push(by === undefined ? { t: 'wipe', path: path.id, owner: path.owner } : { t: 'wipe', path: path.id, owner: path.owner, by });
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
