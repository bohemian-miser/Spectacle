/**
 * The tile layer draws the field itself (and the per-tile claim tint) into
 * the bottom canvas. Two implementations: WebGL2 instanced (`tiles-gl.ts`),
 * and a Canvas2D fallback that redraws the visible tiles when the camera
 * moves (`tiles-2d.ts`).
 */

import type { Pt } from '../../shared/tiles';
import type { Camera } from './camera';
import type { BoardTheme } from './theme';

/** Colour channels in 0..1. */
export type Rgb01 = readonly [number, number, number];

export interface TileLayer {
  readonly kind: 'webgl' | 'canvas2d';
  /** Physical pixel size. */
  resize(pw: number, ph: number): void;
  /** Re-colour for another scheme; the renderer owns the field, so it hands over the fills. */
  setTheme(board: BoardTheme, fills: readonly Rgb01[]): void;
  clearTints(): void;
  /** 0..255 channels; `a` is the tint strength. */
  setTint(tile: number, r: number, g: number, b: number, a: number): void;
  draw(cam: Camera, width: number, height: number, dpr: number): void;
  dispose(): void;
}

/**
 * Muted per-type fills under the strands; claimed tiles get the owner's colour
 * on top. The hues are the tiling's own, the scheme only says how dark they sit
 * (deep on the dark board, pastel on the light one).
 */
export function typeFill(family: string, index: number, board: BoardTheme): Rgb01 {
  const h = family === 'hex' ? (index * 36 + 200) % 360 : (index * 33 + 180) % 360;
  return hslToRgb(h, board.tileSat, board.tileLight + (index % 3) * 0.03);
}

/**
 * World→pixel scale at which a tile is big enough to wear its direction arrow.
 * A hexagon is 2 units across, so this is about 36 px of tile: below it the
 * darts turn into speckle and the board is better off without them.
 */
export const ARROW_MIN_SCALE = 18;

/**
 * A dart in tile-local coordinates, from the tile's centre to the middle of its
 * edge 0 — which way the tile is turned.
 *
 * Hexagons are why this exists: every hex tile is the same regular hexagon, so
 * nothing on the board says which of the six rotations a tile is sitting in,
 * while its edge classes are numbered from edge 0 round. The arrow is that
 * edge, and the thumb in the rule editor wears the same one, so the numbers
 * there can be read straight off the board.
 */
export function directionArrow(pts: readonly Pt[]): Pt[] {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x / n;
    cy += p.y / n;
  }
  const mx = (pts[0].x + pts[1 % n].x) / 2;
  const my = (pts[0].y + pts[1 % n].y) / 2;
  const r = Math.hypot(mx - cx, my - cy) || 1;
  // Unit vector at the edge, and its left normal.
  const dx = (mx - cx) / r;
  const dy = (my - cy) / r;
  const nx = -dy;
  const ny = dx;
  const at = (along: number, across: number): Pt => ({
    x: cx + dx * along * r + nx * across * r,
    y: cy + dy * along * r + ny * across * r,
  });
  const tip = 0.62;
  const head = 0.24;
  const wing = 0.21;
  const shaft = 0.08;
  const tail = -0.34;
  return [at(tip, 0), at(head, wing), at(head, shaft), at(tail, shaft), at(tail, -shaft), at(head, -shaft), at(head, -wing)];
}

export function hslToRgb(h: number, s: number, l: number): Rgb01 {
  const a = s * Math.min(l, 1 - l);
  const f = (k0: number): number => {
    const k = (k0 + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function cssRgb(c: Rgb01): string {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

/**
 * A closed circuit's colour: the owner's colour, darkened with the length of
 * the loop — short loops stay bright, a loop of thousands of tiles goes deep.
 * `t` in [0, 1] is the darkening amount; the same curve serves lines and tints.
 */
export function circuitDarkening(length: number): number {
  return Math.min(0.42, 0.42 * (Math.log2(Math.max(1, length)) / 12));
}

/**
 * A player's colour as this board should draw it: deepened where the ground is
 * pale, and darkened further by `extra` (a closed circuit's length).
 */
export function strandColor(board: BoardTheme, css: string, extra = 0): string {
  const t = 1 - (1 - board.strandDarken) * (1 - extra);
  return t > 0.001 ? darkenCss(css, t) : css;
}

export function darkenCss(css: string, t: number): string {
  const [r, g, b] = parseColor(css);
  const k = 1 - t;
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

/** Parse `hsl(h, s%, l%)` or `#rrggbb` into 0..255 channels. */
export function parseColor(css: string): [number, number, number] {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css);
  if (m) {
    const c = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
  }
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (h) {
    const v = Number.parseInt(h[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return [255, 255, 255];
}
