/**
 * Player feedback, the client half: where a report goes and what goes with
 * it. The server keeps it (server/feedback.ts) until the triage workflow
 * files it as a GitHub issue.
 */

import type { PlayerRule } from '../../shared/game/rule';
import { getTheme } from './theme';

/** The issue backlog, where a report turns up once the triage agent has filed it. */
export const BACKLOG_URL = 'https://github.com/bohemian-miser/Spectacle/issues';
/** Where to go when there is no server to send to, or it can't take it. */
export const ISSUES_URL = `${BACKLOG_URL}/new`;

/** The backlog searched for a report's id, which the triage agent writes into the issue. */
export function issueSearchUrl(id: string): string {
  return `${BACKLOG_URL}?q=${encodeURIComponent(`is:issue "${id}"`)}`;
}

/** The server's MAX_MESSAGE (server/feedback.ts). */
export const MAX_MESSAGE = 4000;

/** POST target: the server this page came from, or for the static build the online arena's (none without one). */
export function feedbackUrl(soloOnly: boolean, onlineUrl: string): string | null {
  if (!soloOnly) return '/feedback';
  return onlineUrl ? `${onlineUrl.replace(/\/+$/, '')}/feedback` : null;
}

/** What the screen knows about where the player is. */
export interface GameContext {
  readonly mode: 'online' | 'solo';
  readonly gameMode?: string;
  readonly room?: string;
  readonly field?: { readonly family: string; readonly level: number };
  readonly rule?: PlayerRule;
  readonly renderer?: string;
}

/** The context sent with a report (server/feedback.ts's FeedbackContext): the game's, plus page, theme, screen and browser. */
export function feedbackContext(game: GameContext): Record<string, unknown> {
  return {
    url: location.href,
    mode: game.mode,
    gameMode: game.gameMode,
    room: game.room || undefined,
    field: game.field ? `${game.field.family} level ${game.field.level}` : undefined,
    rule: game.rule,
    theme: getTheme(),
    renderer: game.renderer,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    userAgent: navigator.userAgent,
  };
}

/** Send a report: its id, or the error (the server's own words when it gives any). */
export async function sendFeedback(
  url: string,
  report: { message: string; contact: string; context?: Record<string, unknown> },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const j = (await r.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (r.ok) return { ok: true, id: j?.id ?? '' };
    return { ok: false, error: j?.error ?? `The server answered ${r.status}.` };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}
