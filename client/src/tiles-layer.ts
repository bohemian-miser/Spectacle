/**
 * The tile layer draws the field itself (and the per-tile claim tint) into
 * the bottom canvas. Two implementations: WebGL2 instanced (`tiles-gl.ts`),
 * and a Canvas2D fallback that redraws the visible tiles when the camera
 * moves (`tiles-2d.ts`).
 */

import { TILE_PALETTES, type Pt, type Rgb, type TileTypeId } from '../../shared/tiles';
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
  /** Show or hide the direction arrows (the plain board hides them). */
  setArrows(on: boolean): void;
  draw(cam: Camera, width: number, height: number, dpr: number): void;
  dispose(): void;
}

/** Anything the palette has no entry for (there is nothing, today). */
const UNKNOWN_TILE: Rgb = [200, 200, 200];

/**
 * A tile type's colour: Spectre's original table (`config.colmap_orig`, the
 * explorer's `bright` scheme) — Xi yellow, the Gammas white, Pi sky blue.
 * A type is its colour across the whole project, board and rule lab alike.
 *
 * `dim` scales it toward black for the scheme: the light board shows the
 * colours as they are, the dark board sits them back so the strands on top
 * still carry. It is a plain multiply, so the hues never move.
 */
export function typeFill(type: TileTypeId, dim = 1): Rgb01 {
  const c = TILE_PALETTES.bright[type] ?? UNKNOWN_TILE;
  return [(c[0] / 255) * dim, (c[1] / 255) * dim, (c[2] / 255) * dim];
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
 * Every closed circuit's colour, told apart by length. A loop's length (log
 * scale, 8 to ~4000 steps) walks its hue `CIRCUIT_HUE_SPAN`° across the range,
 * centred on its owner's colour, and its lightness from pale (short loops) to
 * deep (long ones). Equal lengths still differ by up to ±`CIRCUIT_HUE_JITTER`°
 * (per circuit id), so two neighbouring loops never merge into one blob. The
 * result is the colour itself: no lift, no further darkening.
 */
const CIRCUIT_HUE_SPAN = 220;
const CIRCUIT_HUE_JITTER = 14;
const CIRCUIT_LIGHT = [84, 26] as const;

/** A stable 0..1 per circuit (golden-ratio walk over the path id). */
function circuitJitter(id: number): number {
  return (id * 0.6180339887498949) % 1;
}

/** Where a loop of `length` steps sits on the ramp, 0 (short) to 1 (long). */
export function circuitLengthT(length: number): number {
  return Math.max(0, Math.min(1, (Math.log2(Math.max(1, length)) - 3) / 9));
}

export function circuitColor(css: string, length: number, id: number): string {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%/.exec(css);
  if (!m) return css;
  const t = circuitLengthT(length);
  const shift = (t - 0.5) * CIRCUIT_HUE_SPAN + (circuitJitter(id) * 2 - 1) * CIRCUIT_HUE_JITTER;
  const h = (((Number(m[1]) + shift) % 360) + 360) % 360;
  const l = CIRCUIT_LIGHT[0] + (CIRCUIT_LIGHT[1] - CIRCUIT_LIGHT[0]) * t;
  return `hsl(${h.toFixed(1)}, ${m[2]}%, ${l.toFixed(1)}%)`;
}

/**
 * A circuit's colour under team colours: the team hue kept, only the
 * lightness walking the length ramp, so yours stay blue and theirs red.
 */
export function circuitShade(css: string, length: number): string {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%/.exec(css);
  if (!m) return css;
  const t = circuitLengthT(length);
  const l = 74 + (34 - 74) * t;
  return `hsl(${m[1]}, ${m[2]}%, ${l.toFixed(1)}%)`;
}

/** Turn an `hsl(…)` colour round the wheel by `deg`; any other form comes back as is. */
export function shiftHue(css: string, deg: number): string {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css);
  if (!m) return css;
  const h = (((Number(m[1]) + deg) % 360) + 360) % 360;
  return `hsl(${h.toFixed(1)}, ${m[2]}%, ${m[3]}%)`;
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
