/**
 * Server integration: the instance-wide capacity ceiling (`MAX_INSTANCE_PLAYERS`)
 * that keeps one process from growing without bound under a surge — see
 * server/index.ts's "Scaling past one instance". Spawns the real server on a
 * free port with a tiny cap.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';

// Clear of rooms.test.ts (19000-19999) and resume.test.ts (18000-18999): vitest runs files in parallel.
const PORT = 20000 + Math.floor(Math.random() * 1000);
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

function connect(): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(ws);
  return ws;
}

/** Send `join` and resolve with the first `welcome` or `error`. */
async function join(ws: WebSocket, extra: Record<string, unknown> = {}): Promise<ServerMessage> {
  const msg = new Promise<ServerMessage>((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'welcome' || m.t === 'error') resolve(m);
    });
  });
  if (ws.readyState !== ws.OPEN) await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'x', rule: defaultRule('hex'), ...extra }));
  return msg;
}

beforeAll(async () => {
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), BOTS: '0', FIELD_LEVEL: '3', ROOM_SIZE: '10', MAX_INSTANCE_PLAYERS: '2' },
    stdio: 'ignore',
  });
  await waitForHealth();
}, 30_000);

afterAll(() => {
  for (const ws of sockets) ws.close();
  server?.kill();
});

describe('instance capacity', () => {
  it('fills to MAX_INSTANCE_PLAYERS, then refuses new joins without touching room state', async () => {
    const a = (await join(connect())) as Extract<ServerMessage, { t: 'welcome' }>;
    const b = (await join(connect())) as Extract<ServerMessage, { t: 'welcome' }>;
    expect(a.t).toBe('welcome');
    expect(b.t).toBe('welcome');

    const refused = (await join(connect())) as Extract<ServerMessage, { t: 'error' }>;
    expect(refused).toMatchObject({ t: 'error', code: 'full' });

    const health = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as {
      players: number;
      maxPlayers: number;
      atCapacity: boolean;
    };
    expect(health.players).toBe(2);
    expect(health.maxPlayers).toBe(2);
    expect(health.atCapacity).toBe(true);

    // An existing player resuming adds no new load, so it is exempt from the
    // cap even while every seat is taken — a dropped connection or a page
    // refresh must not lose your place just because the arena is busy.
    const resumed = (await join(connect(), { resume: { id: a.you, token: a.token } })) as Extract<ServerMessage, { t: 'welcome' }>;
    expect(resumed.t).toBe('welcome');
    expect(resumed.you).toBe(a.you);

    // Still exactly the same two humans — a resume replaces, it doesn't add.
    const after = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { players: number };
    expect(after.players).toBe(2);
  });
});
