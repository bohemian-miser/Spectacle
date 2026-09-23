/**
 * The settings button and its small modal: theme, circuit colouring, plain
 * board. Every control applies as it changes, so the board updates behind the
 * modal without closing it. Lives in the lobby header and the arena HUD.
 */

import { useEffect, useState } from 'react';
import { CIRCUIT_STYLES, parseCircuitStyle, useSettings } from './settings';
import { parseTheme, useTheme } from './theme';

export function SettingsButton(): JSX.Element {
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
      <button type="button" className="btn settings-btn" aria-label="Settings" title="Settings" onClick={() => setOpen(true)}>
        <span aria-hidden="true">⚙</span> Settings
      </button>
      {open && (
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
          </div>
        </div>
      )}
    </>
  );
}
