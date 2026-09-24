/**
 * Which patterns (rules) people play, and how they do with them.
 *
 * A *stint* is one player on one rule: it starts when they join or pick a new
 * rule, and ends when they pick another, leave, or time out. The server
 * samples every player once a second (`sample`) — no hooks into the engine's
 * many exits — and counts circuits from the tick's events (`circuit`). Each
 * finished stint is returned for the log and folded into a per (mode, rule,
 * bot) row: stints, time on it, best score, final scores, circuits.
 *
 * Kept off the public /status on purpose: a table of rules by score would
 * hand out the infinite-line rules that players are meant to find.
 */

import type { GameMode } from '../shared/game/knobs';
import { describeRule, ruleKey, type PlayerRule } from '../shared/game/rule';

/** What `sample` needs to know about a player. */
export interface SampledPlayer {
  readonly id: string;
  readonly bot: boolean;
  readonly rule: PlayerRule;
  readonly score: number;
}

/** One finished stint: one player, one rule, start to end. */
export interface StintRecord {
  readonly mode: GameMode;
  readonly rule: string;
  readonly bot: boolean;
  readonly startedAt: number;
  readonly ms: number;
  readonly finalScore: number;
  readonly peakScore: number;
  readonly circuits: number;
}

/** Everything played on one rule in one mode, by people or by bots. */
export interface PatternRow {
  readonly mode: GameMode;
  /** `describeRule` form, e.g. `15 · 000000000`. */
  readonly rule: string;
  readonly bot: boolean;
  stints: number;
  /** Time on the rule, finished stints and the ones still running. */
  ms: number;
  /** Best score ever seen on it. */
  peakScore: number;
  /** Sum of finished stints' final scores (mean = / finished). */
  finalScoreSum: number;
  finished: number;
  circuits: number;
  /** Players on it right now (report only). */
  live: number;
  lastPlayedAt: number;
}

export interface PatternStatsReport {
  readonly now: number;
  readonly since: number;
  readonly rows: readonly PatternRow[];
}

/** What `STATS_FILE` holds between restarts. */
export interface PatternStatsFile {
  readonly since: number;
  readonly rows: readonly PatternRow[];
}

interface Stint {
  readonly key: string;
  readonly rule: string;
  readonly mode: GameMode;
  readonly bot: boolean;
  readonly startedAt: number;
  lastSeen: number;
  lastScore: number;
  peak: number;
  circuits: number;
}

export class PatternStats {
  private readonly rows = new Map<string, PatternRow>();
  private readonly open = new Map<string, Stint>(); // player id → stint
  since: number;

  constructor(now: number, saved?: PatternStatsFile | null) {
    this.since = saved?.since ?? now;
    for (const r of saved?.rows ?? []) {
      this.rows.set(rowKey(r.mode, r.rule, r.bot), { ...r, live: 0 });
    }
  }

  /**
   * Look at every player of every room: open stints for new (player, rule)
   * pairs, update the running ones, and close the ones whose player is gone or
   * has changed rule. Returns the stints that just finished.
   */
  sample(now: number, rooms: Iterable<{ readonly mode: GameMode; readonly players: Iterable<SampledPlayer> }>): StintRecord[] {
    const seen = new Set<string>();
    const done: StintRecord[] = [];
    for (const room of rooms) {
      for (const p of room.players) {
        seen.add(p.id);
        const key = `${room.mode}|${ruleKey(p.rule)}`;
        let s = this.open.get(p.id);
        if (s && s.key !== key) {
          done.push(this.close(p.id, s, now));
          s = undefined;
        }
        if (!s) {
          s = { key, rule: describeRule(p.rule), mode: room.mode, bot: p.bot, startedAt: now, lastSeen: now, lastScore: p.score, peak: p.score, circuits: 0 };
          this.open.set(p.id, s);
          this.row(s).stints++;
        }
        s.lastSeen = now;
        s.lastScore = p.score;
        s.peak = Math.max(s.peak, p.score);
      }
    }
    for (const [id, s] of this.open) if (!seen.has(id)) done.push(this.close(id, s, now));
    return done;
  }

  /** A circuit closed by `owner` counts towards their running stint. */
  circuit(owner: string): void {
    const s = this.open.get(owner);
    if (s) s.circuits++;
  }

  /** Close every running stint (shutdown). */
  finishAll(now: number): StintRecord[] {
    return [...this.open].map(([id, s]) => this.close(id, s, now));
  }

  /** Every row, running stints included, most played first. */
  report(now: number): PatternStatsReport {
    const rows = new Map<string, PatternRow>();
    for (const [k, r] of this.rows) rows.set(k, { ...r, live: 0 });
    for (const s of this.open.values()) {
      const k = rowKey(s.mode, s.rule, s.bot);
      const r = rows.get(k)!;
      r.live++;
      r.ms += s.lastSeen - s.startedAt;
      r.circuits += s.circuits;
      r.peakScore = Math.max(r.peakScore, s.peak);
      r.lastPlayedAt = Math.max(r.lastPlayedAt, s.lastSeen);
    }
    return { now, since: this.since, rows: [...rows.values()].sort((a, b) => b.ms - a.ms) };
  }

