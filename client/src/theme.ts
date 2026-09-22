/**
 * Light/dark theme. The palette is Spectre's explorer tokens
 * (`web/src/styles/widgets.css`, plus the light-scheme accents `stats.css`
 * defines) ported whole, so the two projects look like one site.
 *
 * `styles.css` is the single source of those colours: this module only flips
 * `data-theme` on `<html>` and reads the handful of board tokens back out for
 * the canvas, which cannot use `var()`. Light is the default; the toggle, once
 * used, is remembered (and `?theme=dark` forces one for a screenshot).
 */

import { useEffect, useState } from 'react';
import { parseColor, type Rgb01 } from './tiles-layer';

export type ThemeName = 'light' | 'dark';

export const DEFAULT_THEME: ThemeName = 'light';

/** Where the remembered choice lives; the inline script in index.html reads the same key. */
export const THEME_KEY = 'spectacle.theme';

export function parseTheme(value: string | null | undefined): ThemeName | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function otherTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

/** `?theme=` beats the remembered choice, which beats light. Pure, so it is testable. */
export function initialTheme(stored: string | null, param: string | null): ThemeName {
  return parseTheme(param) ?? parseTheme(stored) ?? DEFAULT_THEME;
}

let current: ThemeName = DEFAULT_THEME;
const listeners = new Set<() => void>();

function stored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

/**
 * Put the theme on `<html>` (CSS does the rest), then read the board tokens
 * back out — here, while that theme is certainly the one in force — and match
 * the address bar to the board.
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  board = readTokens(theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', board.bgCss);
}

/** Resolve and apply the theme once, before React mounts. */
export function startTheme(): ThemeName {
  current = initialTheme(stored(), new URLSearchParams(location.search).get('theme'));
  applyTheme(current);
  return current;
}

export function getTheme(): ThemeName {
  return current;
}

export function setTheme(theme: ThemeName): void {
  if (theme === current) return;
  current = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: this tab only */
  }
  for (const fn of listeners) fn();
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The current theme and a setter, for components that restyle themselves. */
export function useTheme(): [ThemeName, (theme: ThemeName) => void] {
  const [theme, setLocal] = useState(getTheme);
  useEffect(() => subscribeTheme(() => setLocal(getTheme())), []);
  return [theme, setTheme];
}

/**
 * What the renderer needs to know about the scheme. Everything here comes from
 * a CSS token — see the `--board-*` / `--tile-*` block in `styles.css`.
 */
export interface BoardTheme {
  readonly name: ThemeName;
  /** The ground behind the tiles. */
  readonly bg: Rgb01;
  readonly bgCss: string;
  /** The scheme's ink: white-ish on the dark board, near-black on the light one. */
  readonly ink: Rgb01;
  readonly inkCss: string;
  /** Tile outlines (drawn only when zoomed in) and the halo on your own line. */
  readonly lineAlpha: number;
  readonly lineCss: string;
  readonly haloCss: string;
  /** The direction arrow on a tile, also ink — see `directionArrow`. */
  readonly arrowAlpha: number;
  readonly arrowCss: string;
  /** The cross on a stuck line. */
  readonly badCss: string;
  /** Per-type tile fills: saturation, and the lightness the first type takes. */
  readonly tileSat: number;
  readonly tileLight: number;
  /**
   * How far a claimed tile's tint moves off the owner's colour, in 0..255
   * channels: toward white on the dark board, the other way on the light one,
   * so the claim reads against the tiles either way.
   */
  readonly lift: number;
  readonly liftClosed: number;
  /**
   * How far a player's colour is deepened before it is drawn. The server hands
   * out bright colours, which is right on the dark board and washes out on the
   * pale one; see `strandColor`.
   */
  readonly strandDarken: number;
}

function rgbCss(c: readonly [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function rgba(c: readonly [number, number, number], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
}

let board: BoardTheme | null = null;

/**
 * The board palette of the theme now in force. Read from the stylesheet once
 * per change (a style recalc is cheap, but not free — never per frame).
 */
export function boardTheme(): BoardTheme {
  if (!board || board.name !== current) board = readTokens(current);
  return board;
}

/**
 * The fallbacks below only matter if the stylesheet has not loaded: a light
 * page must never get a black board.
 */
function readTokens(name: ThemeName): BoardTheme {
  const dark = name === 'dark';
  const s = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const str = (key: string, fallback: string): string => s?.getPropertyValue(key).trim() || fallback;
  const num = (key: string, fallback: number): number => {
    const n = Number.parseFloat(str(key, ''));
    return Number.isFinite(n) ? n : fallback;
  };
  const bg = parseColor(str('--bg', dark ? '#14161a' : '#f7f8fa'));
  const ink = parseColor(str('--text', dark ? '#e7e9ee' : '#171a1f'));
  const lineAlpha = num('--board-line-alpha', dark ? 0.1 : 0.14);
  const arrowAlpha = num('--board-arrow-alpha', dark ? 0.26 : 0.22);
  return {
    name,
    bg: [bg[0] / 255, bg[1] / 255, bg[2] / 255],
    bgCss: rgbCss(bg),
    ink: [ink[0] / 255, ink[1] / 255, ink[2] / 255],
    inkCss: rgbCss(ink),
    lineAlpha,
    lineCss: rgba(ink, lineAlpha),
    haloCss: rgba(ink, num('--board-halo-alpha', dark ? 0.55 : 0.45)),
    arrowAlpha,
    arrowCss: rgba(ink, arrowAlpha),
    badCss: str('--bad', dark ? '#f58aa2' : '#c53a60'),
    tileSat: num('--tile-sat', dark ? 0.34 : 0.4),
    tileLight: num('--tile-light', dark ? 0.31 : 0.76),
    lift: num('--tile-lift', dark ? 70 : -30),
    liftClosed: num('--tile-lift-closed', dark ? 30 : -55),
    strandDarken: num('--strand-darken', dark ? 0 : 0.22),
  };
}
