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
 *  - a tap starts on the nearest chord of the tile that none of your lines is
 *    on or crosses (your lines block chords, a rival's blocks its whole
 *    tile); it may not start on your
 *    own line — a tap on it extends it instead: a stuck line with somewhere
 *    to go behind its start turns round and grows the other way, a growing
 *    one grows from both ends (a second head), and one of another of your
 *    patterns changes to the active one. A line that runs edge to edge closes like a circuit
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
 *    each further one adds a head, up to `maxHeadsTotal`. A captured
 *    pattern's slot can be swapped for a rule of your own: every line drawn
 *    with it goes, and the points they had earned go with them;
 *  - (`takeEnclosed`) the lines themselves change hands too: every rival
 *    line wholly inside the circuit — loops, edge-to-edge claims, lines still
 *    growing — becomes yours, drawn with the captured pattern, and its points
 *    come with it (zero-sum: the rival loses them);
 *  - (`flipOwnLines`) your lines of different patterns never share a tile:
 *    where two of them meet, the one started later wins that tile. The
 *    loser's steps there go (it splits round the gap), the winner's chords
 *    sprout there as pieces, and the pieces grow on at the owner's speed —
 *    into the loser's next tile, which flips in turn. So the newest pattern
 *    spreads along everything of yours it touches, a tile per step, and never
 *    stops at your own lines: the flip also runs along the losing line
 *    itself (`burn`), a tile per step each way, until it is all flipped.
 *    Newer always beats older, so it settles.
 *  - `mode: 'normal'` changes capturing: a rival line wholly inside your
 *    circuit is converted — it leaves the board and your own pattern sprouts
 *    on its tiles, carrying its points — and you never draw with the rival's
 *    pattern. Each new kind of line you convert still adds a head
 *    (`Player.converted`), exactly as a captured pattern would.
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
  type ChordEnd,
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
  /** Made by a flip, not a tap: it doesn't count against the owner's heads. */
  spawned?: boolean;
  /** When its head stops, it turns round once and grows out of its other end (a flip's pieces). */
  twoWay?: boolean;
  /**
   * Its start grows too (a tap on the line while it grew, with a head to
   * spare): a second head, taking a head of its owner's. It advances in
   * `backProgress` by turning the line round, stepping, and turning it back.
   */
  back?: boolean;
  backProgress?: number;
  /**
   * When the tap that started it (or the line whose flip grew it) happened:
   * where two of a player's patterns meet, the higher wave wins the tile.
   */
  wave: number;
  /**
   * A flip is travelling along this line: each step (at the owner's speed)
   * its `start` and/or `end` tile flips to `strain`, until nothing is left.
   */
  burn?: { strain: Strain; start: boolean; end: boolean; progress: number };
}

