/**
 * Player feedback, the server half: what POST /feedback accepts, how often,
 * and where a report waits until the triage workflow
 * (.github/workflows/feedback-triage.yml) has turned it into a GitHub issue.
 *
 * One JSON object per report under FEEDBACK_URL: `new/<id>.json` until it is
 * triaged, then `triaged/<id>.json` with the outcome added. `gs://bucket/prefix`
 * keeps them in Cloud Storage (the server's service account may only create
 * objects there); a plain path is a directory (dev, the VM).
 * scripts/feedback.ts is the triage half. It reads reports through
 * `toTriageItem`, which leaves out what must not reach a public issue tracker.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRule, isInfiniteLineRule, PLAYABLE_FAMILIES, validateRule, type PlayerRule } from '../shared/game/rule';
import type { TileFamilyId } from '../shared/tiles';
import { parseGsUrl } from './gcp';

/** The longest message kept; the client's textarea stops at the same length. */
export const MAX_MESSAGE = 4000;
/** A request body past this is refused unread. */
export const MAX_BODY = 16 * 1024;
const MAX_CONTACT = 200;
const MAX_FIELD = 400;

/** Where the player was, as the client tells it. All optional; anything else sent is dropped. */
export interface FeedbackContext {
  readonly url?: string;
  /** `online` | `solo`. */
  readonly mode?: string;
  /** `normal` | `conquest`. */
  readonly gameMode?: string;
  readonly room?: string;
  /** The board, e.g. `hex level 6`. */
  readonly field?: string;
  /** The rule they were drawing with. */
  readonly rule?: PlayerRule;
  readonly theme?: string;
  /** `webgl2` | `canvas2d`. */
  readonly renderer?: string;
  /** CSS pixels and device pixel ratio, e.g. `390x844@3`. */
  readonly viewport?: string;
  readonly userAgent?: string;
}

const CONTEXT_STRINGS = ['url', 'mode', 'gameMode', 'room', 'field', 'theme', 'renderer', 'viewport', 'userAgent'] as const;

export type Triage =
  | { readonly status: 'filed'; readonly issue: number; readonly at: string }
  | { readonly status: 'skipped'; readonly reason: string; readonly at: string };

export interface FeedbackRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly message: string;
  /** How to reach the reporter, if they left one. Stays in the store (see toTriageItem). */
  readonly contact?: string;
  readonly context: FeedbackContext;
  /** Which server took it: the instance and its Cloud Run revision (the deploy). */
  readonly server: { readonly instance: string; readonly revision: string | null };
  /** Added when the report moves to triaged/. */
  readonly triage?: Triage;
}

export type FeedbackInput = Pick<FeedbackRecord, 'message' | 'contact' | 'context'>;

/** A POST body → what is kept of it, or why it was refused (shown to the player). */
export function parseFeedback(body: unknown): FeedbackInput | { readonly error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object.' };
  const b = body as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) return { error: 'Please write something first.' };
  if (message.length > MAX_MESSAGE) return { error: `Please keep it under ${MAX_MESSAGE} characters.` };
  const contact = typeof b.contact === 'string' ? b.contact.trim().slice(0, MAX_CONTACT) : '';
  return { message, ...(contact ? { contact } : {}), context: cleanContext(b.context) };
}

function cleanContext(raw: unknown): FeedbackContext {
  if (!raw || typeof raw !== 'object') return {};
  const c = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof FeedbackContext]: FeedbackContext[K] } = {};
  for (const k of CONTEXT_STRINGS) {
    const v = c[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, MAX_FIELD);
  }
  const family = (c.rule as { family?: unknown } | null)?.family;
  const rule = PLAYABLE_FAMILIES.includes(family as TileFamilyId) ? validateRule(c.rule, family as TileFamilyId) : null;
  if (rule) out.rule = rule;
  return out;
}

/** `20261002T093000Z-1a2b3c`: sorts by time, and is safe as a file or object name. */
export function feedbackId(now: Date, rand = randomBytes(3).toString('hex')): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}-${rand}`;
}

export const FEEDBACK_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function checkId(id: string): string {
  if (!FEEDBACK_ID.test(id)) throw new Error(`not a feedback id: ${JSON.stringify(id)}`);
  return id;
}

/**
 * The address a report counts against: the first X-Forwarded-For hop (the
 * client, behind Cloud Run's front end or Caddy), else the socket's peer.
 * The header can be forged, which only dodges the per-address limit: the
 * total one still holds.
 */
export function clientAddress(forwarded: string | string[] | undefined, peer: string | undefined): string {
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
  return (first || peer || 'unknown').slice(0, 64);
}

/**
 * At most `perAddress` reports from one address and `total` from everyone in
 * any `windowMs`, per server process. Feedback is anonymous and every report
 * costs an agent's attention, so these stay small.
 */
export class FeedbackLimiter {
  private readonly byAddress = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    readonly perAddress: number,
    readonly total: number,
    readonly windowMs: number,
  ) {}

  /** Count a report from `address` at `now`, if both limits allow it. */
  take(address: string, now: number): boolean {
    const since = now - this.windowMs;
    this.all = this.all.filter((t) => t > since);
    const mine = (this.byAddress.get(address) ?? []).filter((t) => t > since);
    if (mine.length >= this.perAddress || this.all.length >= this.total) return false;
    mine.push(now);
    this.all.push(now);
    this.byAddress.set(address, mine);
    // Only accepted reports add addresses, so this stays near `total`.
    if (this.byAddress.size > 4 * this.total) {
      for (const [a, ts] of this.byAddress) if (!ts.some((t) => t > since)) this.byAddress.delete(a);
    }
    return true;
  }
}

/** Where reports are kept: a bucket prefix or a directory, the same layout in both. */
export interface FeedbackStore {
  /** Keep a new report; never overwrites one. */
  add(record: FeedbackRecord): Promise<void>;
  /** Ids of the reports not triaged yet, oldest first. */
  untriaged(): Promise<string[]>;
  /** An untriaged report. */
  read(id: string): Promise<FeedbackRecord>;
  /** Move a report to triaged/ with its outcome. */
  settle(id: string, triage: Triage): Promise<void>;
}

/** `gs://bucket/prefix` → Cloud Storage with `token`'s credentials; anything else is a directory. */
export function feedbackStore(base: string, token: () => Promise<string | null>, fetchFn: typeof fetch = fetch): FeedbackStore {
  const gs = parseGsUrl(base);
  return gs ? gcsStore(gs.bucket, gs.prefix, token, fetchFn) : dirStore(base);
}

