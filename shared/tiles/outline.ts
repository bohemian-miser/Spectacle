/**
 * Outline path generation — ports the `CurvyShape` constructor
 * (tiles.ts:480–505) and the polygon emission of `Shape.streamSVG`.
 */

import type { Pt } from './geom';

function fmt(n: number): string {
  return String(n);
}

/** SVG polygon path 'M … L … Z' through the given vertices. */
export function straightOutline(pts: readonly Pt[]): string {
  if (pts.length === 0) return '';
  let s = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) s += ` L ${fmt(pts[i].x)} ${fmt(pts[i].y)}`;
  return `${s} Z`;
}

/** SVG `points="x,y x,y …"` attribute value (matches the old streamSVG form). */
export function polygonPoints(pts: readonly Pt[]): string {
  return pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
}

/**
 * Control-point expansion of the `CurvyShape` constructor: starting from the
 * LAST vertex, each edge gets two control points at 0.33/0.67 along the edge
 * offset by ±0.6 along the left normal, with the sign ALTERNATING per edge
 * (the old `blah` flag, which starts positive).
 *
 * Returns `[start, c1, c2, end, c1, c2, end, …]`.
 */
export function curvyPts(pts: readonly Pt[]): readonly Pt[] {
  if (pts.length === 0) return [];
  let blah = true;
  const out: Pt[] = [pts[pts.length - 1]];
  for (const p of pts) {
    const prev = out[out.length - 1];
    const vx = p.x - prev.x;
    const vy = p.y - prev.y;
    const wx = -vy;
    const wy = vx;
    const sign = blah ? 1 : -1;
    out.push({ x: prev.x + 0.33 * vx + sign * 0.6 * wx, y: prev.y + 0.33 * vy + sign * 0.6 * wy });
    out.push({ x: prev.x + 0.67 * vx + sign * 0.6 * wx, y: prev.y + 0.67 * vy + sign * 0.6 * wy });
    blah = !blah;
    out.push(p);
  }
  return out;
}

/** SVG cubic-bezier outline, matching the old `CurvyShape.streamSVG` path data. */
export function curvyOutline(pts: readonly Pt[]): string {
  const cp = curvyPts(pts);
  if (cp.length === 0) return '';
  let s = `M ${fmt(cp[0].x)} ${fmt(cp[0].y)}`;
  for (let idx = 1; idx + 2 < cp.length; idx += 3) {
    const a = cp[idx];
    const b = cp[idx + 1];
    const c = cp[idx + 2];
    s += ` C ${fmt(a.x)} ${fmt(a.y)} ${fmt(b.x)} ${fmt(b.y)} ${fmt(c.x)} ${fmt(c.y)}`;
  }
  return `${s} Z`;
}

/** Convenience: straight or curvy outline of a tile's vertices. */
export function outlinePath(pts: readonly Pt[], curvy: boolean): string {
  return curvy ? curvyOutline(pts) : straightOutline(pts);
}
