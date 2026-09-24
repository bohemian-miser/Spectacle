/**
 * Solo mode: the whole game running inside the browser tab.
 *
 * The engine, the field and the bots are pure shared code, so a
 * `LocalConnection` simply hosts them and speaks the same messages the real
 * server would. Nothing else in the client knows the difference, which is
 * what lets the static GitHub Pages build play without a server.
 */

import { Bots } from '../../shared/game/bots';
import { Engine } from '../../shared/game/engine';
import { buildField, fieldOutline, type FieldSpec } from '../../shared/game/field';
import { DEFAULT_KNOBS, knobsForMode, type GameMode, type Knobs } from '../../shared/game/knobs';
import type { ClientMessage, GameEvent, ServerMessage } from '../../shared/game/protocol';
import { validateRule } from '../../shared/game/rule';
import { mulberry32 } from '../../shared/game/rng';
import type { TileFamilyId } from '../../shared/tiles';
import type { GameConnection } from './net';
import type { Store } from './store';

export interface SoloOptions {
  readonly family: TileFamilyId;
  readonly level: number;
  readonly bots: number;
}

export const DEFAULT_SOLO: SoloOptions = { family: 'hex', level: 5, bots: 3 };

/** Levels offered in the solo lobby (6 is ~250k tiles: playable, but slow to build on a phone). */
export const SOLO_LEVELS: readonly number[] = [3, 4, 5, 6];

export const YOU = 'you';

export class LocalConnection implements GameConnection {
  readonly kind = 'solo';
  private engine: Engine | null = null;
  private bots: Bots | null = null;
  private timer = 0;
  private last = 0;
  private joined = false;
  private readonly knobs: Knobs;

  constructor(
    private readonly store: Store,
    private readonly opts: SoloOptions,
    mode: GameMode = 'normal',
    base: Knobs = DEFAULT_KNOBS,
  ) {
    this.knobs = knobsForMode(base, mode);
  }

  open(onOpen: () => void, _onClose: (code: number) => void): void {
    const spec: FieldSpec = { family: this.opts.family, level: this.opts.level, rootTile: 'Delta' };
    const field = buildField(spec);
    // Edge-to-edge claims need the outline; build it with the field, not mid-game.
    fieldOutline(field);
    const rng = mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.engine = new Engine(field, this.knobs, rng);
    this.bots = new Bots(this.engine, rng);
    const ev = this.bots.add(this.opts.bots, Date.now());
    this.store.connected = true;
    this.deliver({ t: 'hello', field: spec, knobs: this.knobs, tiles: field.count, players: this.engine.players.size });
    if (ev.length) this.pending.push(...ev);
    this.last = Date.now();
    this.timer = window.setInterval(() => this.tick(), this.knobs.tickMs);
    onOpen();
  }

  private pending: GameEvent[] = [];

  private tick(): void {
    const e = this.engine;
    const b = this.bots;
    if (!e || !b) return;
    const now = Date.now();
    const dt = Math.min(1000, now - this.last);
    this.last = now;
    const ev = e.tick(dt);
    b.update(now, ev);
    if (this.pending.length) {
      ev.unshift(...this.pending);
      this.pending = [];
    }
    if (ev.length && this.joined) this.deliver({ t: 'events', ev });
  }

  private deliver(msg: ServerMessage): void {
    this.store.handle(msg);
  }

  send(msg: ClientMessage): void {
    const e = this.engine;
    if (!e) return;
    switch (msg.t) {
      case 'join': {
        if (this.joined) return;
        const rule = validateRule(msg.rule, e.field.family);
        if (!rule) {
          this.deliver({ t: 'error', message: 'invalid rule' });
          return;
        }
        e.addPlayer(YOU, msg.name.trim() || 'you', rule);
        this.joined = true;
        const snap = e.snapshot();
        this.deliver({ t: 'welcome', you: YOU, token: 'solo', field: e.field.spec, knobs: this.knobs, players: snap.players, paths: snap.paths });
        return;
      }
      case 'tap': {
        const { result, events } = e.tap(YOU, msg.tile, { x: msg.x, y: msg.y });
        if (!result.ok) this.deliver({ t: 'events', ev: [{ t: 'refused', reason: result.reason }] });
        this.pending.push(...events);
        return;
      }
      case 'rule': {
        const rule = validateRule(msg.rule, e.field.family);
        if (!rule) {
          this.deliver({ t: 'events', ev: [{ t: 'refused', reason: 'invalid rule' }] });
          return;
        }
        this.pending.push(...e.setRule(YOU, rule));
        return;
      }
      case 'swap': {
        const rule = validateRule(msg.rule, e.field.family);
        const r = rule ? e.swapPattern(YOU, Number(msg.index), rule) : { ok: false as const, reason: 'invalid rule' };
        if (!r.ok) this.deliver({ t: 'events', ev: [{ t: 'refused', reason: r.reason }] });
        else this.pending.push(...r.events);
        return;
      }
      case 'pattern':
        this.pending.push(...e.setActive(YOU, Number(msg.index)));
        return;
      case 'ping':
        this.deliver({ t: 'pong', n: msg.n });
        return;
    }
  }

  close(): void {
    window.clearInterval(this.timer);
    this.engine = null;
    this.bots = null;
    this.joined = false;
  }
}
