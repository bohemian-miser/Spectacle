/**
 * The leaderboard: every won round's time, and the fastest of them served to
 * the lobby's Leaderboard tab as `GET /wins`, per game mode and board size,
 * optionally for one edge set, for bots' wins or people's only, and for
 * rounds won alone or against bots only.
 *
 * Kept in memory, and in WINS_FILE (one JSON line per win, read back at
 * startup) when that is set. With a remote (server/firestore.ts, every shard
 * writing to one place) the board is the remote's — read at most every
 * `REMOTE_TTL_MS` per query — merged with the wins this process has seen, so
 * a win shows at once on the shard it was won on.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { GAME_MODES, type GameMode } from '../shared/game/knobs';
import type { WinEntry } from '../shared/game/protocol';
import type { WinsRemote } from './firestore';

/** Rows `GET /wins` sends at most. */
export const TOP = 20;
/** Wins kept per (mode, size): the fastest; past this the slowest go. */
const KEEP = 5000;
/** How long a remote answer is served before it's asked again. */
export const REMOTE_TTL_MS = 30_000;

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
  /** Which of `others` were bots, in the same order (absent on wins recorded before it was kept). */
  readonly otherBots?: readonly boolean[];
  /** Won in a `?room=` link's room. */
  readonly named: boolean;
}

/** Who else was at the board: nobody, bots only, or at least one other person. */
export type Company = 'alone' | 'bots' | 'people';

/** The company of a win; one recorded before `otherBots` was kept, with others there, counts as `people`. */
export function companyOf(r: Pick<WinRecord, 'others' | 'otherBots'>): Company {
  if (r.others.length === 0) return 'alone';
  return r.otherBots?.length === r.others.length && r.otherBots.every(Boolean) ? 'bots' : 'people';
}

/** Whose wins: everyone's, bots' only (`only`), or people's only (`none`). */
export type BotFilter = 'all' | 'only' | 'none';

/** Who else was in the round: anyone (`all`), nobody (`alone`), or bots only (`bots`). */
export type CompanyFilter = 'all' | 'alone' | 'bots';

/** What a board is narrowed to: an edge set (`subset` as `ruleKey` writes it; '' or absent = all), whose wins, and who else was there. */
export interface WinsFilter {
  readonly subset?: string;
  readonly bots?: BotFilter;
  readonly company?: CompanyFilter;
}

/** A rule key as `ruleKey` writes it (`hex|01234568|3.0.2.…`), nothing else. */
const RULE_KEY = /^[a-z-]{1,16}\|\d{0,10}\|[\d.]{0,60}$/;

/** `GET /wins`'s query, checked; null if anything is off. No `subset` = every edge set, no `bots` = everyone's, no `company` = whoever else was there. */
export function parseWinsQuery(params: URLSearchParams): { mode: GameMode; level: number; filter: Required<WinsFilter> } | null {
  const mode = params.get('mode') ?? '';
  const level = Number(params.get('level'));
  const subset = params.get('subset') ?? '';
  const bots = params.get('bots') || 'all';
  const company = params.get('company') || 'all';
  if (!(GAME_MODES as readonly string[]).includes(mode) || !Number.isInteger(level) || !/^\d{0,10}$/.test(subset)) return null;
  if (bots !== 'all' && bots !== 'only' && bots !== 'none') return null;
  if (company !== 'all' && company !== 'alone' && company !== 'bots') return null;
  return { mode: mode as GameMode, level, filter: { subset, bots, company } };
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
    (r.otherBots === undefined || (Array.isArray(r.otherBots) && r.otherBots.length === r.others.length && r.otherBots.every((b) => typeof b === 'boolean'))) &&
    typeof r.named === 'boolean'
  );
}

const byTime = (a: WinRecord, b: WinRecord): number => a.ms - b.ms || a.at - b.at;

export class Wins {
  /** Per `mode|level`, fastest first. */
  private readonly lists = new Map<string, WinRecord[]>();

  /** Per query, the remote's last answer and when it came. */
  private readonly cache = new Map<string, { rows: WinRecord[]; at: number; asking?: Promise<void> }>();

  constructor(
    /** WINS_FILE, or '' for memory only. */
    private readonly file = '',
    private readonly onError: (e: unknown) => void = () => {},
    /** Where every shard's wins are kept, and this shard's name to tag them with. */
    private readonly remote: { store: WinsRemote; shard: string } | null = null,
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        try {
          const r: unknown = JSON.parse(line);
          if (isWinRecord(r)) this.keep(r);
        } catch {
          // A blank line, or one cut short by a crash: the rest still count.
        }
      }
    }
  }

  private keep(r: WinRecord): void {
    const key = `${r.mode}|${r.level}`;
    const list = this.lists.get(key) ?? [];
    const i = list.findIndex((o) => byTime(r, o) < 0);
    list.splice(i < 0 ? list.length : i, 0, r);
    if (list.length > KEEP) list.length = KEEP;
    this.lists.set(key, list);
  }

  add(r: WinRecord): void {
    this.keep(r);
    if (this.file) appendFile(this.file, JSON.stringify(r) + '\n').catch(this.onError);
    if (this.remote) this.remote.store.add(r, this.remote.shard).catch(this.onError);
  }

  /** The fastest `TOP` in a mode at a size this process has seen, narrowed by `filter`. */
  top(mode: GameMode, level: number, filter: WinsFilter = {}): WinEntry[] {
    return this.localTop(mode, level, filter).map(entry);
  }

  /**
   * The board for `GET /wins`: the remote's fastest (every shard's, kept for
   * good) merged with this process's own, or the local board alone without a
   * remote. A remote that fails leaves its last answer standing.
   */
  async board(mode: GameMode, level: number, filter: WinsFilter = {}, now = Date.now()): Promise<WinEntry[]> {
    const local = this.localTop(mode, level, filter);
    if (!this.remote) return local.map(entry);
    const key = `${mode}|${level}|${filter.subset ?? ''}|${filter.bots ?? 'all'}|${filter.company ?? 'all'}`;
    let c = this.cache.get(key);
    if (!c || now - c.at > REMOTE_TTL_MS) {
      const held = c ?? { rows: [], at: 0 };
      this.cache.set(key, held);
      held.asking ??= this.remote.store
        .top(mode, level, filter, TOP)
        .then((rows) => {
          held.rows = rows;
          held.at = Date.now();
        })
        .catch((e) => {
          held.at = Date.now(); // try again after the TTL, not on every request
          this.onError(e);
        })
        .finally(() => (held.asking = undefined));
      await held.asking;
      c = held;
    }
    const seen = new Set<string>();
    const merged: WinRecord[] = [];
    for (const r of [...c.rows, ...local].sort(byTime)) {
      const id = `${r.at}|${r.name}|${r.ms}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(r);
      if (merged.length === TOP) break;
    }
    return merged.map(entry);
  }

  private localTop(mode: GameMode, level: number, { subset = '', bots = 'all', company = 'all' }: WinsFilter): WinRecord[] {
    const out: WinRecord[] = [];
    for (const r of this.lists.get(`${mode}|${level}`) ?? []) {
      if (subset && r.rule.split('|')[1] !== subset) continue;
      if ((bots === 'only' && !r.bot) || (bots === 'none' && r.bot)) continue;
      if (company !== 'all' && companyOf(r) !== company) continue;
      out.push(r);
      if (out.length === TOP) break;
    }
    return out;
  }
}

const entry = (r: WinRecord): WinEntry => ({ rule: r.rule, ms: r.ms, at: r.at, name: r.name, bot: r.bot, others: r.others, ...(r.otherBots ? { otherBots: r.otherBots } : {}) });
