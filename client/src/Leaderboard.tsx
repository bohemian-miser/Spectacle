/**
 * The lobby's Leaderboard tab: the fastest won rounds at a board size, from
 * the server's `GET /wins` (server/wins.ts), all edge sets or one,
 * everyone's, bots' or people's, and won against anyone, nobody, only bots or
 * not just bots. Each row counts the winner's opponents, people and bots;
 * tapping it lists them. Its rule takes that rule back to Play.
 */

import { Fragment, useEffect, useState } from 'react';
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

/** Who won: `GET /wins`'s `bots`. */
const WINNER = [
  { value: 'all', label: 'Anyone' },
  { value: 'none', label: 'Person' },
  { value: 'only', label: 'Bot' },
] as const;

/** Who else was in the round: `GET /wins`'s `company`. */
const AGAINST = [
  { value: 'all', label: 'Anyone' },
  { value: 'alone', label: 'Nobody' },
  { value: 'bots', label: 'Only bots' },
  { value: 'notbots', label: 'Not just bots' },
] as const;

type Winner = (typeof WINNER)[number]['value'];
type Against = (typeof AGAINST)[number]['value'];

/** A labelled row of joined toggle buttons, one of them on. */
function Segmented<T extends string>({ label, options, value, onPick }: { label: string; options: readonly { value: T; label: JSX.Element | string }[]; value: T; onPick(v: T): void }): JSX.Element {
  return (
    <div className="lb-filter">
      <span className="lb-filter-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onPick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Who else was at the board when a round was won, the winner left out; a name there more than once (the unnamed bots of old wins) is counted. */
export function opponents(w: WinEntry): { name: string; bot: boolean; n: number }[] {
  const out: { name: string; bot: boolean; n: number }[] = [];
  w.others.forEach((name, i) => {
    const bot = w.otherBots?.[i] === true;
    const same = out.find((o) => o.name === name && o.bot === bot);
    if (same) same.n++;
    else out.push({ name, bot, n: 1 });
  });
  return out;
}

/** A won round's opponents as people and bots; null for a win recorded before `otherBots`. */
export function opponentCount(w: WinEntry): { people: number; bots: number } | null {
  if (w.others.length > 0 && w.otherBots?.length !== w.others.length) return null;
  const bots = (w.otherBots ?? []).filter(Boolean).length;
  return { people: w.others.length - bots, bots };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

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
  const [winner, setWinner] = useState<Winner>('all');
  const [against, setAgainst] = useState<Against>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [wins, setWins] = useState<readonly WinEntry[] | 'error' | null>(null);
  const sets = validEdgeSubsets(family)
    .map((v) => v.edges.join(''))
    .filter((s) => s.length > 0);

  useEffect(() => {
    setWins(null);
    setOpen(null);
    const ctl = new AbortController();
    const q = new URLSearchParams({
      mode,
      level: String(level),
      subset,
      bots: winner,
      company: against,
    });
    fetch(`/wins?${q}`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ wins: WinEntry[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => setWins(j.wins))
      .catch(() => {
        if (!ctl.signal.aborted) setWins('error');
      });
    return () => ctl.abort();
  }, [mode, level, subset, winner, against]);

  return (
    <section className="panel leaderboard">
      <h2>Fastest wins · {MODE_LABELS[mode]}</h2>
      <div className="lb-filters">
        {levels.length > 1 && (
          <Segmented
            label="Size"
            options={levels.map((l) => ({
              value: String(l),
              label: String(l),
            }))}
            value={String(level)}
            onPick={(v) => onLevel(Number(v))}
          />
        )}
        <Segmented<Winner> label="Winner" options={WINNER} value={winner} onPick={setWinner} />
        <Segmented<Against> label="Against" options={AGAINST} value={against} onPick={setAgainst} />
        <Segmented
          label="Edges"
          options={['', ...sets].map((s) => ({
            value: s,
            label: s ? <code>{s}</code> : 'All',
          }))}
          value={subset}
          onPick={setSubset}
        />
      </div>
      {wins === null ? (
        <p className="muted">Loading…</p>
      ) : wins === 'error' ? (
        <p className="muted">Couldn't load the wins just now.</p>
      ) : wins.length === 0 ? (
        <p className="muted">No wins here yet.</p>
      ) : (
        <div className="lb-scroll">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time</th>
                <th scope="col">Name</th>
                <th scope="col">Opponents</th>
                <th scope="col">Rule</th>
              </tr>
            </thead>
            <tbody>
              {wins.map((w, i) => {
                const rule = ruleFromKey(w.rule, family);
                const key = `${w.at}-${w.name}`;
                const n = opponentCount(w);
                const expands = w.others.length > 0;
                const isOpen = expands && open === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className={[expands && 'is-expandable', isOpen && 'is-open'].filter(Boolean).join(' ') || undefined}
                      onClick={expands ? () => setOpen(isOpen ? null : key) : undefined}
                      aria-expanded={expands ? isOpen : undefined}
                    >
                      <td className="muted">{i + 1}</td>
                      <td className="leaderboard-time">{formatWinTime(w.ms)}</td>
                      <td>
                        <span className="lb-name">
                          {w.bot ? <BotIcon /> : <PersonIcon />} {w.name}
                        </span>
                      </td>
                      <td className="lb-players">
                        {n ? (
                          <span className="lb-icons" aria-label={`${plural(n.people, 'person', 'people')}, ${plural(n.bots, 'bot', 'bots')}`}>
                            <PersonIcon /> {n.people}
                            <BotIcon /> {n.bots}
                          </span>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td>
                        {rule ? (
                          <button
                            type="button"
                            className="btn-link"
                            title="Play with this rule"
                            onClick={(e) => {
                              e.stopPropagation();
                              onUse(rule);
                            }}
                          >
                            <code>{describeRule(rule)}</code>
                          </button>
                        ) : (
                          <code>{w.rule}</code>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="lb-detail">
                        <td />
                        <td colSpan={4}>
                          <ul className="lb-people">
                            {opponents(w).map((p, j) => (
                              <li key={j}>
                                {p.bot ? <BotIcon /> : <PersonIcon />} {p.name}
                                {p.n > 1 && ` ×${p.n}`}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const PersonIcon = (): JSX.Element => (
  <svg className="lb-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="5" r="3" />
    <path d="M2.5 14.5c0-3.2 2.5-5 5.5-5s5.5 1.8 5.5 5z" />
  </svg>
);

const BotIcon = (): JSX.Element => (
  <svg className="lb-icon" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2.5" y="4.5" width="11" height="9" rx="2.5" />
    <rect x="7.25" y="1.5" width="1.5" height="3" />
    <circle cx="6" cy="9" r="1.2" className="lb-icon-eye" />
    <circle cx="10" cy="9" r="1.2" className="lb-icon-eye" />
  </svg>
);
