import { describe, expect, it } from 'vitest';
import { buildField, chainOutline, fieldOutline, polygonArea, tilePolygon, tileType } from '../shared/game/field';
import { defaultRule, fassRule, randomCleanRule, ruleFromCombo, type PlayerRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor, tileChords, walkStrand, worldChord } from '../shared/game/strand';
import { connectionPoints, leafPts, transPt, validEdgeSubsets, type Pt } from '../shared/tiles';
import {
  VIEW_FAMILY,
  fitSimilarity,
  pieceXform,
  spectreView,
  viewChord,
  viewOutline,
  viewPoint,
  viewPolygon,
  viewStep,
  viewTap,
  viewTileAt,
} from '../client/src/spectre-view';

const LEVEL = 3;
const field = buildField({ family: 'hex', level: LEVEL, rootTile: 'Delta' });
const view = spectreView(field);
const key = (x: number, y: number): string => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
const near = (a: Pt, b: Pt, eps = 1e-9): boolean => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

/** Is `p` on the outline of polygon `poly`? */
function onOutline(p: Pt, poly: readonly Pt[], eps = 1e-7): boolean {
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const u = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (Math.hypot(a.x + vx * u - p.x, a.y + vy * u - p.y) < eps) return true;
  }
  return false;
}

describe('the Spectre view of a hexagon field', () => {
  it('has one piece per hex tile and two per Gamma, in step', () => {
    let gammas = 0;
    for (let i = 0; i < field.count; i++) {
      const n = view.first[i + 1] - view.first[i];
      if (tileType(field, i) === 'Gamma') {
        gammas++;
        expect(n).toBe(2);
        expect(view.leafTypes[view.types[view.first[i]]]).toBe('Gamma1');
        expect(view.leafTypes[view.types[view.first[i] + 1]]).toBe('Gamma2');
      } else {
        expect(n).toBe(1);
        expect(view.leafTypes[view.types[view.first[i]]]).toBe(tileType(field, i));
      }
      for (let s = view.first[i]; s < view.first[i + 1]; s++) expect(view.parent[s]).toBe(i);
    }
    expect(gammas).toBeGreaterThan(0);
    expect(view.count).toBe(field.count + gammas);
  });

  it('starts on the hexagons: every corner, exactly each tile’s area', () => {
    for (let i = 0; i < field.count; i++) {
      const hex = tilePolygon(field, i);
      const corners = new Set(hex.map((p) => key(p.x, p.y)));
      let area = 0;
      const seen = new Set<string>();
      for (let s = view.first[i]; s < view.first[i + 1]; s++) {
        const poly = viewPolygon(view, s, 0);
        area += polygonArea(poly);
        for (const p of poly) seen.add(key(p.x, p.y));
      }
      expect(area).toBeCloseTo(polygonArea(hex), 9);
      for (const c of corners) expect(seen.has(c), `tile ${i} corner ${c}`).toBe(true);
    }
  });

  it('ends on the fitted Spectre patch: a vertex shared by pieces has one home, and pieces touch as hexagons', () => {
    const home = new Map<string, Pt>();
    for (let s = 0; s < view.count; s++) {
      const to = viewPolygon(view, s, 1);
      const from = viewPolygon(view, s, 0);
      to.forEach((p, k) => {
        const at = key(p.x, p.y);
        const h = home.get(at);
        if (h) expect(near(h, from[k], 1e-9), `piece ${s} vertex ${k}`).toBe(true);
        else home.set(at, from[k]);
      });
    }
  });

  it('is fitted with no net rotation or scale left, and every tile within half a unit', () => {
    const a: Pt[] = [];
    const b: Pt[] = [];
    let drift = 0;
    for (let i = 0; i < field.count; i++) {
      a.push({ x: field.centers[i * 2], y: field.centers[i * 2 + 1] });
      b.push({ x: view.centers[i * 2], y: view.centers[i * 2 + 1] });
      drift = Math.max(drift, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
    }
    const fit = fitSimilarity(a, b);
    expect(Math.atan2(fit[3], fit[0])).toBeCloseTo(0, 9);
    expect(Math.hypot(fit[0], fit[3])).toBeCloseTo(1, 9);
    expect(drift).toBeLessThan(0.5);
    // The Spectre patch itself is turned and scaled against the hexagons.
    expect(Math.abs((Math.atan2(view.align[3], view.align[0]) * 180) / Math.PI)).toBeGreaterThan(15);
  });

  it('Gamma2’s wedge is flanked by a Delta’s -6 seam and a Sigma’s 6 seam, dot for dot', () => {
    const six = new Set([6]);
    const g2six = new Set<string>();
    const g2minus = new Set<string>();
    for (let s = 0; s < view.count; s++) {
      if (view.leafTypes[view.types[s]] !== 'Gamma2') continue;
      const X = pieceXform(view, s);
      for (const c of connectionPoints(VIEW_FAMILY, 'Gamma2', six)) {
        const w = transPt(X, c.pt);
        (c.edge.sign > 0 ? g2six : g2minus).add(key(w.x, w.y));
      }
    }
    expect(g2six.size).toBeGreaterThan(0);
    let deltas = 0;
    let sigmas = 0;
    for (let s = 0; s < view.count; s++) {
      const type = view.leafTypes[view.types[s]];
      if (type !== 'Delta' && type !== 'Sigma') continue;
      const X = pieceXform(view, s);
      for (const c of connectionPoints(VIEW_FAMILY, type, six)) {
        const w = transPt(X, c.pt);
        if (type === 'Delta') {
          deltas++;
          expect(g2six.has(key(w.x, w.y)), `Delta piece ${s}`).toBe(true);
        } else {
          sigmas++;
          expect(g2minus.has(key(w.x, w.y)), `Sigma piece ${s}`).toBe(true);
        }
      }
    }
    expect(deltas).toBeGreaterThan(0);
    expect(sigmas).toBeGreaterThan(0);
    // …and in the hexagon view the wedge is flat: no area.
    for (let s = 0; s < view.count; s++) {
      if (view.leafTypes[view.types[s]] !== 'Gamma2') continue;
      const poly = viewPolygon(view, s, 0);
      expect(polygonArea(poly.slice(4, 9))).toBeLessThan(1e-9);
    }
  });

  it('finds the tile under a point in the view, and names a tapped chord by its hexagon midpoint', () => {
    for (let s = 0; s < view.count; s += 7) {
      const poly = viewPolygon(view, s, 1);
      // A point inside the piece: a little way in from a reflex-free corner.
      let cx = 0, cy = 0;
      for (const p of poly) {
        cx += p.x / poly.length;
        cy += p.y / poly.length;
      }
      const inside = { x: poly[3].x + (cx - poly[3].x) * 0.2, y: poly[3].y + (cy - poly[3].y) * 0.2 };
      expect(viewTileAt(view, inside, 1)).toBe(view.parent[s]);
    }
    const table = chordTableFor(field, fassRule('hex'));
    const pts: number[] = [];
    let checked = 0;
    for (let i = 0; i < field.count && checked < 40; i++) {
      const n = tileChords(field, table, i).length;
      for (let c = 0; c < n; c++) {
        viewChord(view, table, i, c, 1, pts);
        const mid = { x: (pts[0] + pts[2]) / 2, y: (pts[1] + pts[3]) / 2 };
        const [a, b] = worldChord(field, table, i, c);
        expect(near(viewTap(view, table, i, mid), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    // A point with no chord to pin it moves with its tile.
    const p = { x: field.centers[10], y: field.centers[11] };
    expect(near(viewPoint(view, p, 1), { x: view.centers[10], y: view.centers[11] })).toBe(true);
    expect(near(viewPoint(view, p, 0), p)).toBe(true);
  });

  it('has an outline that closes round all of its pieces: the one chaining every piece edge gives', () => {
    const ring = viewOutline(view);
    expect(ring.length).toBeGreaterThan(fieldOutline(field).length);
    let area = 0;
    for (let s = 0; s < view.count; s++) area += polygonArea(viewPolygon(view, s, 1));
    expect(polygonArea(ring)).toBeCloseTo(area, 6);
    const full = chainOutline(view.count, (s) => viewPolygon(view, s, 1));
    expect(ring.length).toBe(full.length);
    const edges = (r: readonly Pt[]): Set<string> =>
      new Set(r.map((p, k) => [key(p.x, p.y), key(r[(k + 1) % r.length].x, r[(k + 1) % r.length].y)].sort().join('>')));
    const a = edges(ring);
    for (const e of edges(full)) expect(a.has(e), e).toBe(true);
    // Level 4 too, where the outline pinches.
    const deeper = spectreView(buildField({ family: 'hex', level: 4, rootTile: 'Delta' }));
    const ring4 = viewOutline(deeper);
    const full4 = chainOutline(deeper.count, (s) => viewPolygon(deeper, s, 1));
    expect(ring4.length).toBe(full4.length);
    const a4 = edges(ring4);
    for (const e of edges(full4)) expect(a4.has(e), e).toBe(true);
  });
});

/**
 * Every strand of the rule, walked on the hexagons, drawn in the view: the
 * polylines join end to end (and close where the strand does), every point
 * lies on the outline of a piece of the step's tile (or the Sigma's, past the
 * wedge), and the morph starts from the hexagon chord.
 */
function checkStrands(rule: PlayerRule): { steps: number; bridged: number } {
  const table = chordTableFor(field, rule);
  const seen = new Set<string>();
  const pts: number[] = [];
  const hexPts: number[] = [];
  let steps = 0;
  let bridged = 0;
  const outlinesOf = (tile: number): Pt[][] => {
    const out: Pt[][] = [];
    for (let s = view.first[tile]; s < view.first[tile + 1]; s++) out.push(viewPolygon(view, s, 1));
    return out;
  };
  for (let i = 0; i < field.count; i++) {
    const chords = tileChords(field, table, i);
    for (let c = 0; c < chords.length; c++) {
      if (seen.has(`${i}/${c}`)) continue;
      const walk = walkStrand(field, table, i, c, 1);
      for (const s of walk.steps) seen.add(`${s.tile}/${s.chord}`);
      let prevEnd: Pt | null = null;
      let firstStart: Pt | null = null;
      for (const st of walk.steps) {
        steps++;
        viewStep(view, table, st, 1, pts);
        expect(pts.length === 4 || pts.length === 6, `step on tile ${st.tile}`).toBe(true);
        if (pts.length === 6) bridged++;
        const start = { x: pts[0], y: pts[1] };
        const end = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
        if (prevEnd) expect(near(prevEnd, start, 1e-7), `join on tile ${st.tile}`).toBe(true);
        if (!firstStart) firstStart = start;
        prevEnd = end;
        // Every point sits on a piece's outline: a dot on a seam.
        const polys = outlinesOf(st.tile);
        if (pts.length === 6) {
          // The far point is past the wedge, on the Sigma: every tile touching it will do.
          for (let t = 0; t < field.count; t++) if (tileType(field, t) === 'Sigma') polys.push(...outlinesOf(t));
        }
        for (let k = 0; k < pts.length; k += 2) {
          const p = { x: pts[k], y: pts[k + 1] };
          expect(polys.some((poly) => onOutline(p, poly)), `point ${k / 2} of a step on tile ${st.tile} (${tileType(field, st.tile)})`).toBe(true);
        }
        // At the hexagon end of the morph the polyline is the hex chord.
        viewStep(view, table, st, 0, hexPts);
        expect(near({ x: hexPts[0], y: hexPts[1] }, st.a)).toBe(true);
        expect(near({ x: hexPts[hexPts.length - 2], y: hexPts[hexPts.length - 1] }, st.b)).toBe(true);
      }
      if (walk.closed && prevEnd && firstStart) expect(near(prevEnd, firstStart, 1e-7)).toBe(true);
    }
  }
  return { steps, bridged };
}

describe('hex strands drawn on the Spectres', () => {
  it('the default rule (15) and the FASS rule (128)', () => {
    expect(checkStrands(defaultRule('hex')).steps).toBeGreaterThan(0);
    expect(checkStrands(fassRule('hex')).steps).toBeGreaterThan(0);
  });
  it('rules with class 6: the Delta’s chord carries on over Gamma2’s wedge to the Sigma', () => {
    const withSix = validEdgeSubsets('hex').filter((v) => v.edges.includes(6));
    expect(withSix.length).toBeGreaterThan(0);
    let bridged = 0;
    for (const v of withSix.slice(0, 4)) {
      const rule = ruleFromCombo('hex', v.edges.join(''), '000000000');
      bridged += checkStrands(rule).bridged;
    }
    expect(bridged).toBeGreaterThan(0);
  });
  it('random clean rules', () => {
    const rng = mulberry32(11);
    for (let k = 0; k < 4; k++) checkStrands(randomCleanRule('hex', rng));
  });
  it('a Gamma chord across the class-7 seam goes straight from Gamma1 to Gamma2', () => {
    const rule = fassRule('hex');
    const table = chordTableFor(field, rule);
    const pts: number[] = [];
    let crossed = 0;
    for (let i = 0; i < field.count; i++) {
      if (tileType(field, i) !== 'Gamma') continue;
      const n = tileChords(field, table, i).length;
      for (let c = 0; c < n; c++) {
        viewChord(view, table, i, c, 1, pts);
        expect(pts.length).toBe(4);
        const g1 = viewPolygon(view, view.first[i], 1);
        const g2 = viewPolygon(view, view.first[i] + 1, 1);
        const a = { x: pts[0], y: pts[1] };
        const b = { x: pts[2], y: pts[3] };
        if ((onOutline(a, g1) && onOutline(b, g2)) || (onOutline(a, g2) && onOutline(b, g1))) crossed++;
      }
    }
    expect(crossed).toBeGreaterThan(0);
  });
  it('a piece is a Spectre: its vertices are the leaf’s under its transform', () => {
    const leaf = leafPts(VIEW_FAMILY, 'Delta');
    const poly = viewPolygon(view, 5, 1);
    const X = pieceXform(view, 5);
    poly.forEach((p, k) => expect(near(p, transPt(X, leaf[k]))).toBe(true));
  });
});
