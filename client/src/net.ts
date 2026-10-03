import type { ClientMessage, ServerMessage } from '../../shared/game/protocol';
import { CHECK_MS, Heartbeat } from './heartbeat';
import type { Store } from './store';

export function wsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_WS_URL) return env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * The close code of a socket the client gave up on because the server
 * stopped answering (heartbeat.ts). Sent to the server, which logs it, and
 * handed to `onClose` like any other drop, so the app reconnects and resumes.
 * (4000 and 4001 are the server's own.)
 */
export const STALE_CLOSE = 4002;

/** What the app talks to: the real server over a WebSocket, or the in-tab engine. */
export interface GameConnection {
  readonly kind: 'online' | 'solo';
  /**
   * `onClose` gets the WebSocket close code (4000: the player was resumed in
   * another tab; `STALE_CLOSE`: the server stopped answering).
   */
  open(onOpen: () => void, onClose: (code: number) => void): void;
  send(msg: ClientMessage): void;
  close(): void;
}

export class Connection implements GameConnection {
  readonly kind = 'online';
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private beatTimer = 0;

  constructor(private readonly store: Store) {}

  open(onOpen: () => void, onClose: (code: number) => void): void {
    this.closedByUs = false;
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    // From the start, not from `onopen`: a connect that never opens (the
    // server froze mid-handshake) is given up on as well.
    const beat = new Heartbeat({
      now: () => performance.now(),
      ping: (n) => this.send({ t: 'ping', n }),
      onStale: (stale) => this.store.setStale(stale),
      onDead: () => {
        // A frozen server never finishes the closing handshake, so the
        // socket's own close event could be a minute off: drop it and report
        // the close now.
        this.drop(true);
        this.store.connected = false;
        onClose(STALE_CLOSE);
      },
    });
    this.beatTimer = window.setInterval(() => beat.check(), CHECK_MS);
    ws.onopen = () => {
      this.store.connected = true;
      onOpen();
    };
    ws.onmessage = (e) => {
      beat.heard();
      try {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        this.store.handle(msg);
        // The token this welcome carries is ours now: the server may let the
        // one we resumed on go (until then it keeps both, in case this
        // welcome was lost on the way).
        if (msg.t === 'welcome') this.send({ t: 'ack' });
      } catch (err) {
        console.error('bad message', err);
      }
    };
    ws.onclose = (e) => {
      this.stopBeat();
      this.store.connected = false;
      if (!this.closedByUs) onClose(e.code);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    this.drop();
  }

  private stopBeat(): void {
    window.clearInterval(this.beatTimer);
    this.store.setStale(false);
  }

  /**
   * Stop the heartbeat, unhook the socket and close it (`stale`: with
   * `STALE_CLOSE`, for the server's log). Unhook first: a
   * closing socket still delivers what was in flight, and its close can land
   * after the next connection opened. Neither may touch the store, which
   * belongs to the new connection now.
   */
  private drop(stale = false): void {
    this.stopBeat();
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (stale) ws.close(STALE_CLOSE, 'server not responding');
      else ws.close();
    }
    this.ws = null;
  }
}
