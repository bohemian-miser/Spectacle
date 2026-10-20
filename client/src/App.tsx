import { useEffect, useMemo, useRef, useState } from 'react';
import { isGameMode, type GameMode } from '../../shared/game/knobs';
import { defaultRule, type PlayerRule } from '../../shared/game/rule';
import { Arena } from './Arena';
import { installBackGuard, type BackGuard } from './back-guard';
import { Lobby } from './Lobby';
import { initialSolo, LocalConnection, saveSoloBots, type SoloOptions } from './local';
import { Connection, STALE_CLOSE, type GameConnection } from './net';
import { answerTabs, clearSession, forgetSession, heldElsewhere, loadSession, saveSession, touchSession } from './session';
import { Store } from './store';
import { useStore } from './useStore';
import { cleanRoomName } from '../../shared/game/room-name';
import { cleanShardName, shardWsUrl, validShardTemplate } from '../../shared/game/shard';

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

/** The online field size: ?level=, else the last one picked, else null (the server's default). */
function initialLevel(): number | null {
  const q = Number(new URLSearchParams(location.search).get('level'));
  if (Number.isInteger(q) && q > 0) return q;
  try {
    const saved = Number(localStorage.getItem('spectacle.level'));
    if (Number.isInteger(saved) && saved > 0) return saved;
  } catch {
    /* private mode */
  }
  return null;
}

/** A room named by a `?room=` link, online only: that room, or a new one by that name. */
export const LINK_ROOM = SOLO_ONLY ? null : cleanRoomName(new URLSearchParams(location.search).get('room'));
/** The shard a link names (`?s=`), whose server holds its room (shared/game/shard.ts). */
const LINK_SHARD = SOLO_ONLY ? null : cleanShardName(new URLSearchParams(location.search).get('s'));

/** How to reach any shard, as the last server's `hello` said: kept so a refresh can go straight to a saved shard. */
const TEMPLATE_KEY = 'spectacle.shardWs';
function loadTemplate(): string | null {
  try {
    const t = localStorage.getItem(TEMPLATE_KEY);
    return validShardTemplate(t) ? t : null;
  } catch {
    return null;
  }
}
function saveTemplate(t: string): void {
  try {
    localStorage.setItem(TEMPLATE_KEY, t);
  } catch {
    /* private mode */
  }
}

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

/**
 * Parking: an online tab nobody is looking at lets its socket go, so an open
 * tab doesn't keep a server (and, on Cloud Run, a billed instance) awake all
 * day. Hidden this long, or no input this long, and it closes; it comes back
 * — resuming the player on its saved ticket, as a refresh would — when the
 * tab is shown again or touched. A parked player is away like any other, so
 * the server's resume window and away switch apply.
 */
const PARK_HIDDEN_MS = { lobby: 60_000, arena: 3 * 60_000 };
const PARK_IDLE_MS = { lobby: 5 * 60_000, arena: 20 * 60_000 };
/** The close code of a socket the server let go for never joining (server/index.ts): park, don't redial. */
export const IDLE_CLOSE = 4003;

