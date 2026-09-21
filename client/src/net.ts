import type { ClientMessage, ServerMessage } from '../../shared/game/protocol';
import type { Store } from './store';

export function wsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_WS_URL) return env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Connection {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(private readonly store: Store) {}

  open(onOpen: () => void, onClose: () => void): void {
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
    ws.onclose = () => {
      this.store.connected = false;
      if (!this.closedByUs) onClose();
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
