/**
 * The permanent stores, with a fake `fetch`: the leaderboard in Firestore
 * (server/firestore.ts) merged with a shard's own wins (server/wins.ts), the
 * stints and wins in BigQuery (server/bigquery.ts), and /patterns' stored
 * totals with the running stints on top (server/pattern-stats.ts).
 */
import { describe, expect, it } from 'vitest';
import { bigQuery } from '../server/bigquery';
import { firestoreWins, type WinsRemote } from '../server/firestore';
import { PatternStats, storedRows } from '../server/pattern-stats';
import { REMOTE_TTL_MS, Wins, type WinRecord } from '../server/wins';
import { defaultRule } from '../shared/game/rule';

const win = (name: string, ms: number, at = ms): WinRecord => ({ mode: 'normal', level: 6, rule: 'hex|15|0.0.0', ms, at, name, bot: false, others: [], named: false });
const token = async () => 'tok';

/** A fetch that records each call and answers with `answer(url, body)`. */
function fakeFetch(answer: (url: string, body: any) => unknown, status = 200) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    return new Response(JSON.stringify(answer(url, body)), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('the leaderboard across shards', () => {
  it('merges the remote board with this shard’s own wins, fastest first, each once', async () => {
    const remote: WinsRemote = { add: async () => {}, top: async () => [win('far', 300), win('mine', 500)] };
    const w = new Wins('', () => {}, { store: remote, shard: 'a' });
    w.add(win('mine', 500)); // won here, and already in the remote
    w.add(win('fresh', 100)); // won here, not in the remote yet
    expect((await w.board('normal', 6)).map((e) => e.name)).toEqual(['fresh', 'far', 'mine']);
  });

  it('asks the remote at most once per TTL, and keeps its last answer when it fails', async () => {
    let asked = 0;
    let fail = false;
    const remote: WinsRemote = {
      add: async () => {},
      top: async () => {
        asked++;
        if (fail) throw new Error('down');
        return [win('far', 300)];
      },
    };
    const errors: unknown[] = [];
    const w = new Wins('', (e) => errors.push(e), { store: remote, shard: 'a' });
    const t = Date.now();
    await w.board('normal', 6, {}, t);
    await w.board('normal', 6, {}, t + 1000);
    expect(asked).toBe(1);
    fail = true;
    expect((await w.board('normal', 6, {}, t + REMOTE_TTL_MS + 1)).map((e) => e.name)).toEqual(['far']);
    expect(asked).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it('writes a win to Firestore and reads the fastest back, filtered by edge set', async () => {
    const f = fakeFetch((url) =>
      url.endsWith(':runQuery')
        ? [{ document: { fields: { mode: { stringValue: 'normal' }, level: { integerValue: '6' }, rule: { stringValue: 'hex|15|0.0.0' }, ms: { integerValue: '42' }, at: { integerValue: '7' }, name: { stringValue: 'ann' }, bot: { booleanValue: true }, others: { arrayValue: { values: [{ stringValue: 'bob' }] } }, named: { booleanValue: false } } } }, { readTime: 'x' }]
        : {},
    );
    const fs = firestoreWins('proj', token, f.fn);
    await fs.add({ ...win('ann', 42), others: ['hexbot'], otherBots: [true] }, 'b');
    expect(f.calls[0].url).toMatch(/projects\/proj\/databases\/\(default\)\/documents\/wins$/);
    expect(f.calls[0].body.fields).toMatchObject({ subset: { stringValue: '15' }, shard: { stringValue: 'b' }, ms: { integerValue: '42' }, company: { stringValue: 'bots' }, otherBots: { arrayValue: { values: [{ booleanValue: true }] } } });
    const top = await fs.top('normal', 6, { subset: '15' }, 20);
    expect(top).toEqual([{ mode: 'normal', level: 6, rule: 'hex|15|0.0.0', ms: 42, at: 7, name: 'ann', bot: true, others: ['bob'], named: false }]);
    const filters = f.calls[1].body.structuredQuery.where.compositeFilter.filters.map((x: any) => x.fieldFilter.field.fieldPath);
    expect(filters).toEqual(['mode', 'level', 'subset']);
    await fs.top('normal', 6, { bots: 'none' }, 20);
    const byBot = f.calls[2].body.structuredQuery.where.compositeFilter.filters;
    expect(byBot.map((x: any) => x.fieldFilter.field.fieldPath)).toEqual(['mode', 'level', 'bot']);
    expect(byBot[2].fieldFilter.value).toEqual({ booleanValue: false });
    await fs.top('normal', 6, { subset: '15', bots: 'only', company: 'alone' }, 20);
    const all = f.calls[3].body.structuredQuery.where.compositeFilter.filters;
    expect(all.map((x: any) => x.fieldFilter.field.fieldPath)).toEqual(['mode', 'level', 'subset', 'bot', 'company']);
    expect(all[4].fieldFilter.value).toEqual({ stringValue: 'alone' });
  });
});

describe('BigQuery', () => {
  it('sends queued rows with their ids, and keeps them for the next flush when a send fails', async () => {
    let status = 500;
    const sent: any[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const bq = bigQuery({ project: 'proj', dataset: 'ds' }, token, (e) => errors.push(e), fn);
    bq.add('stints', 'id1', { a: 1 });
    await bq.flush();
    expect(errors).toHaveLength(1);
    status = 200;
    bq.add('stints', 'id2', { a: 2 });
    await bq.flush();
    expect(sent[1].rows).toEqual([{ insertId: 'id1', json: { a: 1 } }, { insertId: 'id2', json: { a: 2 } }]);
    await bq.flush();
    expect(sent).toHaveLength(2); // nothing left to send
  });

  it('answers a query as rows by column name, with the dataset filled in', async () => {
    const f = fakeFetch(() => ({ jobComplete: true, schema: { fields: [{ name: 'n' }, { name: 'm' }] }, rows: [{ f: [{ v: '3' }, { v: null }] }] }));
    const bq = bigQuery({ project: 'proj', dataset: 'ds' }, token, () => {}, f.fn);
    expect(await bq.query('SELECT 1 FROM {dataset}.stints')).toEqual([{ n: '3', m: null }]);
    expect(f.calls[0].body.query).toBe('SELECT 1 FROM `proj.ds`.stints');
  });
});

describe('/patterns from the stored totals', () => {
  it('adds this process’s running stints to the rows BigQuery keeps', () => {
    const { since, rows } = storedRows([
      { mode: 'normal', rule: '15 · 000000000', bot: 'false', stints: '4', ms: '1000', peakScore: '9', finalScoreSum: '20', finished: '4', circuits: '2', peakCoverage: '0.5', coverageSum: '1', wins: '1', lastPlayedAt: '50', since: '10' },
    ]);
    expect(since).toBe(10);
    const stats = new PatternStats(0);
    const rule = defaultRule('hex');
    stats.sample(100, [{ mode: 'normal', level: 6, boardTiles: 100, players: [{ id: 'p1', bot: false, rule, score: 3, tiles: 1 }] }]);
    stats.sample(600, [{ mode: 'normal', level: 6, boardTiles: 100, players: [{ id: 'p1', bot: false, rule, score: 30, tiles: 60 }] }]);
    const report = stats.withLive(700, since!, rows);
    const r = report.rows.find((x) => x.rule === '15 · 000000000' && !x.bot)!;
    expect(r).toMatchObject({ stints: 5, live: 1, ms: 1500, peakScore: 30, peakCoverage: 0.6, finished: 4, wins: 1 });
    expect(report.since).toBe(10);
  });
});
