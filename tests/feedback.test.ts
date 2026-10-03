/**
 * Player feedback: what POST /feedback keeps and refuses, its limits, the two
 * stores, what the triage agent may see (nothing for a public issue it
 * shouldn't), and the triage CLI's pull → mark → apply round. Spawns the real
 * server and the real CLI against a directory store.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRule, fassRule } from '../shared/game/rule';
import {
  clientAddress,
  FEEDBACK_ID,
  feedbackId,
  FeedbackLimiter,
  feedbackStore,
  MAX_MESSAGE,
  parseFeedback,
  toTriageItem,
  type FeedbackRecord,
} from '../server/feedback';
import { startServer, type TestServer } from './server';

const noToken = async (): Promise<string | null> => null;

function record(id: string, extra: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return { id, createdAt: '2026-10-02T09:30:00.000Z', message: 'lines vanish', context: {}, server: { instance: 'abc123', revision: 'spectacle-00042' }, ...extra };
}

describe('parseFeedback', () => {
  it('keeps the message, the contact and the known context, and drops the rest', () => {
    const rule = defaultRule('hex');
    const r = parseFeedback({
      message: '  my line stopped  ',
      contact: ' me@example.com ',
      context: { url: 'https://x/?room=a', mode: 'online', rule, viewport: '390x844@3', evil: 'x', room: 5 },
      extra: true,
    });
    expect(r).toEqual({
      message: 'my line stopped',
      contact: 'me@example.com',
      context: { url: 'https://x/?room=a', mode: 'online', rule, viewport: '390x844@3' },
    });
  });

  it('refuses an empty or overlong message and anything but an object', () => {
    expect(parseFeedback({ message: '   ' })).toHaveProperty('error');
    expect(parseFeedback({ message: 'x'.repeat(MAX_MESSAGE + 1) })).toHaveProperty('error');
    expect(parseFeedback([])).toHaveProperty('error');
    expect(parseFeedback('hi')).toHaveProperty('error');
    expect(parseFeedback(null)).toHaveProperty('error');
  });

  it('caps context strings and drops a rule that is not a valid one', () => {
    const r = parseFeedback({ message: 'x', context: { userAgent: 'u'.repeat(5000), rule: { family: 'hex', subset: [1], matching: [999] } } });
    expect('context' in r && r.context.userAgent?.length).toBe(400);
    expect('context' in r && r.context.rule).toBeUndefined();
    expect(parseFeedback({ message: 'x', context: { rule: { family: 'hat', subset: [], matching: [] } } })).toEqual({ message: 'x', context: {} });
  });
});

describe('ids and addresses', () => {
  it('makes ids that sort by time and are safe as names', () => {
    const id = feedbackId(new Date('2026-10-02T09:30:05.123Z'), 'a1b2c3');
    expect(id).toBe('20261002T093005Z-a1b2c3');
    expect(FEEDBACK_ID.test(id)).toBe(true);
    expect(FEEDBACK_ID.test(feedbackId(new Date()))).toBe(true);
    expect(FEEDBACK_ID.test('../etc/passwd')).toBe(false);
  });

  it('counts a report against the first forwarded hop, else the peer', () => {
    expect(clientAddress('203.0.113.7, 10.0.0.1', '10.0.0.2')).toBe('203.0.113.7');
    expect(clientAddress(['198.51.100.1'], undefined)).toBe('198.51.100.1');
    expect(clientAddress(undefined, '::1')).toBe('::1');
    expect(clientAddress(undefined, undefined)).toBe('unknown');
  });
});

describe('FeedbackLimiter', () => {
  it('holds each address to its share and everyone to the total, per window', () => {
    const l = new FeedbackLimiter(2, 3, 1000);
    expect(l.take('a', 0)).toBe(true);
    expect(l.take('a', 1)).toBe(true);
    expect(l.take('a', 2)).toBe(false);
    expect(l.take('b', 3)).toBe(true);
    expect(l.take('c', 4)).toBe(false); // the total is spent
    expect(l.take('a', 1001)).toBe(true); // the first two have aged out
    expect(l.take('c', 1002)).toBe(true);
  });
});

describe('directory store', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('adds, lists oldest first, reads, and settles into triaged/', async () => {
    const s = feedbackStore(dir, noToken);
    await s.add(record('20261002T093001Z-bbbbbb'));
    await s.add(record('20261002T093000Z-aaaaaa'));
    await expect(s.add(record('20261002T093000Z-aaaaaa'))).rejects.toThrow(); // never overwrites
    expect(await s.untriaged()).toEqual(['20261002T093000Z-aaaaaa', '20261002T093001Z-bbbbbb']);
    expect((await s.read('20261002T093001Z-bbbbbb')).message).toBe('lines vanish');
    await s.settle('20261002T093000Z-aaaaaa', { status: 'filed', issue: 7, at: 'now' });
    expect(await s.untriaged()).toEqual(['20261002T093001Z-bbbbbb']);
    const done = JSON.parse(readFileSync(join(dir, 'triaged', '20261002T093000Z-aaaaaa.json'), 'utf8')) as FeedbackRecord;
    expect(done.triage).toEqual({ status: 'filed', issue: 7, at: 'now' });
    await expect(s.read('../x')).rejects.toThrow(/not a feedback id/);
  });
});

describe('Cloud Storage store', () => {
  it('creates only new objects, pages through the list, and moves on settle', async () => {
    const calls: { method: string; url: string; auth: string; body?: string }[] = [];
    const objects = new Map<string, string>([['fb/new/20261002T093000Z-aaaaaa.json', JSON.stringify(record('20261002T093000Z-aaaaaa'))]]);
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, auth: (init.headers as Record<string, string>).Authorization, body: init.body as string | undefined });
      const u = new URL(url);
      if (method === 'POST') objects.set(u.searchParams.get('name')!, init.body as string);
      if (method === 'GET' && u.searchParams.get('alt') === 'media') {
        const name = decodeURIComponent(u.pathname.split('/o/')[1]);
        return new Response(objects.get(name) ?? '', { status: objects.has(name) ? 200 : 404 });
      }
      if (method === 'GET') {
        // Two pages: the first holds a stray object that isn't a report.
        const page = u.searchParams.get('pageToken');
        const items = page ? [{ name: 'fb/new/20261002T093000Z-aaaaaa.json' }] : [{ name: 'fb/new/20261002T093009Z-cccccc.json' }, { name: 'fb/new/notes.txt' }];
        return Response.json({ items, ...(page ? {} : { nextPageToken: 'p2' }) });
      }
      if (method === 'DELETE') objects.delete(decodeURIComponent(u.pathname.split('/o/')[1]));
      return new Response('{}');
    }) as typeof fetch;
    const s = feedbackStore('gs://bucket/fb/', async () => 'tok', fakeFetch);

    await s.add(record('20261002T093009Z-cccccc'));
    const add = calls[0];
    expect(add.method).toBe('POST');
    expect(add.url).toContain('/upload/storage/v1/b/bucket/o?uploadType=media');
    expect(new URL(add.url).searchParams.get('name')).toBe('fb/new/20261002T093009Z-cccccc.json');
    expect(new URL(add.url).searchParams.get('ifGenerationMatch')).toBe('0');
    expect(add.auth).toBe('Bearer tok');

    expect(await s.untriaged()).toEqual(['20261002T093000Z-aaaaaa', '20261002T093009Z-cccccc']);

    await s.settle('20261002T093000Z-aaaaaa', { status: 'skipped', reason: 'test', at: 'now' });
    expect(objects.has('fb/new/20261002T093000Z-aaaaaa.json')).toBe(false);
    expect(JSON.parse(objects.get('fb/triaged/20261002T093000Z-aaaaaa.json')!).triage.reason).toBe('test');

    const offGcp = feedbackStore('gs://bucket', noToken, fakeFetch);
    await expect(offGcp.add(record('20261002T093000Z-dddddd'))).rejects.toThrow(/credentials/);
  });
});

describe('toTriageItem', () => {
  it('never shows the contact, and never names an infinite-line rule', () => {
    const plain = toTriageItem(record('20261002T093000Z-aaaaaa', { contact: 'me@example.com', context: { rule: defaultRule('hex'), mode: 'solo', userAgent: 'UA' } }));
    expect(JSON.stringify(plain)).not.toContain('me@example.com');
    expect(plain.game).toEqual({ mode: 'solo', rule: expect.stringMatching(/^15 · /), browser: 'UA' });
    expect(plain.server).toBe('spectacle-00042');
    for (const family of ['hex', 'spectre'] as const) {
      const fass = fassRule(family);
      const item = toTriageItem(record('20261002T093000Z-aaaaaa', { context: { rule: fass } }));
      expect(item.game.rule).toMatch(/infinite-line rule/);
      expect(JSON.stringify(item)).not.toContain(fass.subset.join(''));
    }
  });
});

describe('POST /feedback on the real server', () => {
  const PORT = 21000 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${PORT}/feedback`;
  let dir: string;
  let server: TestServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-server-'));
    server = await startServer(PORT, { BOTS: '0', FIELD_LEVEL: '3', FEEDBACK_URL: dir, FEEDBACK_PER_ADDRESS: '2' });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('answers a CORS preflight, so the Pages build can post here', async () => {
    const r = await fetch(url, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(url)).status).toBe(405);
  });

  it('keeps a report as new/<id>.json, refuses bad ones, and limits each address', async () => {
    const ok = await post({ message: 'circuit did not score', contact: 'me@example.com', context: { mode: 'online' } });
    expect(ok.status).toBe(200);
    const { id } = (await ok.json()) as { id: string };
    expect(FEEDBACK_ID.test(id)).toBe(true);
    const kept = JSON.parse(readFileSync(join(dir, 'new', `${id}.json`), 'utf8')) as FeedbackRecord;
    expect(kept).toMatchObject({ id, message: 'circuit did not score', contact: 'me@example.com', context: { mode: 'online' } });
    expect(kept.server.instance).toMatch(/^[0-9a-f]{6}$/);

    expect((await post({ message: '' })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ message: 'x'.repeat(20_000) })).status).toBe(413);

    expect((await post({ message: 'second' })).status).toBe(200);
    const third = await post({ message: 'third' });
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toMatch(/try again/);
    // Another address has its own share (the first forwarded hop).
    expect((await post({ message: 'from elsewhere' }, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
    expect(readdirSync(join(dir, 'new'))).toHaveLength(3);
  });
});

describe('triage CLI', () => {
  it('pulls without the contact, marks into the ledger, and applies it to the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedback-cli-'));
    try {
      const s = feedbackStore(join(dir, 'store'), noToken);
      await s.add(record('20261002T093000Z-aaaaaa', { contact: 'me@example.com' }));
      await s.add(record('20261002T093001Z-bbbbbb'));
      await s.add(record('20261002T093002Z-cccccc'));
      const env = { ...process.env, FEEDBACK_URL: join(dir, 'store'), TRIAGE_DIR: join(dir, '.triage') };
      const cli = (...args: string[]) => spawnSync('npx', ['tsx', 'scripts/feedback.ts', ...args], { env, encoding: 'utf8' });

      const pulled = cli('pull', '--limit', '2');
      expect(pulled.status).toBe(0);
      const items = JSON.parse(pulled.stdout) as { id: string }[];
      expect(items.map((i) => i.id)).toEqual(['20261002T093000Z-aaaaaa', '20261002T093001Z-bbbbbb']);
      expect(pulled.stdout).not.toContain('me@example.com');

      expect(cli('mark', '20261002T093000Z-aaaaaa', '--issue', '12').status).toBe(0);
      expect(cli('mark', '20261002T093001Z-bbbbbb', '--skip', 'test message').status).toBe(0);
      expect(cli('mark', '20261002T093002Z-cccccc', '--issue', '3').status).toBe(1); // not pulled
      expect(cli('mark', '20261002T093001Z-bbbbbb', '--issue', 'x').status).toBe(1);
      // Written past `mark`, for a report that was never pulled: apply ignores it.
      appendFileSync(join(dir, '.triage', 'ledger.jsonl'), `${JSON.stringify({ id: '20261002T093002Z-cccccc', status: 'skipped', reason: 'x' })}\n`);

      const applied = cli('apply');
      expect(applied.status).toBe(0);
      expect(await s.untriaged()).toEqual(['20261002T093002Z-cccccc']);
      const filed = JSON.parse(readFileSync(join(dir, 'store', 'triaged', '20261002T093000Z-aaaaaa.json'), 'utf8')) as FeedbackRecord;
      expect(filed.triage).toMatchObject({ status: 'filed', issue: 12 });
      expect(filed.contact).toBe('me@example.com'); // kept in the store, for the owner
      expect(readFileSync(join(dir, '.triage', 'ledger.jsonl'), 'utf8')).toBe('');
      expect(existsSync(join(dir, 'store', 'new', '20261002T093001Z-bbbbbb.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
