/**
 * Affine geometry primitives — pure port of `web/src/utils.ts`.
 *
 * The only changes from the original are cosmetic: `p.cos/p.sin` become
 * `Math.cos/Math.sin` (identical for radian input) and points are plain
 * `{x, y}` objects instead of `p5.Vector`.
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * Row-major 2x3 affine matrix `[a b c / d e f]`, i.e. the same 6-number
 * layout the old `number[]` transforms used:
 *   x' = a*x + b*y + c
 *   y' = d*x + e*y + f
 */
export type Affine = readonly [number, number, number, number, number, number];

/** utils.ident */
export const IDENT: Affine = [1, 0, 0, 0, 1, 0];

/** utils.adjust_mat — kept for parity with the old thumbnail framing. */
export const ADJUST_MAT: Affine = [0.95, 0, 0, 0, 0.95, 0.3];

/** The reflection used by the substitution rules (sketch.ts buildSupertiles). */
export const REFLECT_X: Affine = [-1, 0, 0, 0, 1, 0];

export function pt(x: number, y: number): Pt {
  return { x, y };
}

/** utils.inv — affine matrix inverse. */
export function inv(T: Affine): Affine {
  const det = T[0] * T[4] - T[1] * T[3];
  return [
    T[4] / det,
    -T[1] / det,
    (T[1] * T[5] - T[2] * T[4]) / det,
    -T[3] / det,
    T[0] / det,
    (T[2] * T[3] - T[0] * T[5]) / det,
  ];
}

/** utils.mul — affine matrix multiply (A then applied to B's output). */
export function mul(A: Affine, B: Affine): Affine {
  return [
    A[0] * B[0] + A[1] * B[3],
    A[0] * B[1] + A[1] * B[4],
    A[0] * B[2] + A[1] * B[5] + A[2],

    A[3] * B[0] + A[4] * B[3],
    A[3] * B[1] + A[4] * B[4],
    A[3] * B[2] + A[4] * B[5] + A[5],
  ];
}

/** utils.trot — rotation by `ang` radians. */
export function trot(ang: number): Affine {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [c, -s, 0, s, c, 0];
}

/** utils.ttrans — translation. */
export function ttrans(tx: number, ty: number): Affine {
  return [1, 0, tx, 0, 1, ty];
}

/** utils.transPt — matrix * point. */
export function transPt(M: Affine, P: Pt): Pt {
  return { x: M[0] * P.x + M[1] * P.y + M[2], y: M[3] * P.x + M[4] * P.y + M[5] };
}

/** Determinant of the linear part; negative means the transform mirrors. */
export function det(M: Affine): number {
  return M[0] * M[4] - M[1] * M[3];
}

/** p5.radians */
export function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Arithmetic mean of a point list (used for label placement / inward normals). */
export function centroid(pts: readonly Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const n = pts.length || 1;
  return { x: sx / n, y: sy / n };
}

/** Linear interpolation between two points. */
export function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distSq(a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

/**
 * Convert a row-major `Affine` to the column-major argument order SVG's
 * `matrix(a, b, c, d, e, f)` expects. Row-major `[a b c / d e f]` becomes
 * `matrix(a, d, b, e, c, f)`.
 */
export function toSvgMatrix(M: Affine): [number, number, number, number, number, number] {
  return [M[0], M[3], M[1], M[4], M[2], M[5]];
}

/** `matrix(...)` transform string for SVG/Canvas consumers. */
export function svgMatrixString(M: Affine): string {
  return `matrix(${toSvgMatrix(M).join(',')})`;
}
