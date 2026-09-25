import { useEffect, useMemo, useRef, useState } from 'react';
import { isGameMode, type GameMode } from '../../shared/game/knobs';
import { defaultRule, type PlayerRule } from '../../shared/game/rule';
import { Arena } from './Arena';
import { Lobby } from './Lobby';
import { initialSolo, LocalConnection, saveSoloBots, type SoloOptions } from './local';
import { Connection, type GameConnection } from './net';
import { answerTabs, clearSession, heldElsewhere, loadSession, saveSession } from './session';
import { Store } from './store';
import { useStore } from './useStore';
import { cleanRoomName } from '../../shared/game/room-name';

export type Mode = 'online' | 'solo';
type Screen = 'lobby' | 'arena';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
/** The static (GitHub Pages) build has no server behind it: solo only. */
export const SOLO_ONLY = env.VITE_SOLO_ONLY === '1';
/** Where the online arena lives, for the static build to link to. */
export const ONLINE_URL = env.VITE_ONLINE_URL || '';

function loadName(): string {
  try {
    return localStorage.getItem('spectacle.name') ?? '';
  } catch {
    return '';
  }
}

/** The game mode (normal or conquest): ?mode=, else the last one picked, else normal. */
function initialGameMode(): GameMode {
  const q = new URLSearchParams(location.search).get('mode');
  if (isGameMode(q)) return q;
  try {
    const saved = localStorage.getItem('spectacle.mode');
    if (isGameMode(saved)) return saved;
  } catch {
    /* private mode */
  }
  return 'normal';
}

/** A room named by a `?room=` link, online only: that room, or a new one by that name. */
export const LINK_ROOM = SOLO_ONLY ? null : cleanRoomName(new URLSearchParams(location.search).get('room'));

function initialMode(): Mode {
  if (SOLO_ONLY) return 'solo';
  return new URLSearchParams(location.search).has('solo') ? 'solo' : 'online';
}

/**
 * Consecutive failed connect attempts before we stop just retrying silently
 * and offer solo instead — a busy or overloaded server should never leave a
 * player staring at "Connecting…" with no way out. At the default backoff
 * (500ms, 1s, 2s, …) this is a few seconds in; retries keep going in the
 * background after, so it still recovers on its own if the server comes back.
 */
const STRUGGLE_ATTEMPTS = 3;

