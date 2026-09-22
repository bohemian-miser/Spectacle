import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonArea } from '../shared/game/field';
import { directionArrow } from '../client/src/tiles-layer';
import { centroid, leafOrder, leafPts, transPt, type Affine, type Pt } from '../shared/tiles';

const HEX = leafPts('hex', 'Delta');

function edgeMid(pts: readonly Pt[], i: number): Pt {
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

describe('tile direction arrow', () => {
  it('points from the centre at edge 0', () => {
    const arrow = directionArrow(HEX);
    const c = centroid(HEX);
    const m = edgeMid(HEX, 0);
    const dx = (m.x - c.x) / Math.hypot(m.x - c.x, m.y - c.y);
    const dy = (m.y - c.y) / Math.hypot(m.x - c.x, m.y - c.y);
    const along = (p: Pt): number => (p.x - c.x) * dx + (p.y - c.y) * dy;
    const tip = arrow[0];
    // The tip is the point nearest the edge, and every other point trails it.
    for (const p of arrow.slice(1)) expect(along(p)).toBeLessThan(along(tip));
    // It is a dart, not a blob: the tip sits well off the centre.
    expect(along(tip)).toBeGreaterThan(0.5 * along(m));
    // And it aims at edge 0, not past its ends.
    expect(Math.abs((tip.x - c.x) * -dy + (tip.y - c.y) * dx)).toBeLessThan(1e-9);
  });

  it('stays inside every leaf tile of the family', () => {
    for (const family of ['hex', 'spectre'] as const) {
      for (const type of leafOrder(family)) {
        const pts = leafPts(family, type);
        for (const p of directionArrow(pts)) {
          expect(pointInPolygon(p, pts), `${family}/${type}`).toBe(true);
        }
      }
    }
  });

  it('turns with the tile', () => {
    // A sixth of a turn: the arrow must follow, or it says nothing about which
    // rotation a hexagon is sitting in.
    const a = Math.PI / 3;
    const c = centroid(HEX);
    const rot: Affine = [
      Math.cos(a), -Math.sin(a), c.x - c.x * Math.cos(a) + c.y * Math.sin(a),
      Math.sin(a), Math.cos(a), c.y - c.x * Math.sin(a) - c.y * Math.cos(a),
    ];
    const turned = directionArrow(HEX.map((p) => transPt(rot, p)));
    const direct = directionArrow(HEX).map((p) => transPt(rot, p));
    turned.forEach((p, i) => {
      expect(p.x).toBeCloseTo(direct[i].x, 9);
      expect(p.y).toBeCloseTo(direct[i].y, 9);
    });
    // A hexagon looks identical after that turn; the arrow does not.
    expect(Math.hypot(turned[0].x - directionArrow(HEX)[0].x, turned[0].y - directionArrow(HEX)[0].y)).toBeGreaterThan(0.3);
  });

  it('has area to draw', () => {
    expect(polygonArea(directionArrow(HEX))).toBeGreaterThan(0.05);
  });
});
