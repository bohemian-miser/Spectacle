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
import type { GameMode, Knobs } from './knobs';
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
  /** A closed line that runs edge to edge: the region it claims (line + field outline). */
  readonly region?: readonly Pt[];
  /** Which of the owner's patterns drew it (index into `PlayerPublic.patterns`); absent = 0, their own. */
  readonly pattern?: number;
  /** Grown out of a flip rather than a tap: it doesn't take up one of the owner's heads. */
  readonly spawned?: true;
}

/**
 * A pattern a player drew lines with. Index 0 is always their own rule; the
 * rest were captured by closing a circuit around someone else's line.
 */
export interface PatternPublic {
  readonly rule: PlayerRule;
  /** The line colour it draws in: the owner's own, or a blend with its source's. */
  readonly color: string;
  /** Whose line it was taken from (absent on the player's own). */
  readonly from?: string;
  readonly fromName?: string;
}

export interface PlayerPublic {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly rule: PlayerRule;
  readonly score: number;
  readonly combo: number;
  readonly bot: boolean;
  /** `patterns[0]` is `rule` itself; captured ones follow in the order they were taken. */
  readonly patterns: readonly PatternPublic[];
  /** The pattern a tap starts a line with. */
  readonly active: number;
  /** Normal mode: kinds of rival line converted — a head each (absent = 0). */
  readonly converted?: number;
}

// --- client → server ---------------------------------------------------------

export interface ResumeTicket {
  readonly id: string;
  readonly token: string;
}

export type ClientMessage =
  /** `resume` reattaches to a player the server still holds after a dropped connection. */
  | {
      readonly t: 'join';
      readonly name: string;
      readonly rule: PlayerRule;
      readonly resume?: ResumeTicket;
      /** Which kind of arena to be put in (default normal); the server picks a room of it. */
      readonly mode?: GameMode;
    }
  | { readonly t: 'tap'; readonly tile: number; readonly x: number; readonly y: number }
  | { readonly t: 'rule'; readonly rule: PlayerRule }
  /** Choose which of your patterns the next tap draws with. */
  | { readonly t: 'pattern'; readonly index: number }
  /** Swap captured pattern `index` (≥ 1) for `rule`: that pattern's lines, and their points, go. */
  | { readonly t: 'swap'; readonly index: number; readonly rule: PlayerRule }
  /** Leave the arena for good: your lines and points go now, not after the resume window. */
  | { readonly t: 'leave' }
  | { readonly t: 'ping'; readonly n: number };

// --- server → client ---------------------------------------------------------

export type GameEvent =
  | { readonly t: 'join'; readonly player: PlayerPublic }
  | { readonly t: 'leave'; readonly id: string }
  /** A new rule is a restart: paths gone, captured patterns gone, own pattern active. */
  | { readonly t: 'rule'; readonly id: string; readonly rule: PlayerRule; readonly score: number; readonly combo: number }
  /**
   * A path grew by one step (the first step creates it; it carries `pattern`
   * when that is not 0, and `spawned` when a flip made it).
   */
  | {
      readonly t: 'step';
      readonly path: number;
      readonly owner: string;
      readonly step: PathStepWire;
      readonly pattern?: number;
      readonly spawned?: true;
    }
  /** `id` closed a circuit round a rival's line and took its pattern (appended to their patterns). */
  | { readonly t: 'capture'; readonly id: string; readonly pattern: PatternPublic }
  /**
   * `id` swapped captured pattern `index` for a rule of their own: its lines
   * were wiped just before (`wipe` without `by`), and `pattern` replaces it in place.
   */
  | { readonly t: 'swap'; readonly id: string; readonly index: number; readonly pattern: PatternPublic }
  /**
   * `owner` closed a circuit round `from`'s line `path` and took it: it is
   * theirs now, drawn with their pattern `pattern`. Its points follow as `score`s.
   */
  | { readonly t: 'take'; readonly path: number; readonly from: string; readonly owner: string; readonly pattern: number }
  /**
   * Normal mode: `id` closed a circuit round `from`'s line and converted it to
   * their own pattern (its wipe and the new pieces' steps come with it).
   * `converted` is how many kinds of line they have converted: a head each.
   */
  | { readonly t: 'convert'; readonly id: string; readonly from: string; readonly converted: number }
  /** `id` switched the pattern their taps draw with. */
  | { readonly t: 'active'; readonly id: string; readonly active: number }
  | { readonly t: 'status'; readonly path: number; readonly status: PathStatus }
  /**
   * A flip took some of `path`'s steps: it is replaced by `runs`, each the
   * old steps `start` ≤ i < `end` (indices mod its length — a loop opens by
   * wrapping round), same owner, pattern and `spawned`. The first run reuses
   * the id. A closed path's circuit is gone.
   */
  | {
      readonly t: 'split';
      readonly path: number;
      readonly runs: readonly { readonly id: number; readonly start: number; readonly end: number; readonly status: PathStatus }[];
    }
  /** A line that ran off the board turned round: its steps now run the other way, and it grows again. */
  | { readonly t: 'reverse'; readonly path: number }
  /** A path was cut (`by`, in a collision at `at`) or abandoned (`by` absent) and is gone. */
  | { readonly t: 'wipe'; readonly path: number; readonly owner: string; readonly by?: string; readonly at?: Pt }
  | {
      readonly t: 'circuit';
      readonly path: number;
      readonly owner: string;
      readonly length: number;
      readonly area: number;
      readonly bonus: number;
      readonly combo: number;
      /** Present when an edge-to-edge line closed against the field's outline. */
      readonly region?: readonly Pt[];
    }
  | { readonly t: 'score'; readonly id: string; readonly score: number; readonly combo: number }
  /** Your tap was refused, with a reason to show. */
  | { readonly t: 'refused'; readonly reason: string };

/** One arena on the server. */
export interface RoomSummary {
  readonly id: string;
  readonly mode: GameMode;
  /** Humans in it (bots aside), including ones who dropped and may resume. */
  readonly players: number;
  readonly capacity: number;
}

export type ServerMessage =
  /** Sent on connect, before any join: what the arena is, so a rule can be built for it. */
  | {
      readonly t: 'hello';
      readonly field: FieldSpec;
      readonly knobs: Knobs;
      readonly tiles: number;
      /** Humans playing across every room. */
      readonly players: number;
      /** What is running, per mode (absent from older servers and solo). */
      readonly rooms?: readonly RoomSummary[];
    }
  | {
      readonly t: 'welcome';
      readonly you: string;
      /** Present it with `join.resume` to pick this player up again after a drop. */
      readonly token: string;
      readonly field: FieldSpec;
      readonly knobs: Knobs;
      readonly players: readonly PlayerPublic[];
      readonly paths: readonly PathWire[];
      /** The room you were put in (online), e.g. "normal-2". */
      readonly room?: string;
    }
  | { readonly t: 'events'; readonly ev: readonly GameEvent[] }
  | { readonly t: 'pong'; readonly n: number }
  | { readonly t: 'error'; readonly message: string };