export function App(): JSX.Element {
  const store = useMemo(() => new Store(), []);
  useStore(store);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [solo, setSolo] = useState<SoloOptions>(initialSolo);
  const [gameMode, setGameMode] = useState<GameMode>(initialGameMode);
  /** Bumped to start over with a fresh connection (leaving the arena). */
  const [epoch, setEpoch] = useState(0);
  const [screen, setScreen] = useState<Screen>('lobby');
  const [name, setName] = useState(loadName);
  const [rule, setRule] = useState<PlayerRule | null>(null);
  /** Why the lobby is back when the player didn't ask for it. */
  const [notice, setNotice] = useState('');
  /** Online, can't reach the server after a few tries — offer solo instead of just spinning. */
  const [struggling, setStruggling] = useState(false);
  const connRef = useRef<GameConnection | null>(null);
  const joined = useRef(false);
  const retry = useRef(0);
  /** What to send on reconnect so the player is picked up where they were. */
  const rejoin = useRef<{ name: string; rule: PlayerRule; mode: GameMode; resume: { id: string; token: string } | null; room?: string } | null>(null);

  // One connection per (mode, solo options); reconnect online with backoff.
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    joined.current = false;
    setStruggling(false);
    // A refresh lands here with the tab's saved session: go straight back in.
    const saved = mode === 'online' ? loadSession() : null;
    rejoin.current = saved ? { ...saved, mode: saved.mode ?? 'normal' } : null;
    store.reset();
    setScreen(rejoin.current ? 'arena' : 'lobby');
    const connect = (): void => {
      if (disposed) return;
      const conn: GameConnection = mode === 'solo' ? new LocalConnection(store, solo, gameMode) : new Connection(store);
      connRef.current = conn;
      conn.open(
        () => {
          retry.current = 0;
          setStruggling(false);
          // Back online after a drop or a refresh: rejoin straight away,
          // resuming if the server still has us, so the arena never shows the
          // lobby.
          const r = rejoin.current;
          if (r && conn.kind === 'online') {
            conn.send({ t: 'join', name: r.name, rule: r.rule, mode: r.mode, resume: r.resume ?? undefined, room: r.room ?? LINK_ROOM ?? undefined });
            joined.current = true;
            setScreen('arena');
          }
        },
        (code) => {
          if (disposed) return;
          joined.current = false;
          if (code === 4000) {
            // Resumed in another tab: the player is theirs now, and our
            // ticket is dead — rejoining on it would only make a second one.
            rejoin.current = null;
            clearSession();
            setNotice('Your game carried on in another tab.');
          } else if (rejoin.current) {
            if (store.resume) rejoin.current.resume = store.resume;
            // If the server forgot us (a restart), rejoin the same room.
            if (store.room) rejoin.current.room = store.room;
          }
          store.reset();
          if (!rejoin.current) setScreen('lobby');
          // Still retrying in the background either way (below) — this only
          // stops presenting it as a silent, endless spinner.
          if (mode === 'online' && retry.current >= STRUGGLE_ATTEMPTS) setStruggling(true);
          const delay = Math.min(10_000, 500 * 2 ** retry.current++);
          timer = window.setTimeout(connect, delay);
        },
      );
    };
    // A duplicated tab brings the original's ticket along: if that tab is
    // still playing the player, start afresh here instead of taking it over.
    if (saved) {
      void heldElsewhere(saved.resume.id).then((held) => {
        if (disposed) return;
        if (held) {
          clearSession();
          rejoin.current = null;
          setScreen('lobby');
        }
        connect();
      });
    } else connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      connRef.current?.close();
      connRef.current = null;
    };
    // A solo board is rebuilt for a new game mode; online, the mode only picks the room on join.
  }, [mode, solo, store, mode === 'solo' ? gameMode : null, epoch]);

  // Tell a duplicated tab when this one is playing the player its ticket names.
  useEffect(() => answerTabs(() => (mode === 'online' && joined.current ? store.you : '')), [mode, store]);

  // Every welcome carries a fresh token (the server rotates it on resume):
  // keep the latest, for the next drop and the next refresh.
  useEffect(() => {
    const r = rejoin.current;
    if (mode !== 'online' || !r || !store.resume) return;
    if (r.resume && r.resume.id !== store.resume.id) store.toast('Your last session had expired — you are a new player', 'info');
    r.resume = store.resume;
    if (store.room) r.room = store.room;
    const rule = store.me?.rule ?? r.rule;
    saveSession({ name: r.name, rule, mode: r.mode, resume: store.resume, room: r.room });
  }, [mode, store.resume, store]);

  // A saved session from an arena that has since changed family (a redeploy)
  // can't rejoin on its rule, and no longer names a player here: start over.
  useEffect(() => {
    const r = rejoin.current;
    if (mode !== 'online' || joined.current === false || store.you || !r || !store.hello) return;
    if (r.rule.family === store.hello.field.family) return;
    clearSession();
    rejoin.current = null;
    joined.current = false;
    setScreen('lobby');
  }, [mode, store.hello, store.you, store]);

  // Once we know the arena's family, offer a starting rule for it.
  useEffect(() => {
    if (store.hello && (!rule || rule.family !== store.hello.field.family)) setRule(defaultRule(store.hello.field.family));
  }, [store.hello, rule]);

  // A join was refused (the arena's full, an invalid rule, …): back out of
  // the optimistic "joined" state to the lobby with the reason, rather than
  // leaving the player looking at an empty arena that never welcomes them.
  useEffect(() => {
    if (!store.lastError || store.you || !joined.current) return;
    joined.current = false;
    rejoin.current = null;
    setScreen('lobby');
    setNotice(store.lastError.message);
  }, [store.lastError, store]);

  const enter = (): void => {
    const conn = connRef.current;
    if (!rule || !conn) return;
    setNotice('');
    try {
      localStorage.setItem('spectacle.name', name);
    } catch {
      /* private mode */
    }
    if (joined.current) conn.send({ t: 'rule', rule });
    else {
      conn.send({ t: 'join', name, rule, mode: gameMode, room: LINK_ROOM ?? undefined });
      joined.current = true;
    }
    const playing = rejoin.current?.mode ?? gameMode;
    const room = rejoin.current?.room ?? LINK_ROOM ?? undefined;
    rejoin.current = { name, rule, mode: playing, resume: rejoin.current?.resume ?? null, room };
    if (mode === 'online' && rejoin.current.resume) saveSession({ name, rule, mode: playing, resume: rejoin.current.resume, room });
    setScreen('arena');
  };

  /** Leave the arena for the main screen: the player goes, and a fresh connection brings the lobby back. */
  const leave = (): void => {
    connRef.current?.send({ t: 'leave' });
    clearSession();
    rejoin.current = null;
    joined.current = false;
    setEpoch((n) => n + 1);
  };

  /** Switch between online and solo, clearing any notice left over from the mode being left. */
  const changeMode = (m: Mode): void => {
    setNotice('');
    setMode(m);
  };

  /** Give up on the online arena (it's full, or unreachable) and switch to solo, in this tab. */
  const leaveToSolo = (): void => {
    connRef.current?.send({ t: 'leave' });
    clearSession();
    rejoin.current = null;
    joined.current = false;
    setStruggling(false);
    changeMode('solo');
  };

  /** Put the edited rule in captured slot `index` instead of restarting on it. */
  const swap = (index: number): void => {
    const conn = connRef.current;
    if (!rule || !conn || !joined.current) return;
    conn.send({ t: 'swap', index, rule });
    setScreen('arena');
  };

  if (screen === 'arena' && (store.you || rejoin.current) && connRef.current) {
    return (
      <Arena
        store={store}
        conn={connRef.current}
        onNewRule={() => setScreen('lobby')}
        onLeave={leave}
        struggling={mode === 'online' && struggling}
        onGiveUp={leaveToSolo}
      />
    );
  }
  return (
    <Lobby
      store={store}
      mode={mode}
      solo={solo}
      gameMode={gameMode}
      struggling={mode === 'online' && struggling}
      onGiveUp={leaveToSolo}
      onGameMode={(m) => {
        setGameMode(m);
        try {
          localStorage.setItem('spectacle.mode', m);
        } catch {
          /* private mode */
        }
      }}
      rule={rule ?? defaultRule(solo.family)}
      name={name}
      inArena={joined.current && !!store.you}
      notice={notice}
      linkRoom={mode === 'online' ? LINK_ROOM : null}
      onMode={changeMode}
      onSolo={(opts) => {
        if (opts.bots !== solo.bots) saveSoloBots(opts.bots);
        setSolo(opts);
      }}
      onRule={setRule}
      onName={setName}
      onEnter={enter}
      onSwap={swap}
      onCancel={() => setScreen('arena')}
      onLeave={leave}
    />
  );
}
