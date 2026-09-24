/**
 * Server integration: rooms. Each game mode has its own rooms; a room takes
 * ROOM_SIZE humans and the next joiner of that mode opens another. Spawns the
 * real server on a free port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { GameMode } from '../shared/game/knobs';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';

const PORT = 19000 + Math.floor(Math.random() * 1000);
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

const sockets: WebSocket[] = [];

/** Connect, join `mode`, and return the welcome. */
async function join(mode?: GameMode, room?: string): Promise<Extract<ServerMessage, { t: 'welcome' }> & { ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(ws);
  const welcome = new Promise<Extract<ServerMessage, { t: 'welcome' }>>((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'welcome') resolve(m);
    });
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'x', rule: defaultRule('hex'), mode, room }));
  return { ...(await welcome), ws };
}

beforeAll(async () => {
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), BOTS: '1', FIELD_LEVEL: '3', ROOM_SIZE: '2' },
    stdio: 'ignore',
  });
  await waitForHealth();
}, 30_000);

afterAll(() => {
  for (const ws of sockets) ws.close();
  server?.kill();
});

describe('rooms', () => {
  it('fills a room to ROOM_SIZE humans, then opens the next; modes never mix', async () => {
    const a = await join();
    const b = await join('normal');
    const c = await join('normal');
    const d = await join('conquest');
    expect(a.room).toBe('normal-1');
    expect(a.knobs.mode).toBe('normal');
    expect(b.room).toBe('normal-1');
    expect(c.room).toBe('normal-2');
    expect(d.room).toBe('conquest-1');
    expect(d.knobs.mode).toBe('conquest');
    // Each room has its own bot, and only its own players.
    expect(c.players.filter((p) => !p.bot).map((p) => p.id)).toEqual([c.you]);
    expect(c.players.some((p) => p.bot)).toBe(true);
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { players: number; rooms: { id: string; players: number }[] };
    expect(health.players).toBe(4);
    expect(Object.fromEntries(health.rooms.map((r) => [r.id, r.players]))).toEqual({ 'normal-1': 2, 'conquest-1': 1, 'normal-2': 1 });
  });

  it('leave frees the seat at once, with no resume window', async () => {
    const health = async () =>
      ((await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { rooms: { id: string; players: number }[] }).rooms;
    const e = await join('conquest');
    expect(e.room).toBe('conquest-1');
    expect((await health()).find((r) => r.id === 'conquest-1')?.players).toBe(2);
    e.ws.send(JSON.stringify({ t: 'leave' }));
    await new Promise((r) => setTimeout(r, 150));
    expect((await health()).find((r) => r.id === 'conquest-1')?.players).toBe(1);
    // The old ticket is dead: a resume with it is a new player.
    const again = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(again);
    const w = new Promise<Extract<ServerMessage, { t: 'welcome' }>>((resolve) =>
      again.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        if (m.t === 'welcome') resolve(m);
      }),
    );
    await new Promise((r) => again.once('open', r));
    again.send(JSON.stringify({ t: 'join', name: 'x', rule: defaultRule('hex'), mode: 'conquest', resume: { id: e.you, token: e.token } }));
    expect((await w).you).not.toBe(e.you);
  });

  it('a ?room= link opens a room by that name; matchmaking never sends anyone in', async () => {
    const a = await join('conquest', 'Friends!');
    expect(a.room).toBe('friends');
    expect(a.knobs.mode).toBe('conquest');
    // The link wins over the mode asked for, and over ROOM_SIZE.
    const b = await join('normal', 'friends');
    const c = await join('normal', 'friends');
    expect([b.room, c.room]).toEqual(['friends', 'friends']);
    expect(b.knobs.mode).toBe('conquest');
    // A link to a matchmade room leads into it.
    const d = await join('normal', 'normal-2');
    expect(d.room).toBe('normal-2');
    // Plain joins still matchmake round the named room.
    const e = await join('conquest');
    expect(e.room).not.toBe('friends');
  });

  it('/status.json reports rooms, players and the recent log', async () => {
    const r = (await (await fetch(`http://127.0.0.1:${PORT}/status.json`)).json()) as {
      rooms: { id: string; named: boolean; players: { bot: boolean; connected: boolean }[] }[];
      counters: { joins: number; errors: number };
      recent: { text: string }[];
    };
    const friends = r.rooms.find((q) => q.id === 'friends');
    expect(friends?.named).toBe(true);
    expect(friends?.players.filter((p) => !p.bot && p.connected)).toHaveLength(3);
    expect(r.counters.joins).toBeGreaterThan(0);
    expect(r.counters.errors).toBe(0);
    expect(r.recent.some((l) => /joined friends/.test(l.text))).toBe(true);
    const page = await fetch(`http://127.0.0.1:${PORT}/status`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('Spectacle status');
  });
});