  /** Finished stints only — what `STATS_FILE` keeps. */
  toFile(): PatternStatsFile {
    return { since: this.since, rows: [...this.rows.values()].map((r) => ({ ...r, live: 0 })) };
  }

  private row(s: Stint): PatternRow {
    const k = rowKey(s.mode, s.rule, s.bot);
    let r = this.rows.get(k);
    if (!r) {
      r = { mode: s.mode, rule: s.rule, bot: s.bot, stints: 0, ms: 0, peakScore: 0, finalScoreSum: 0, finished: 0, circuits: 0, live: 0, lastPlayedAt: s.startedAt };
      this.rows.set(k, r);
    }
    return r;
  }

  /** A stint ends at the sample that finds it over; its score is the last one seen. */
  private close(id: string, s: Stint, now: number): StintRecord {
    this.open.delete(id);
    const ms = Math.max(0, now - s.startedAt);
    const r = this.row(s);
    r.ms += ms;
    r.finished++;
    r.finalScoreSum += s.lastScore;
    r.peakScore = Math.max(r.peakScore, s.peak);
    r.circuits += s.circuits;
    r.lastPlayedAt = Math.max(r.lastPlayedAt, now);
    return { mode: s.mode, rule: s.rule, bot: s.bot, startedAt: s.startedAt, ms, finalScore: s.lastScore, peakScore: s.peak, circuits: s.circuits };
  }
}

function rowKey(mode: GameMode, rule: string, bot: boolean): string {
  return `${mode}|${rule}|${bot ? 'bot' : 'human'}`;
}

export const PATTERNS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Spectacle patterns</title>
<style>
  :root { --bg: #f6f7f9; --panel: #fff; --line: #dfe3e8; --text: #1d2330; --muted: #5b6472; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14171c; --panel: #1c2027; --line: #2c323c; --text: #e6e9ee; --muted: #9aa2b1; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
  .muted { color: var(--muted); }
  .wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 10px; border-top: 1px solid var(--line); white-space: nowrap; text-align: right; }
  th { border-top: 0; font-weight: 600; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; }
  th:nth-child(-n+2), td:nth-child(-n+2) { text-align: left; }
  td:first-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Spectacle patterns</h1>
  <div id="state" class="muted">loading…</div>
  <h2>People</h2>
  <div class="wrap"><table id="people"></table></div>
  <h2>Bots</h2>
  <div class="wrap"><table id="bots"></table></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dur = (ms) => {
    if (ms < 60000) return Math.round(ms / 1000) + ' s';
    const m = Math.round(ms / 60000);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  };
  const cols = [
    ['Rule', (r) => r.rule, (r) => esc(r.rule)],
    ['Mode', (r) => r.mode, (r) => esc(r.mode)],
    ['Now', (r) => r.live, (r) => r.live || ''],
    ['Stints', (r) => r.stints, (r) => r.stints],
    ['Time', (r) => r.ms, (r) => dur(r.ms)],
    ['Best score', (r) => r.peakScore, (r) => r.peakScore],
    ['Mean final', (r) => r.finished ? r.finalScoreSum / r.finished : -1, (r) => r.finished ? Math.round(r.finalScoreSum / r.finished) : '–'],
    ['Circuits', (r) => r.circuits, (r) => r.circuits],
    ['Circuits / h', (r) => r.ms ? r.circuits / r.ms : 0, (r) => r.ms > 60000 ? (r.circuits / (r.ms / 3600000)).toFixed(1) : '–'],
  ];
  let sort = 4, data = null;
  function table(el, rows) {
    const sorted = rows.slice().sort((a, b) => {
      const x = cols[sort][1](a), y = cols[sort][1](b);
      return typeof x === 'string' ? x.localeCompare(y) : y - x;
    });
    el.innerHTML = '<tr>' + cols.map((c, i) => '<th data-i="' + i + '">' + c[0] + (i === sort ? ' ▾' : '') + '</th>').join('') + '</tr>' +
      (sorted.map((r) => '<tr>' + cols.map((c) => '<td>' + c[2](r) + '</td>').join('') + '</tr>').join('') ||
        '<tr><td colspan="' + cols.length + '" class="muted">Nothing yet.</td></tr>');
  }
  function render() {
    $('state').textContent = 'since ' + new Date(data.since).toLocaleString() + ' · ' + data.rows.filter((r) => !r.bot).length + ' rule' + (data.rows.filter((r) => !r.bot).length === 1 ? '' : 's') + ' played by people';
    table($('people'), data.rows.filter((r) => !r.bot));
    table($('bots'), data.rows.filter((r) => r.bot));
  }
  document.addEventListener('click', (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i !== undefined && data) { sort = Number(i); render(); }
  });
  async function poll() {
    try {
      const res = await fetch('/patterns.json' + location.search, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      render();
    } catch (e) {
      $('state').textContent = 'server not answering (' + (e.message || e) + ') — retrying';
    }
  }
  poll();
  setInterval(poll, 10000);
</script>
</body>
</html>
`;
