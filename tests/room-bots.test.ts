/**
 * Players choose a room's bots (the arena's Bots panel → `bots` message):
 * anyone in the room may, it applies to everyone, and the server caps it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { cleanBotMix } from '../shared/game/bots';
import type { GameEvent, ServerMessage } from '../shared/game/protocol';
import { defaultRule } from '../shared/game/rule';

describe('cleanBotMix', () => {
  const kinds = ['wanderer', 'hunter'];
  it('takes known kinds, whole counts, within the caps', () => {
    expect(cleanBotMix({ wanderer: 2, hunter: 0 }, kinds, 3, 6)).toEqual({ mix: { wanderer: 2 } });
    expect(cleanBotMix({}, kinds, 3, 6)).toEqual({ mix: {} });
    expect(cleanBotMix({ dragon: 1 }, kinds, 3, 6)).toEqual({ refused: 'no such bot: dragon' });
    expect(cleanBotMix({ wanderer: 1.5 }, kinds, 3, 6)).toEqual({ refused: 'bad count for wanderer' });
    expect(cleanBotMix({ wanderer: -1 }, kinds, 3, 6)).toEqual({ refused: 'bad count for wanderer' });
    expect(cleanBotMix({ wanderer: 4 }, kinds, 3, 6)).toEqual({ refused: 'at most 3 of a kind' });
    expect(cleanBotMix({ wanderer: 3, hunter: 3 }, kinds, 3, 5)).toEqual({ refused: 'at most 5 bots in a room' });
    expect(cleanBotMix(null, kinds, 3, 6)).toEqual({ refused: 'no bots given' });
  });
});

describe('a room’s bots, set by its players', () => {
  const PORT = 22000 + Math.floor(Math.random() * 1000);
  let server: ChildProcess;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    server = spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(PORT), BOTS: '1', FIELD_LEVEL: '3', ROOM_MAX_BOTS: '4', ROOM_MAX_BOTS_PER_KIND: '2' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not come up');
  }, 30_000);

  afterAll(() => {
    for (const ws of sockets) ws.close();
    server?.kill();
  });

  async function join(name: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(ws);
    const events: GameEvent[] = [];
    let welcome: Extract<ServerMessage, { t: 'welcome' }> | null = null;
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'welcome') welcome = m;
      if (m.t === 'events') events.push(...m.ev);
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name, rule: defaultRule('hex'), room: 'botlab' }));
    for (let i = 0; i < 50 && !welcome; i++) await new Promise((r) => setTimeout(r, 50));
    return { ws, events, welcome: welcome! };
  }

  const until = async (f: () => boolean) => {
    for (let i = 0; i < 60 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(f()).toBe(true);
  };

  it('anyone in the room changes them for everyone; the server caps and paces it', async () => {
    const a = await join('ann');
    const b = await join('bob');
    expect(a.welcome.bots).toMatchObject({ mix: { wanderer: 1 }, maxPerKind: 2, max: 4 });
    expect(a.welcome.bots!.kinds.map((k) => k.kind)).toContain('hunter');
    const wanderer = a.welcome.players.find((p) => p.bot)!;

    a.ws.send(JSON.stringify({ t: 'bots', mix: { wanderer: 0, hunter: 2 } }));
    const botsEvent = () => b.events.find((e): e is Extract<GameEvent, { t: 'bots' }> => e.t === 'bots');
    await until(() => !!botsEvent());
    expect(botsEvent()).toMatchObject({ by: a.welcome.you, bots: { mix: { hunter: 2 } } });
    // Bob saw the wanderer leave and two hunters join.
    expect(b.events.some((e) => e.t === 'leave' && e.id === wanderer.id)).toBe(true);
    expect(b.events.filter((e) => e.t === 'join' && e.player.bot).map((e) => (e as Extract<GameEvent, { t: 'join' }>).player.name)).toEqual(['Hunter', 'Hunter 2']);

    // Straight away again: too soon. Then over the caps.
    a.ws.send(JSON.stringify({ t: 'bots', mix: { hunter: 1 } }));
    await until(() => a.events.some((e) => e.t === 'refused' && e.reason === 'one bot change a second'));
    b.ws.send(JSON.stringify({ t: 'bots', mix: { hunter: 3 } }));
    await until(() => b.events.some((e) => e.t === 'refused' && e.reason === 'at most 2 of a kind'));
    await new Promise((r) => setTimeout(r, 1000));
    b.ws.send(JSON.stringify({ t: 'bots', mix: { hunter: 2, farmer: 2, wanderer: 1 } }));
    await until(() => b.events.some((e) => e.t === 'refused' && e.reason === 'at most 4 bots in a room'));

    // Someone joining later finds the room as its players left it.
    const c = await join('cat');
    expect(c.welcome.bots!.mix).toEqual({ hunter: 2 });
    expect(c.welcome.players.filter((p) => p.bot).map((p) => p.name)).toEqual(['Hunter', 'Hunter 2']);
  }, 30_000);
});