export function App(): JSX.Element {
  const store = useMemo(() => new Store(), []);
  useStore(store);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [solo, setSolo] = useState<SoloOptions>(initialSolo);
  const [gameMode, setGameMode] = useState<GameMode>(initialGameMode);
  /** The online field size picked (null: the server's default); one the server doesn't offer falls back to its default. */
  const [level, setLevel] = useState<number | null>(initialLevel);
  /** Bumped to start over with a fresh connection (leaving the arena). */
  const [epoch, setEpoch] = useState(0);
  const [screen, setScreen] = useState<Screen>('lobby');
  const [name, setName] = useState(loadName);
  const [rule, setRule] = useState<PlayerRule | null>(null);
  /** Why the lobby is back when the player didn't ask for it. */
  const [notice, setNotice] = useState('');
  /** Online, can't reach the server after a few tries — offer solo instead of just spinning. */
  const [struggling, setStruggling] = useState(false);
  /** Online, the socket let go while nobody's looking (see `PARK_HIDDEN_MS`). */
  const [parked, setParked] = useState(false);
  /** Set while parked: waking resumes our own ticket, which this tab's own `answerTabs` would otherwise claim against us. */
  const wasParked = useRef(false);
  const connRef = useRef<GameConnection | null>(null);
  const joined = useRef(false);
  const retry = useRef(0);
  /** What to send on reconnect so the player is picked up where they were. */
  /** Swallows back (Android's edge swipe) while the arena is up. */
  const backGuard = useRef<BackGuard | null>(null);
  const inArena = useRef(false);
  inArena.current = screen === 'arena';
  useEffect(() => {
    const g = installBackGuard(() => inArena.current, () => store.toast('Back is off in the arena — use the exit button to leave', 'info'));
    backGuard.current = g;
    return () => g.dispose();
  }, []);
  useEffect(() => {
    if (screen === 'arena') backGuard.current?.arm();
  }, [screen]);
  const rejoin = useRef<{ name: string; rule: PlayerRule; mode: GameMode; resume: { id: string; token: string } | null; room?: string; level?: number; shard?: string } | null>(null);
  /** The socket template for shards, from a `hello` (or the last one, kept). */
  const template = useRef<string | null>(loadTemplate());
  /** Set when a full shard hands a join on: the next connection carries `rejoin` as it is, not the saved ticket. */
  const keepRejoin = useRef(false);

  // One connection per (mode, solo options); reconnect online with backoff.
  useEffect(() => {
    // Parked: no connection, and the board stays as it was until we're back.
    if (parked) {
      wasParked.current = true;
      return;
    }
    const waking = wasParked.current;
    wasParked.current = false;
    let timer = 0;
    let disposed = false;
    joined.current = false;
    setStruggling(false);
    // A refresh lands here with the tab's saved session: go straight back in.
    // So does a new tab soon after the last one closed (the shared copy).
    const saved = mode === 'online' ? loadSession() : null;
    const kept = keepRejoin.current;
    keepRejoin.current = false;
    if (!kept) rejoin.current = saved ? { name: saved.name, rule: saved.rule, resume: saved.resume, room: saved.room, mode: saved.mode ?? 'normal', level: saved.level, shard: saved.shard } : null;
    // The player's shard, else the one a link names; with no template yet,
    // the page's own server (its hello brings the template, below).
    const target = rejoin.current ? rejoin.current.shard : LINK_SHARD;
    const url = target && template.current ? shardWsUrl(template.current, target) : undefined;
    store.reset();
    setScreen(rejoin.current ? 'arena' : 'lobby');
    const connect = (): void => {
      if (disposed) return;
      const conn: GameConnection = mode === 'solo' ? new LocalConnection(store, solo, gameMode) : new Connection(store, url);
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
            conn.send({ t: 'join', name: r.name, rule: r.rule, mode: r.mode, level: r.level, resume: r.resume ?? undefined, room: r.room ?? LINK_ROOM ?? undefined, packed: true });
            joined.current = true;
            setScreen('arena');
          }
        },
        (code) => {
          if (disposed) return;
          joined.current = false;
          if (code === IDLE_CLOSE) {
            setParked(true);
            return;
          }
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
          // stops presenting it as a silent, endless spinner. A server that
          // stopped answering has already kept the player waiting
          // `DEAD_MS`: offer the way out at once.
          if (mode === 'online' && (retry.current >= STRUGGLE_ATTEMPTS || code === STALE_CLOSE)) setStruggling(true);
          const delay = Math.min(10_000, 500 * 2 ** retry.current++);
          timer = window.setTimeout(connect, delay);
        },
      );
    };
    // A duplicated tab brings the original's ticket along, and a new tab may
    // have picked up the shared copy: if another tab is still playing the
    // player, start afresh here instead of taking it over.
    if (saved && !waking && !kept) {
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
  }, [mode, solo, store, mode === 'solo' ? gameMode : null, epoch, parked]);

  // Park an online tab that's hidden or untouched for a while; wake it when it's shown or touched.
  const screenRef = useRef<Screen>(screen);
  screenRef.current = screen;
  useEffect(() => {
    if (mode !== 'online') return;
    let lastInput = Date.now();
    let hiddenSince = document.hidden ? Date.now() : 0;
    let asleep = false;
    const wake = (): void => {
      lastInput = Date.now();
      if (!asleep) return;
      asleep = false;
      setParked(false);
    };
    const onVisibility = (): void => {
      if (document.hidden) hiddenSince = Date.now();
      else {
        hiddenSince = 0;
        wake();
      }
    };
    const check = (): void => {
      if (asleep) return;
      const now = Date.now();
      const where = screenRef.current;
      if ((hiddenSince && now - hiddenSince > PARK_HIDDEN_MS[where]) || now - lastInput > PARK_IDLE_MS[where]) {
        asleep = true;
        // Nothing goes out while parked; waking joins afresh on the saved ticket.
        joined.current = false;
        setParked(true);
      }
    };
    // The server let an idle lobby go (IDLE_CLOSE): the same as parking here.
    if (parked) asleep = true;
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(check, 10_000);
    return () => {
      for (const e of events) window.removeEventListener(e, wake);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [mode, parked]);

  // Tell a duplicated tab when this one is playing the player its ticket names.
  // Also while reconnecting (no `store.you` yet): a new tab on the shared
  // ticket would otherwise take the player over mid-reconnect.
  useEffect(() => answerTabs(() => (mode !== 'online' ? '' : joined.current && store.you ? store.you : (rejoin.current?.resume?.id ?? ''))), [mode, store]);

  // Every welcome carries a fresh token (the server rotates it on resume):
  // keep the latest, for the next drop and the next refresh.
  useEffect(() => {
    const r = rejoin.current;
    if (mode !== 'online' || !r || !store.resume) return;
    if (r.resume && r.resume.id !== store.resume.id) store.toast('Your last session had expired — you are a new player', 'info');
    r.resume = store.resume;
    if (store.room) r.room = store.room;
    const rule = store.me?.rule ?? r.rule;
    r.shard = store.hello?.shard?.name ?? r.shard;
    saveSession({ name: r.name, rule, mode: r.mode, resume: store.resume, room: r.room, level: r.level, shard: r.shard });
  }, [mode, store.resume, store]);

  // Keep the shared ticket's clock running while this tab plays its player,
  // so a new tab opened soon after this one closes still picks it up.
  useEffect(() => {
    if (mode !== 'online') return;
    const touch = (): void => {
      if (joined.current && store.you) touchSession(store.you);
    };
    const timer = window.setInterval(touch, 30_000);
    window.addEventListener('pagehide', touch);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', touch);
    };
  }, [mode, store]);

  // A saved session from an arena that has since changed family (a redeploy)
  // can't rejoin on its rule, and no longer names a player here: start over.
  useEffect(() => {
    const r = rejoin.current;
    if (mode !== 'online' || joined.current === false || store.you || !r || !store.hello) return;
    if (r.rule.family === store.hello.field.family) return;
    forgetSession();
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
  // A sharded server says how to reach the others. In the lobby with a link
  // to another shard, and no template to get there before: go there now.
  useEffect(() => {
    const info = store.hello?.shard;
    if (mode !== 'online' || !info) return;
    const learned = template.current !== info.template;
    template.current = info.template;
    if (learned) saveTemplate(info.template);
    if (learned && !joined.current && !rejoin.current && LINK_SHARD && LINK_SHARD !== info.name) setEpoch((n) => n + 1);
  }, [mode, store.hello, store]);

  useEffect(() => {
    if (!store.lastError || store.you || !joined.current) return;
    // A full shard hands the join on to the next: carry it there, same name, rule and room.
    const next = cleanShardName(store.lastError.next);
    const r = rejoin.current;
    if (next && template.current && r && r.shard !== next) {
      rejoin.current = { ...r, shard: next, resume: null };
      keepRejoin.current = true;
      joined.current = false;
      setEpoch((n) => n + 1);
      return;
    }
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
    // Only a size the server offers; otherwise it picks its default.
    const size = level !== null && store.hello?.levels.some((l) => l.level === level) ? level : undefined;
    if (joined.current) conn.send({ t: 'rule', rule });
    else {
      conn.send({ t: 'join', name, rule, mode: gameMode, level: size, room: LINK_ROOM ?? undefined, packed: true });
      joined.current = true;
    }
    const playing = rejoin.current?.mode ?? gameMode;
    const playingLevel = rejoin.current ? rejoin.current.level : size;
    const room = rejoin.current?.room ?? LINK_ROOM ?? undefined;
    // The shard this socket reached is where the player will be.
    const shard = store.hello?.shard?.name ?? rejoin.current?.shard;
    rejoin.current = { name, rule, mode: playing, resume: rejoin.current?.resume ?? null, room, level: playingLevel, shard };
    if (mode === 'online' && rejoin.current.resume) saveSession({ name, rule, mode: playing, resume: rejoin.current.resume, room, level: playingLevel, shard });
    setScreen('arena');
  };

  /** Leave the arena for the main screen: the player goes, and a fresh connection brings the lobby back. */
  const leave = (): void => {
    connRef.current?.send({ t: 'leave' });
    forgetSession();
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
    forgetSession();
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

  const pause = parked && (
    <div className="overlay park-overlay" role="status" onPointerDown={() => setParked(false)}>
      <div>
        Paused while you were away
        <div className="overlay-fallback">tap to carry on</div>
      </div>
    </div>
  );
  if (screen === 'arena' && (store.you || rejoin.current) && connRef.current) {
    return (
      <>
      <Arena
        store={store}
        conn={connRef.current}
        mode={mode}
        onNewRule={() => setScreen('lobby')}
        onLeave={leave}
        struggling={mode === 'online' && struggling}
        parked={parked}
        onGiveUp={leaveToSolo}
      />
      {pause}
      </>
    );
  }
  return (
    <>
    <Lobby
      store={store}
      mode={mode}
      solo={solo}
      gameMode={gameMode}
      struggling={mode === 'online' && (struggling || store.stale)}
      onGiveUp={leaveToSolo}
      onGameMode={(m) => {
        setGameMode(m);
        try {
          localStorage.setItem('spectacle.mode', m);
        } catch {
          /* private mode */
        }
      }}
      level={level}
      onLevel={(lv) => {
        setLevel(lv);
        try {
          localStorage.setItem('spectacle.level', String(lv));
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
    {pause}
    </>
  );
}
