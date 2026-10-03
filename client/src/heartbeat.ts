/**
 * Is the online server still answering? A server process that freezes keeps
 * its sockets open — no close, no error — so the client went on looking
 * connected while every tap vanished (2026-10-03: a bot brain held one
 * server's single loop for minutes). So the client pings, the server answers
 * straight from its message handler, and anything at all heard back (a pong,
 * events, a welcome) proves its loop is turning. Silence is shown to the
 * player, then the socket is given up for a fresh one, which resumes.
 *
 * Pure: the clock is passed in and `check()` is called from outside (net.ts,
 * every `CHECK_MS`), so the tests drive it without waiting.
 */

/**
 * Ping this often. In a live room events arrive every tick anyway; this is
 * what keeps a quiet one (the lobby, a board with nothing growing) heard from
 * well inside `STALE_MS`. Tiny, and answered at once.
 */
export const PING_MS = 5_000;

/**
 * Nothing heard for this long: "Server not responding…". Over one missed
 * ping and most of the next, so a slow network or a big welcome still
 * downloading doesn't cry wolf; short enough that a player tapping into
 * silence is told within a few taps.
 */
export const STALE_MS = 9_000;

/**
 * Nothing heard for this long: give this socket up and reconnect (resuming on
 * the ticket, as after any drop). Long enough that a passing stall (a heavy
 * rule switch on the handler, a GC pause) recovers in place; short enough
 * not to sit for minutes on a stuck instance — the new connection may land
 * on a healthy one. Also bounds a connect that never opens.
 */
export const DEAD_MS = 25_000;

/** How often net.ts calls `check()`. */
export const CHECK_MS = 1_000;

/**
 * A check this long after the last means the tab was asleep or blocked, not
 * the server (background tabs' timers fire as little as once a minute; a
 * phone locks; a huge welcome parses): what wasn't heard meanwhile proves
 * nothing, so the clock restarts and a ping goes at once.
 */
export const ASLEEP_MS = PING_MS;

export interface HeartbeatHooks {
  /** A monotonic clock in ms (`performance.now()` in the browser). */
  now(): number;
  /** Send a ping, numbered from 1. */
  ping(n: number): void;
  /** The server went quiet (true), or was heard again (false). */
  onStale(stale: boolean): void;
  /** Quiet for `DEAD_MS`: give the connection up. Called once; the heartbeat stops. */
  onDead(): void;
}

export class Heartbeat {
  private heardAt: number;
  private pingedAt: number;
  private checkedAt: number;
  private sent = 0;
  private stale = false;
  private dead = false;

  constructor(private readonly hooks: HeartbeatHooks) {
    const now = hooks.now();
    this.heardAt = this.pingedAt = this.checkedAt = now;
  }

  /** Anything arrived from the server: it's alive. */
  heard(): void {
    if (this.dead) return;
    this.heardAt = this.hooks.now();
    if (this.stale) {
      this.stale = false;
      this.hooks.onStale(false);
    }
  }

  /** Every `CHECK_MS`: ping when one is due, and judge the silence. */
  check(): void {
    if (this.dead) return;
    const now = this.hooks.now();
    if (now - this.checkedAt > ASLEEP_MS) {
      // Only time we were awake to hear in counts. A "not responding" already
      // up stays until the server is actually heard.
      this.heardAt = now;
      this.pingedAt = -Infinity;
    }
    this.checkedAt = now;
    if (now - this.pingedAt >= PING_MS) {
      this.pingedAt = now;
      this.hooks.ping(++this.sent);
    }
    const quiet = now - this.heardAt;
    if (quiet >= DEAD_MS) {
      this.dead = true;
      this.hooks.onDead();
    } else if (quiet >= STALE_MS && !this.stale) {
      this.stale = true;
      this.hooks.onStale(true);
    }
  }
}
