/**
 * Client-side mirror of the arena. Applies the server's event stream to plain
 * mutable structures the canvas renderer reads directly every frame, and bumps
 * a version counter so React HUD components can subscribe cheaply.
 */

import { buildField, tileCenter, type Field } from '../../shared/game/field';
import { headLimit, type Knobs } from '../../shared/game/knobs';
import { chordTableFor, stepForward, type ChordTable } from '../../shared/game/strand';
import type { PlayerRule } from '../../shared/game/rule';
import { nextStep, unpackPaths, unpackStep } from '../../shared/game/wire';
import type { Pt } from '../../shared/tiles';
import type { GameEvent, PathStatus, PathStepWire, PatternPublic, PlayerPublic, RoomSummary, ServerMessage } from '../../shared/game/protocol';

export interface ClientPath {
  readonly id: number;
  /** Changes hands on a `take`. */
  owner: string;
  status: PathStatus;
  readonly steps: PathStepWire[];
  /** An edge-to-edge line's claimed region, once closed (else the loop is its own polygon). */
  region?: readonly Pt[];
  /** Which of the owner's patterns drew it (0 = their own rule). */
  pattern: number;
  /** Grown out of a flip: it doesn't take up a head. */
  spawned?: boolean;
  /** Growing from its start too: a second head. */
  back?: boolean;
  /** Its rule's chords, fixed when it began: a `grow` event's steps are worked out with them. */
  table?: ChordTable;
}

export interface ClientPlayer extends Omit<PlayerPublic, 'score' | 'combo' | 'rule' | 'patterns' | 'active' | 'converted'> {
  rule: PlayerPublic['rule'];
  /** Normal mode: kinds of rival line converted (a head each). */
  converted: number;
  score: number;
  combo: number;
  patterns: PatternPublic[];
  active: number;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: 'good' | 'bad' | 'info';
  readonly at: number;
}

/** A line cut in a collision, fading off the board (the renderer drops it when done). */
export interface Dying {
  readonly path: ClientPath;
  readonly color: string;
  readonly mine: boolean;
  readonly born: number;
}

/** A little spray of sparks where a collision happened, in the cut line's colour. */
export interface Burst {
  readonly at: Pt;
  readonly color: string;
  /** The cut line was yours (for team colours). */
  readonly mine: boolean;
  readonly seed: number;
  readonly born: number;
}

/**
 * A player switched rule: every tile their old lines were on sends a mote to
 * the nearest tile the new rule's lines start on (`to`; null: nothing
 * survived, it fades where it is). The renderer plays and prunes them.
 */
export interface Coalesce {
  readonly owner: string;
  readonly color: string;
  readonly mine: boolean;
  readonly born: number;
  readonly from: readonly Pt[];
  readonly to: readonly (Pt | null)[];
  /**
   * What the switch bought, whole: each circuit or line the new rule will
   * regrow into (`kind` 1 a loop, 2 an edge-to-edge claim, 0 a line that
   * stops short), for a brief pulse of the end state.
   */
  readonly ghost: readonly Ghost[];
}

export interface Ghost {
  readonly pts: readonly Pt[];
  readonly kind: number;
}

/** At most this many motes per switch (a huge territory is sampled evenly). */
const MAX_MOTES = 1500;

/**
 * How many of `n` motes each target takes: `share` is each one's fraction of
 * the budget the old tiles held. They add up to what the budget bought —
 * short of 1 when some of it was lost, and those motes go nowhere; past 1
 * (a stretch) every mote is taken. Largest remainders round it off.
 */
export function motesPerTile(share: readonly number[], n: number): number[] {
  const total = share.reduce((a, b) => a + b, 0);
  if (total <= 0 || n === 0) return share.map(() => 0);
  const spent = Math.round(n * Math.min(1, total));
  const exact = share.map((w) => (w / total) * spent);
  const cap = exact.map(Math.floor);
  let left = spent - cap.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) cap[order[k][1]]++;
  return cap;
}

