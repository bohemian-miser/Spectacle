/**
 * Wire types between server and client (JSON over WebSocket).
 *
 * The server is authoritative. A client gets one `welcome` snapshot and then a
 * stream of batched `events`; it never simulates growth itself, it only draws
 * what it is told. Geometry travels as world-space points so a client can draw
 * everyone's strands without knowing everyone's rule.
 */

import type { Pt } from '../tiles';
import type { FieldSpec } from './field';
import type { Knobs } from './knobs';
import type { PlayerRule } from './rule';

export type PathStatus = 'growing' | 'stuck' | 'closed';

export interface PathStepWire {
  readonly tile: number;
  readonly chord: number;
  readonly a: Pt;
  readonly b: Pt;
}

export interface PathWire {
  readonly id: number;
  readonly owner: string;
  readonly status: PathStatus;
  readonly steps: readonly PathStepWire[];
}

export interface PlayerPublic {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly rule: PlayerRule;
  readonly score: number;
  readonly combo: number;
  readonly bot: boolean;
}

// --- client → server ---------------------------------------------------------

export interface ResumeTicket {
  readonly id: string;
  readonly token: string;
}

export type ClientMessage =
  /** `resume` reattaches to a player the server still holds after a dropped connection. */
  | { readonly t: 'join'; readonly name: string; readonly rule: PlayerRule; readonly resume?: ResumeTicket }
  | { readonly t: 'tap'; readonly tile: number; readonly x: number; readonly y: number }
  | { readonly t: 'rule'; readonly rule: PlayerRule }
  | { readonly t: 'ping'; readonly n: number };

// --- server → client ---------------------------------------------------------

export type GameEvent =
  | { readonly t: 'join'; readonly player: PlayerPublic }
  | { readonly t: 'leave'; readonly id: string }
  | { readonly t: 'rule'; readonly id: string; readonly rule: PlayerRule; readonly score: number; readonly combo: number }
  /** A path grew by one step (the first step creates it). */
  | { readonly t: 'step'; readonly path: number; readonly owner: string; readonly step: PathStepWire }
  | { readonly t: 'status'; readonly path: number; readonly status: PathStatus }
  /** A path was cut (`by`) or abandoned (`by` absent) and is gone. */
  | { readonly t: 'wipe'; readonly path: number; readonly owner: string; readonly by?: string }
  | {
      readonly t: 'circuit';
      readonly path: number;
      readonly owner: string;
      readonly length: number;
      readonly area: number;
      readonly bonus: number;
      readonly combo: number;
    }
  | { readonly t: 'score'; readonly id: string; readonly score: number; readonly combo: number }
  /** Your tap was refused, with a reason to show. */
  | { readonly t: 'refused'; readonly reason: string };

export type ServerMessage =
  /** Sent on connect, before any join: what the arena is, so a rule can be built for it. */
  | { readonly t: 'hello'; readonly field: FieldSpec; readonly knobs: Knobs; readonly tiles: number; readonly players: number }
  | {
      readonly t: 'welcome';
      readonly you: string;
      /** Present it with `join.resume` to pick this player up again after a drop. */
      readonly token: string;
      readonly field: FieldSpec;
      readonly knobs: Knobs;
      readonly players: readonly PlayerPublic[];
      readonly paths: readonly PathWire[];
    }
  | { readonly t: 'events'; readonly ev: readonly GameEvent[] }
  | { readonly t: 'pong'; readonly n: number }
  | { readonly t: 'error'; readonly message: string };
