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
