/**
 * Server integration: a dropped connection can resume the same player within
 * the grace period, and cannot with a wrong token. Spawns the real server on a
 * free port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/game/protocol';
import { fassRule } from '../shared/game/rule';

const PORT = 18000 + Math.floor(Math.random() * 1000);
let server: ChildProcess;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

class Client {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }
  send(m: ClientMessage): void {
    this.ws.send(JSON.stringify(m));
  }
  next(): Promise<ServerMessage> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((r) => this.waiters.push(r));
  }
  async until(t: ServerMessage['t']): Promise<ServerMessage> {
    for (;;) {
      const m = await this.next();
      if (m.t === t) return m;
    }
  }
}

/**
 * The resume window opens when the *server* notices the socket go: `tryResume`
 * only finds a player its close handler has already detached. So close, wait
 * for the closing handshake, and give the server one round-trip to work
 * through it — reconnect any sooner and the drop has not registered yet, and
 * the resume correctly hands out a new player instead.
 */
async function awaitDrop(c: Client): Promise<void> {
  c.ws.close();
  await new Promise<void>((r) => c.ws.once('close', () => r()));
  await fetch(`http://127.0.0.1:${PORT}/healthz`);
}

beforeAll(async () => {
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), BOTS: '0', FIELD_LEVEL: '3', RESUME_GRACE_MS: '5000' },
    stdio: 'ignore',
  });
  await waitForHealth();
}, 30_000);

afterAll(() => {
  server.kill();
});

describe('resume', () => {
  it('a reconnect with the welcome token gets the same player back; a wrong token gets a new one', async () => {
    const a = new Client();
    await a.open();
    await a.until('hello');
    a.send({ t: 'join', name: 'Ann', rule: fassRule('hex') });
    const w1 = await a.until('welcome');
    if (w1.t !== 'welcome') throw new Error();
    expect(w1.token).toMatch(/^[0-9a-f]{32}$/);
    await awaitDrop(a);

    const b = new Client();
    await b.open();
    await b.until('hello');
    b.send({ t: 'join', name: 'ignored', rule: fassRule('hex'), resume: { id: w1.you, token: w1.token } });
    const w2 = await b.until('welcome');
    if (w2.t !== 'welcome') throw new Error();
    expect(w2.you).toBe(w1.you);
    expect(w2.players.map((p) => p.name)).toEqual(['Ann']);
    await awaitDrop(b);

    const c = new Client();
    await c.open();
    await c.until('hello');
    c.send({ t: 'join', name: 'Cat', rule: fassRule('hex'), resume: { id: w1.you, token: 'nope' } });
    const w3 = await c.until('welcome');
    if (w3.t !== 'welcome') throw new Error();
    expect(w3.you).not.toBe(w1.you);
    // Ann is still held (detached) for the grace period, so both are listed.
    expect(w3.players.map((p) => p.name).sort()).toEqual(['Ann', 'Cat']);
    await awaitDrop(c);

    // Tokens are single use: w1's died when b resumed with it.
    const d = new Client();
    await d.open();
    await d.until('hello');
    d.send({ t: 'join', name: 'Dan', rule: fassRule('hex'), resume: { id: w1.you, token: w1.token } });
    const w4 = await d.until('welcome');
    if (w4.t !== 'welcome') throw new Error();
    expect(w4.you).not.toBe(w1.you);
    expect(w2.token).not.toBe(w1.token);
    d.ws.close();
  }, 20_000);

  it('a refresh that reconnects before the old socket is gone takes the player over', async () => {
    const a = new Client();
    await a.open();
    await a.until('hello');
    a.send({ t: 'join', name: 'Eve', rule: fassRule('hex') });
    const w1 = await a.until('welcome');
    if (w1.t !== 'welcome') throw new Error();

    // No close on `a` first: the new page beats the old one's goodbye.
    const closed = new Promise<number>((r) => a.ws.once('close', (code) => r(code)));
    const b = new Client();
    await b.open();
    await b.until('hello');
    b.send({ t: 'join', name: 'ignored', rule: fassRule('hex'), resume: { id: w1.you, token: w1.token } });
    const w2 = await b.until('welcome');
    if (w2.t !== 'welcome') throw new Error();
    expect(w2.you).toBe(w1.you);
    expect(await closed).toBe(4000);
    expect(w2.players.filter((p) => p.name === 'Eve')).toHaveLength(1);
    // The old socket's close must not have unhooked the new one: b still
    // hears about a newcomer.
    await fetch(`http://127.0.0.1:${PORT}/healthz`);
    const c = new Client();
    await c.open();
    await c.until('hello');
    c.send({ t: 'join', name: 'Fay', rule: fassRule('hex') });
    await c.until('welcome');
    const ev = await b.until('events');
    if (ev.t !== 'events') throw new Error();
    expect(ev.ev.some((e) => e.t === 'join' && e.player.name === 'Fay')).toBe(true);
    b.ws.close();
    c.ws.close();
  }, 20_000);
});
