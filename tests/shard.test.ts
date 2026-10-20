/**
 * Server integration: a shard (shared/game/shard.ts). Its hello says which
 * shard it is and how to reach the others, its ids name it, and once full it
 * refuses a new player with the next shard to try — except a link into a
 * room already open there. Spawns the real server with a cap of one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';
import { cleanShardName, shardWsUrl, validShardTemplate } from '../shared/game/shard';
import { startServer, type TestServer } from './server';

// Clear of the other spawning tests' port ranges: vitest runs files in parallel.
const PORT = 26000 + Math.floor(Math.random() * 1000);
let server: TestServer;
const sockets: WebSocket[] = [];

/** Open a socket; resolve with it and its hello. */
async function connect(): Promise<{ ws: WebSocket; hello: Extract<ServerMessage, { t: 'hello' }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(ws);
  const hello = await new Promise<ServerMessage>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)) as ServerMessage)));
  if (hello.t !== 'hello') throw new Error('expected hello first');
  return { ws, hello };
}

async function join(ws: WebSocket, extra: Record<string, unknown> = {}): Promise<ServerMessage> {
  const msg = new Promise<ServerMessage>((resolve) => {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'welcome' || m.t === 'error') resolve(m);
    });
  });
  ws.send(JSON.stringify({ t: 'join', name: 'x', rule: defaultRule('hex'), ...extra }));
  return msg;
}

beforeAll(async () => {
  server = await startServer(PORT, {
    BOTS: '0',
    FIELD_LEVEL: '3',
    MAX_INSTANCE_PLAYERS: '1',
    SHARD: 'a',
    SHARD_NEXT: 'b',
    SHARD_WS: 'wss://{shard}.s.example.test/ws',
  });
}, 30_000);

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.stop();
});

describe('shard helpers', () => {
  it('cleans names and fills the template', () => {
    expect(cleanShardName('b')).toBe('b');
    expect(cleanShardName('B')).toBeNull();
    expect(cleanShardName('evil.host')).toBeNull();
    expect(validShardTemplate('wss://{shard}.s.hexagon.rodeo/ws')).toBe(true);
    expect(validShardTemplate('https://{shard}.x/ws')).toBe(false);
    expect(shardWsUrl('wss://{shard}.s.hexagon.rodeo/ws', 'c')).toBe('wss://c.s.hexagon.rodeo/ws');
  });
});

describe('a full shard', () => {
  it('names itself, then hands new players on to the next shard', async () => {
    const first = await connect();
    expect(first.hello.shard).toEqual({ name: 'a', next: 'b', template: 'wss://{shard}.s.example.test/ws' });
    const w = (await join(first.ws, { room: 'friends' })) as Extract<ServerMessage, { t: 'welcome' }>;
    expect(w.t).toBe('welcome');
    expect(w.you.startsWith('a')).toBe(true);

    const second = await connect();
    expect(await join(second.ws)).toMatchObject({ t: 'error', code: 'full', next: 'b' });

    // A link into the room already open here gets in: the next shard's "friends" isn't this one.
    const third = await connect();
    expect(await join(third.ws, { room: 'friends' })).toMatchObject({ t: 'welcome' });
  });
});
