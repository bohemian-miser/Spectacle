/**
 * The leaderboard's records: every won round's time, kept per (mode, board
 * size, rule), and the fastest few of each served to the lobby's Leaderboard
 * tab as `GET /wins`.
 *
 * Where they last (WINS_URL):
 * - unset: this process's memory only (dev, tests);
 * - a file path: one JSON line per win, read back at startup (the VM);
 * - `firestore://<project>[/<collection>]`: one Firestore document per win,
 *   written and queried over REST with the instance's token (Cloud Run, where
 *   instances come and go). The query needs a composite index on
 *   (`board` asc, `ms` asc); docs/leaderboard.md has the setup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { GAME_MODES, type GameMode } from '../shared/game/knobs';
import type { WinEntry } from '../shared/game/protocol';

export type { WinEntry };

/** How many times a board keeps and serves. */
export const TOP = 5;

export interface WinRecord {
  readonly mode: GameMode;
  readonly level: number;
  /** `ruleKey` of the winner's own rule. */
  readonly rule: string;
  /** Time played in the round, ms (the room's ticked time). */
  readonly ms: number;
  /** When it was won, epoch ms. */
  readonly at: number;
  readonly name: string;
  readonly bot: boolean;
  /** Everyone else at the board when it was won, by name. */
  readonly others: readonly string[];
  /** Won in a `?room=` link's room. */
  readonly named: boolean;
}

/** One leaderboard: a rule at a size in a mode. */
export function boardKey(mode: string, level: number, rule: string): string {
  return `${mode}|${level}|${rule}`;
}

/** A rule key as `ruleKey` writes it (`hex|01234568|3.0.2.…`), nothing else. */
const RULE_KEY = /^[a-z-]{1,16}\|\d{0,10}\|[\d.]{0,60}$/;

/** `GET /wins`'s query, checked; null if anything is off. */
export function parseWinsQuery(params: URLSearchParams): { mode: GameMode; level: number; rule: string } | null {
  const rule = params.get('rule') ?? '';
  const level = Number(params.get('level'));
  const mode = params.get('mode') ?? '';
  if (!RULE_KEY.test(rule) || !Number.isInteger(level) || level < 1 || level > 9) return null;
  if (!(GAME_MODES as readonly string[]).includes(mode)) return null;
  return { mode: mode as GameMode, level, rule };
}

const byTime = (a: WinEntry, b: WinEntry): number => a.ms - b.ms || a.at - b.at;

function entry(r: WinRecord): WinEntry {
  return { ms: r.ms, at: r.at, name: r.name, bot: r.bot, others: r.others, named: r.named };
}

/** Each board's fastest `TOP`, in memory. */
export class WinBoards {
  private readonly boards = new Map<string, WinEntry[]>();

  add(r: WinRecord): void {
    const key = boardKey(r.mode, r.level, r.rule);
    const list = this.boards.get(key) ?? [];
    list.push(entry(r));
    list.sort(byTime);
    if (list.length > TOP) list.length = TOP;
    this.boards.set(key, list);
  }

