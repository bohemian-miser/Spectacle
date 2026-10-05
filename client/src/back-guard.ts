/**
 * Swallows the browser's back while the arena is up. On Android the system
 * back gesture is a swipe in from either screen edge — exactly where a player
 * pans and taps — and a page can't turn that gesture off. What it can do is
 * keep a spare history entry on top, so the gesture only pops that: in the
 * arena it is pushed straight back and nothing leaves; elsewhere (the lobby)
 * back carries on to wherever it would have gone.
 */
const MARK = 'spectacleBackGuard';

function guarded(): boolean {
  const s = history.state as Record<string, unknown> | null;
  return !!s && s[MARK] === true;
}

function push(): void {
  history.pushState({ ...((history.state as object | null) ?? {}), [MARK]: true }, '');
}

export interface BackGuard {
  /** Puts the spare entry back if it is gone (call on entering the arena). */
  arm(): void;
  dispose(): void;
}

/** Installs the guard; `trapped` says whether back should be swallowed now. */
export function installBackGuard(trapped: () => boolean, onBlocked: () => void): BackGuard {
  if (typeof history === 'undefined' || typeof history.pushState !== 'function') return { arm: () => {}, dispose: () => {} };
  const arm = (): void => {
    if (!guarded()) push();
  };
  arm();
  const onPop = (): void => {
    if (guarded()) return; // forward onto our own entry
    if (trapped()) {
      push();
      onBlocked();
    } else {
      history.back(); // past the spare entry: leave as the player meant to
    }
  };
  window.addEventListener('popstate', onPop);
  return { arm, dispose: () => window.removeEventListener('popstate', onPop) };
}
