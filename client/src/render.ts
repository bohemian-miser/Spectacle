/**
 * Canvas2D arena renderer.
 *
 * Two layers on one canvas: the static tiling (redrawn only when the camera
 * moves, into an offscreen canvas) and the live layer — claimed tiles washed
 * with their owner's colour, every path as a polyline, a pulsing head on each
 * growing one. Tiles are drawn as one `Path2D` per leaf type under a
 * per-tile `setTransform`, so the per-frame cost is one fill per visible tile.
 */

import { tilesInBox, type Box, type Field } from '../../shared/game/field';
import { leafPts, type TileFamilyId, type TileTypeId } from '../../shared/tiles';
import type { ClientPath, Store } from './store';

export interface Camera {
  x: number;
  y: number;
  /** Screen pixels per world unit (CSS px). */
  scale: number;
}

/** Muted per-type fills on a dark ground; claimed tiles get the owner's colour on top. */
function typeFill(family: TileFamilyId, type: TileTypeId, index: number): string {
  const h = family === 'hex' ? (index * 36 + 200) % 360 : (index * 33 + 180) % 360;
  return `hsl(${h}, 13%, ${17 + (index % 3) * 2}%)`;
}

export class Renderer {
  readonly camera: Camera = { x: 0, y: 0, scale: 10 };
  private ctx: CanvasRenderingContext2D;
  private staticCanvas: HTMLCanvasElement;
  private staticCtx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private paths2d = new Map<string, Path2D>();
  private fills: string[] = [];
  private lastCameraKey = '';
  private lastGeometry = -1;
  private visible: number[] = [];
  private field: Field | null = null;
  private frameHandle = 0;
  private lastFrameAt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: Store,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.staticCanvas = document.createElement('canvas');
    this.staticCtx = this.staticCanvas.getContext('2d')!;
  }

  setField(field: Field): void {
    if (this.field === field) return;
    this.field = field;
    this.paths2d.clear();
    this.fills = field.leafTypes.map((t, i) => typeFill(field.family, t, i));
    for (const type of field.leafTypes) {
      const pts = leafPts(field.family, type);
      const p = new Path2D();
      p.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
      p.closePath();
      this.paths2d.set(type, p);
    }
    this.lastCameraKey = '';
  }

  fitToField(): void {
    if (!this.field) return;
    const b = this.field.bounds;
    this.camera.x = (b.minX + b.maxX) / 2;
    this.camera.y = (b.minY + b.maxY) / 2;
    const s = Math.min(this.width / (b.maxX - b.minX + 4), this.height / (b.maxY - b.minY + 4));
    this.camera.scale = Math.max(0.2, s);
    this.lastCameraKey = '';
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const pw = Math.round(this.width * this.dpr);
    const ph = Math.round(this.height * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.staticCanvas.width = pw;
      this.staticCanvas.height = ph;
    }
    this.lastCameraKey = '';
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.width / 2) / this.camera.scale + this.camera.x,
      y: (sy - this.height / 2) / this.camera.scale + this.camera.y,
    };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.camera.x) * this.camera.scale + this.width / 2,
      y: (wy - this.camera.y) * this.camera.scale + this.height / 2,
    };
  }

  panBy(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.scale;
    this.camera.y -= dy / this.camera.scale;
    this.clampCamera();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.camera.scale = Math.max(0.15, Math.min(400, this.camera.scale * factor));
    const after = this.screenToWorld(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.clampCamera();
  }

  centerOn(wx: number, wy: number, minScale = 18): void {
    this.camera.x = wx;
    this.camera.y = wy;
    if (this.camera.scale < minScale) this.camera.scale = minScale;
    this.clampCamera();
  }

  private clampCamera(): void {
    if (!this.field) return;
    const b = this.field.bounds;
    const pad = 6;
    this.camera.x = Math.max(b.minX - pad, Math.min(b.maxX + pad, this.camera.x));
    this.camera.y = Math.max(b.minY - pad, Math.min(b.maxY + pad, this.camera.y));
  }

  start(): void {
    const loop = (t: number): void => {
      this.frameHandle = requestAnimationFrame(loop);
      // Cap at ~60 fps; the live layer animates the head pulse so it always redraws.
      if (t - this.lastFrameAt < 15) return;
      this.lastFrameAt = t;
      this.draw(t);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
  }

  private viewBox(): Box {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.width, this.height);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  /** Canvas transform = camera ∘ tile transform (row-major affine from the field). */
  private setTileTransform(ctx: CanvasRenderingContext2D, i: number): void {
    const f = this.field!;
    const m = f.xforms;
    const o = i * 6;
    const s = this.camera.scale * this.dpr;
    ctx.setTransform(
      m[o] * s,
      m[o + 3] * s,
      m[o + 1] * s,
      m[o + 4] * s,
      (m[o + 2] - this.camera.x) * s + (this.width * this.dpr) / 2,
      (m[o + 5] - this.camera.y) * s + (this.height * this.dpr) / 2,
    );
  }

  private drawStatic(): void {
    const f = this.field!;
    const ctx = this.staticCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    const box = this.viewBox();
    tilesInBox(f, box, this.visible);
    const strokes = this.camera.scale > 4;
    ctx.lineWidth = 0.05;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    for (const i of this.visible) {
      const type = f.leafTypes[f.types[i]];
      const p = this.paths2d.get(type)!;
      this.setTileTransform(ctx, i);
      ctx.fillStyle = this.fills[f.types[i]];
      ctx.fill(p);
      if (strokes) ctx.stroke(p);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private draw(t: number): void {
    const f = this.field;
    if (!f) return;
    const ctx = this.ctx;
    const camKey = `${this.camera.x.toFixed(3)}|${this.camera.y.toFixed(3)}|${this.camera.scale.toFixed(4)}|${this.width}x${this.height}`;
    if (camKey !== this.lastCameraKey) {
      this.drawStatic();
      this.lastCameraKey = camKey;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticCanvas, 0, 0);
    this.drawLive(t);
    this.lastGeometry = this.store.geometryVersion;
  }

  private drawLive(t: number): void {
    const f = this.field!;
    const ctx = this.ctx;
    const store = this.store;
    const s = this.camera.scale * this.dpr;
    const box = this.viewBox();
    const pad = 4;
    const inView = (x: number, y: number): boolean =>
      x > box.minX - pad && x < box.maxX + pad && y > box.minY - pad && y < box.maxY + pad;

    // 1. Claimed tiles: a wash of the owner's colour (the tapped tile "fades").
    for (const [tile, paths] of store.occupancy) {
      const cx = f.centers[tile * 2];
      const cy = f.centers[tile * 2 + 1];
      if (!inView(cx, cy)) continue;
      const type = f.leafTypes[f.types[tile]];
      const p = this.paths2d.get(type)!;
      this.setTileTransform(ctx, tile);
      // Fade the tile up first, then tint it with each owner's colour.
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#ffffff';
      ctx.fill(p);
      for (const path of paths) {
        const owner = store.players.get(path.owner);
        if (!owner) continue;
        ctx.globalAlpha = path.owner === store.you ? 0.4 : 0.28;
        ctx.fillStyle = owner.color;
        ctx.fill(p);
      }
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 2. Paths.
    const toScreen = (x: number, y: number): [number, number] => [
      ((x - this.camera.x) * this.camera.scale + this.width / 2) * this.dpr,
      ((y - this.camera.y) * this.camera.scale + this.height / 2) * this.dpr,
    ];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawPath = (path: ClientPath, mine: boolean): void => {
      const owner = store.players.get(path.owner);
      if (!owner) return;
      const w = Math.max(1.5, 0.14 * s) * (mine ? 1.35 : 1);
      ctx.beginPath();
      let pen = false;
      for (const st of path.steps) {
        const vis = inView(st.a.x, st.a.y) || inView(st.b.x, st.b.y);
        if (!vis) {
          pen = false;
          continue;
        }
        const [ax, ay] = toScreen(st.a.x, st.a.y);
        const [bx, by] = toScreen(st.b.x, st.b.y);
        if (!pen) ctx.moveTo(ax, ay);
        else ctx.lineTo(ax, ay);
        ctx.lineTo(bx, by);
        pen = true;
      }
      if (path.status === 'closed') {
        const first = path.steps[0];
        const [ax, ay] = toScreen(first.a.x, first.a.y);
        ctx.lineTo(ax, ay);
      }
      if (mine) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = w + Math.max(2, 0.08 * s);
        ctx.stroke();
      }
      ctx.strokeStyle = owner.color;
      ctx.lineWidth = w;
      ctx.globalAlpha = path.status === 'stuck' ? 0.6 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Head marker.
      const last = path.steps[path.steps.length - 1];
      if (path.status === 'growing' && inView(last.b.x, last.b.y)) {
        const [hx, hy] = toScreen(last.b.x, last.b.y);
        const pulse = 1 + 0.35 * Math.sin(t / 160);
        ctx.beginPath();
        ctx.arc(hx, hy, Math.max(3, 0.22 * s) * pulse, 0, Math.PI * 2);
        ctx.fillStyle = owner.color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, 0.05 * s);
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      if (path.status === 'stuck' && inView(last.b.x, last.b.y)) {
        const [hx, hy] = toScreen(last.b.x, last.b.y);
        const r = Math.max(3, 0.18 * s);
        ctx.strokeStyle = '#ff5c7a';
        ctx.lineWidth = Math.max(1.5, 0.06 * s);
        ctx.beginPath();
        ctx.moveTo(hx - r, hy - r);
        ctx.lineTo(hx + r, hy + r);
        ctx.moveTo(hx + r, hy - r);
        ctx.lineTo(hx - r, hy + r);
        ctx.stroke();
      }
    };
    for (const path of store.paths.values()) if (path.owner !== store.you) drawPath(path, false);
    for (const path of store.paths.values()) if (path.owner === store.you) drawPath(path, true);
  }
}