/** The `rule` event's `outline`, walked out with the new rule into the points of each circuit or line. */
export function walkOutline(field: Field, rule: PlayerRule, outline: readonly number[]): Ghost[] {
  const table = chordTableFor(field, rule);
  const out: Ghost[] = [];
  for (let k = 0; k + 2 < outline.length; k += 3) {
    let cur = unpackStep(field, table, outline[k]);
    const pts: Pt[] = [cur.a];
    for (let n = 1; n < outline[k + 1]; n++) {
      const next = stepForward(field, table, cur);
      if (next.kind !== 'step') break;
      pts.push(next.step.a);
      cur = next.step;
    }
    pts.push(cur.b);
    out.push({ pts, kind: outline[k + 2] });
  }
  return out;
}

/**
 * Send each mote (`from`) to a target with room left (`cap`), nearest pairs
 * first — a greedy transport, so the flow looks local — and whatever finds no
 * room nowhere (null).
 */
export function flow(from: readonly Pt[], to: readonly Pt[], cap: readonly number[]): (Pt | null)[] {
  const room = [...cap];
  const out: (Pt | null)[] = from.map(() => null);
  const d = (i: number, j: number): number => (from[i].x - to[j].x) ** 2 + (from[i].y - to[j].y) ** 2;
  // Each mote's nearest few targets, all the candidate pairs sorted by distance.
  const K = Math.min(to.length, 8);
  const pairs: [number, number, number][] = [];
  for (let i = 0; i < from.length; i++) {
    const near = to.map((_, j) => j).sort((a, b) => d(i, a) - d(i, b)).slice(0, K);
    for (const j of near) pairs.push([d(i, j), i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const done = new Set<number>();
  for (const [, i, j] of pairs) {
    if (done.has(i) || room[j] <= 0) continue;
    out[i] = to[j];
    room[j]--;
    done.add(i);
  }
  // Motes whose nearest few filled up take the nearest target with room anywhere.
  for (let i = 0; i < from.length; i++) {
    if (done.has(i)) continue;
    let best = -1;
    for (let j = 0; j < to.length; j++) if (room[j] > 0 && (best < 0 || d(i, j) < d(i, best))) best = j;
    if (best < 0) break;
    out[i] = to[best];
    room[best]--;
    done.add(i);
  }
  return out;
}

export type Listener = () => void;

export class Store {
  field: Field | null = null;
  knobs: Knobs | null = null;
  you = '';
  /** The server room we were put in (online), e.g. "normal-2". */
  room = '';
  /** Resume ticket from the last `welcome` (online only). */
  resume: { id: string; token: string } | null = null;
  /**
   * The most recent `error` from the server, a fresh object every time (even
   * a repeat of the same text) so a `useEffect` keyed on it fires again.
   * Cleared on a successful `welcome`.
   */
  lastError: { message: string; code?: 'full' } | null = null;
  readonly players = new Map<string, ClientPlayer>();
  readonly paths = new Map<number, ClientPath>();
  /** tile → paths on it (for the faded-tile render). */
  readonly occupancy = new Map<number, Set<ClientPath>>();
  toasts: Toast[] = [];
  /** Collision after-effects, in `performance.now()` time; the renderer prunes them. */
  dying: Dying[] = [];
  bursts: Burst[] = [];
  coalesce: Coalesce[] = [];
  /** The arena's camera when it was last left for the rule screen (`fieldKey` of its field). */
  lastCamera: { field: string; camera: { x: number; y: number; scale: number } } | null = null;
  /** Within one batch of events: tiles of lines wiped without a cutter, per owner… */
  private readonly batchWipes = new Map<string, Set<number>>();
  /** …and, for each player whose rule changed, the tiles their new lines start on. */
  private readonly switched = new Map<string, Set<number>>();
  /** …and how much energy each of those tiles takes in (the `rule` event's `absorb`). */
  private readonly absorb = new Map<string, Map<number, number>>();
  /** …and the end state it grows towards (the `rule` event's `outline`, walked out). */
  private readonly ghosts = new Map<string, Ghost[]>();
  connected = false;
  version = 0;
  /** Bumped whenever geometry changed (paths), for the renderer's dirty flag. */
  geometryVersion = 0;
  /**
   * Bumped when any tile's tint may have changed without its tile being
   * touched (players came or went, patterns changed, a new board): the
   * renderer re-tints everything. Otherwise it re-tints the touched tiles.
   */
  tintsVersion = 0;
  /** Bumped when the closed lines changed — one closed, opened, went or changed hands: the washes. */
  closedVersion = 0;
  /** Each watcher's tiles touched since it last looked (see `watchTiles`). */
  private readonly tileSinks = new Set<Set<number>>();
  private nextToast = 1;
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /**
   * A set the store adds every tile to whose lines changed; the watcher
   * empties it as it catches up. A busy board changes a few hundred tiles a
   * tick out of a hundred thousand drawn on, so the tints follow these.
   */
  watchTiles(): Set<number> {
    const sink = new Set<number>();
    this.tileSinks.add(sink);
    return sink;
  }

  unwatchTiles(sink: Set<number>): void {
    this.tileSinks.delete(sink);
  }

  private touch(tile: number): void {
    for (const sink of this.tileSinks) sink.add(tile);
  }

  /** Every tile of `path` may look different (its owner, pattern or status changed). */
  private touchPath(path: ClientPath): void {
    for (const s of path.steps) this.touch(s.tile);
    if (path.status === 'closed') this.closedVersion++;
  }

  /** Everything may look different. */
  private touchAll(): void {
    this.tintsVersion++;
    this.closedVersion++;
  }

  get me(): ClientPlayer | undefined {
    return this.players.get(this.you);
  }

  /** The colour a path draws in: its pattern's, which for a player's own rule is theirs. */
  pathColor(path: ClientPath): string | undefined {
    const owner = this.players.get(path.owner);
    if (!owner) return undefined;
    return owner.patterns[path.pattern]?.color ?? owner.color;
  }

  myPaths(): ClientPath[] {
    return [...this.paths.values()].filter((p) => p.owner === this.you);
  }

  /** The chords of `owner`'s pattern `pattern` — what a line of it is drawn with. */
  private tableFor(owner: string, pattern: number): ChordTable | undefined {
    const rule = this.players.get(owner)?.patterns[pattern]?.rule;
    return rule && this.field ? chordTableFor(this.field, rule) : undefined;
  }

  /** Refusals before this time (ms) go unshown: a drag taps every tile it crosses. */
  quietRefusalsUntil = 0;

  /**
   * Your heads: how many more lines you could start now (`free`) out of the
   * engine's `headLimit` (`total`; 0 = unlimited, `free` then Infinity).
   */
  heads(): { free: number; total: number } {
    const k = this.knobs;
    const me = this.me;
    if (!k || !me) return { free: 0, total: 0 };
    const total = headLimit(k, me.patterns.length + me.converted);
    if (total === 0) return { free: Infinity, total };
    let growing = 0;
    for (const p of this.paths.values()) if (p.owner === this.you && p.status === 'growing' && !p.spawned) growing += p.back ? 2 : 1;
    return { free: Math.max(0, total - growing), total };
  }

  /**
   * Whether a tap now could start a line as far as heads go. The server still
   * decides; this only keeps a drag from sending taps it would refuse.
   */
  hasFreeHead(): boolean {
    return this.heads().free > 0;
  }

  /** At most two at once; a repeat of one still showing just refreshes it. */
  toast(text: string, tone: Toast['tone'] = 'info'): void {
    const rest = this.toasts.filter((t) => t.text !== text);
    this.toasts = [...rest.slice(-1), { id: this.nextToast++, text, tone, at: Date.now() }];
    this.emit();
  }

  pruneToasts(maxAgeMs = 2500): void {
    const cut = Date.now() - maxAgeMs;
    const keep = this.toasts.filter((t) => t.at > cut);
    if (keep.length !== this.toasts.length) {
      this.toasts = keep;
      this.emit();
    }
  }

  reset(): void {
    this.players.clear();
    this.paths.clear();
    this.occupancy.clear();
    this.dying = [];
    this.bursts = [];
    this.you = '';
    this.room = '';
    this.resume = null;
    this.lastError = null;
    this.geometryVersion++;
    this.touchAll();
    this.emit();
  }

  /** Arena description from `hello`, available before joining. */
  hello: { field: import('../../shared/game/field').FieldSpec; tiles: number; players: number; rooms: readonly RoomSummary[] } | null = null;

  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello': {
        this.hello = { field: msg.field, tiles: msg.tiles, players: msg.players, rooms: msg.rooms ?? [] };
        this.knobs = msg.knobs;
        if (!this.field || this.field.spec.family !== msg.field.family || this.field.spec.level !== msg.field.level || this.field.spec.rootTile !== msg.field.rootTile) {
          this.field = buildField(msg.field);
        }
        this.emit();
        return;
      }
      case 'welcome': {
        this.players.clear();
        this.paths.clear();
        this.occupancy.clear();
        this.dying = [];
        this.bursts = [];
        this.coalesce = [];
        // A new session (or a resume) starts from the whole field, not a view kept from before.
        if (msg.you !== this.you) this.lastCamera = null;
        this.you = msg.you;
        this.resume = { id: msg.you, token: msg.token };
        this.room = msg.room ?? '';
        this.lastError = null;
        this.knobs = msg.knobs;
        if (!this.field || this.field.spec.family !== msg.field.family || this.field.spec.level !== msg.field.level || this.field.spec.rootTile !== msg.field.rootTile) {
          this.field = buildField(msg.field);
        }
        for (const p of msg.players) this.players.set(p.id, clientPlayer(p));
        for (const pw of msg.packed ? unpackPaths(this.field, msg.packed) : msg.paths) {
          const path: ClientPath = { id: pw.id, owner: pw.owner, status: pw.status, steps: [...pw.steps], pattern: pw.pattern ?? 0 };
          path.table = this.tableFor(path.owner, path.pattern);
          if (pw.region) path.region = pw.region;
          if (pw.spawned) path.spawned = true;
          if (pw.back) path.back = true;
          this.paths.set(path.id, path);
          for (const s of path.steps) this.occupy(s.tile, path);
        }
        this.geometryVersion++;
        this.touchAll();
        this.emit();
        return;
      }
      case 'events':
        this.batchWipes.clear();
        this.switched.clear();
        this.absorb.clear();
        this.ghosts.clear();
        for (const ev of msg.ev) this.apply(ev);
        this.coalesceSwitches();
        this.emit();
        return;
      case 'error':
        this.lastError = { message: msg.message, code: msg.code };
        this.toast(msg.message, 'bad'); // toast() emits, so this reaches subscribers too
        return;
      case 'pong':
        return;
    }
  }

  /**
   * A rule change arrives as one batch: the old lines' wipes, the `rule`, then
   * the steps of whatever regrows on the tiles they held. Each old tile's
   * energy is a mote, and the motes flow to the tiles the new lines start on
   * in proportion to what each takes in (`absorb`: the budget its circuits
   * cost) — nearest first, each tile taking its share, a tile that carries
   * on keeping its own. Energy the budget couldn't spend fades where it was.
   */
  private coalesceSwitches(): void {
    const field = this.field;
    if (!field || this.switched.size === 0) return;
    for (const [id, targets] of this.switched) {
      const sources = this.batchWipes.get(id) ?? new Set<number>();
      const p = this.players.get(id);
      const ghost = this.ghosts.get(id) ?? [];
      if (!p || (sources.size === 0 && ghost.length === 0)) continue;
      let src = [...sources];
      if (src.length > MAX_MOTES) {
        const stride = src.length / MAX_MOTES;
        src = Array.from({ length: MAX_MOTES }, (_, k) => src[Math.floor(k * stride)]);
      }
      const weights = this.absorb.get(id);
      const dst = [...targets];
      // No shares (a server without them): an even split, all of it taken.
      const share = dst.map((t) => (weights ? weights.get(t) ?? 0 : 1 / dst.length));
      const cap = motesPerTile(share, src.length);
      const from = src.map((t) => tileCenter(field, t));
      const to = flow(from, dst.map((t) => tileCenter(field, t)), cap);
      this.coalesce.push({ owner: id, color: p.color, mine: id === this.you, born: performance.now(), from, to, ghost });
    }
  }

  private occupy(tile: number, path: ClientPath): void {
    let set = this.occupancy.get(tile);
    if (!set) {
      set = new Set();
      this.occupancy.set(tile, set);
    }
    set.add(path);
    this.touch(tile);
  }

  private unoccupy(path: ClientPath): void {
    if (path.status === 'closed') this.closedVersion++;
    for (const s of path.steps) {
      this.touch(s.tile);
      const set = this.occupancy.get(s.tile);
      if (set) {
        set.delete(path);
        if (set.size === 0) this.occupancy.delete(s.tile);
      }
    }
  }

  private apply(ev: GameEvent): void {
    switch (ev.t) {
      case 'join':
        this.players.set(ev.player.id, clientPlayer(ev.player));
        this.touchAll();
        return;
      case 'leave':
        this.players.delete(ev.id);
        this.touchAll();
        return;
      case 'rule': {
        const p = this.players.get(ev.id);
        if (p) {
          p.rule = ev.rule;
          p.score = ev.score;
          p.combo = ev.combo;
          p.patterns = [{ rule: ev.rule, color: p.color }];
          p.active = 0;
          p.converted = 0;
          this.switched.set(ev.id, new Set());
          if (ev.outline && this.field) this.ghosts.set(ev.id, walkOutline(this.field, ev.rule, ev.outline));
          if (ev.absorb) {
            const w = new Map<number, number>();
            for (let k = 0; k + 1 < ev.absorb.length; k += 2) w.set(ev.absorb[k], ev.absorb[k + 1]);
            this.absorb.set(ev.id, w);
          }
        }
        this.touchAll();
        return;
      }
      case 'capture': {
        const p = this.players.get(ev.id);
        if (p) p.patterns = [...p.patterns, ev.pattern];
        this.touchAll();
        if (ev.id === this.you) this.toast(`Took ${ev.pattern.fromName || 'someone'}'s pattern`, 'good');
        else if (ev.pattern.from === this.you) this.toast(`${p?.name ?? 'Someone'} took your pattern`, 'bad');
        this.geometryVersion++;
        return;
      }
      case 'convert': {
        const p = this.players.get(ev.id);
        if (p) p.converted = ev.converted;
        if (ev.id === this.you) this.toast(`Converted ${this.players.get(ev.from)?.name ?? 'someone'}'s lines`, 'good');
        else if (ev.from === this.you) this.toast(`${p?.name ?? 'Someone'} converted your lines`, 'bad');
        return;
      }
      case 'swap': {
        const p = this.players.get(ev.id);
        if (p && ev.index > 0 && ev.index < p.patterns.length) {
          p.patterns = p.patterns.map((q, i) => (i === ev.index ? ev.pattern : q));
        }
        this.touchAll();
        if (ev.id === this.you) this.toast('Pattern swapped — its lines are gone', 'info');
        this.geometryVersion++;
        return;
      }
      case 'take': {
        const path = this.paths.get(ev.path);
        if (path) {
          path.owner = ev.owner;
          path.pattern = ev.pattern;
          this.touchPath(path);
        }
        if (ev.owner === this.you) this.toast(`Took ${this.players.get(ev.from)?.name ?? 'someone'}'s lines`, 'good');
        else if (ev.from === this.you) this.toast(`${this.players.get(ev.owner)?.name ?? 'Someone'} took your lines`, 'bad');
        this.geometryVersion++;
        return;
      }
      case 'active': {
        const p = this.players.get(ev.id);
        if (p) p.active = ev.active;
        if (ev.id === this.you) this.geometryVersion++;
        return;
      }
      case 'step': {
        let path = this.paths.get(ev.path);
        if (!path) {
          path = { id: ev.path, owner: ev.owner, status: 'growing', steps: [], pattern: ev.pattern ?? 0 };
          if (ev.spawned) path.spawned = true;
          path.table = this.tableFor(path.owner, path.pattern);
          this.paths.set(path.id, path);
        }
        path.steps.push(ev.step);
        this.occupy(ev.step.tile, path);
        this.switched.get(ev.owner)?.add(ev.step.tile);
        this.geometryVersion++;
        return;
      }
      case 'begin': {
        const table = this.tableFor(ev.owner, ev.pattern ?? 0);
        if (!table || !this.field) return;
        const path: ClientPath = { id: ev.path, owner: ev.owner, status: 'growing', steps: [], pattern: ev.pattern ?? 0, table };
        if (ev.spawned) path.spawned = true;
        this.paths.set(path.id, path);
        const step = unpackStep(this.field, table, ev.first);
        path.steps.push(step);
        this.occupy(step.tile, path);
        this.switched.get(ev.owner)?.add(step.tile);
        this.geometryVersion++;
        return;
      }
      case 'grow': {
        const path = this.paths.get(ev.path);
        if (!path?.table || !this.field || path.steps.length === 0) return;
        for (let k = 0; k < ev.n; k++) {
          const step = nextStep(this.field, path.table, path.steps[path.steps.length - 1], path.id);
          if (!step) break;
          path.steps.push(step);
          this.occupy(step.tile, path);
          this.switched.get(path.owner)?.add(step.tile);
        }
        this.geometryVersion++;
        return;
      }
      case 'status': {
        const path = this.paths.get(ev.path);
        if (path) {
          if ((path.status === 'closed') !== (ev.status === 'closed')) this.touchPath(path);
          path.status = ev.status;
        }
        this.geometryVersion++;
        return;
      }
      case 'split': {
        const path = this.paths.get(ev.path);
        if (path) {
          this.unoccupy(path);
          this.paths.delete(path.id);
          const n = path.steps.length;
          for (const r of ev.runs) {
            const steps: PathStepWire[] = [];
            for (let i = r.start; i < r.end; i++) steps.push(path.steps[i % n]);
            const run: ClientPath = { id: r.id, owner: path.owner, status: r.status, steps, pattern: path.pattern, table: path.table };
            if (path.spawned) run.spawned = true;
            this.paths.set(run.id, run);
            for (const s of steps) this.occupy(s.tile, run);
          }
        }
        this.geometryVersion++;
        return;
      }
      case 'back': {
        const path = this.paths.get(ev.path);
        if (path) path.back = ev.back || undefined;
        this.geometryVersion++;
        return;
      }
      case 'reverse': {
        const path = this.paths.get(ev.path);
        if (path) {
          const turned = path.steps.map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })).reverse();
          path.steps.length = 0;
          path.steps.push(...turned);
          if (path.status === 'closed') this.touchPath(path);
          path.status = 'growing';
        }
        this.geometryVersion++;
        return;
      }
      case 'wipe': {
        const path = this.paths.get(ev.path);
        if (path && ev.by !== undefined) {
          // Cut: the line goes kaput where it was hit and fades out, rather than blinking away.
          const color = this.pathColor(path);
          const born = performance.now();
          if (color) {
            this.dying.push({ path, color, mine: path.owner === this.you, born });
            if (ev.at) this.bursts.push({ at: ev.at, color, mine: path.owner === this.you, seed: path.id, born });
          }
        }
        if (path) {
          if (ev.by === undefined) {
            let tiles = this.batchWipes.get(path.owner);
            if (!tiles) this.batchWipes.set(path.owner, (tiles = new Set()));
            for (const s of path.steps) tiles.add(s.tile);
          }
          this.paths.delete(ev.path);
          this.unoccupy(path);
        }
        if (ev.by !== undefined) {
          const by = this.players.get(ev.by)?.name ?? 'someone';
          if (ev.owner === this.you) this.toast(`Cut by ${by}`, 'bad');
          else if (ev.by === this.you) this.toast(`Cut ${this.players.get(ev.owner)?.name ?? 'someone'}`, 'good');
        }
        this.geometryVersion++;
        return;
      }
      case 'circuit': {
        const path = this.paths.get(ev.path);
        if (path) {
          path.status = 'closed';
          if (ev.region) path.region = ev.region;
          this.touchPath(path);
        }
        if (ev.owner === this.you) this.toast(`${ev.region ? 'Claimed' : 'Circuit'}${ev.bonus ? ` +${ev.bonus}` : ' closed'}`, 'good');
        this.geometryVersion++;
        return;
      }
      case 'score': {
        const p = this.players.get(ev.id);
        if (p) {
          p.score = ev.score;
          p.combo = ev.combo;
        }
        return;
      }
      case 'refused':
        if (Date.now() >= this.quietRefusalsUntil) this.toast(ev.reason, 'bad');
        return;
    }
  }
}

function clientPlayer(p: PlayerPublic): ClientPlayer {
  const { converted, ...rest } = p;
  return { ...rest, patterns: [...p.patterns], converted: converted ?? 0 };
}
