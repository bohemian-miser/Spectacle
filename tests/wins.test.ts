/**
 * The leaderboard's records (server/wins.ts): each board keeps its fastest
 * five, a file of wins survives a restart, Firestore is spoken to as its REST
 * API expects, and a spawned server records a real win and serves it on
 * GET /wins.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/game/protocol';
import { defaultRule, ruleKey } from '../shared/game/rule';
import {
  boardKey,
  FileWinStore,
  FirestoreWinStore,
  parseFirestoreUrl,
  parseWinsQuery,
  STORE_TTL_MS,
  TOP,
  WinBoards,
  Wins,
  type WinEntry,
  type WinRecord,
  type WinStore,
} from '../server/wins';
import { formatWinTime } from '../client/src/TopWins';
import { startServer, type TestServer } from './server';

const RULE = ruleKey(defaultRule('hex'));
const win = (ms: number, name = 'a', extra: Partial<WinRecord> = {}): WinRecord => ({
  mode: 'normal',
  level: 3,
  rule: RULE,
  ms,
  at: 1000 + ms,
  name,
  bot: false,
  others: ['hexbot'],
  named: false,
  ...extra,
});
const KEY = boardKey('normal', 3, RULE);

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wins-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('boards', () => {
  it('keeps the fastest TOP per board, fastest first, boards apart', () => {
    const b = new WinBoards();
    for (const ms of [9000, 3000, 7000, 1000, 5000, 8000, 2000]) b.add(win(ms));
    b.add(win(500, 'other size', { level: 4 }));
    b.add(win(400, 'other mode', { mode: 'conquest' }));
    expect(b.top(KEY).map((e) => e.ms)).toEqual([1000, 2000, 3000, 5000, 7000]);
    expect(b.top(KEY)).toHaveLength(TOP);
    expect(b.top(boardKey('normal', 4, RULE)).map((e) => e.name)).toEqual(['other size']);
  });

  it('a board from the store folds in without doubling what is already here', () => {
    const b = new WinBoards();
    b.add(win(3000));
    const fromStore: WinEntry = { ms: 2000, at: 5, name: 'b', bot: true, others: [], named: false };
    b.merge(KEY, [fromStore, { ms: 3000, at: 1000 + 3000, name: 'a', bot: false, others: ['hexbot'], named: false }]);
    expect(b.top(KEY).map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('the query', () => {
  it('takes a mode, a level and a rule key, nothing else', () => {
    const q = (s: string) => parseWinsQuery(new URLSearchParams(s));
    expect(q(`mode=normal&level=3&rule=${encodeURIComponent(RULE)}`)).toEqual({ mode: 'normal', level: 3, rule: RULE });
    expect(q(`level=3&rule=${encodeURIComponent(RULE)}`)?.mode).toBe('normal');
    expect(q(`mode=normal&level=x&rule=${encodeURIComponent(RULE)}`)).toBeNull();
    expect(q(`mode=chaos&level=3&rule=${encodeURIComponent(RULE)}`)).toBeNull();
    expect(q('mode=normal&level=3&rule=hex|15|0.0"}')).toBeNull();
    expect(q('mode=normal&level=3')).toBeNull();
  });

  it('names Firestore as firestore://project[/collection]', () => {
    expect(parseFirestoreUrl('firestore://spectacle-game')).toEqual({ project: 'spectacle-game', collection: 'wins' });
    expect(parseFirestoreUrl('firestore://p/records')).toEqual({ project: 'p', collection: 'records' });
    expect(parseFirestoreUrl('/data/wins.jsonl')).toBeNull();
  });

  it('shows times as m:ss, and h:mm:ss past an hour', () => {
    expect(formatWinTime(74_050)).toBe('1:14');
    expect(formatWinTime(5_000)).toBe('0:05');
    expect(formatWinTime(3_725_000)).toBe('1:02:05');
  });
});

describe('a file of wins', () => {
  it('reads back what it kept, and skips a line that is not a win', async () => {
    const path = join(tmp(), 'wins.jsonl');
    const store = new FileWinStore(path);
    await store.add(win(4000));
    await store.add(win(2000, 'b'));
    writeFileSync(path, '{"cut short\n', { flag: 'a' });
    writeFileSync(path, JSON.stringify({ ...win(1), ms: -5 }) + '\n', { flag: 'a' });
    const again = new Wins(new FileWinStore(path));
    again.preload(new FileWinStore(path).load());
    expect((await again.top(KEY)).map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('Firestore', () => {
  it('posts one document per win and queries a board by time', async () => {
    const calls: { url: string; body: unknown; auth: string | undefined }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
      if (url.endsWith(':runQuery')) {
        return new Response(
          JSON.stringify([
            { readTime: 'x' },
            { document: { fields: { ms: { integerValue: '2500' }, at: { integerValue: '9' }, name: { stringValue: 'b' }, bot: { booleanValue: true }, others: { arrayValue: { values: [{ stringValue: 'x' }] } }, named: { booleanValue: false } } } },
            { document: { fields: { ms: { integerValue: 'NaN' } } } },
          ]),
        );
      }
      return new Response('{}');
    }) as unknown as typeof fetch;
    const store = new FirestoreWinStore('proj', 'wins', async () => 'tok', fake);
    await store.add(win(3000));
    const top = await store.top(KEY);
    const base = 'https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents';
    expect(calls[0].url).toBe(`${base}/wins`);
    expect(calls[0].auth).toBe('Bearer tok');
    const fields = (calls[0].body as { fields: Record<string, unknown> }).fields;
    expect(fields.board).toEqual({ stringValue: KEY });
    expect(fields.ms).toEqual({ integerValue: '3000' });
    expect(fields.others).toEqual({ arrayValue: { values: [{ stringValue: 'hexbot' }] } });
    expect(calls[1].url).toBe(`${base}:runQuery`);
    const sq = (calls[1].body as { structuredQuery: Record<string, unknown> }).structuredQuery;
    expect(sq.where).toEqual({ fieldFilter: { field: { fieldPath: 'board' }, op: 'EQUAL', value: { stringValue: KEY } } });
    expect(sq.orderBy).toEqual([{ field: { fieldPath: 'ms' }, direction: 'ASCENDING' }]);
    expect(sq.limit).toBe(TOP);
    expect(top).toEqual([{ ms: 2500, at: 9, name: 'b', bot: true, others: ['x'], named: false }]);
  });

  it('asks the store at most once a TTL per board, and answers from memory when it fails', async () => {
    let now = 0;
    let asked = 0;
    let fail = false;
    const store: WinStore = {
      add: async () => {},
      top: async () => {
        asked++;
        if (fail) throw new Error('down');
        return [{ ms: 100, at: 1, name: 'elsewhere', bot: false, others: [], named: false }];
      },
    };
    const errors: string[] = [];
    const wins = new Wins(store, (what) => errors.push(what), () => now);
    wins.add(win(5000, 'here'));
    expect((await wins.top(KEY)).map((e) => e.name)).toEqual(['elsewhere', 'here']);
    await wins.top(KEY);
    expect(asked).toBe(1);
    now += STORE_TTL_MS + 1;
    fail = true;
    expect((await wins.top(KEY)).map((e) => e.name)).toEqual(['elsewhere', 'here']);
    await wins.top(KEY);
    expect(asked).toBe(2);
    expect(errors).toEqual(['read wins']);
  });
});

describe('a real win', () => {
  const PORT = 19000 + Math.floor(Math.random() * 1000);
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];
  const path = join(tmp(), 'wins.jsonl');
  // A round is won at 2% of the 496-tile board: seconds, not minutes.
  const env = { BOTS: '1', FIELD_LEVEL: '3', WINS_URL: path, KNOB_WIN_FRACTION: '0.02' };
  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await server?.stop();
  });

  const get = async (rule: string, level = 3): Promise<{ status: number; wins?: WinEntry[] }> => {
    const r = await fetch(`http://127.0.0.1:${PORT}/wins?mode=normal&level=${level}&rule=${encodeURIComponent(rule)}`);
    return { status: r.status, ...(r.ok ? ((await r.json()) as { wins: WinEntry[] }) : {}) };
  };

  it('is kept with its time and who was there, and outlives a restart', async () => {
    server = await startServer(PORT, env);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(ws);
    let players: { id: string; name: string; rule: Parameters<typeof ruleKey>[0] }[] = [];
    const won = new Promise<string>((resolve) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        if (m.t === 'welcome') players = [...m.players];
        if (m.t === 'events') {
          for (const e of m.ev) {
            if (e.t === 'join') players.push(e.player);
            if (e.t === 'win') resolve(e.id);
          }
        }
      });
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'tester', rule: defaultRule('hex') }));
    const winnerId = await won;
    const winner = players.find((p) => p.id === winnerId)!;
    const other = players.find((p) => p.id !== winnerId)!;
    const rule = ruleKey(winner.rule);

    const first = await get(rule);
    expect(first.status).toBe(200);
    expect(first.wins).toHaveLength(1);
    expect(first.wins![0].name).toBe(winner.name);
    expect(first.wins![0].others).toEqual([other.name]);
    expect(first.wins![0].ms).toBeGreaterThan(0);
    expect((await get(rule, 4)).wins).toEqual([]);
    expect((await get('hex|15|0"')).status).toBe(400);

    ws.close();
    await server.stop();
    server = await startServer(PORT, env);
    expect((await get(rule)).wins).toEqual(first.wins);
  }, 60_000);
});
