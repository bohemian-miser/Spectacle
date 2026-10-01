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
 *
 * The tab's ticket is also copied to localStorage (`LAST_KEY`), so closing
 * the tab and opening the game again in a new one — or a phone browser
 * throwing the tab's storage away — still finds the player. A tab only falls
 * back on that copy when it has no ticket of its own, the copy was last seen
 * within the server's resume window, and no open tab is playing it (the same
 * `heldElsewhere` check a duplicated tab makes). The copy is removed only
 * when the player is gone for good (`forgetSession`); a tab that loses its
 * player to another tab drops just its own ticket (`clearSession`), since the
 * copy by then names the other tab's player.
 */
export interface SavedSession {
  readonly name: string;
  readonly rule: PlayerRule;
  readonly resume: ResumeTicket;
  /** The kind of arena it was (older sessions: normal). */
  readonly mode?: GameMode;
  /** The room it was in, so a rejoin after the server forgot us lands there again. */
  readonly room?: string;
}

const KEY = 'spectacle.session';
/** The last ticket any tab of this browser held, for a tab that has none. */
const LAST_KEY = 'spectacle.lastSession';
/**
 * How long after it was last seen the shared copy is still worth a resume:
 * the server's RESUME_GRACE_MS (5 min). Past it the player is gone, and
 * a new tab should open on the lobby rather than rejoin on an old rule.
 */
export const SHARED_MAX_AGE_MS = 300_000;

/** The shared copy: the ticket, and when its tab was last seen playing. */
interface SharedSession extends SavedSession {
  readonly seenAt: number;
}

function parse(raw: string | null): SavedSession | null {
  if (!raw) return null;
  const s = JSON.parse(raw) as Partial<SavedSession>;
  if (typeof s.name !== 'string' || !s.rule || typeof s.resume?.id !== 'string' || typeof s.resume.token !== 'string') return null;
  if (s.mode !== undefined && !isGameMode(s.mode)) return null;
  return s as SavedSession;
}

/**
 * This tab's ticket, else the shared one while it is fresh. `shared` says
 * which: a shared ticket may belong to an open tab, so check `heldElsewhere`
 * before resuming on either.
 */
export function loadSession(now = Date.now()): (SavedSession & { readonly shared: boolean }) | null {
  try {
    const own = parse(sessionStorage.getItem(KEY));
    if (own) return { ...own, shared: false };
  } catch {
    /* private mode, or a bad value: try the shared copy */
  }
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const s = parse(raw) as SharedSession | null;
    if (!s || typeof s.seenAt !== 'number' || now - s.seenAt > SHARED_MAX_AGE_MS || s.seenAt > now + 60_000) return null;
    const { seenAt: _, ...ticket } = s;
    return { ...ticket, shared: true };
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession, now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...s, seenAt: now } satisfies SharedSession));
  } catch {
    /* private mode */
  }
}

/**
 * The player `id` is still being played here: keep the shared copy's clock
 * running, so it is fresh when the tab closes. Only while the copy is still
 * ours — another tab may have saved its own since.
 */
export function touchSession(id: string, now = Date.now()): void {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const s = parse(raw) as SharedSession | null;
    if (s?.resume.id === id) localStorage.setItem(LAST_KEY, JSON.stringify({ ...s, seenAt: now } satisfies SharedSession));
  } catch {
    /* private mode */
  }
}

/** Drop this tab's ticket only (the player went to another tab, or isn't ours). */
export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/** The player is gone for good (left, or no longer valid here): drop this tab's ticket and the shared copy if it is the same player. */
export function forgetSession(): void {
  let id: string | undefined;
  try {
    id = parse(sessionStorage.getItem(KEY))?.resume.id;
  } catch {
    /* private mode */
  }
  clearSession();
  try {
    const shared = parse(localStorage.getItem(LAST_KEY));
    if (id !== undefined && shared?.resume.id === id) localStorage.removeItem(LAST_KEY);
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
