/**
 * The client's heartbeat: a server that freezes keeps its socket open, so
 * silence is the only sign. `Heartbeat` on an injected clock, then the online
 * `Connection` wired to a fake socket on fake timers — no real waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASLEEP_MS, CHECK_MS, DEAD_MS, Heartbeat, PING_MS, STALE_MS } from '../client/src/heartbeat';
import { Connection, STALE_CLOSE } from '../client/src/net';
import { Store } from '../client/src/store';
import type { ClientMessage, ServerMessage } from '../shared/game/protocol';

/** A heartbeat on a clock the test moves, checked every `CHECK_MS` as net.ts does. */
function rig() {
  let t = 1_000;
  const log = { pings: [] as number[], stale: [] as [number, boolean][], dead: [] as number[] };
  const beat = new Heartbeat({
    now: () => t,
    ping: (n) => log.pings.push(n),
    onStale: (s) => log.stale.push([t, s]),
    onDead: () => log.dead.push(t),
  });
  const start = t;
  /** Move the clock on by `ms`, checking each `CHECK_MS` (and hearing the server each check, with `talk`). */
  const run = (ms: number, talk = false): void => {
    for (let left = ms; left > 0; left -= CHECK_MS) {
      t += Math.min(CHECK_MS, left);
      if (talk) beat.heard();
      beat.check();
    }
  };
  return { beat, log, run, at: (ms: number) => start + ms, jump: (ms: number) => (t += ms), now: () => t };
}

describe('Heartbeat', () => {
  it('pings every PING_MS, and a server that keeps talking is never stale', () => {
    const { log, run } = rig();
    run(60_000, true);
    expect(log.pings).toEqual(Array.from({ length: 60_000 / PING_MS }, (_, i) => i + 1));
    expect(log.stale).toEqual([]);
    expect(log.dead).toEqual([]);
  });

  it('silence goes stale at STALE_MS, and anything heard clears it', () => {
    const { beat, log, run, at, now } = rig();
    run(STALE_MS - CHECK_MS);
    expect(log.stale).toEqual([]);
    run(CHECK_MS);
    expect(log.stale).toEqual([[at(STALE_MS), true]]);
    run(3 * CHECK_MS);
    expect(log.stale).toHaveLength(1); // said once, not every check
    expect(log.pings.length).toBeGreaterThan(1); // still pinging meanwhile
    beat.heard();
    expect(log.stale).toEqual([
      [at(STALE_MS), true],
      [now(), false],
    ]);
    // Heard again: the clock starts over.
    run(STALE_MS - CHECK_MS);
    expect(log.stale).toHaveLength(2);
    expect(log.dead).toEqual([]);
  });

  it('gives up once, at DEAD_MS, and stops', () => {
    const { beat, log, run, at } = rig();
    run(DEAD_MS);
    expect(log.dead).toEqual([at(DEAD_MS)]);
    const pings = log.pings.length;
    run(60_000);
    beat.heard();
    expect(log.dead).toHaveLength(1);
    expect(log.pings).toHaveLength(pings);
    expect(log.stale).toEqual([[at(STALE_MS), true]]); // no "false" from a dead heartbeat
  });

  it("a tab that slept doesn't blame the server: the clock restarts and a ping goes at once", () => {
    const { log, run, jump } = rig();
    run(2 * CHECK_MS, true);
    const pings = log.pings.length;
    jump(60_000); // a background tab's timer fires once a minute
    run(CHECK_MS);
    expect(log.pings).toHaveLength(pings + 1);
    expect(log.stale).toEqual([]);
    expect(log.dead).toEqual([]);
    // Then silence is judged from the wake-up, not from before the sleep.
    run(STALE_MS - 2 * CHECK_MS);
    expect(log.stale).toEqual([]);
    run(2 * CHECK_MS);
    expect(log.stale).toHaveLength(1);
  });

  it('a check up to ASLEEP_MS late is not sleep', () => {
    const { log, run, jump, at } = rig();
    jump(ASLEEP_MS - CHECK_MS); // the next check comes ASLEEP_MS after the last
    run(STALE_MS - (ASLEEP_MS - CHECK_MS));
    expect(log.stale).toEqual([[at(STALE_MS), true]]);
  });

  it('"not responding" stays up across a sleep until the server is heard', () => {
    const { beat, log, run, jump, at } = rig();
    run(STALE_MS);
    jump(60_000);
    run(CHECK_MS);
    expect(log.stale).toEqual([[at(STALE_MS), true]]);
    run(DEAD_MS - 2 * CHECK_MS);
    expect(log.dead).toEqual([]);
    beat.heard();
    expect(log.stale.at(-1)?.[1]).toBe(false);
  });
});

