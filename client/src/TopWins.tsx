/**
 * The Leaderboard tab's box beside the rule preview: the fastest wins with
 * the rule on show, per board size, from the server's `GET /wins`
 * (server/wins.ts). Who else was in each round stays folded away behind its
 * row's count.
 */

import { useEffect, useState } from 'react';
import type { GameMode } from '../../shared/game/knobs';
import { ruleKey, type PlayerRule } from '../../shared/game/rule';

/** One win as `GET /wins` sends it (server/wins.ts's WinEntry). */
export interface WinEntry {
  readonly ms: number;
  readonly at: number;
  readonly name: string;
  readonly bot: boolean;
  readonly others: readonly string[];
  readonly named: boolean;
}

export interface TopWinsProps {
  readonly rule: PlayerRule;
  readonly mode: GameMode;
  /** The board sizes the server offers. */
  readonly levels: readonly number[];
  /** The size shown first: the one picked in the lobby. */
  readonly level: number;
}

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatWinTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function TopWins({ rule, mode, levels, level }: TopWinsProps): JSX.Element {
  const [lv, setLv] = useState(level);
  const [wins, setWins] = useState<readonly WinEntry[] | 'error' | null>(null);
  const [open, setOpen] = useState(-1);
  const key = ruleKey(rule);

  useEffect(() => setLv(level), [level]);

  useEffect(() => {
    setWins(null);
    setOpen(-1);
    if (rule.subset.length === 0) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({ mode, level: String(lv), rule: key });
    fetch(`/wins?${q}`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ wins: WinEntry[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => setWins(j.wins))
      .catch(() => {
        if (!ctl.signal.aborted) setWins('error');
      });
    return () => ctl.abort();
  }, [key, lv, mode, rule.subset.length]);

  return (
    <div className="top-wins">
      <h2>Fastest wins</h2>
      {levels.length > 1 && (
        <div className="mode-row" role="radiogroup" aria-label="Board size">
          {levels.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={l === lv} className={`btn${l === lv ? ' is-on' : ''}`} onClick={() => setLv(l)}>
              level {l}
            </button>
          ))}
        </div>
      )}
      {rule.subset.length === 0 ? (
        <p className="muted">Pick some edge classes to see a rule's wins.</p>
      ) : wins === null ? (
        <p className="muted">Loading…</p>
      ) : wins === 'error' ? (
        <p className="muted">Couldn't load the wins just now.</p>
      ) : wins.length === 0 ? (
        <p className="muted">Nobody has won with this rule at level {lv} yet.</p>
      ) : (
        <ol className="top-wins-list">
          {wins.map((w, i) => (
            <li key={`${w.at}-${w.name}`}>
              <span className="top-wins-time">{formatWinTime(w.ms)}</span>
              <span className="top-wins-name">
                {w.name}
                {w.bot && <span className="muted"> (bot)</span>}
              </span>
              <button
                type="button"
                className="tag tag-btn"
                aria-expanded={open === i}
                title="Who else was in the round"
                onClick={() => setOpen(open === i ? -1 : i)}
              >
                {w.others.length ? `+${w.others.length}` : 'alone'}
              </button>
              {open === i && (
                <span className="top-wins-others muted">
                  {w.others.length ? `With ${w.others.join(', ')}` : 'Nobody else was there'}
                  {w.named ? ' · private room' : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
