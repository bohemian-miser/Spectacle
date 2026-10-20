/**
 * The leaderboard: every won round's time, and the fastest of them served to
 * the lobby's Leaderboard tab as `GET /wins`, per game mode and board size,
 * optionally for one edge set.
 *
 * Kept in memory, and in WINS_FILE (one JSON line per win, read back at
 * startup) when that is set.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { GAME_MODES, type GameMode } from '../shared/game/knobs';
import type { WinEntry } from '../shared/game/protocol';

/** Rows `GET /wins` sends at most. */
export const TOP = 20;
/** Wins kept per (mode, size): the fastest; past this the slowest go. */
const KEEP = 5000;

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

/** A rule key as `ruleKey` writes it (`hex|01234568|3.0.2.…`), nothing else. */
const RULE_KEY = /^[a-z-]{1,16}\|\d{0,10}\|[\d.]{0,60}$/;

/** `GET /wins`'s query, checked; null if anything is off. `subset` '' = every edge set. */
export function parseWinsQuery(params: URLSearchParams): { mode: GameMode; level: number; subset: string } | null {
  const mode = params.get('mode') ?? '';
  const level = Number(params.get('level'));
  const subset = params.get('subset') ?? '';
  if (!(GAME_MODES as readonly string[]).includes(mode) || !Number.isInteger(level) || !/^\d{0,10}$/.test(subset)) return null;
  return { mode: mode as GameMode, level, subset };
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

const byTime = (a: WinRecord, b: WinRecord): number => a.ms - b.ms || a.at - b.at;

export class Wins {
  /** Per `mode|level`, fastest first. */
  private readonly lists = new Map<string, WinRecord[]>();

  constructor(
    /** WINS_FILE, or '' for memory only. */
    private readonly file = '',
    private readonly onError: (e: unknown) => void = () => {},
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
  }

  /** The fastest `TOP` in a mode at a size, of one edge set (`subset` as `ruleKey` writes it) or of all. */
  top(mode: GameMode, level: number, subset = ''): WinEntry[] {
    const out: WinEntry[] = [];
    for (const r of this.lists.get(`${mode}|${level}`) ?? []) {
      if (subset && r.rule.split('|')[1] !== subset) continue;
      out.push({ rule: r.rule, ms: r.ms, at: r.at, name: r.name, bot: r.bot, others: r.others });
      if (out.length === TOP) break;
    }
    return out;
  }
}
