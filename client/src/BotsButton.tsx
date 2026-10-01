/**
 * The arena's Bots button and its modal: how many of each kind of bot play
 * in this room. Online, anyone in the room may change it and it changes for
 * everyone (the server caps it: `RoomBots.max`, `maxPerKind`); in solo it is
 * your own game, and the lobby's picker remembers it. Like Settings, there
 * is no Apply: each − / + changes the room. Taps in quick succession are
 * shown at once and sent as one change (`SEND_QUIET_MS`), no sooner than the
 * server's one change a second (`SEND_GAP_MS`).
 *
 * The modal is portalled to <body>: the HUD it opens from has a
 * `backdrop-filter`, which makes it the containing block for fixed
 * children — the modal was trapped (and clipped) inside the HUD panel.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameConnection } from './net';
import type { Store } from './store';

/** Wait this long after the last tap before sending the change. */
const SEND_QUIET_MS = 350;
/** The server takes one bot change a second per client; keep a margin. */
const SEND_GAP_MS = 1100;

export function BotsButton({ store, conn }: { store: Store; conn: GameConnection }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  /** Taps not yet confirmed by the room (null: show the room's own mix). */
  const [want, setWant] = useState<Record<string, number> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(0);
  const wantRef = useRef(want);
  wantRef.current = want;
  const bots = store.roomBots;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // The room answered (ours or someone else's change): show it, unless more taps are still waiting to go.
  useEffect(() => {
    if (!timer.current) setWant(null);
  }, [bots]);

  useEffect(
    () => () => {
      // Closing the arena mid-wait: send what was asked rather than drop it.
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [],
  );

  if (!bots) return null;

  function flush(): void {
    timer.current = null;
    const mix = wantRef.current;
    if (!mix) return;
    lastSent.current = Date.now();
    conn.send({
      t: 'bots',
      mix: Object.fromEntries(Object.entries(mix).filter(([, n]) => n > 0)),
    });
  }

  const shown = want ?? bots.mix;
  const playing = Object.values(bots.mix).reduce((n, k) => n + k, 0);
  const total = Object.values(shown).reduce((n, k) => n + k, 0);

  const set = (kind: string, n: number): void => {
    const next = {
      ...shown,
      [kind]: Math.max(0, Math.min(bots.maxPerKind, n)),
    };
    setWant(next);
    wantRef.current = next;
    if (timer.current) clearTimeout(timer.current);
    const wait = Math.max(SEND_QUIET_MS, lastSent.current + SEND_GAP_MS - Date.now());
    timer.current = setTimeout(flush, wait);
  };

  return (
    <>
      <button type="button" className="btn" title="Which bots play in this room" onClick={() => setOpen(true)}>
        Bots {playing}
      </button>
      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setOpen(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Bots" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <b>Bots</b>
                <button type="button" className="btn modal-close" aria-label="Close" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              <p className="bots-note">{store.room ? 'For everyone in this room — anyone here can change it. A bot taken off takes its lines with it.' : 'A bot taken off takes its lines with it.'}</p>
              {bots.kinds.map((k) => {
                const n = shown[k.kind] ?? 0;
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
                      <button type="button" className="btn" aria-label={`More ${k.label} bots`} disabled={n >= bots.maxPerKind || total >= bots.max} onClick={() => set(k.kind, n + 1)}>
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
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