function dirStore(root: string): FeedbackStore {
  const file = (where: 'new' | 'triaged', id: string): string => join(root, where, `${checkId(id)}.json`);
  const read = async (id: string): Promise<FeedbackRecord> => JSON.parse(readFileSync(file('new', id), 'utf8')) as FeedbackRecord;
  return {
    async add(record) {
      mkdirSync(join(root, 'new'), { recursive: true });
      writeFileSync(file('new', record.id), JSON.stringify(record, null, 2), { flag: 'wx' });
    },
    async untriaged() {
      let names: string[];
      try {
        names = readdirSync(join(root, 'new'));
      } catch {
        return [];
      }
      return names
        .map((f) => f.replace(/\.json$/, ''))
        .filter((id) => FEEDBACK_ID.test(id))
        .sort();
    },
    read,
    async settle(id, triage) {
      const record = await read(id);
      mkdirSync(join(root, 'triaged'), { recursive: true });
      writeFileSync(file('triaged', id), JSON.stringify({ ...record, triage }, null, 2));
      unlinkSync(file('new', id));
    },
  };
}

function gcsStore(bucket: string, prefix: string, token: () => Promise<string | null>, fetchFn: typeof fetch): FeedbackStore {
  const dir = (where: 'new' | 'triaged'): string => `${prefix ? `${prefix}/` : ''}${where}/`;
  const object = (where: 'new' | 'triaged', id: string): string => `${dir(where)}${checkId(id)}.json`;
  const api = `https://storage.googleapis.com/storage/v1/b/${bucket}/o`;
  const call = async (method: string, url: string, body?: string): Promise<Response> => {
    const t = await token();
    if (!t) throw new Error('no Google Cloud credentials to reach the feedback bucket');
    const r = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${method} ${url.replace(/\?.*$/, '')}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`.trim());
    return r;
  };
  // ifGenerationMatch=0: only if no such object yet, which is all the
  // server's create-only role would allow anyway.
  const upload = (name: string, record: FeedbackRecord, onlyNew: boolean): Promise<Response> =>
    call(
      'POST',
      `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}${onlyNew ? '&ifGenerationMatch=0' : ''}`,
      JSON.stringify(record, null, 2),
    );
  const read = async (id: string): Promise<FeedbackRecord> =>
    (await (await call('GET', `${api}/${encodeURIComponent(object('new', id))}?alt=media`)).json()) as FeedbackRecord;
  return {
    async add(record) {
      await upload(object('new', record.id), record, true);
    },
    async untriaged() {
      const ids: string[] = [];
      let page = '';
      do {
        const q = `prefix=${encodeURIComponent(dir('new'))}&fields=${encodeURIComponent('items(name),nextPageToken')}`;
        const r = await call('GET', `${api}?${q}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
        const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const { name } of j.items ?? []) {
          const id = name.slice(dir('new').length).replace(/\.json$/, '');
          if (FEEDBACK_ID.test(id)) ids.push(id);
        }
        page = j.nextPageToken ?? '';
      } while (page);
      return ids.sort();
    },
    read,
    async settle(id, triage) {
      const record = await read(id);
      await upload(object('triaged', id), { ...record, triage }, false);
      await call('DELETE', `${api}/${encodeURIComponent(object('new', id))}`);
    },
  };
}

/** What the triage agent is shown of a report. */
export interface TriageItem {
  readonly id: string;
  readonly createdAt: string;
  readonly message: string;
  readonly page: string;
  /** Where the player was: mode, room, board, rule, theme, renderer, viewport, browser. */
  readonly game: Readonly<Record<string, string>>;
  /** The server revision (deploy) that took it. */
  readonly server: string;
}

/**
 * A report as the triage agent may see it. The repo and its issues are
 * public, so the contact never leaves the store, and an infinite-line rule
 * is not named.
 */
export function toTriageItem(r: FeedbackRecord): TriageItem {
  const c = r.context;
  const game: Record<string, string> = {};
  for (const k of ['mode', 'gameMode', 'room', 'field', 'theme', 'renderer', 'viewport'] as const) {
    const v = c[k];
    if (v) game[k] = v;
  }
  if (c.rule) game.rule = isInfiniteLineRule(c.rule) ? '(an infinite-line rule: never name it in public)' : describeRule(c.rule);
  if (c.userAgent) game.browser = c.userAgent;
  return { id: r.id, createdAt: r.createdAt, message: r.message, page: c.url ?? '', game, server: r.server.revision ?? r.server.instance };
}
