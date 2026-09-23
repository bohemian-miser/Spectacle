/**
 * Client-side mirror of the arena. Applies the server's event stream to plain
 * mutable structures the canvas renderer reads directly every frame, and bumps
 * a version counter so React HUD components can subscribe cheaply.
 */

import { buildField, type Field } from '../../shared/game/field';
import type { Knobs } from '../../shared/game/knobs';
import type { Pt } from '../../shared/tiles';
import type { GameEvent, PathStatus, PathStepWire, PlayerPublic, ServerMessage } from '../../shared/game/protocol';

export interface ClientPath {
  readonly id: number;
  readonly owner: string;
  status: PathStatus;
  readonly steps: PathStepWire[];
  /** An edge-to-edge line's claimed region, once closed (else the loop is its own polygon). */
  region?: readonly Pt[];
}

export interface ClientPlayer extends Omit<PlayerPublic, 'score' | 'combo' | 'rule'> {
  rule: PlayerPublic['rule'];
  score: number;
  combo: number;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: 'good' | 'bad' | 'info';
  readonly at: number;
}

export type Listener = () => void;

export class Store {
  field: Field | null = null;
  knobs: Knobs | null = null;
  you = '';
  /** Resume ticket from the last `welcome` (online only). */
  resume: { id: string; token: string } | null = null;
  readonly players = new Map<string, ClientPlayer>();
  readonly paths = new Map<number, ClientPath>();
  /** tile → paths on it (for the faded-tile render). */
  readonly occupancy = new Map<number, Set<ClientPath>>();
  toasts: Toast[] = [];
  connected = false;
  version = 0;
  /** Bumped whenever geometry changed (paths), for the renderer's dirty flag. */
  geometryVersion = 0;
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

  get me(): ClientPlayer | undefined {
    return this.players.get(this.you);
  }

  myPaths(): ClientPath[] {
    return [...this.paths.values()].filter((p) => p.owner === this.you);
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
    this.you = '';
    this.resume = null;
    this.geometryVersion++;
    this.emit();
  }

  /** Arena description from `hello`, available before joining. */
  hello: { field: import('../../shared/game/field').FieldSpec; tiles: number; players: number } | null = null;

  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello': {
        this.hello = { field: msg.field, tiles: msg.tiles, players: msg.players };
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
        this.you = msg.you;
        this.resume = { id: msg.you, token: msg.token };
        this.knobs = msg.knobs;
        if (!this.field || this.field.spec.family !== msg.field.family || this.field.spec.level !== msg.field.level || this.field.spec.rootTile !== msg.field.rootTile) {
          this.field = buildField(msg.field);
        }
        for (const p of msg.players) this.players.set(p.id, { ...p });
        for (const pw of msg.paths) {
          const path: ClientPath = { id: pw.id, owner: pw.owner, status: pw.status, steps: [...pw.steps] };
          if (pw.region) path.region = pw.region;
          this.paths.set(path.id, path);
          for (const s of path.steps) this.occupy(s.tile, path);
        }
        this.geometryVersion++;
        this.emit();
        return;
      }
      case 'events':
        for (const ev of msg.ev) this.apply(ev);
        this.emit();
        return;
      case 'error':
        this.toast(msg.message, 'bad');
        return;
      case 'pong':
        return;
    }
  }

  private occupy(tile: number, path: ClientPath): void {
    let set = this.occupancy.get(tile);
    if (!set) {
      set = new Set();
      this.occupancy.set(tile, set);
    }
    set.add(path);
  }

  private apply(ev: GameEvent): void {
    switch (ev.t) {
      case 'join':
        this.players.set(ev.player.id, { ...ev.player });
        return;
      case 'leave':
        this.players.delete(ev.id);
        return;
      case 'rule': {
        const p = this.players.get(ev.id);
        if (p) {
          p.rule = ev.rule;
          p.score = ev.score;
          p.combo = ev.combo;
        }
        return;
      }
      case 'step': {
        let path = this.paths.get(ev.path);
        if (!path) {
          path = { id: ev.path, owner: ev.owner, status: 'growing', steps: [] };
          this.paths.set(path.id, path);
        }
        path.steps.push(ev.step);
        this.occupy(ev.step.tile, path);
        this.geometryVersion++;
        return;
      }
      case 'status': {
        const path = this.paths.get(ev.path);
        if (path) path.status = ev.status;
        this.geometryVersion++;
        return;
      }
      case 'reverse': {
        const path = this.paths.get(ev.path);
        if (path) {
          const turned = path.steps.map((q) => ({ tile: q.tile, chord: q.chord, a: q.b, b: q.a })).reverse();
          path.steps.length = 0;
          path.steps.push(...turned);
          path.status = 'growing';
        }
        this.geometryVersion++;
        return;
      }
      case 'wipe': {
        const path = this.paths.get(ev.path);
        if (path) {
          this.paths.delete(ev.path);
          for (const s of path.steps) {
            const set = this.occupancy.get(s.tile);
            if (set) {
              set.delete(path);
              if (set.size === 0) this.occupancy.delete(s.tile);
            }
          }
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
        }
        if (ev.owner === this.you) this.toast(`${ev.region ? 'Claimed' : 'Circuit'} +${ev.bonus}`, 'good');
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
        this.toast(ev.reason, 'bad');
        return;
    }
  }
}
