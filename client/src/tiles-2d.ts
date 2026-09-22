/**
 * Canvas2D tile layer: the fallback when WebGL2 is unavailable. Redraws the
 * visible tiles (one `Path2D` per leaf type under a per-tile transform) into
 * an offscreen canvas whenever the camera moves, then blits it and washes
 * the claimed tiles on top. Fine to ~50k tiles; the WebGL layer is for more.
 */

import { tilesInBox, type Box, type Field } from '../../shared/game/field';
import { leafPts } from '../../shared/tiles';
import type { Camera } from './camera';
import type { BoardTheme } from './theme';
import { cssRgb, type Rgb01, type TileLayer } from './tiles-layer';

export function createCanvasTiles(canvas: HTMLCanvasElement, field: Field, fills: readonly Rgb01[], board: BoardTheme): TileLayer {
  const ctx = canvas.getContext('2d')!;
  const back = document.createElement('canvas');
  const bctx = back.getContext('2d')!;
  const paths = field.leafTypes.map((type) => {
    const pts = leafPts(field.family, type);
    const p = new Path2D();
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
    p.closePath();
    return p;
  });
  let css = fills.map(cssRgb);
  let scheme = board;
  const tints = new Map<number, string>();
  let lastKey = '';
  const visible: number[] = [];

  const setTransform = (c: CanvasRenderingContext2D, i: number, cam: Camera, w: number, h: number, dpr: number): void => {
    const m = field.xforms;
    const o = i * 6;
    const s = cam.scale * dpr;
    c.setTransform(m[o] * s, m[o + 3] * s, m[o + 1] * s, m[o + 4] * s, (m[o + 2] - cam.x) * s + (w * dpr) / 2, (m[o + 5] - cam.y) * s + (h * dpr) / 2);
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
    clearTints() {
      tints.clear();
    },
    setTint(tile, r, g, b, a) {
      tints.set(tile, `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`);
    },
    draw(cam, w, h, dpr) {
      const key = `${cam.x.toFixed(3)}|${cam.y.toFixed(3)}|${cam.scale.toFixed(4)}|${w}x${h}`;
      if (key !== lastKey) {
        lastKey = key;
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.fillStyle = scheme.bgCss;
        bctx.fillRect(0, 0, back.width, back.height);
        tilesInBox(field, viewBox(cam, w, h), visible);
        const strokes = cam.scale > 4;
        bctx.lineWidth = 0.05;
        bctx.strokeStyle = scheme.lineCss;
        for (const i of visible) {
          setTransform(bctx, i, cam, w, h, dpr);
          bctx.fillStyle = css[field.types[i]];
          bctx.fill(paths[field.types[i]]);
          if (strokes) bctx.stroke(paths[field.types[i]]);
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
        setTransform(ctx, tile, cam, w, h, dpr);
        ctx.fillStyle = color;
        ctx.fill(paths[field.types[tile]]);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
    dispose() {},
  };
}
