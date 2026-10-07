/**
 * The settings button and its small modal: theme, circuit colouring, plain
 * board, team colours, the Spectre view of a hexagon board. Every control applies as it changes, so the board
 * updates behind the modal without closing it. Lives in the lobby header and
 * the arena HUD.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CIRCUIT_STYLES, parseCircuitStyle, useSettings } from './settings';
import { parseTheme, useTheme } from './theme';

/** `icon`: a bare gear for the arena HUD's icon row; otherwise a labelled button (the lobby). */
export function SettingsButton({ icon = false }: { icon?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [settings, update] = useSettings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {icon ? (
        <button type="button" className="hud-icon" aria-label="Settings" title="Settings" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
              <circle cx="8" cy="8" r="4.6" />
            </g>
          </svg>
        </button>
      ) : (
        <button type="button" className="btn settings-btn" aria-label="Settings" title="Settings" onClick={() => setOpen(true)}>
          <span aria-hidden="true">⚙</span> Settings
        </button>
      )}
      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setOpen(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <b>Settings</b>
                <button type="button" className="btn modal-close" aria-label="Close" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              <label className="setting">
                <span>Theme</span>
                <select value={theme} onChange={(e) => setTheme(parseTheme(e.target.value) ?? theme)}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="setting">
                <span>Circuit colours</span>
                <select
                  value={settings.circuitStyle}
                  onChange={(e) => update({ circuitStyle: parseCircuitStyle(e.target.value) ?? settings.circuitStyle })}
                >
                  {CIRCUIT_STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting setting-check">
                <input type="checkbox" checked={settings.plainTiles} onChange={(e) => update({ plainTiles: e.target.checked })} />
                <span>Plain board (hide tile colours and arrows)</span>
              </label>
              <label className="setting setting-check">
                <input type="checkbox" checked={settings.teams} onChange={(e) => update({ teams: e.target.checked })} />
                <span>Team colours: you blue, everyone else red (T)</span>
              </label>
              <label className="setting setting-check">
                <input type="checkbox" checked={settings.spectres} onChange={(e) => update({ spectres: e.target.checked })} />
                <span>Draw the hexagons as Spectres (S)</span>
              </label>
            </div>
          </div>,
          // Portalled: in the arena the HUD's backdrop-filter would trap a fixed modal inside it.
          document.body,
        )}
    </>
  );
}
