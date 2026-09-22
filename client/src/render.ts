/**
 * Arena renderer: a tile layer in the bottom canvas (WebGL2 instanced, or
 * Canvas2D where WebGL is missing) and a Canvas2D overlay on top for the
 * live things — every path as a polyline, a pulsing head on each growing
 * one, a cross on each stuck one. Claimed tiles are tinted in the tile layer.
 */

import type { Box, Field } from '../../shared/game/field';
import type { Camera } from './camera';
import type { ClientPath, Store } from './store';
import { createCanvasTiles } from './tiles-2d';
import { createGlTiles } from './tiles-gl';
import { circuitDarkening, darkenCss, parseColor, typeFill, type TileLayer } from './tiles-layer';

export class Renderer {
  readonly camera: Camera = { x: 0, y: 0, scale: 10 };
  private ctx: CanvasRenderingContext2D;
  private tiles: TileLayer | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private field: Field | null = null;
  private frameHandle = 0;
  private lastFrameAt = 0;
  private lastGeometry = -1;
  private lastPlayersVersion = -1;

  constructor(
    private readonly tileCanvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly store: Store,
  ) {
    this.ctx = overlay.getContext('2d')!;
  }

  get layerKind(): 'webgl' | 'canvas2d' | 'none' {
    return this.tiles?.kind ?? 'none';
  }

  setField(field: Field): void {
    if (this.field === field) return;
    this.field = field;
    this.tiles?.dispose();
    const fills = field.leafTypes.map((_, i) => typeFill(field.family, i));
    let layer: TileLayer | null = null;
    // `?gl=1` forces WebGL (even on a software renderer), `?gl=0` forbids it.
    const glParam = new URLSearchParams(location.search).get('gl');
    const force = glParam === '1' ? true : glParam === '0' ? false : undefined;
    try {
      layer = createGlTiles(this.tileCanvas, field, fills, { force });
    } catch (err) {
      console.warn('WebGL tile layer failed, using Canvas2D', err);
    }
    this.tiles = layer ?? createCanvasTiles(this.tileCanvas, field, fills);
    this.tiles.resize(Math.round(this.width * this.dpr), Math.round(this.height * this.dpr));
    this.lastGeometry = -1;
  }

  fitToField(): void {
    if (!this.field) return;
    const b = this.field.bounds;
    this.camera.x = (b.minX + b.maxX) / 2;
    this.camera.y = (b.minY + b.maxY) / 2;
    const s = Math.min(this.width / (b.maxX - b.minX + 4), this.height / (b.maxY - b.minY + 4));
    this.camera.scale = Math.max(0.05, s);
  }

  resize(): void {
    const rect = this.overlay.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const pw = Math.round(this.width * this.dpr);
    const ph = Math.round(this.height * this.dpr);
    if (this.overlay.width !== pw || this.overlay.height !== ph) {
      this.overlay.width = pw;
      this.overlay.height = ph;
    }
    this.tiles?.resize(pw, ph);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.width / 2) / this.camera.scale + this.camera.x,
      y: (sy - this.height / 2) / this.camera.scale + this.camera.y,
    };
  }

  panBy(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.scale;
    this.camera.y -= dy / this.camera.scale;
    this.clampCamera();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.camera.scale = Math.max(0.05, Math.min(400, this.camera.scale * factor));
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
      if (t - this.lastFrameAt < 15) return;
      this.lastFrameAt = t;
      this.draw(t);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.tiles?.dispose();
    this.tiles = null;
  }

  private viewBox(): Box {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.width, this.height);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  /** Push the claimed-tile tints into the tile layer when paths or players changed. */
  private syncTints(): void {
    const tiles = this.tiles;
    if (!tiles) return;
    const store = this.store;
    if (store.geometryVersion === this.lastGeometry && store.version === this.lastPlayersVersion) return;
    this.lastGeometry = store.geometryVersion;
    this.lastPlayersVersion = store.version;
    tiles.clearTints();
    const colors = new Map<string, [number, number, number]>();
    for (const [tile, paths] of store.occupancy) {
      // Your own claim wins the tint; otherwise the first path on the tile.
      let pick: ClientPath | null = null;
      for (const p of paths) {
        if (p.owner === store.you) {
          pick = p;
          break;
        }
        if (pick === null) pick = p;
      }
      if (pick === null) continue;
      const player = store.players.get(pick.owner);
      if (!player) continue;
      let rgb = colors.get(pick.owner);
      if (!rgb) {
        rgb = parseColor(player.color);
        colors.set(pick.owner, rgb);
      }
      // Lighten toward the colour: the tile "fades" and takes the owner's
      // hue. A closed circuit's tiles darken with its length instead.
      const mine = pick.owner === store.you;
      const k = pick.status === 'closed' ? 1 - circuitDarkening(pick.steps.length) : 1;
      const lift = pick.status === 'closed' ? 30 : 70;
      tiles.setTint(tile, Math.min(255, (rgb[0] + lift) * k), Math.min(255, (rgb[1] + lift) * k), Math.min(255, (rgb[2] + lift) * k), mine ? 115 : 85);
    }
  }

  private draw(t: number): void {
    const f = this.field;
    if (!f || !this.tiles) return;
    this.syncTints();
    // Both layers are cheap to call every frame: WebGL redraws in one pass,
    // the 2D layer caches its tiles by camera and only re-blits.
    this.tiles.draw(this.camera, this.width, this.height, this.dpr);
    this.drawOverlay(t);
  }

  private drawOverlay(t: number): void {
    const ctx = this.ctx;
    const store = this.store;
    const s = this.camera.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const box = this.viewBox();
    const pad = 4;
    const inView = (x: number, y: number): boolean =>
      x > box.minX - pad && x < box.maxX + pad && y > box.minY - pad && y < box.maxY + pad;
    const toScreen = (x: number, y: number): [number, number] => [
      ((x - this.camera.x) * this.camera.scale + this.width / 2) * this.dpr,
      ((y - this.camera.y) * this.camera.scale + this.height / 2) * this.dpr,
    ];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawPath = (path: ClientPath, mine: boolean): void => {
      const owner = store.players.get(path.owner);
      if (!owner || path.steps.length === 0) return;
      const w = Math.max(1.5, 0.14 * s) * (mine ? 1.35 : 1);
      ctx.beginPath();
      let pen = false;
      for (const st of path.steps) {
        if (!(inView(st.a.x, st.a.y) || inView(st.b.x, st.b.y))) {
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
      if (path.status === 'closed' && pen) {
        const first = path.steps[0];
        const [ax, ay] = toScreen(first.a.x, first.a.y);
        ctx.lineTo(ax, ay);
      }
      if (mine) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = w + Math.max(2, 0.08 * s);
        ctx.stroke();
      }
      ctx.strokeStyle = path.status === 'closed' ? darkenCss(owner.color, circuitDarkening(path.steps.length)) : owner.color;
      ctx.lineWidth = w;
      ctx.globalAlpha = path.status === 'stuck' ? 0.6 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
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
