/**
 * The leaderboard (server/wins.ts): the fastest wins per mode and size, all
 * edge sets or one, kept across a restart in WINS_FILE; and a spawned server
 * recording a real win and serving it on GET /wins.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, WinEntry } from '../shared/game/protocol';
import { defaultRule, ruleFromCombo, ruleKey, type PlayerRule } from '../shared/game/rule';
import { companyOf, parseWinsQuery, TOP, Wins, type WinRecord } from '../server/wins';
import { formatWinTime, opponentCount, opponents, ruleFromKey } from '../client/src/Leaderboard';
import { startServer, type TestServer } from './server';

const R15 = ruleKey(defaultRule('hex'));
const R258 = ruleKey(ruleFromCombo('hex', '258', '000000000'));
const win = (ms: number, name = 'a', extra: Partial<WinRecord> = {}): WinRecord => ({
  mode: 'normal',
  level: 3,
  rule: R15,
  ms,
  at: 1000 + ms,
  name,
  bot: false,
  others: ['hexbot'],
  named: false,
  ...extra,
});

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wins-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the board', () => {
  it('lists the fastest TOP at a mode and size, fastest first', () => {
    const w = new Wins();
    for (let i = 0; i < TOP + 5; i++) w.add(win(10_000 - i * 100, `p${i}`));
    w.add(win(1, 'other size', { level: 4 }));
    w.add(win(1, 'other mode', { mode: 'conquest' }));
    const top = w.top('normal', 3);
    expect(top).toHaveLength(TOP);
    expect(top[0].name).toBe(`p${TOP + 4}`);
    expect(top.map((e) => e.ms)).toEqual([...top.map((e) => e.ms)].sort((a, b) => a - b));
    expect(w.top('normal', 4).map((e) => e.name)).toEqual(['other size']);
  });

  it('filters by edge set', () => {
    const w = new Wins();
    w.add(win(3000, 'fifteen'));
    w.add(win(2000, 'two-five-eight', { rule: R258 }));
    expect(w.top('normal', 3).map((e) => e.name)).toEqual(['two-five-eight', 'fifteen']);
    expect(w.top('normal', 3, { subset: '15' }).map((e) => e.name)).toEqual(['fifteen']);
    expect(w.top('normal', 3, { subset: '258' })[0]).toEqual({ rule: R258, ms: 2000, at: 3000, name: 'two-five-eight', bot: false, others: ['hexbot'] });
    expect(w.top('normal', 3, { subset: '0136' })).toEqual([]);
  });

  it("filters by who won: bots' wins only, people's only, or everyone's", () => {
    const w = new Wins();
    w.add(win(3000, 'person'));
    w.add(win(2000, 'hexbot', { bot: true }));
    w.add(win(1000, 'Bridge', { bot: true, rule: R258 }));
    expect(w.top('normal', 3).map((e) => e.name)).toEqual(['Bridge', 'hexbot', 'person']);
    expect(w.top('normal', 3, { bots: 'only' }).map((e) => e.name)).toEqual(['Bridge', 'hexbot']);
    expect(w.top('normal', 3, { bots: 'none' }).map((e) => e.name)).toEqual(['person']);
    expect(w.top('normal', 3, { subset: '15', bots: 'only' }).map((e) => e.name)).toEqual(['hexbot']);
  });

  it('filters by who else was there: nobody, bots only, not just bots, or anyone', () => {
    const w = new Wins();
    w.add(win(4000, 'with people', { others: ['hexbot', 'Mitch'], otherBots: [true, false] }));
    w.add(win(3000, 'with bots', { others: ['hexbot', 'Bridge'], otherBots: [true, true] }));
    w.add(win(2000, 'alone', { others: [], otherBots: [] }));
    w.add(win(1000, 'unknown company')); // recorded before otherBots: counts as people
    expect(w.top('normal', 3).map((e) => e.name)).toEqual(['unknown company', 'alone', 'with bots', 'with people']);
    expect(w.top('normal', 3, { company: 'alone' }).map((e) => e.name)).toEqual(['alone']);
    expect(w.top('normal', 3, { company: 'bots' }).map((e) => e.name)).toEqual(['with bots']);
    expect(w.top('normal', 3, { company: 'bots' })[0].otherBots).toEqual([true, true]);
    expect(w.top('normal', 3, { company: 'notbots' }).map((e) => e.name)).toEqual(['unknown company', 'alone', 'with people']);
    expect(companyOf({ others: ['a'], otherBots: [true] })).toBe('bots');
    expect(companyOf({ others: ['a'] })).toBe('people');
  });

  it("lists and counts a round's opponents, the winner left out", () => {
    const ann = { rule: R15, ms: 1, at: 1, name: 'ann', bot: false };
    expect(opponents({ ...ann, others: ['hexbot', 'bob'], otherBots: [true, false] })).toEqual([{ name: 'hexbot', bot: true, n: 1 }, { name: 'bob', bot: false, n: 1 }]);
    expect(opponents({ ...ann, others: ['bot', 'bot', 'bot'], otherBots: [true, true, true] })).toEqual([{ name: 'bot', bot: true, n: 3 }]);
    expect(opponentCount({ ...ann, others: ['hexbot', 'bob', 'Bridge'], otherBots: [true, false, true] })).toEqual({ people: 1, bots: 2 });
    expect(opponentCount({ ...ann, bot: true, others: [] })).toEqual({ people: 0, bots: 0 });
    expect(opponentCount({ ...ann, others: ['bob'] })).toBeNull(); // recorded before otherBots
  });

  it('reads its file back, skipping a line that is not a win', async () => {
    const path = join(tmp(), 'wins.jsonl');
    const w = new Wins(path);
    w.add(win(4000));
    w.add(win(2000, 'b'));
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path, '{"cut short\n' + JSON.stringify({ ...win(1), ms: -5 }) + '\n', { flag: 'a' });
    expect(new Wins(path).top('normal', 3).map((e) => e.name)).toEqual(['b', 'a']);
  });

  it('takes a mode, a level and maybe an edge set and whose wins, nothing else', () => {
    const q = (s: string) => parseWinsQuery(new URLSearchParams(s));
    expect(q('mode=normal&level=3')).toEqual({ mode: 'normal', level: 3, filter: { subset: '', bots: 'all', company: 'all' } });
    expect(q('mode=normal&level=3&subset=258&bots=only')).toEqual({ mode: 'normal', level: 3, filter: { subset: '258', bots: 'only', company: 'all' } });
    expect(q('mode=normal&level=3&company=bots')?.filter.company).toBe('bots');
    expect(q('mode=normal&level=3&company=notbots')?.filter.company).toBe('notbots');
    expect(q('mode=normal&level=3&company=people')).toBeNull();
    expect(q('mode=normal&level=3&bots=none')?.filter.bots).toBe('none');
    expect(q('mode=normal&level=3&bots=some')).toBeNull();
    expect(q('level=3')).toBeNull();
    expect(q('mode=normal&level=x')).toBeNull();
    expect(q('mode=normal&level=3&subset=2"5')).toBeNull();
  });

  it('shows times as m:ss, h:mm:ss past an hour; a row\'s rule comes back from its key', () => {
    expect(formatWinTime(74_050)).toBe('1:14');
    expect(formatWinTime(3_725_000)).toBe('1:02:05');
    const rule = ruleFromCombo('hex', '01234568', '302114041');
    expect(ruleFromKey(ruleKey(rule), 'hex')).toEqual(rule);
    expect(ruleFromKey('hex|15|9.9', 'hex')).toBeNull();
  });
});

describe('a real win', () => {
  const PORT = 19000 + Math.floor(Math.random() * 1000);
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];
  const path = join(tmp(), 'wins.jsonl');
  // A round is won at 2% of the 496-tile board: seconds, not minutes.
  const env = { BOTS: '1', FIELD_LEVEL: '3', WINS_FILE: path, KNOB_WIN_FRACTION: '0.02' };
  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await server?.stop();
  });

  const get = async (query: string): Promise<{ status: number; wins?: WinEntry[] }> => {
    const r = await fetch(`http://127.0.0.1:${PORT}/wins?${query}`);
    return { status: r.status, ...(r.ok ? ((await r.json()) as { wins: WinEntry[] }) : {}) };
  };

  it('is kept with its time, rule and who was there, and outlives a restart', async () => {
    server = await startServer(PORT, env);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(ws);
    let players: { id: string; name: string; bot: boolean; rule: PlayerRule }[] = [];
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
    const other = players.find((p) => p !== winner)!;

    const first = await get('mode=normal&level=3');
    expect(first.wins).toHaveLength(1);
    expect(first.wins![0]).toMatchObject({ rule: ruleKey(winner.rule), name: winner.name, others: [other.name], otherBots: [other.bot] });
    expect(first.wins![0].ms).toBeGreaterThan(0);
    expect((await get(`mode=normal&level=3&subset=${winner.rule.subset.join('')}`)).wins).toEqual(first.wins);
    expect((await get(`mode=normal&level=3&bots=${winner.bot ? 'only' : 'none'}`)).wins).toEqual(first.wins);
    expect((await get(`mode=normal&level=3&bots=${winner.bot ? 'none' : 'only'}`)).wins).toEqual([]);
    expect((await get(`mode=normal&level=3&company=${other.bot ? 'bots' : 'alone'}`)).wins).toEqual(other.bot ? first.wins : []);
    expect((await get('mode=normal&level=3&company=alone')).wins).toEqual([]);
    expect((await get('mode=normal&level=3&company=people')).status).toBe(400);
    // Only the sizes this server offers (level 3 alone here).
    expect((await get('mode=normal&level=4')).status).toBe(400);

    ws.close();
    await server.stop();
    server = await startServer(PORT, env);
    expect((await get('mode=normal&level=3')).wins).toEqual(first.wins);
  }, 60_000);
});
