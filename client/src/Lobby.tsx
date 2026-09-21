import { useState } from 'react';
import type { PlayerRule } from '../../shared/game/rule';
import { FAMILY_DISPLAY_NAMES } from '../../shared/tiles';
import { RuleEditor } from './RuleEditor';
import type { Store } from './store';

export interface LobbyProps {
  readonly store: Store;
  readonly rule: PlayerRule;
  readonly name: string;
  /** Already in the arena: this is a "new rule" restart, not a first entry. */
  readonly inArena: boolean;
  onRule(rule: PlayerRule): void;
  onName(name: string): void;
  onEnter(): void;
  onCancel(): void;
}

export function Lobby({ store, rule, name, inArena, onRule, onName, onEnter, onCancel }: LobbyProps): JSX.Element {
  const [touched, setTouched] = useState(false);
  const hello = store.hello;
  const ready = rule.subset.length > 0 && name.trim().length > 0;
  const color = store.me?.color ?? '#17c3b2';

  return (
    <div className="lobby">
      <header className="lobby-head">
        <h1>Spectacle</h1>
        <p className="muted">
          A massively multiplayer strand-drawing game on {hello ? FAMILY_DISPLAY_NAMES[hello.field.family].toLowerCase() : 'tiles'}.
          {hello ? ` ${hello.tiles.toLocaleString()} tiles, ${hello.players} playing.` : ''}
        </p>
      </header>

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
          <RuleEditor family={hello.field.family} rule={rule} color={color} onChange={onRule} />
        ) : (
          <p className="muted">Connecting to the arena…</p>
        )}
      </section>

      <footer className="lobby-foot">
        {inArena && (
          <button type="button" className="btn" onClick={onCancel}>
            Back
          </button>
        )}
        <button type="button" className="btn btn-accent btn-big" disabled={!ready || !hello} onClick={onEnter}>
          {inArena ? 'Restart with this rule' : 'Enter the arena'}
        </button>
        {inArena && <span className="muted">Restarting wipes your lines{store.knobs?.resetScoreOnRule ? ' and score' : ''}.</span>}
      </footer>
    </div>
  );
}
