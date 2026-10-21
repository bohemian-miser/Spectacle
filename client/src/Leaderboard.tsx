/**
 * The lobby's Leaderboard tab: the fastest won rounds at a board size, from
 * the server's `GET /wins` (server/wins.ts), all edge sets or one, and
 * everyone's, bots' or people's. A rule's row takes that rule back to Play.
 */

import { useEffect, useState } from 'react';
import { MODE_LABELS, type GameMode } from '../../shared/game/knobs';
import type { WinEntry } from '../../shared/game/protocol';
import { describeRule, validateRule, type PlayerRule } from '../../shared/game/rule';
import { validEdgeSubsets, type TileFamilyId } from '../../shared/tiles';

export interface LeaderboardProps {
  readonly family: TileFamilyId;
  readonly mode: GameMode;
  /** The board sizes the server offers. */
  readonly levels: readonly number[];
  /** The lobby's size: the one Play would use. */
  readonly level: number;
  onLevel(level: number): void;
  /** Play with this rule. */
  onUse(rule: PlayerRule): void;
}

/** The Bots filter, in the order a tap steps through it; `GET /wins`'s `bots`. */
const BOTS = [
  { bots: 'all', label: 'Everything' },
  { bots: 'only', label: 'Only bots' },
  { bots: 'none', label: 'No bots' },
] as const;

/** `m:ss`, or `h:mm:ss` from an hour. */
export function formatWinTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A `ruleKey` back to its rule, or null if it isn't a legal one of `family`. */
export function ruleFromKey(key: string, family: TileFamilyId): PlayerRule | null {
  const [fam, subset = '', matching = ''] = key.split('|');
  return validateRule({ family: fam, subset: [...subset].map(Number), matching: matching.split('.').map(Number) }, family);
}

export function Leaderboard({ family, mode, levels, level, onLevel, onUse }: LeaderboardProps): JSX.Element {
  const [subset, setSubset] = useState('');
  const [botsAt, setBotsAt] = useState(0);
  const bots = BOTS[botsAt];
  const [wins, setWins] = useState<readonly WinEntry[] | 'error' | null>(null);
  const sets = validEdgeSubsets(family)
    .map((v) => v.edges.join(''))
    .filter((s) => s.length > 0);

  useEffect(() => {
    setWins(null);
    const ctl = new AbortController();
    const q = new URLSearchParams({ mode, level: String(level), subset, bots: bots.bots });
    fetch(`/wins?${q}`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ wins: WinEntry[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => setWins(j.wins))
      .catch(() => {
        if (!ctl.signal.aborted) setWins('error');
      });
    return () => ctl.abort();
  }, [mode, level, subset, bots.bots]);

  return (
    <section className="panel leaderboard">
      <h2>Fastest wins · {MODE_LABELS[mode]}</h2>
      <div className="leaderboard-row">
        {levels.length > 1 && (
          <div role="radiogroup" aria-label="Board size">
            {levels.map((l) => (
              <button key={l} type="button" role="radio" aria-checked={l === level} className={`btn${l === level ? ' is-on' : ''}`} onClick={() => onLevel(l)}>
                level {l}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`btn${bots.bots === 'all' ? '' : ' is-on'}`}
          title="Tap for bots' wins only, people's only, or everyone's"
          onClick={() => setBotsAt((botsAt + 1) % BOTS.length)}
        >
          Bots: {bots.label}
        </button>
      </div>
      <div className="mode-row" role="radiogroup" aria-label="Edge classes">
        {['', ...sets].map((s) => (
          <button key={s} type="button" role="radio" aria-checked={s === subset} className={`btn${s === subset ? ' is-on' : ''}`} onClick={() => setSubset(s)}>
            {s ? <code>{s}</code> : 'All edges'}
          </button>
        ))}
      </div>
      {wins === null ? (
        <p className="muted">Loading…</p>
      ) : wins === 'error' ? (
        <p className="muted">Couldn't load the wins just now.</p>
      ) : wins.length === 0 ? (
        <p className="muted">No wins here yet.</p>
      ) : (
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Time</th>
              <th scope="col">Name</th>
              <th scope="col">Rule</th>
            </tr>
          </thead>
          <tbody>
            {wins.map((w, i) => {
              const rule = ruleFromKey(w.rule, family);
              return (
                <tr key={`${w.at}-${w.name}`}>
                  <td className="muted">{i + 1}</td>
                  <td className="leaderboard-time">{formatWinTime(w.ms)}</td>
                  <td title={w.others.length ? `With ${w.others.join(', ')}` : 'Nobody else was there'}>
                    {w.name}
                    {w.bot && <span className="muted"> (bot)</span>}
                  </td>
                  <td>
                    {rule ? (
                      <button type="button" className="btn-link" title="Play with this rule" onClick={() => onUse(rule)}>
                        <code>{describeRule(rule)}</code>
                      </button>
                    ) : (
                      <code>{w.rule}</code>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