  /** Fold in what the store says (it has every instance's wins); one already here isn't doubled. */
  merge(key: string, list: readonly WinEntry[]): void {
    if (list.length === 0) return;
    const seen = new Set<string>();
    const all = [...(this.boards.get(key) ?? []), ...list].filter((e) => {
      const id = `${e.at}|${e.ms}|${e.name}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    this.boards.set(key, all.sort(byTime).slice(0, TOP));
  }

  top(key: string): readonly WinEntry[] {
    return this.boards.get(key) ?? [];
  }
}

/** Somewhere wins outlive the process. */
export interface WinStore {
  add(r: WinRecord): Promise<void>;
  /** A board's fastest `TOP`, or null if this store can't say (then memory answers). */
  top(key: string): Promise<readonly WinEntry[] | null>;
}

/** Plausible values only: a hand-edited or truncated line is skipped, not trusted. */
export function isWinRecord(v: unknown): v is WinRecord {
  const r = v as Partial<WinRecord> | null;
  return (
    !!r &&
    (GAME_MODES as readonly string[]).includes(r.mode as string) &&
    Number.isInteger(r.level) &&
    typeof r.rule === 'string' &&
    RULE_KEY.test(r.rule) &&
    typeof r.ms === 'number' &&
    r.ms >= 0 &&
    typeof r.at === 'number' &&
    typeof r.name === 'string' &&
    typeof r.bot === 'boolean' &&
    Array.isArray(r.others) &&
    r.others.every((o) => typeof o === 'string') &&
    typeof r.named === 'boolean'
  );
}

/** One JSON line per win. Every line is read back into memory at startup, so `top` is memory's. */
export class FileWinStore implements WinStore {
  constructor(private readonly path: string) {}

  load(): WinRecord[] {
    if (!existsSync(this.path)) return [];
    const out: WinRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (isWinRecord(r)) out.push(r);
      } catch {
        // A line cut short by a crash: the rest still count.
      }
    }
    return out;
  }

  async add(r: WinRecord): Promise<void> {
    await appendFile(this.path, JSON.stringify(r) + '\n');
  }

  async top(): Promise<null> {
    return null;
  }
}

type Fetch = typeof fetch;
type Tokens = () => Promise<string | null>;

/** Firestore's typed value for what a record holds. */
type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { arrayValue: { values?: FsValue[] } };

function fsFields(r: WinRecord): Record<string, FsValue> {
  return {
    board: { stringValue: boardKey(r.mode, r.level, r.rule) },
    mode: { stringValue: r.mode },
    level: { integerValue: String(r.level) },
    rule: { stringValue: r.rule },
    ms: { integerValue: String(Math.round(r.ms)) },
    at: { integerValue: String(r.at) },
    name: { stringValue: r.name },
    bot: { booleanValue: r.bot },
    others: { arrayValue: { values: r.others.map((o) => ({ stringValue: o })) } },
    named: { booleanValue: r.named },
  };
}

/** A document's fields back to an entry, or null if they aren't one. */
export function fsEntry(fields: Record<string, Record<string, unknown>> | undefined): WinEntry | null {
  if (!fields) return null;
  const str = (k: string): string | undefined => fields[k]?.stringValue as string | undefined;
  const int = (k: string): number => Number(fields[k]?.integerValue);
  const ms = int('ms');
  const at = int('at');
  const name = str('name');
  if (!Number.isFinite(ms) || !Number.isFinite(at) || name === undefined) return null;
  const others = ((fields.others?.arrayValue as { values?: { stringValue?: string }[] } | undefined)?.values ?? [])
    .map((v) => v.stringValue)
    .filter((v): v is string => typeof v === 'string');
  return { ms, at, name, bot: fields.bot?.booleanValue === true, others, named: fields.named?.booleanValue === true };
}

/** `firestore://project[/collection]` → its parts; anything else → null. */
export function parseFirestoreUrl(url: string): { project: string; collection: string } | null {
  const m = /^firestore:\/\/([a-z0-9-]+)(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(url);
  return m ? { project: m[1], collection: m[2] ?? 'wins' } : null;
}

/** One document per win in a Firestore collection, over REST. */
export class FirestoreWinStore implements WinStore {
  private readonly base: string;

  constructor(
    project: string,
    private readonly collection: string,
    private readonly tokens: Tokens,
    private readonly fetchFn: Fetch = fetch,
  ) {
    this.base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.tokens();
    if (!token) throw new Error('no GCP token for Firestore');
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  async add(r: WinRecord): Promise<void> {
    const res = await this.fetchFn(`${this.base}/${this.collection}`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ fields: fsFields(r) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Firestore add: ${res.status}`);
  }

  async top(key: string): Promise<readonly WinEntry[]> {
    const query = {
      structuredQuery: {
        from: [{ collectionId: this.collection }],
        where: { fieldFilter: { field: { fieldPath: 'board' }, op: 'EQUAL', value: { stringValue: key } } },
        orderBy: [{ field: { fieldPath: 'ms' }, direction: 'ASCENDING' }],
        limit: TOP,
      },
    };
    const res = await this.fetchFn(`${this.base}:runQuery`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Firestore query: ${res.status}`);
    const rows = (await res.json()) as { document?: { fields?: Record<string, Record<string, unknown>> } }[];
    return rows.map((row) => fsEntry(row.document?.fields)).filter((e): e is WinEntry => e !== null);
  }
}

/** How long a board fetched from the store is served from memory before asking again. */
export const STORE_TTL_MS = 60_000;
/** Boards remembered as fetched; past this the memory of when is dropped (any query names a board). */
const MAX_FETCHED = 10_000;
/**
 * Store queries a minute, at most: every rule the editor shows is a board, so
 * a script walking rules would otherwise be a query (and a billed read) each.
 * Past it, boards are served from memory until the minute is up.
 */
export const STORE_QUERIES_PER_MIN = 120;

/**
 * Memory in front of a store. Wins go to both; a board is read from the store
 * at most once a `STORE_TTL_MS` (other instances' wins show up by then), and
 * from memory when the store can't answer.
 */
export class Wins {
  readonly boards = new WinBoards();
  private readonly fetched = new Map<string, number>();
  private minute = 0;
  private queries = 0;

  constructor(
    private readonly store: WinStore | null,
    private readonly onError: (what: string, e: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Records already kept (a file read at startup): into memory, not written again. */
  preload(records: readonly WinRecord[]): void {
    for (const r of records) this.boards.add(r);
  }

  add(r: WinRecord): void {
    this.boards.add(r);
    this.store?.add(r).catch((e: unknown) => this.onError('keep a win', e));
  }

  async top(key: string): Promise<readonly WinEntry[]> {
    const at = this.fetched.get(key);
    const now = this.now();
    if (now - this.minute >= 60_000) {
      this.minute = now;
      this.queries = 0;
    }
    if (this.store && (at === undefined || now - at > STORE_TTL_MS) && this.queries < STORE_QUERIES_PER_MIN) {
      this.queries++;
      // Stamped before asking, so a failing store is asked once a TTL, not once a request.
      if (this.fetched.size >= MAX_FETCHED) this.fetched.clear();
      this.fetched.set(key, now);
      try {
        const list = await this.store.top(key);
        if (list) this.boards.merge(key, list);
      } catch (e) {
        this.onError('read wins', e);
      }
    }
    return this.boards.top(key);
  }
}

/** The records WINS_URL names (see the top of this file), file ones already read back in. */
export function winsFrom(url: string, tokens: Tokens, onError: (what: string, e: unknown) => void): Wins {
  if (!url) return new Wins(null, onError);
  const fs = parseFirestoreUrl(url);
  if (fs) return new Wins(new FirestoreWinStore(fs.project, fs.collection, tokens), onError);
  const file = new FileWinStore(url);
  const wins = new Wins(file, onError);
  wins.preload(file.load());
  return wins;
}
