import { useState } from 'react';
import type { PlayerRule } from '../../shared/game/rule';
import { FAMILY_DISPLAY_NAMES, buildSystem, countTiles, type TileFamilyId } from '../../shared/tiles';
import { ONLINE_URL, SOLO_ONLY, type Mode } from './App';
import { SOLO_LEVELS, type SoloOptions } from './local';
import { RuleEditor } from './RuleEditor';
import type { Store } from './store';
import { SettingsButton } from './SettingsButton';

export interface LobbyProps {
  readonly store: Store;
  readonly mode: Mode;
  readonly solo: SoloOptions;
  readonly rule: PlayerRule;
  readonly name: string;
  /** Already in the arena: this is a "new rule" restart, not a first entry. */
  readonly inArena: boolean;
  onMode(mode: Mode): void;
  onSolo(opts: SoloOptions): void;
  onRule(rule: PlayerRule): void;
  onName(name: string): void;
  onEnter(): void;
  onCancel(): void;
}

function tileCount(family: TileFamilyId, level: number): number {
  return countTiles(buildSystem(family, level)['Delta']);
}

export function Lobby(props: LobbyProps): JSX.Element {
  const { store, mode, solo, rule, name, inArena, onMode, onSolo, onRule, onName, onEnter, onCancel } = props;
  const [touched, setTouched] = useState(false);
  const [drafting, setDrafting] = useState<readonly string[]>([]);
  const hello = store.hello;
  const ready = rule.subset.length > 0 && name.trim().length > 0 && drafting.length === 0;
  // Before the server hands out a player colour, the chords wear Spectre's accent.
  const color = store.me?.color ?? '#6ea8fe';

  return (
    <div className="lobby">
      <header className="lobby-head">
        <div>
          <h1>Spectacle</h1>
          <p className="muted">
            A massively multiplayer strand-drawing game on {hello ? FAMILY_DISPLAY_NAMES[hello.field.family].toLowerCase() : 'tiles'}.
            {hello && mode === 'online' ? ` ${hello.tiles.toLocaleString()} tiles, ${hello.players} playing.` : ''}
          </p>
        </div>
        <SettingsButton />
      </header>

      {!inArena && (
        <section className="panel">
          <h2>Where</h2>
          {!SOLO_ONLY && (
            <div className="mode-row">
              <button type="button" className={`btn${mode === 'online' ? ' is-on' : ''}`} onClick={() => onMode('online')}>
                Online arena
              </button>
              <button type="button" className={`btn${mode === 'solo' ? ' is-on' : ''}`} onClick={() => onMode('solo')}>
                Solo, in this tab
              </button>
            </div>
          )}
          {mode === 'solo' && (
            <div className="solo-row">
              <label>
                Tiles
                <select value={solo.family} onChange={(e) => onSolo({ ...solo, family: e.target.value as TileFamilyId })}>
                  <option value="hex">Hexagons</option>
                  <option value="spectre">Tile(1,1) — the Spectre</option>
                </select>
              </label>
              <label>
                Size
                <select value={solo.level} onChange={(e) => onSolo({ ...solo, level: Number(e.target.value) })}>
                  {SOLO_LEVELS.map((lv) => (
                    <option key={lv} value={lv}>
                      level {lv} · {tileCount(solo.family, lv).toLocaleString()} tiles
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Bots
                <input type="number" min={0} max={12} value={solo.bots} onChange={(e) => onSolo({ ...solo, bots: Math.max(0, Math.min(12, Number(e.target.value) || 0)) })} />
              </label>
              <span className="muted">
                Everything runs in your browser; nothing is shared.
                {SOLO_ONLY && ONLINE_URL && (
                  <>
                    {' '}
                    <a href={ONLINE_URL}>Play online with others →</a>
                  </>
                )}
              </span>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>1. Your name</h2>
        <input
          className="input"
          value={name}
          maxLength={store.knobs?.maxNameLength ?? 16}
          placeholder="name"
          disabled={inArena}
          onChange={(e) => {
            setTouched(true);
            onName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) onEnter();
          }}
          autoFocus={!inArena}
        />
        {touched && name.trim().length === 0 && <span className="tag tag-bad">say who you are</span>}
      </section>

      <section className="panel">
        <h2>2. Your rule</h2>
        <p className="muted">
          Switch on edge classes to send a line in from every seam of that class; then choose, tile by tile, how the
          lines pair up. Every tile plays by <em>your</em> rule when your line runs through it — a tile with an odd number
          of lines is a tail, and your line stops there.
        </p>
        {hello ? (
          <RuleEditor family={hello.field.family} rule={rule} color={color} onChange={onRule} onDrafting={setDrafting} />
        ) : (
          <p className="muted">{mode === 'online' ? 'Connecting to the arena…' : 'Building the field…'}</p>
        )}
      </section>

      <footer className="lobby-foot">
        {inArena && (
          <button type="button" className="btn" onClick={onCancel}>
            Back
          </button>
        )}
        <button type="button" className="btn btn-accent btn-big" disabled={!ready || !hello} onClick={onEnter}>
          {inArena ? 'Restart with this rule' : mode === 'solo' ? 'Play solo' : 'Enter the arena'}
        </button>
        {drafting.length > 0 && <span className="tag tag-bad">finish pairing {drafting.join(', ')} first</span>}
        {inArena && <span className="muted">Restarting wipes your lines{store.knobs?.resetScoreOnRule ? ' and score' : ''}.</span>}
      </footer>
    </div>
  );
}
