import { isGameMode, type GameMode } from '../../shared/game/knobs';
import type { ResumeTicket } from '../../shared/game/protocol';
import type { PlayerRule } from '../../shared/game/rule';

/**
 * The online session, kept so a page refresh picks the same player back up.
 *
 * sessionStorage, not localStorage or a cookie: it is per tab (two tabs are
 * two players, not one fighting itself), it dies with the tab (the server
 * forgets the player after RESUME_GRACE_MS anyway), and it never rides along
 * on a request the way a cookie would. The server rotates the token on every
 * resume, so a stale copy — a duplicated tab, a leaked value — is dead the
 * moment the real tab reconnects.
 */
export interface SavedSession {
  readonly name: string;
  readonly rule: PlayerRule;
  readonly resume: ResumeTicket;
  /** The kind of arena it was (older sessions: normal). */
  readonly mode?: GameMode;
}

const KEY = 'spectacle.session';

export function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedSession>;
    if (typeof s.name !== 'string' || !s.rule || typeof s.resume?.id !== 'string' || typeof s.resume.token !== 'string') return null;
    if (s.mode !== undefined && !isGameMode(s.mode)) return null;
    return s as SavedSession;
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/*
 * A duplicated tab copies sessionStorage, ticket and all, so it would resume
 * the player the original tab is still playing: it lands in that tab's arena
 * (whatever mode it asked for) and the original, kicked off, comes back as a
 * second player. So before resuming, a tab asks the others on a
 * BroadcastChannel whether one of them holds the player; a refreshed page is
 * gone by then and doesn't answer.
 */
const TABS = 'spectacle.tabs';
const ASK_MS = 150;

type TabMessage = { t: 'who'; id: string } | { t: 'mine'; id: string };

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(TABS) : null;
  } catch {
    return null;
  }
}

/** Resolves true when another open tab says it is playing `id`. */
export function heldElsewhere(id: string): Promise<boolean> {
  const ch = channel();
  if (!ch) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (held: boolean): void => {
      window.clearTimeout(timer);
      ch.close();
      resolve(held);
    };
    const timer = window.setTimeout(() => done(false), ASK_MS);
    ch.onmessage = (e: MessageEvent<TabMessage>) => {
      if (e.data?.t === 'mine' && e.data.id === id) done(true);
    };
    ch.postMessage({ t: 'who', id } satisfies TabMessage);
  });
}

/** Answer other tabs asking after the player this tab is playing (`current()`); returns the unsubscribe. */
export function answerTabs(current: () => string): () => void {
  const ch = channel();
  if (!ch) return () => {};
  ch.onmessage = (e: MessageEvent<TabMessage>) => {
    const id = current();
    if (e.data?.t === 'who' && id && e.data.id === id) ch.postMessage({ t: 'mine', id } satisfies TabMessage);
  };
  return () => ch.close();
}

const HELP_KEY = 'spectacle.helpSeen';

/** The "tap a tile" card shows once per browser, not once per arena visit. */
export function helpSeen(): boolean {
  try {
    return localStorage.getItem(HELP_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHelpSeen(): void {
  try {
    localStorage.setItem(HELP_KEY, '1');
  } catch {
    /* private mode */
  }
}
