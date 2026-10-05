/**
 * Server integration: field sizes. Each level on offer (FIELD_LEVELS, plus
 * FIELD_LEVEL, the default) has its own field and its own rooms; `hello`
 * lists them and `join.level` picks one. Spawns the real server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';
import { startServer, type TestServer } from './server';

const PORT = 22000 + Math.floor(Math.random() * 1000);
let server: TestServer;
const sockets: WebSocket[] = [];

type Hello = Extract<ServerMessage, { t: 'hello' }>;
type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

/** Connect and return the hello, and the welcome to a join with `extra`. */
async function join(extra: Record<string, unknown>): Promise<{ hello: Hello; welcome: Welcome }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(ws);
  let hello!: Hello;
  const welcome = new Promise<Welcome>((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'hello') hello = m;
      if (m.t === 'welcome') resolve(m);
    });
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'x', rule: defaultRule('hex'), mode: 'normal', packed: true, ...extra }));
  return { welcome: await welcome, hello };
}

beforeAll(async () => {
  server = await startServer(PORT, { BOTS: '1', FIELD_LEVEL: '4', FIELD_LEVELS: '3', ROOM_SIZE: '10' });
}, 30_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.stop();
});

describe('field levels', () => {
  it('offers each level, the default always among them', async () => {
    const { hello, welcome } = await join({});
    expect(hello.field.level).toBe(4);
    expect(hello.levels?.map((l) => l.level)).toEqual([3, 4]);
    const [three, four] = hello.levels!;
    expect(three.tiles).toBeLessThan(four.tiles);
    expect(hello.tiles).toBe(four.tiles);
    // No level asked for: the default's rooms.
    expect(welcome.field.level).toBe(4);
    expect(welcome.room).toBe('normal-1');
  });

  it('puts a join at another level in rooms of that level, on that field', async () => {
    const a = await join({ level: 3 });
    const b = await join({ level: 3 });
    expect(a.welcome.field.level).toBe(3);
    expect(a.welcome.room).toBe('normal-l3-1');
    expect(b.welcome.room).toBe('normal-l3-1');
    // Its bot plays on the same field: no player of another room is in it.
    expect(b.welcome.players.filter((p) => !p.bot).map((p) => p.id).sort()).toEqual([a.welcome.you, b.welcome.you].sort());
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as { rooms: { id: string; level: number; players: number }[] };
    expect(health.rooms.find((r) => r.id === 'normal-l3-1')).toMatchObject({ level: 3, players: 2 });
  });

  it('a level not on offer gets the default', async () => {
    const { welcome } = await join({ level: 6 });
    expect(welcome.field.level).toBe(4);
    expect(welcome.room).toBe('normal-1');
  });
});