/** What a flip spreads: a pattern of the owner's, and the wave it won with. */
export type Strain = Pick<Path, 'rule' | 'table' | 'pattern' | 'wave'>;

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
  /** Steps banked for this player's flip pieces, shared between them (`flipPieceHeads`). */
  pieceProgress: number;
  /** Which piece grows next (round robin). */
  pieceCursor: number;
  /** Flip pieces whose head may have nothing new to lay: `settle` checks them. */
  readonly unsettled: Path[];
  /** `patterns[0]` is `rule`/`table`; captured patterns follow. */
  readonly patterns: Pattern[];
  /** The pattern a tap draws with. */
  active: number;
  /** Normal mode: the kinds (rules) of rival line converted so far — a head each, like a captured pattern. */
  readonly converted: PlayerRule[];
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
  private nextWave = 1;
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
      pieceProgress: 0,
      pieceCursor: 0,
      unsettled: [],
      patterns: [{ rule, table, color }],
      active: 0,
      converted: [],
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
    p.converted.length = 0;
    if (this.knobs.resetScoreOnRule) p.score = 0;
    p.combo = this.knobs.comboStart;
    ev.push({ t: 'rule', id, rule, score: p.score, combo: p.combo });
    return ev;
  }

  publicOf(p: Player): PlayerPublic {
    const pub: PlayerPublic = {
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
    return p.converted.length > 0 ? { ...pub, converted: p.converted.length } : pub;
  }

  /** How many lines `p` may have growing at once (0 = unlimited). */
  headLimit(p: Player): number {
    return headLimit(this.knobs, p.patterns.length + p.converted.length);
  }

  /** Lines of `p`'s that are growing and take up a head (a flip's pieces don't). */
  headsInUse(p: Player): number {
    let n = 0;
    for (const q of p.paths) if (q.status === 'growing' && !q.spawned) n += q.back ? 2 : 1;
    return n;
  }

  /**
   * Swap captured pattern `index` (never 0 — that is `setRule`) for `rule`,
   * keeping the slot (and so the head it gives) and its colour. Every line
   * drawn with the old pattern is wiped, and its points leave with it. A rule
   * already held in another slot is refused; the same rule again is a no-op.
   */
  swapPattern(id: string, index: number, rule: PlayerRule): { ok: true; events: GameEvent[] } | { ok: false; reason: string } {
    const p = this.players.get(id);
    if (!p) return { ok: false, reason: 'not in the arena' };
    if (!Number.isInteger(index) || index < 1 || index >= p.patterns.length) return { ok: false, reason: 'no such pattern to swap' };
    if (rule.family !== this.field.spec.family) return { ok: false, reason: 'invalid rule' };
    const old = p.patterns[index];
    if (sameRule(old.rule, rule)) return { ok: true, events: [] };
    if (p.patterns.some((q) => sameRule(q.rule, rule))) return { ok: false, reason: 'you already hold that pattern' };
    const ev: GameEvent[] = [];
    for (const path of p.paths.filter((q) => q.pattern === index)) this.dropPath(path, undefined, ev);
    const pattern: Pattern = { rule, table: chordTableFor(this.field, rule), color: old.color };
    p.patterns[index] = pattern;
    ev.push({ t: 'swap', id, index, pattern: patternPublic(pattern) });
    return { ok: true, events: ev };
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
        if (path.spawned) wire.spawned = true;
        if (path.back && path.status === 'growing') wire.back = true;
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
    if (!Number.isInteger(tile) || tile < 0 || tile >= this.field.count) {
      return { result: { ok: false, reason: 'no such tile' }, events: ev };
    }
    const heads = this.headLimit(p);
    const free = heads === 0 || this.headsInUse(p) < heads;
    const pattern = p.patterns[p.active] ?? p.patterns[0];
    const own = this.tapOwnLine(p, pattern, tile, at, free, ev);
    if (own !== null) return { result: { ok: true, path: own }, events: ev };
    if (!free) {
      return { result: { ok: false, reason: heads > 1 ? 'your lines are still growing' : 'your line is still growing' }, events: ev };
    }
    if (tileChords(this.field, pattern.table, tile).length === 0) {
      return {
        result: { ok: false, reason: p.active === 0 ? 'your rule draws no line on this tile' : 'that pattern draws no line on this tile' },
        events: ev,
      };
    }
    // Your lines block chords, not tiles: a tap on a tile one already runs
    // through starts on the nearest chord of it that none is on or crosses.
    // A tile a rival's line runs through is theirs — refused outright.
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
      wave: this.nextWave++,
    };
    p.paths.push(path);
    this.pathsById.set(path.id, path);
    this.addStep(p, path, startStep(this.field, pattern.table, tile, chord, exitEnd), ev);
    return { result: { ok: true, path: path.id }, events: ev };
  }

  /**
   * A tap on one of `p`'s own lines (the chord of it nearest `at`), by
   * the line's pattern:
   *  - one of another pattern (`flipOwnLines`) changes to `pattern`: the tile
   *    flips as if a newer line of it had arrived, and the flip burns on
   *    along the whole line — no head needed;
   *  - one of `pattern` that is stuck with somewhere to go behind its start
   *    turns round and grows from there (a line that ran off the edge, or into
   *    a tail);
   *  - one of `pattern` still growing starts growing from its start too, a
   *    second head (`Path.back`).
   * The last two take a head, so only when one is `free`. Returns the line's
   * id, or null when the tap is an ordinary one.
   */
  private tapOwnLine(p: Player, pattern: Pattern, tile: number, at: Pt, free: boolean, ev: GameEvent[]): number | null {
    const occ = this.occupancy.get(tile);
    if (!occ) return null;
    for (const q of [...occ].sort((x, y) => y.wave - x.wave)) {
      if (q.owner !== p.id) continue;
      const near = nearestChord(this.field, q.table, tile, at);
      if (!q.steps.some((s) => s.tile === tile && s.chord === near)) continue;
      if (!sameRule(q.rule, pattern.rule)) {
        if (!this.knobs.flipOwnLines) continue;
        this.recolor(p, q, pattern, tile, ev);
        return q.id;
      }
      if (!free || q.spawned || !this.canGrowBack(q)) continue;
      if (q.status === 'stuck') {
        this.turnRound(q, ev);
        return q.id;
      }
      if (q.status === 'growing' && !q.back) {
        this.setBack(q, true, ev);
        return q.id;
      }
    }
    return null;
  }

  /** Is there somewhere for `path` to grow behind its start (not back over itself)? */
  private canGrowBack(path: Path): boolean {
    const s = path.steps[0];
    return continuations(this.field, path.table, s.tile, s.chord, s.a).some(
      (o) => !path.steps.some((q) => q.tile === o.tile && q.chord === o.chord),
    );
  }

  /**
   * Change `path` (a line of `p`'s) to `pattern` from `tile` outward: a newer
   * wave of `pattern` wins the tile, the line loses its steps there and burns
   * on from the gap (`splitOff`), and `pattern` sprouts on the tile. The
   * line's points go to the first piece (zero-sum), or stay on it when
   * nothing could sprout.
   */
  private recolor(p: Player, path: Path, pattern: Pattern, tile: number, ev: GameEvent[]): void {
    const strain: Strain = { rule: pattern.rule, table: pattern.table, pattern: p.patterns.indexOf(pattern), wave: this.nextWave++ };
    const points = path.points;
    path.points = 0;
    const runs = this.splitOff(path, tile, ev, strain);
    const made = this.sprout(p, strain, [tile], ev);
    const heir = made.find((q) => this.pathsById.has(q.id)) ?? runs.find((q) => this.pathsById.has(q.id));
    if (heir) heir.points += points;
    else if (points > 0) this.addScore(p, -points, ev);
  }

  /**
   * The chord of `tile` nearest `at` that player `id` may start on with
   * `pattern`: none of their own lines on it or crossing it (with
   * `overlapOwnLines`, none of their lines of the same pattern on it, and none
   * of another pattern on the tile at all — unless `flipOwnLines`, when the
   * tap flips those), on a tile no rival's line passes through at all unless
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
      // A line of another of your patterns gets flipped by the tap.
      if (mine && this.knobs.flipOwnLines && !sameRule(other.rule, rule)) continue;
      if (mine && this.knobs.overlapOwnLines) {
        // Your lines of the same pattern block only the chord they are on;
        // one of another pattern keeps the whole tile.
        if (!sameRule(other.rule, rule)) return 'another of your patterns runs through this tile';
        if (other.steps.some((q) => q.tile === tile && sameSeg(seg, worldChord(this.field, other.table, tile, q.chord)))) {
          return "that's your own line";
        }
        continue;
      }
      if (!mine) {
        // A rival's line owns its whole tile: no chord of it is yours to start on.
        if (this.knobs.tapOntoOthers) continue;
        rival = true;
        continue;
      }
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
    const shared = this.knobs.flipPieceHeads > 0;
    for (const p of this.players.values()) {
      for (const path of [...p.paths]) {
        if (path.status !== 'growing' || (shared && path.spawned)) continue;
        path.progress += dtMs / stepIntervalMs(this.knobs, p.score, this.field.count);
        // Guard: a huge dt must not spin for thousands of steps in one tick.
        let budget = 256;
        while (path.progress >= 1 && path.status === 'growing' && budget-- > 0) {
          path.progress -= 1;
          this.advance(p, path, ev);
        }
        if (path.status !== 'growing') path.progress = 0;
        if (path.back && path.status === 'growing' && this.pathsById.has(path.id)) {
          path.backProgress = (path.backProgress ?? 0) + dtMs / stepIntervalMs(this.knobs, p.score, this.field.count);
          let backBudget = 256;
          while ((path.backProgress ?? 0) >= 1 && path.back && path.status === 'growing' && backBudget-- > 0) {
            path.backProgress! -= 1;
            this.advanceBack(p, path, ev);
          }
        }
      }
      if (shared) this.growPieces(p, dtMs, ev);
      // Flips travel at the owner's speed too: every burning line (and each
      // run it splits into, which inherits what is left of its progress) takes
      // as many steps as its progress allows.
      const step = dtMs / stepIntervalMs(this.knobs, p.score, this.field.count);
      for (const path of p.paths) if (path.burn) path.burn.progress += step;
      for (let budget = 256; budget > 0; budget--) {
        const ready = p.paths.filter((q) => q.burn && q.burn.progress >= 1);
        if (ready.length === 0) break;
        for (const path of ready) if (path.burn && this.pathsById.has(path.id)) this.burnOn(p, path, ev);
      }
      this.settle(p, ev);
    }
    return ev;
  }

  /**
   * A flip's pieces share `flipPieceHeads` heads' worth of growth between
   * them, taking turns — however many there are, a flip spreads outward at
   * the owner's speed rather than flooding the board. A piece whose head
   * would join a line already there, close or stop doesn't wait for its turn:
   * `settle` does it straight away and the turn is taken on credit.
   */
  private growPieces(p: Player, dtMs: number, ev: GameEvent[]): void {
    this.settle(p, ev);
    let pieces = p.paths.filter((q) => q.spawned && q.status === 'growing');
    if (pieces.length === 0) {
      // Nothing banked for the next flip, but a close's credit is still owed.
      p.pieceProgress = Math.min(p.pieceProgress, 0);
      return;
    }
    const heads = this.knobs.flipPieceHeads;
    p.pieceProgress = Math.min(p.pieceProgress + (heads * dtMs) / stepIntervalMs(this.knobs, p.score, this.field.count), 256);
    while (p.pieceProgress >= 1) {
      if (pieces.length === 0) {
        pieces = p.paths.filter((q) => q.spawned && q.status === 'growing');
        if (pieces.length === 0) break;
      }
      const path = pieces[p.pieceCursor++ % pieces.length];
      if (path.status === 'growing' && path.spawned && this.pathsById.has(path.id)) {
        p.pieceProgress -= 1;
        p.unsettled.push(this.advance(p, path, ev));
        this.settle(p, ev);
      }
      if (p.pieceCursor % pieces.length === 0) pieces = [];
    }
  }

  /**
   * Flip pieces laid next to lines of their own pattern are mostly done
   * before they start: the head's next chord is already drawn. Each queued
   * piece whose head has nothing new to lay (`peekHead`) takes that move now —
   * joins the line it abuts, closes, turns round or stops — until it needs a
   * new chord, so a finished piece never sits on the board as a live head
   * waiting for its turn. Each move still costs the turn it always did, taken
   * on credit — the pieces' next new chords wait for it — so a flip spreads
   * at the same pace; only the order changes.
   */
  private settle(p: Player, ev: GameEvent[]): void {
    for (let path = p.unsettled.pop(); path; path = p.unsettled.pop()) {
      // Each move folds a line away or ends a head, so this is short; the cap is a backstop.
      for (let guard = 0; guard < 1024; guard++) {
        if (!path.spawned || path.status !== 'growing' || !this.pathsById.has(path.id)) break;
        if (this.peekHead(p, path) === 'grow') break;
        p.pieceProgress -= 1;
        path = this.advance(p, path, ev);
      }
    }
  }

  /** Carry a flip one step along `path` (see `Path.burn`): a tile from each burning end. */
  private burnOn(p: Player, path: Path, ev: GameEvent[]): void {
    const burn = path.burn!;
    // A swapped-out pattern spreads no further.
    if (!p.patterns[burn.strain.pattern] || !sameRule(p.patterns[burn.strain.pattern].rule, burn.strain.rule)) {
      path.burn = undefined;
      return;
    }
    burn.progress -= 1;
    const tiles = new Set<number>();
    if (burn.start) tiles.add(path.steps[0].tile);
    if (burn.end) tiles.add(path.steps[path.steps.length - 1].tile);
    // Each end burns on in whichever run the split leaves it in.
    let live: Path[] = [path];
    for (const t of tiles) {
      const next: Path[] = [];
      for (const q of live) {
        if (!this.pathsById.has(q.id)) continue;
        if (q.steps.some((x) => x.tile === t)) next.push(...this.splitOff(q, t, ev, burn.strain));
        else next.push(q);
      }
      live = next;
      this.sprout(p, burn.strain, [t], ev);
    }
  }

  // --- internals -----------------------------------------------------------

  /**
   * One step from the start of a line growing both ways: turned round, the
   * start is the head, so it steps like any head (collisions, joins, circuits,
   * flips all as usual) and turns back. The client sees the same: `reverse`,
   * the step's events, `reverse`. If that head stops, `stop` has already
   * turned the line so its other head leads.
   */
  private advanceBack(p: Player, path: Path, ev: GameEvent[]): void {
    this.reverseSteps(path, ev);
    this.advance(p, path, ev);
    if (!this.pathsById.has(path.id) || !path.back) return;
    if (path.status === 'growing') this.reverseSteps(path, ev);
    else this.setBack(path, false, ev);
  }

  /** Run `path`'s steps the other way (a flip burning along it keeps its ends). */
  private reverseSteps(path: Path, ev: GameEvent[]): void {
    const turned = path.steps.map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })).reverse();
    path.steps.length = 0;
    path.steps.push(...turned);
    if (path.burn) path.burn = { ...path.burn, start: path.burn.end, end: path.burn.start };
    ev.push({ t: 'reverse', path: path.id });
  }

  private setBack(path: Path, on: boolean, ev: GameEvent[]): void {
    if (!!path.back === on) return;
    path.back = on || undefined;
    path.backProgress = 0;
    ev.push({ t: 'back', path: path.id, back: on });
  }

  /** One step of `path`'s head. Returns the line that carries on: `path`, or the one a join folded it into. */
  private advance(p: Player, path: Path, ev: GameEvent[]): Path {
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
        return path;
      }
    }
    if (out.kind === 'dead' && !path.back && this.joinBehind(p, path, ev)) return path;
    if (out.kind === 'dead' || out.kind === 'junction') {
      this.stop(path, ev);
      return path;
    }
    const s = out.step;
    const first = path.steps[0];
    if (s.tile === first.tile && s.chord === first.chord) {
      this.closeCircuit(p, path, ev);
      return path;
    }
    if (path.steps.some((q) => q.tile === s.tile && q.chord === s.chord)) {
      // Re-entered the middle of ourselves (only possible via a junction).
      this.stop(path, ev);
      return path;
    }
    const own = this.meetOwn(p, path, s);
    if (own === 'stop') {
      this.stop(path, ev);
      return path;
    }
    if (own) {
      const joined = this.join(p, path, own, ev);
      if (joined !== path) return joined;
    } else if (!this.addStep(p, path, s, ev)) return path; // died in a collision
    if (this.knobs.maxPathLength > 0 && path.steps.length >= this.knobs.maxPathLength) {
      this.setStatus(path, 'stuck', ev);
    }
    return path;
  }

  /**
   * What would `advance` do to `path`'s head, without doing it? 'grow' lays a
   * new step (or claims, or does something only `advance` should decide);
   * 'join' folds in a line of its own already on the board; 'close' closes
   * the line into a circuit; 'end' stops it (or turns a piece round). Only
   * 'grow' lays a new chord. A junction the random policy would pick through
   * counts as 'grow' (picking spends the rng).
   */
  private peekHead(p: Player, path: Path): 'grow' | 'join' | 'close' | 'end' {
    // (The kinds are for reading; `settle` only asks whether it is 'grow'.)
    const cur = path.steps[path.steps.length - 1];
    const options = continuations(this.field, path.table, cur.tile, cur.chord, cur.b);
    if (options.length === 0) {
      // Off the edge, a claim or a join behind is `advance`'s to make.
      const edge = onFieldBoundary(this.field, cur.tile, cur.b) && (this.startsAtEdge(path) || (!path.back && this.canTurn(path)));
      return edge ? 'grow' : 'end';
    }
    if (options.length > 1) return this.knobs.junctionPolicy === 'random' ? 'grow' : 'end';
    const o = options[0];
    const first = path.steps[0];
    if (o.tile === first.tile && o.chord === first.chord) return 'close';
    if (path.steps.some((q) => q.tile === o.tile && q.chord === o.chord)) return 'end';
    const seg = worldChord(this.field, path.table, o.tile, o.chord);
    const own = this.meetOwn(p, path, { tile: o.tile, chord: o.chord, a: seg[o.end], b: seg[1 - o.end] });
    return own === 'stop' ? 'end' : own ? 'join' : 'grow';
  }

  /**
   * The head of `path` can go no further. A flip's piece (`twoWay`) turns
   * round, once, to grow out of its other end; anything else is stuck.
   */
  private stop(path: Path, ev: GameEvent[]): void {
    // The other head carries on.
    if (path.back) {
      this.setBack(path, false, ev);
      this.turnRound(path, ev);
      return;
    }
    if (path.twoWay) {
      path.twoWay = false;
      const s = path.steps[0];
      const back = continuations(this.field, path.table, s.tile, s.chord, s.a);
      if (back.some((o) => !path.steps.some((q) => q.tile === o.tile && q.chord === o.chord))) {
        this.turnRound(path, ev);
        return;
      }
    }
    this.setStatus(path, 'stuck', ev);
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
      // Where two of your patterns meet, the step lands and one of them flips (`addStep`).
      if (this.knobs.flipOwnLines && !sameRule(other.rule, path.rule)) continue;
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
      // A flip's piece that reaches a line of its own pattern has nothing left
      // to flip that way: running on would only double the line.
      if (path.spawned && sameRule(other.rule, path.rule) && other.steps.some((q) => q.tile === s.tile && q.chord === s.chord)) {
        return 'stop';
      }
    }
    return null;
  }

  /**
   * Two of a player's lines meet end to end: `other` is folded into `path`
   * (its steps appended, its points carried over — nothing is scored twice) and
   * leaves the board. The joined line grows on from `other`'s far end, so two
   * lines that each ran off the edge become one edge-to-edge claim. Returns
   * the joined line: `path`, or — when both are a flip's pieces and `other` is
   * the longer — `other`, with `path` folded into it instead (the same line,
   * for far fewer events).
   */
  private join(p: Player, path: Path, meet: { other: Path; tail: WalkStep[] }, ev: GameEvent[]): Path {
    const { other, tail } = meet;
    if (path.spawned && other.spawned && other.steps.length > path.steps.length) return this.foldInto(p, path, meet, ev);
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
    return path;
  }

  /**
   * `join`, the other way round: the joined line is `path`'s steps then
   * `tail`, kept under `other`'s id. The client gets it as: reverse `other`
   * if `tail` runs its way, append `path` backwards, reverse back.
   */
  private foldInto(p: Player, path: Path, meet: { other: Path; tail: WalkStep[] }, ev: GameEvent[]): Path {
    const { other, tail } = meet;
    const forward = tail[0] === other.steps[0];
    const status = path.status;
    const progress = path.progress;
    const twoWay = path.twoWay;
    const moved = path.steps.slice();
    other.points += path.points;
    path.points = 0;
    this.dropPath(path, undefined, ev);
    if (forward) ev.push({ t: 'reverse', path: other.id });
    for (let i = moved.length - 1; i >= 0; i--) {
      const q = moved[i];
      ev.push({ t: 'step', path: other.id, owner: p.id, step: { tile: q.tile, chord: q.chord, a: q.b, b: q.a } });
      let occ = this.occupancy.get(q.tile);
      if (!occ) this.occupancy.set(q.tile, (occ = new Set()));
      occ.add(other);
    }
    ev.push({ t: 'reverse', path: other.id });
    other.steps.length = 0;
    other.steps.push(...moved, ...tail);
    other.status = status;
    other.progress = progress;
    other.twoWay = twoWay;
    other.wave = Math.max(other.wave, path.wave);
    if (status !== 'growing') ev.push({ t: 'status', path: other.id, status });
    return other;
  }

  /**
   * Extend `path` by one step. Returns false when the path can't grow on: the
   * step was a fatal collision, or it lost the tile to a newer pattern of its owner's.
   */
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
    if (this.knobs.flipOwnLines) this.flipTile(p, path, s.tile, ev);
    return path.status === 'growing' && this.pathsById.has(path.id);
  }

  /**
   * `path` just stepped onto `tile`. Every line of its owner's there of
   * another pattern meets it: the newest line (highest `wave`) wins the tile.
   * Each line of another pattern than the winner's loses its steps on the
   * tile (`splitOff`), its points going to the winner — nothing is lost or
   * scored twice — and the winner's pattern sprouts on the tile. Its pieces
   * grow into the losers' next tiles and flip those, so a flip travels.
   */
  private flipTile(p: Player, path: Path, tile: number, ev: GameEvent[]): void {
    const occ = this.occupancy.get(tile);
    if (!occ) return;
    const met = [...occ].filter((q) => q.owner === p.id && q !== path && !sameRule(q.rule, path.rule));
    if (met.length === 0) return;
    let winner = path;
    for (const q of met) if (q.wave > winner.wave) winner = q;
    for (const q of [path, ...met]) {
      if (sameRule(q.rule, winner.rule)) continue;
      winner.points += q.points;
      q.points = 0;
      this.splitOff(q, tile, ev, winner);
    }
    this.sprout(p, winner, [tile], ev);
  }

  /**
   * Take `path`'s steps on `tile` out of it. What is left splits into runs:
   * the first keeps the path's id, the rest become new lines of the same
   * owner, pattern and wave. A run that still ends at a growing head keeps
   * growing; the rest are stuck, and a closed loop opens (one run, wrapping
   * round). Nothing left: the path goes. Points stay where they are. Each
   * run end next to the gap burns on with `strain` (`Path.burn`); ends that
   * were already burning keep burning. Returns the runs.
   */
  private splitOff(path: Path, tile: number, ev: GameEvent[], strain: Strain): Path[] {
    const n = path.steps.length;
    const runs: { start: number; end: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (path.steps[i].tile === tile) continue;
      const last = runs[runs.length - 1];
      if (last && last.end === i) last.end++;
      else runs.push({ start: i, end: i + 1 });
    }
    if (runs.length === 1 && runs[0].start === 0 && runs[0].end === n) return [path];
    // A line growing both ways keeps whichever heads the gap missed; the
    // start's, if it survives, leads the first run (turned round below).
    const startAlive = !!path.back && path.status === 'growing' && runs.length > 0 && runs[0].start === 0;
    this.setBack(path, false, ev);
    if (runs.length === 0) {
      this.dropPath(path, undefined, ev);
      return [];
    }
    const closed = path.status === 'closed';
    // A loop opens by wrapping round; an edge-to-edge claim is closed but its
    // ends are on the field's edge, not joined.
    const loop = closed && !path.region;
    if (runs.length === 1 && !loop) {
      const run = this.trimEnds(path, tile, runs[0], strain, ev);
      if (startAlive && run.status !== 'growing') this.turnRound(run, ev);
      return [run];
    }
    if (loop && runs.length > 1 && runs[0].start === 0 && runs[runs.length - 1].end === n) {
      const first = runs.shift()!;
      runs[runs.length - 1].end = n + first.end;
    }
    const old = path.steps.slice();
    const head = (r: { end: number }) => !closed && path.status === 'growing' && r.end === n;
    for (const q of old) {
      const occ = this.occupancy.get(q.tile);
      if (!occ) continue;
      occ.delete(path);
      if (occ.size === 0) this.occupancy.delete(q.tile);
    }
    const owner = this.players.get(path.owner);
    const wire: { id: number; start: number; end: number; status: PathStatus }[] = [];
    const was = path.burn;
    // The newer of the two flips carries on along the whole line.
    const carry = was && was.strain.wave > strain.wave ? was.strain : strain;
    const out: Path[] = [];
    runs.forEach((r, k) => {
      const status: PathStatus = head(r) ? 'growing' : 'stuck';
      let q = path;
      if (k > 0) {
        q = {
          id: this.nextPathId++,
          owner: path.owner,
          status,
          steps: [],
          progress: 0,
          points: 0,
          rule: path.rule,
          table: path.table,
          pattern: path.pattern,
          spawned: path.spawned,
          twoWay: path.twoWay,
          wave: path.wave,
        };
        owner?.paths.push(q);
        this.pathsById.set(q.id, q);
      }
      q.steps.length = 0;
      for (let i = r.start; i < r.end; i++) q.steps.push(old[i % n]);
      if (status !== 'growing') {
        q.progress = 0;
        q.twoWay = false;
      }
      q.status = status;
      for (const st of q.steps) {
        let occ = this.occupancy.get(st.tile);
        if (!occ) this.occupancy.set(st.tile, (occ = new Set()));
        occ.add(q);
      }
      // An end burns when the gap is right behind it, or when it burned already.
      const start = loop || r.start > 0 || !!was?.start;
      const end = loop || r.end < n || !!was?.end;
      q.burn = { strain: carry, start, end, progress: was?.progress ?? 0 };
      if (q.spawned && status === 'growing') owner?.unsettled.push(q);
      out.push(q);
      wire.push({ id: q.id, start: r.start, end: r.end, status });
    });
    path.region = undefined;
    ev.push({ t: 'split', path: path.id, runs: wire });
    if (startAlive) this.turnRound(out[0], ev);
    return out;
  }

  /**
   * `splitOff` when the tile only held the line's ends (a flip burning in from
   * them, the usual case): drop those steps in place instead of rebuilding.
   */
  private trimEnds(path: Path, tile: number, run: { start: number; end: number }, strain: Strain, ev: GameEvent[]): Path {
    const n = path.steps.length;
    const was = path.burn;
    const growing = path.status === 'growing' && run.end === n;
    path.steps.splice(run.end);
    path.steps.splice(0, run.start);
    path.region = undefined;
    if (!path.steps.some((q) => q.tile === tile)) {
      const occ = this.occupancy.get(tile);
      if (occ) {
        occ.delete(path);
        if (occ.size === 0) this.occupancy.delete(tile);
      }
    }
    const status: PathStatus = growing ? 'growing' : 'stuck';
    if (!growing) {
      path.progress = 0;
      path.twoWay = false;
    }
    path.status = status;
    path.burn = {
      strain: was && was.strain.wave > strain.wave ? was.strain : strain,
      start: run.start > 0 || !!was?.start,
      end: run.end < n || !!was?.end,
      progress: was?.progress ?? 0,
    };
    ev.push({ t: 'split', path: path.id, runs: [{ id: path.id, start: run.start, end: run.end, status }] });
    if (path.spawned && growing) this.players.get(path.owner)?.unsettled.push(path);
    return path;
  }

  /**
   * Redraw flipped `tiles` with `path`'s pattern: each of their chords that
   * no line is on or meets, strung into runs along the strand. Each run
   * becomes a line of `p`'s (same pattern and wave as `path`) that grows
   * outward from both ends (a run that already closes is a circuit on the
   * spot). Placing them scores nothing — the tiles were already paid for.
   * Returns the lines it made.
   */
  private sprout(p: Player, path: Strain, tiles: readonly number[], ev: GameEvent[]): Path[] {
    const { field } = this;
    const table = path.table;
    const key = (t: number, c: number): number => t * 64 + c;
    const free = new Set<number>();
    for (const tile of tiles) {
      tileChords(field, table, tile).forEach((_, c) => {
        if (!this.sproutBlocked(p, path.rule, tile, worldChord(field, table, tile, c))) free.add(key(tile, c));
      });
    }
    const made: Path[] = [];
    const used = new Set<number>();
    const next = (cur: WalkStep): WalkStep | ChordEnd | null => {
      const o = continuations(field, table, cur.tile, cur.chord, cur.b).find((e) => free.has(key(e.tile, e.chord)));
      if (!o) return null;
      if (used.has(key(o.tile, o.chord))) return o;
      used.add(key(o.tile, o.chord));
      const seg = worldChord(field, table, o.tile, o.chord);
      return { tile: o.tile, chord: o.chord, a: seg[o.end], b: seg[1 - o.end] };
    };
    const isStep = (x: WalkStep | ChordEnd): x is WalkStep => 'a' in x;
    for (const k of free) {
      if (used.has(k)) continue;
      used.add(k);
      const seed = startStep(field, table, Math.floor(k / 64), k % 64, 1);
      const fwd: WalkStep[] = [seed];
      let closed = false;
      for (;;) {
        const n = next(fwd[fwd.length - 1]);
        if (!n) break;
        if (!isStep(n)) {
          closed = key(n.tile, n.chord) === k;
          break;
        }
        fwd.push(n);
      }
      const back: WalkStep[] = [];
      if (!closed) {
        let cur: WalkStep = { tile: seed.tile, chord: seed.chord, a: seed.b, b: seed.a };
        for (;;) {
          const n = next(cur);
          if (!n || !isStep(n)) break;
          back.push(n);
          cur = n;
        }
      }
      const steps = [...back.reverse().map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })), ...fwd];
      const piece: Path = {
        id: this.nextPathId++,
        owner: p.id,
        status: 'growing',
        steps: [],
        progress: 0,
        points: 0,
        rule: path.rule,
        table,
        pattern: path.pattern,
        spawned: true,
        twoWay: !closed,
        wave: path.wave,
      };
      p.paths.push(piece);
      this.pathsById.set(piece.id, piece);
      made.push(piece);
      for (const q of steps) {
        ev.push(this.stepEvent(p, piece, q));
        piece.steps.push(q);
        let occ = this.occupancy.get(q.tile);
        if (!occ) {
          occ = new Set();
          this.occupancy.set(q.tile, occ);
        }
        occ.add(piece);
      }
      if (closed) this.closeCircuit(p, piece, ev);
      else p.unsettled.push(piece);
    }
    return made;
  }

  /** May a flip's piece be laid on segment `seg` of `tile`? Not over or across any line. */
  private sproutBlocked(p: Player, rule: PlayerRule, tile: number, seg: Segment): boolean {
    const occ = this.occupancy.get(tile);
    if (!occ) return false;
    for (const other of occ) {
      if (other.owner === p.id) {
        // One pattern's chords never cross each other; another's keeps its tile.
        if (!sameRule(other.rule, rule)) return true;
        if (other.steps.some((q) => q.tile === tile && sameSeg(seg, worldChord(this.field, other.table, tile, q.chord)))) return true;
      } else if (this.pathMeets(other, tile, seg)) {
        return true;
      }
    }
    return false;
  }

  /** A path's step event; the first one says which pattern drew it. */
  private stepEvent(p: Player, path: Path, s: WalkStep): GameEvent {
    const e: { -readonly [K in keyof Extract<GameEvent, { t: 'step' }>]: Extract<GameEvent, { t: 'step' }>[K] } = {
      t: 'step',
      path: path.id,
      owner: p.id,
      step: s,
    };
    if (path.steps.length === 0) {
      if (path.pattern !== 0) e.pattern = path.pattern;
      if (path.spawned) e.spawned = true;
    }
    return e;
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
    this.reverseSteps(path, ev);
    path.status = 'growing';
    path.progress = 0;
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
    this.setBack(path, false, ev);
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
        // A conversion's pieces can close circuits of their own and take lines mid-loop.
        if (other.steps.length === 0 || other.owner !== rival.id || !this.pathsById.has(other.id)) continue;
        const enclosed = other.steps.every((s) => inside({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }));
        if (!enclosed) continue;
        if (k.mode === 'normal') {
          this.convertPath(other, rival, p, ev);
          continue;
        }
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

  /**
   * Normal mode: `to` closed a circuit round `from`'s `path`. A new kind of
   * line earns `to` a head (`converted`, capped like captured patterns); with
   * `takeEnclosed` the line itself turns into `to`'s own pattern: it leaves
   * the board (its points leave `from`), and `to`'s rule sprouts on its tiles
   * as pieces that carry those points and grow on like a flip's.
   */
  private convertPath(path: Path, from: Player, to: Player, ev: GameEvent[]): void {
    const k = this.knobs;
    const own = sameRule(path.rule, to.rule);
    const cap = k.maxCapturedPatterns;
    if (
      k.captureOnEnclose &&
      !own &&
      !to.converted.some((r) => sameRule(r, path.rule)) &&
      !(cap > 0 && to.converted.length >= cap)
    ) {
      to.converted.push(path.rule);
    }
    ev.push({ t: 'convert', id: to.id, from: from.id, converted: to.converted.length });
    if (!k.takeEnclosed) return;
    // Already your pattern: nothing to convert, the line just changes hands.
    if (own) {
      this.takePath(path, from, to, 0, ev);
      return;
    }
    const tiles = [...new Set(path.steps.map((q) => q.tile))];
    const points = path.points;
    this.dropPath(path, undefined, ev);
    const mine = to.patterns[0];
    const pieces = this.sprout(to, { rule: mine.rule, table: mine.table, pattern: 0, wave: this.nextWave++ }, tiles, ev);
    const holder = pieces.find((q) => this.pathsById.has(q.id) && q.owner === to.id);
    if (holder && points > 0) {
      holder.points += points;
      this.addScore(to, points, ev);
    }
  }

  /** Hand `path` from `from` to `to`, drawn with `to`'s pattern `index`; its points go with it. */
  private takePath(path: Path, from: Player, to: Player, index: number, ev: GameEvent[]): void {
    const i = from.paths.indexOf(path);
    if (i >= 0) from.paths.splice(i, 1);
    to.paths.push(path);
    path.owner = to.id;
    path.pattern = index;
    path.burn = undefined;
    ev.push({ t: 'take', path: path.id, from: from.id, owner: to.id, pattern: index });
    if (path.points > 0) {
      this.addScore(from, -path.points, ev);
      this.addScore(to, path.points, ev);
    }
  }

  private setStatus(path: Path, status: PathStatus, ev: GameEvent[]): void {
    if (path.status === status) return;
    if (status !== 'growing') this.setBack(path, false, ev);
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
    if (p && by !== undefined && path.status === 'growing' && !path.spawned) p.respawnAt = this.now + this.knobs.respawnDelayMs;
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
