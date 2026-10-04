/**
 * Canvas2D tile layer: the fallback when WebGL2 is unavailable. Redraws the
 * visible tiles (one `Path2D` per leaf type under a per-tile transform) into
 * an offscreen canvas whenever the camera moves, then blits it and washes
 * the claimed tiles on top. Fine to ~50k tiles; the WebGL layer is for more.
 * In the Spectre view (and the morph into it) each visible tile's pieces are
 * drawn as the polygons they are at that moment instead.
 */

import { tilesInBox, type Box, type Field } from '../../shared/game/field';
import { leafPts, type Pt } from '../../shared/tiles';
import type { Camera } from './camera';
import { viewPolygon, type SpectreView } from './spectre-view';
import type { BoardTheme } from './theme';
import { ARROW_MIN_SCALE, cssRgb, directionArrow, type Rgb01, type TileLayer } from './tiles-layer';

function polyPath(pts: readonly { x: number; y: number }[]): Path2D {
  const p = new Path2D();
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  p.closePath();
  return p;
}

export function createCanvasTiles(canvas: HTMLCanvasElement, field: Field, fills: readonly Rgb01[], board: BoardTheme): TileLayer {
  const ctx = canvas.getContext('2d')!;
  const back = document.createElement('canvas');
  const bctx = back.getContext('2d')!;
  const paths = field.leafTypes.map((type) => polyPath(leafPts(field.family, type)));
  // Every hex tile is the same regular hexagon, so only the arrow says which
  // way one is turned; a Spectre wears its rotation on its outline.
  const arrow = field.family === 'hex' ? polyPath(directionArrow(leafPts(field.family, field.leafTypes[0]))) : null;
  let css = fills.map(cssRgb);
  let scheme = board;
  const tints = new Map<number, string>();
  let lastKey = '';
  let arrows = true;
  let view: SpectreView | null = null;
  let morph = 0;
  const visible: number[] = [];
  const poly: Pt[] = [];

  const setTransform = (c: CanvasRenderingContext2D, i: number, cam: Camera, w: number, h: number, dpr: number): void => {
    const m = field.xforms;
    const o = i * 6;
    const s = cam.scale * dpr;
    c.setTransform(m[o] * s, m[o + 3] * s, m[o + 1] * s, m[o + 4] * s, (m[o + 2] - cam.x) * s + (w * dpr) / 2, (m[o + 5] - cam.y) * s + (h * dpr) / 2);
  };
  /** World → the backing canvas's pixels. */
  const worldTransform = (c: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number): void => {
    const s = cam.scale * dpr;
    c.setTransform(s, 0, 0, s, (w * dpr) / 2 - cam.x * s, (h * dpr) / 2 - cam.y * s);
  };
  /** Trace tile `i`'s pieces as they are `morph` of the way to the Spectres. */
  const tracePieces = (c: CanvasRenderingContext2D, i: number): void => {
    const v = view!;
    for (let s = v.first[i]; s < v.first[i + 1]; s++) {
      viewPolygon(v, s, morph, poly);
      c.moveTo(poly[0].x, poly[0].y);
      for (let k = 1; k < poly.length; k++) c.lineTo(poly[k].x, poly[k].y);
      c.closePath();
    }
  };

  const viewBox = (cam: Camera, w: number, h: number): Box => ({
    minX: cam.x - w / 2 / cam.scale,
    maxX: cam.x + w / 2 / cam.scale,
    minY: cam.y - h / 2 / cam.scale,
    maxY: cam.y + h / 2 / cam.scale,
  });

  return {
    kind: 'canvas2d',
    resize(pw, ph) {
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        back.width = pw;
        back.height = ph;
        lastKey = '';
      }
    },
    setTheme(next, nextFills) {
      scheme = next;
      css = nextFills.map(cssRgb);
      lastKey = '';
    },
    setArrows(on) {
      arrows = on;
    },
    setView(next) {
      view = next;
      lastKey = '';
    },
    setMorph(t) {
      morph = Math.max(0, Math.min(1, t));
    },
    clearTints() {
      tints.clear();
    },
    setTint(tile, r, g, b, a) {
      if (a <= 0) tints.delete(tile);
      else tints.set(tile, `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`);
    },
    draw(cam, w, h, dpr) {
      const morphing = view !== null && morph > 0;
      const key = `${cam.x.toFixed(3)}|${cam.y.toFixed(3)}|${cam.scale.toFixed(4)}|${w}x${h}|${morphing ? morph : 0}`;
      if (key !== lastKey) {
        lastKey = key;
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.fillStyle = scheme.bgCss;
        bctx.fillRect(0, 0, back.width, back.height);
        tilesInBox(field, viewBox(cam, w, h), visible);
        const strokes = cam.scale > 4;
        bctx.strokeStyle = scheme.lineCss;
        if (morphing) {
          // Pieces move, so they are drawn as polygons in world space, one
          // path per leaf type (its fill) across the visible tiles.
          worldTransform(bctx, cam, w, h, dpr);
          bctx.lineWidth = 0.05;
          const byType = new Map<number, number[]>();
          for (const i of visible) {
            const list = byType.get(field.types[i]);
            if (list) list.push(i);
            else byType.set(field.types[i], [i]);
          }
          for (const [t, tiles] of byType) {
            bctx.beginPath();
            // A Gamma's two halves share its fill (both white).
            for (const i of tiles) tracePieces(bctx, i);
            bctx.fillStyle = css[t];
            bctx.fill();
            if (strokes) bctx.stroke();
          }
        } else {
          bctx.lineWidth = 0.05;
          for (const i of visible) {
            setTransform(bctx, i, cam, w, h, dpr);
            bctx.fillStyle = css[field.types[i]];
            bctx.fill(paths[field.types[i]]);
            if (strokes) bctx.stroke(paths[field.types[i]]);
          }
        }
        bctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(back, 0, 0);
      const box = viewBox(cam, w, h);
      for (const [tile, color] of tints) {
        const cx = field.centers[tile * 2];
        const cy = field.centers[tile * 2 + 1];
        if (cx < box.minX - 4 || cx > box.maxX + 4 || cy < box.minY - 4 || cy > box.maxY + 4) continue;
        ctx.fillStyle = color;
        if (morphing) {
          worldTransform(ctx, cam, w, h, dpr);
          ctx.beginPath();
          tracePieces(ctx, tile);
          ctx.fill();
        } else {
          setTransform(ctx, tile, cam, w, h, dpr);
          ctx.fill(paths[field.types[tile]]);
        }
      }
      // Arrows last, so a claimed tile keeps its direction — on the hexagons
      // only. `visible` is the last tilesInBox result, which is this camera:
      // it is refreshed above on every move.
      if (arrow && arrows && !morphing && cam.scale > ARROW_MIN_SCALE) {
        ctx.fillStyle = scheme.arrowCss;
        for (const i of visible) {
          setTransform(ctx, i, cam, w, h, dpr);
          ctx.fill(arrow);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
    dispose() {},
  };
}