/** Just enough WebSocket for `Connection`: the test plays the server. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  readonly sent: ClientMessage[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(code = 1005): void {
    this.closedWith = code;
    this.readyState = 2;
  }
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  say(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('Connection heartbeat', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' });
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connect() {
    const store = new Store();
    const conn = new Connection(store);
    const closes: number[] = [];
    let opened = 0;
    conn.open(
      () => opened++,
      (code) => closes.push(code),
    );
    const ws = FakeSocket.all.at(-1)!;
    ws.accept();
    return { store, conn, ws, closes, opened: () => opened };
  }

  const pings = (ws: FakeSocket) => ws.sent.filter((m) => m.t === 'ping');

  it('pings, shows a quiet server as stale, clears it when it speaks', () => {
    const { store, ws, closes } = connect();
    expect(store.connected).toBe(true);
    vi.advanceTimersByTime(PING_MS);
    expect(pings(ws)).toEqual([{ t: 'ping', n: 1 }]);
    ws.say({ t: 'pong', n: 1 });
    vi.advanceTimersByTime(STALE_MS - CHECK_MS);
    expect(store.stale).toBe(false);
    const v = store.version;
    vi.advanceTimersByTime(CHECK_MS);
    expect(store.stale).toBe(true);
    expect(store.version).toBeGreaterThan(v); // subscribers hear of it
    expect(store.connected).toBe(true); // the socket is still open: that's the trap
    ws.say({ t: 'events', ev: [] }); // any message counts, not only a pong
    expect(store.stale).toBe(false);
    expect(closes).toEqual([]);
  });

  it('gives a silent server up after DEAD_MS: closes with STALE_CLOSE and reports it once, without waiting for the close event', () => {
    const { store, ws, closes } = connect();
    vi.advanceTimersByTime(DEAD_MS);
    expect(closes).toEqual([STALE_CLOSE]);
    expect(ws.closedWith).toBe(STALE_CLOSE);
    expect(store.connected).toBe(false);
    expect(store.stale).toBe(false); // "Reconnecting…" takes over
    // The old socket is unhooked and the heartbeat stopped.
    expect(ws.onclose).toBeNull();
    expect(ws.onmessage).toBeNull();
    const sent = ws.sent.length;
    vi.advanceTimersByTime(60_000);
    expect(ws.sent).toHaveLength(sent);
    expect(closes).toEqual([STALE_CLOSE]);
  });

  it('gives up on a connect that never opens, too', () => {
    const store = new Store();
    const closes: number[] = [];
    new Connection(store).open(
      () => {},
      (code) => closes.push(code),
    );
    vi.advanceTimersByTime(DEAD_MS);
    expect(closes).toEqual([STALE_CLOSE]);
    expect(FakeSocket.all[0].closedWith).toBe(STALE_CLOSE);
  });

  it('stops with the connection: close() or a normal drop', () => {
    const a = connect();
    a.conn.close();
    vi.advanceTimersByTime(DEAD_MS * 2);
    expect(a.closes).toEqual([]);
    expect(pings(a.ws)).toEqual([]);

    const b = connect();
    vi.advanceTimersByTime(STALE_MS);
    expect(b.store.stale).toBe(true);
    b.ws.onclose?.({ code: 1006 });
    expect(b.store.stale).toBe(false);
    vi.advanceTimersByTime(DEAD_MS * 2);
    expect(b.closes).toEqual([1006]); // the drop alone, no second report from the heartbeat
  });
});
