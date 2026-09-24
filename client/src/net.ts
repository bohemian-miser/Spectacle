import type { ClientMessage, ServerMessage } from '../../shared/game/protocol';
import type { Store } from './store';

export function wsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_WS_URL) return env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** What the app talks to: the real server over a WebSocket, or the in-tab engine. */
export interface GameConnection {
  readonly kind: 'online' | 'solo';
  /** `onClose` gets the WebSocket close code (4000: the player was resumed in another tab). */
  open(onOpen: () => void, onClose: (code: number) => void): void;
  send(msg: ClientMessage): void;
  close(): void;
}

export class Connection implements GameConnection {
  readonly kind = 'online';
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly store: Store) {}

  open(onOpen: () => void, onClose: (code: number) => void): void {
    this.closedByUs = false;
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.store.connected = true;
      onOpen();
    };
    ws.onmessage = (e) => {
      try {
        this.store.handle(JSON.parse(String(e.data)) as ServerMessage);
      } catch (err) {
        console.error('bad message', err);
      }
    };
    ws.onclose = (e) => {
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
    // Unhook first: a closing socket still delivers what was in flight, and
    // its close can land after the next connection opened. Neither may touch
    // the store, which belongs to the new connection now.
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this.ws = null;
  }
}
