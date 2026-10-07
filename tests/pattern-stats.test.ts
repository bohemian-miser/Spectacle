/** Pattern stats: stints open, close on a rule change or departure, and fold into rows. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultRule, describeRule, fassRule } from '../shared/game/rule';
import { PatternStats, type PatternStatsFile, type PatternStatsReport, type SampledPlayer, type SampledRoom } from '../server/pattern-stats';
import { startServer, type TestServer } from './server';

const a = defaultRule('hex');
const b = fassRule('hex');

type Mode = 'normal' | 'conquest';
const room = (mode: Mode, players: SampledPlayer[], boardTiles = 1000): SampledRoom => ({ mode, level: 3, boardTiles, players });
const pl = (id: string, rule = a, score = 0, tiles = 0, bot = false): SampledPlayer => ({ id, bot, rule, score, tiles });

describe('PatternStats', () => {
  it('tracks a stint per player and rule, and closes it on change or departure', () => {
    const s = new PatternStats(0);
    expect(s.sample(0, [room('normal', [pl('p1')])])).toEqual([]);
    s.circuit('p1');
    s.sample(5000, [room('normal', [pl('p1', a, 40, 40)])]);
    // Running stints show in the report.
    const live = s.report(5000).rows[0];
    expect(live).toMatchObject({ rule: describeRule(a), live: 1, stints: 1, ms: 5000, peakScore: 40, circuits: 1, finished: 0, peakCoverage: 0.04 });
    // A new rule closes the old stint (score as last seen) and opens another.
    const done = s.sample(6000, [room('normal', [pl('p1', b)])]);
    expect(done).toEqual([{
      mode: 'normal', level: 3, rule: describeRule(a), bot: false, startedAt: 0, ms: 6000, finalScore: 40, peakScore: 40, circuits: 1,
      boardTiles: 1000, peakTiles: 40, peakCoverage: 0.04, won: false, end: 'rule',
    }]);
    // Gone from the sample: closed.
    const gone = s.sample(9000, []);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ rule: describeRule(b), ms: 3000, peakCoverage: 0, end: 'left' });
    const rows = s.report(9000).rows;
    expect(rows.map((r) => r.rule)).toEqual([describeRule(a), describeRule(b)]);
    expect(rows.every((r) => r.live === 0)).toBe(true);
  });

  it('keeps each stint’s peak board coverage, not its last', () => {
    const s = new PatternStats(0);
    s.sample(0, [room('normal', [pl('p1', a, 10, 10)], 200)]);
    s.sample(1000, [room('normal', [pl('p1', a, 50, 50)], 200)]);
    s.sample(2000, [room('normal', [pl('p1', a, 5, 5)], 200)]);
    const [done] = s.sample(3000, []);
    expect(done).toMatchObject({ finalScore: 5, peakTiles: 50, boardTiles: 200, peakCoverage: 0.25 });
    // A second, smaller stint: the row keeps the best and the sum for the mean.
    s.sample(4000, [room('normal', [pl('p2', a, 20, 20)], 200)]);
    s.sample(5000, []);
    const row = s.report(5000).rows[0];
    expect(row.peakCoverage).toBe(0.25);
    expect(row.coverageSum).toBeCloseTo(0.35);
    expect(row.finished).toBe(2);
  });

  it('keeps modes and bots apart, and survives a save and load', () => {
    const s = new PatternStats(0);
    s.sample(0, [room('normal', [pl('p1'), pl('b1', a, 0, 0, true)]), room('conquest', [pl('p2')])]);
    s.sample(1000, []);
    expect(s.report(1000).rows).toHaveLength(3);
    const again = new PatternStats(5000, JSON.parse(JSON.stringify(s.toFile())));
    expect(again.since).toBe(0);
    again.sample(5000, [room('normal', [pl('p9', a, 7, 7)])]);
    again.sample(7000, []);
    const row = again.report(7000).rows.find((r) => r.mode === 'normal' && !r.bot)!;
    expect(row).toMatchObject({ stints: 2, finished: 2, ms: 3000, finalScoreSum: 7, peakCoverage: 0.007 });
  });

  it('counts a won round, and ends every stint in the room with it', () => {
    const s = new PatternStats(0);
    const players = [pl('p1', a, 900, 900), pl('b1', b, 50, 50, true)];
    s.sample(0, [room('normal', players)]);
    s.win('p1');
    s.win('nobody'); // no stint: ignored
    expect(s.report(500).rows.find((r) => !r.bot)?.wins).toBe(1);
    const ended = s.endRound(1000, ['p1', 'b1']);
    expect(ended.map((x) => [x.bot, x.won, x.end, x.peakCoverage])).toEqual([[false, true, 'round', 0.9], [true, false, 'round', 0.05]]);
    // The next round opens new stints for the same players.
    s.sample(2000, [room('normal', [pl('p1'), pl('b1', b, 0, 0, true)])]);
    const rows = s.report(2000).rows;
    expect(rows.find((r) => !r.bot)).toMatchObject({ stints: 2, finished: 1, wins: 1, live: 1 });
    expect(rows.find((r) => r.bot)).toMatchObject({ stints: 2, wins: 0 });
    expect(s.finishAll(3000).every((x) => x.end === 'shutdown' && !x.won)).toBe(true);
  });

  it('loads a file saved before coverage was kept', () => {
    const old = { since: 0, rows: [{ mode: 'normal', rule: describeRule(a), bot: false, stints: 1, ms: 10, peakScore: 3, finalScoreSum: 3, finished: 1, circuits: 0, live: 0, lastPlayedAt: 10 }] };
    const s = new PatternStats(0, old as unknown as PatternStatsFile);
    expect(s.report(0).rows[0]).toMatchObject({ peakCoverage: 0, coverageSum: 0, wins: 0 });
  });
});

describe('/patterns on the real server', () => {
  const PORT = 23000 + Math.floor(Math.random() * 1000);
  const statsFile = join(mkdtempSync(join(tmpdir(), 'spectacle-stats-')), 'stats.json');
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(PORT, { BOTS: '1', FIELD_LEVEL: '3', STATS_FILE: statsFile });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
  });

  const report = async () => (await (await fetch(`http://127.0.0.1:${PORT}/patterns.json`)).json()) as PatternStatsReport;
  const until = async (f: (r: PatternStatsReport) => boolean) => {
    let r = await report();
    for (let i = 0; i < 60 && !f(r); i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      r = await report();
    }
    expect(f(r)).toBe(true);
    return r;
  };

  it('counts a player on their rule, closes the stint when they leave, and saves it on shutdown', async () => {
    const page = await fetch(`http://127.0.0.1:${PORT}/patterns`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('Spectacle patterns');

    const rule = describeRule(defaultRule('hex'));
    const person = (r: PatternStatsReport) => r.rows.find((x) => !x.bot && x.rule === rule && x.mode === 'normal');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'stats', rule: defaultRule('hex'), mode: 'normal' }));
    const live = await until((r) => person(r)?.live === 1);
    expect(person(live)).toMatchObject({ stints: 1, finished: 0 });
    // The room's bot is sampled too, as a bot.
    expect(live.rows.some((x) => x.bot && x.live === 1)).toBe(true);

    ws.send(JSON.stringify({ t: 'leave' }));
    ws.close();
    const done = await until((r) => person(r)?.live === 0);
    expect(person(done)).toMatchObject({ stints: 1, finished: 1 });

    await server.stop();
    const saved = JSON.parse(readFileSync(statsFile, 'utf8')) as PatternStatsFile;
    expect(saved.rows.find((x) => !x.bot && x.rule === rule)).toMatchObject({ stints: 1, finished: 1 });
  }, 30_000);
});

describe('a won round on the real server', () => {
  const PORT = 24000 + Math.floor(Math.random() * 1000);
  let server: TestServer;

  // A win at 0.5% of a level-3 board (3 tiles) comes within seconds; the restart a second later.
  beforeAll(async () => {
    server = await startServer(PORT, { BOTS: 'wanderer:2', FIELD_LEVEL: '3', KNOB_WIN_FRACTION: '0.005', KNOB_WIN_CELEBRATE_MS: '1000' });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
  });

  it('shows the win in /patterns and starts new stints after the restart', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: 'watcher', rule: defaultRule('hex'), mode: 'normal' }));
    let rows: PatternStatsReport['rows'] = [];
    for (let i = 0; i < 150; i++) {
      rows = ((await (await fetch(`http://127.0.0.1:${PORT}/patterns.json`)).json()) as PatternStatsReport).rows;
      // A win, the watcher's stint closed by the round's end, and their next one open.
      if (rows.some((r) => r.wins > 0) && rows.some((r) => !r.bot && r.finished > 0 && r.stints > 1)) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    ws.close();
    expect(rows.some((r) => r.bot && r.wins > 0)).toBe(true);
    const watcher = rows.find((r) => !r.bot)!;
    expect(watcher).toMatchObject({ wins: 0 });
    expect(watcher.finished).toBeGreaterThan(0);
    expect(watcher.stints).toBeGreaterThan(1);
  }, 30_000);
});
