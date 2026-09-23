import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultRule, type PlayerRule } from '../../shared/game/rule';
import { Arena } from './Arena';
import { Lobby } from './Lobby';
import { DEFAULT_SOLO, LocalConnection, type SoloOptions } from './local';
import { Connection, type GameConnection } from './net';
import { clearSession, loadSession, saveSession } from './session';
import { Store } from './store';
import { useStore } from './useStore';

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

function initialMode(): Mode {
  if (SOLO_ONLY) return 'solo';
  return new URLSearchParams(location.search).has('solo') ? 'solo' : 'online';
}

export function App(): JSX.Element {
  const store = useMemo(() => new Store(), []);
  useStore(store);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [solo, setSolo] = useState<SoloOptions>(DEFAULT_SOLO);
  const [screen, setScreen] = useState<Screen>('lobby');
  const [name, setName] = useState(loadName);
  const [rule, setRule] = useState<PlayerRule | null>(null);
  const connRef = useRef<GameConnection | null>(null);
  const joined = useRef(false);
  const retry = useRef(0);
  /** What to send on reconnect so the player is picked up where they were. */
  const rejoin = useRef<{ name: string; rule: PlayerRule; resume: { id: string; token: string } | null } | null>(null);

  // One connection per (mode, solo options); reconnect online with backoff.
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    joined.current = false;
    // A refresh lands here with the tab's saved session: go straight back in.
    rejoin.current = mode === 'online' ? loadSession() : null;
    store.reset();
    setScreen(rejoin.current ? 'arena' : 'lobby');
    const connect = (): void => {
      if (disposed) return;
      const conn: GameConnection = mode === 'solo' ? new LocalConnection(store, solo) : new Connection(store);
      connRef.current = conn;
      conn.open(
        () => {
          retry.current = 0;
          // Back online after a drop or a refresh: rejoin straight away,
          // resuming if the server still has us, so the arena never shows the
          // lobby.
          const r = rejoin.current;
          if (r && conn.kind === 'online') {
            conn.send({ t: 'join', name: r.name, rule: r.rule, resume: r.resume ?? undefined });
            joined.current = true;
            setScreen('arena');
          }
        },
        () => {
          if (disposed) return;
          joined.current = false;
          if (rejoin.current && store.resume) rejoin.current.resume = store.resume;
          store.reset();
          if (!rejoin.current) setScreen('lobby');
          const delay = Math.min(10_000, 500 * 2 ** retry.current++);
          timer = window.setTimeout(connect, delay);
        },
      );
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      connRef.current?.close();
      connRef.current = null;
    };
  }, [mode, solo, store]);

  // Every welcome carries a fresh token (the server rotates it on resume):
  // keep the latest, for the next drop and the next refresh.
  useEffect(() => {
    const r = rejoin.current;
    if (mode !== 'online' || !r || !store.resume) return;
    if (r.resume && r.resume.id !== store.resume.id) store.toast('Your last session had expired — you are a new player', 'info');
    r.resume = store.resume;
    const rule = store.me?.rule ?? r.rule;
    saveSession({ name: r.name, rule, resume: store.resume });
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

  const enter = (): void => {
    const conn = connRef.current;
    if (!rule || !conn) return;
    try {
      localStorage.setItem('spectacle.name', name);
    } catch {
      /* private mode */
    }
    if (joined.current) conn.send({ t: 'rule', rule });
    else {
      conn.send({ t: 'join', name, rule });
      joined.current = true;
    }
    rejoin.current = { name, rule, resume: rejoin.current?.resume ?? null };
    if (mode === 'online' && rejoin.current.resume) saveSession({ name, rule, resume: rejoin.current.resume });
    setScreen('arena');
  };

  if (screen === 'arena' && (store.you || rejoin.current) && connRef.current) {
    return <Arena store={store} conn={connRef.current} onNewRule={() => setScreen('lobby')} />;
  }
  return (
    <Lobby
      store={store}
      mode={mode}
      solo={solo}
      rule={rule ?? defaultRule(solo.family)}
      name={name}
      inArena={joined.current && !!store.you}
      onMode={setMode}
      onSolo={setSolo}
      onRule={setRule}
      onName={setName}
      onEnter={enter}
      onCancel={() => setScreen('arena')}
    />
  );
}
