/**
 * The tile layer draws the field itself (and the per-tile claim tint) into
 * the bottom canvas. Two implementations: WebGL2 instanced (`tiles-gl.ts`),
 * and a Canvas2D fallback that redraws the visible tiles when the camera
 * moves (`tiles-2d.ts`).
 */

import type { Camera } from './camera';

/** Colour channels in 0..1. */
export type Rgb01 = readonly [number, number, number];

export interface TileLayer {
  readonly kind: 'webgl' | 'canvas2d';
  /** Physical pixel size. */
  resize(pw: number, ph: number): void;
  clearTints(): void;
  /** 0..255 channels; `a` is the tint strength. */
  setTint(tile: number, r: number, g: number, b: number, a: number): void;
  draw(cam: Camera, width: number, height: number, dpr: number): void;
  dispose(): void;
}

/** Muted per-type fills on a dark ground; claimed tiles get the owner's colour on top. */
export function typeFill(family: string, index: number): Rgb01 {
  const h = family === 'hex' ? (index * 36 + 200) % 360 : (index * 33 + 180) % 360;
  return hslToRgb(h, 0.13, 0.17 + (index % 3) * 0.02);
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
