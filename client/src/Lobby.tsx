import { useState } from 'react';
import { GAME_MODES, MODE_LABELS, type GameMode } from '../../shared/game/knobs';
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
  readonly gameMode: GameMode;
  readonly rule: PlayerRule;
  readonly name: string;
  /** Already in the arena: this is a "new rule" restart, not a first entry. */
  readonly inArena: boolean;
  /** Why the player is back here, if not by choice. */
  readonly notice?: string;
  /** Online and can't reach the server after a few tries. */
  readonly struggling: boolean;
  /** Give up on the online arena and switch to solo. */
  onGiveUp(): void;
  onMode(mode: Mode): void;
  onSolo(opts: SoloOptions): void;
  onGameMode(mode: GameMode): void;
  onRule(rule: PlayerRule): void;
  onName(name: string): void;
  onEnter(): void;
  /** Swap captured pattern `index` for this rule (its lines and their points go). */
  onSwap(index: number): void;
  onCancel(): void;
  /** Leave the arena altogether, back to the full main screen. */
  onLeave(): void;
}

const MODE_BLURBS: Readonly<Record<GameMode, string>> = {
  normal:
    "Loop round a rival's line and it turns into yours — your pattern, on their tiles. Each new kind of line you convert gives you another head.",
  conquest:
    "Loop round a rival's line and you take their pattern: a new tab to draw with, their lines kept as they are, and another head.",
};

function tileCount(family: TileFamilyId, level: number): number {
  return countTiles(buildSystem(family, level)['Delta']);
}

export function Lobby(props: LobbyProps): JSX.Element {
  const { store, mode, solo, gameMode, rule, name, inArena, notice, struggling, onGiveUp, onMode, onSolo, onGameMode, onRule, onName, onEnter, onSwap, onCancel, onLeave } =
    props;
  const [touched, setTouched] = useState(false);
  const [drafting, setDrafting] = useState<readonly string[]>([]);
  const hello = store.hello;
  const ready = rule.subset.length > 0 && name.trim().length > 0 && drafting.length === 0;
  // Before the server hands out a player colour, the chords wear Spectre's accent.
  const color = store.me?.color ?? '#6ea8fe';
  // Captured slots (each worth a head) can take this rule instead of a restart.
  const slots = inArena && store.me ? store.me.patterns.map((q, i) => ({ q, i })).filter(({ i }) => i > 0) : [];

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
          {notice && (
            <p className="lobby-notice">
              {notice}
              {mode === 'online' && (
                <>
                  {' '}
                  <button type="button" className="btn-link" onClick={onGiveUp}>
                    Play bots instead
                  </button>
                </>
              )}
            </p>
          )}
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
          <div className="mode-row" role="radiogroup" aria-label="Game mode">
            {GAME_MODES.map((m) => {
              const rooms = hello && mode === 'online' ? hello.rooms.filter((r) => r.mode === m) : [];
              const playing = rooms.reduce((n, r) => n + r.players, 0);
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={gameMode === m}
                  className={`btn${gameMode === m ? ' is-on' : ''}`}
                  onClick={() => onGameMode(m)}
                >
                  {MODE_LABELS[m]}
                  {rooms.length > 0 && <span className="muted"> · {playing} playing</span>}
                </button>
              );
            })}
          </div>
          <p className="muted mode-blurb">{MODE_BLURBS[gameMode]}</p>
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
        ) : mode === 'online' ? (
          <p className="muted">
            Connecting to the arena…
            {struggling && (
              <>
                {' '}
                Having trouble reaching it —{' '}
                <button type="button" className="btn-link" onClick={onGiveUp}>
                  play bots instead
                </button>
                , no server needed.
              </>
            )}
          </p>
        ) : (
          <p className="muted">Building the field…</p>
        )}
      </section>

      <footer className="lobby-foot">
        {inArena && (
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Back
            </button>
            <button type="button" className="btn" onClick={onLeave} title="Leave the arena: pick a game mode, online or solo">
              Leave arena
            </button>
          </>
        )}
        <button type="button" className="btn btn-accent btn-big" disabled={!ready || !hello} onClick={onEnter}>
          {inArena ? 'Restart with this rule' : SOLO_ONLY ? 'Play' : mode === 'solo' ? 'Play solo' : 'Enter the arena'}
        </button>
        {slots.map(({ q, i }) => (
          <button
            key={i}
            type="button"
            className="btn"
            disabled={!ready || !hello}
            title="Keeps the slot and its head; every line drawn with that pattern goes, with its points"
            onClick={() => onSwap(i)}
          >
            <span className="swatch" style={{ background: q.color }} /> Swap for {q.from === undefined ? `pattern ${i + 1}` : `${q.fromName || 'someone'}'s pattern`}
          </button>
        ))}
        {drafting.length > 0 && <span className="tag tag-bad">finish pairing {drafting.join(', ')} first</span>}
        {inArena && (
          <span className="muted">
            Restarting wipes your lines{store.knobs?.resetScoreOnRule ? ' and score' : ''}
            {slots.length > 0 ? '; swapping a pattern wipes only its lines, and the points they earned' : ''}.
          </span>
        )}
      </footer>
    </div>
  );
}
