/**
 * The Leaderboard tab's box beside the rule preview: the fastest wins with
 * the rule on show, at the lobby's board size and game mode, from the
 * server's `GET /wins` (server/wins.ts). Who else was in each round stays
 * folded away until asked for.
 */

import { useEffect, useState } from 'react';
import { MODE_LABELS, type GameMode } from '../../shared/game/knobs';
import type { WinEntry } from '../../shared/game/protocol';
import { ruleKey, type PlayerRule } from '../../shared/game/rule';

export interface TopWinsProps {
  readonly rule: PlayerRule;
  readonly mode: GameMode;
  /** The board sizes the server offers. */
  readonly levels: readonly number[];
  /** The lobby's size: the one Play would use. */
  readonly level: number;
  onLevel(level: number): void;
}

/** A pause after the rule changes before asking: each click in the editor is a new rule. */
const FETCH_DELAY_MS = 250;

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatWinTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function TopWins({ rule, mode, levels, level, onLevel }: TopWinsProps): JSX.Element {
  const [wins, setWins] = useState<readonly WinEntry[] | 'error' | null>(null);
  const [open, setOpen] = useState(-1);
  const empty = rule.subset.length === 0;
  const key = ruleKey(rule);

  useEffect(() => {
    setWins(null);
    setOpen(-1);
    if (empty) return;
    const ctl = new AbortController();
    const q = new URLSearchParams({ mode, level: String(level), rule: key });
    const timer = setTimeout(() => {
      fetch(`/wins?${q}`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ wins: WinEntry[] }>) : Promise.reject(new Error(String(r.status)))))
        .then((j) => setWins(j.wins))
        .catch(() => {
          if (!ctl.signal.aborted) setWins('error');
        });
    }, FETCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [key, level, mode, empty]);

  return (
    <div className="top-wins">
      <h2>Fastest wins · {MODE_LABELS[mode]}</h2>
      {levels.length > 1 && (
        <div className="mode-row" role="radiogroup" aria-label="Board size">
          {levels.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={l === level} className={`btn${l === level ? ' is-on' : ''}`} onClick={() => onLevel(l)}>
              level {l}
            </button>
          ))}
        </div>
      )}
      {empty ? (
        <p className="muted">Pick some edge classes to see a rule's wins.</p>
      ) : wins === null ? (
        <p className="muted">Loading…</p>
      ) : wins === 'error' ? (
        <p className="muted">Couldn't load the wins just now.</p>
      ) : wins.length === 0 ? (
        <p className="muted">Nobody has won with this rule at level {level} yet.</p>
      ) : (
        <ol className="top-wins-list">
          {wins.map((w, i) => (
            <li key={`${w.at}-${w.name}`}>
              <span className="top-wins-time">{formatWinTime(w.ms)}</span>
              <span className="top-wins-name">
                {w.name}
                {w.bot && <span className="muted"> (bot)</span>}
              </span>
              {w.others.length > 0 ? (
                <button type="button" className="btn-link top-wins-with" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                  with {w.others.length}
                </button>
              ) : (
                <span className="muted top-wins-with">alone</span>
              )}
              {open === i && <span className="top-wins-others muted">{w.others.join(', ')}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
