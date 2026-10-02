/**
 * The arena's Bots button and its modal: how many of each kind of bot play
 * in this room. Online, anyone in the room may change it and it changes for
 * everyone (the server caps it: `RoomBots.max`, `maxPerKind`); in solo it is
 * your own game, and the lobby's picker remembers it. Unlike Settings, a
 * change waits for Apply — every change brings bots in or takes them (and
 * their lines) off the board.
 */

import { useEffect, useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';
import type { GameConnection } from './net';
import type { Store } from './store';

export function BotsButton({ store, conn }: { store: Store; conn: GameConnection }): JSX.Element | null {
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const bots = store.roomBots;

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  if (!bots) return null;
  const playing = Object.values(bots.mix).reduce((n, k) => n + k, 0);
  const total = draft ? Object.values(draft).reduce((n, k) => n + k, 0) : 0;
  const changed = !!draft && bots.kinds.some((k) => (draft[k.kind] ?? 0) !== (bots.mix[k.kind] ?? 0));
  const set = (kind: string, n: number): void => setDraft((d) => ({ ...d, [kind]: Math.max(0, Math.min(bots.maxPerKind, n)) }));

  const apply = (): void => {
    if (!draft) return;
    conn.send({ t: 'bots', mix: Object.fromEntries(Object.entries(draft).filter(([, n]) => n > 0)) });
    setDraft(null);
  };

  return (
    <>
      <button type="button" className="btn" title="Which bots play in this room" onClick={() => setDraft({ ...bots.mix })}>
        Bots {playing}
      </button>
      {draft && (
        <ModalBackdrop onClose={() => setDraft(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Bots" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>Bots</b>
              <button type="button" className="btn modal-close" aria-label="Close" onClick={() => setDraft(null)}>
                ✕
              </button>
            </div>
            <p className="bots-note">
              {store.room ? 'For everyone in this room — anyone here can change it. A bot taken off takes its lines with it.' : 'A bot taken off takes its lines with it.'}
            </p>
            {bots.kinds.map((k) => {
              const n = draft[k.kind] ?? 0;
              return (
                <div key={k.kind} className="bots-row">
                  <div className="bots-kind">
                    <span className="bot-name">{k.label}</span>
                    <span className="bot-blurb">{k.blurb}</span>
                  </div>
                  <div className="bots-stepper">
                    <button type="button" className="btn" aria-label={`Fewer ${k.label} bots`} disabled={n <= 0} onClick={() => set(k.kind, n - 1)}>
                      −
                    </button>
                    <span className="bots-count" aria-label={`${k.label} bots`}>
                      {n}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`More ${k.label} bots`}
                      disabled={n >= bots.maxPerKind || total >= bots.max}
                      onClick={() => set(k.kind, n + 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="bots-foot">
              <span className="bots-total">
                {total} / {bots.max}
              </span>
              <button type="button" className="btn btn-accent" disabled={!changed} onClick={apply}>
                Apply
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </>
  );
}
