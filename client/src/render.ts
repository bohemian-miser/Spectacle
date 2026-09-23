/**
 * Arena renderer: a tile layer in the bottom canvas (WebGL2 instanced, or
 * Canvas2D where WebGL is missing) and a Canvas2D overlay on top for the
 * live things — every path as a polyline, a pulsing head on each growing
 * one, a cross on each stuck one. Claimed tiles are tinted in the tile layer,
 * and a closed circuit washes the tiles it encloses in its owner's colour.
 * Zoomed in close, your own rule is sketched faintly over the free tiles.
 */

import { tilesInBox, tilesInsidePolygon, type Box, type Field } from '../../shared/game/field';
import { chordTableFor, tileChords, worldChord } from '../../shared/game/strand';
import type { Camera } from './camera';
import type { ClientPath, Store } from './store';
import { boardTheme, type BoardTheme } from './theme';
import { createCanvasTiles } from './tiles-2d';
import { createGlTiles } from './tiles-gl';
import { ARROW_MIN_SCALE, circuitDarkening, parseColor, strandColor, typeFill, type Rgb01, type TileLayer } from './tiles-layer';

/**
 * Scale at which your rule's pattern starts to show on the free tiles — a
 * little closer in than the direction arrows. It fades in over the next
 * `PATTERN_FADE` of scale, so it dims away as you zoom back out.
 */
export const PATTERN_MIN_SCALE = ARROW_MIN_SCALE * 1.3;
const PATTERN_FADE = 16;
const PATTERN_ALPHA = 0.35;

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
  private board: BoardTheme = boardTheme();
  /** A closed circuit's enclosed tiles; a closed path never changes, so once is enough. */
  private readonly interiors = new WeakMap<ClientPath, readonly number[]>();
  /** Tiles inside anyone else's closed circuit (rebuilt with the tints). */
  private rivalInterior = new Set<number>();
  private readonly visible: number[] = [];

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
    const fills = this.fills(field);
    let layer: TileLayer | null = null;
    // `?gl=1` forces WebGL (even on a software renderer), `?gl=0` forbids it.
    const glParam = new URLSearchParams(location.search).get('gl');
    const force = glParam === '1' ? true : glParam === '0' ? false : undefined;
    try {
      layer = createGlTiles(this.tileCanvas, field, fills, this.board, { force });
    } catch (err) {
      console.warn('WebGL tile layer failed, using Canvas2D', err);
    }
    this.tiles = layer ?? createCanvasTiles(this.tileCanvas, field, fills, this.board);
    this.tiles.resize(Math.round(this.width * this.dpr), Math.round(this.height * this.dpr));
    this.lastGeometry = -1;
  }

  private fills(field: Field): Rgb01[] {
    return field.leafTypes.map((type) => typeFill(type, this.board.tileDim));
  }

  /** Repaint in another scheme: new tile fills, ground and ink, and fresh tints. */
  setTheme(board: BoardTheme): void {
    this.board = board;
    if (this.field) this.tiles?.setTheme(board, this.fills(this.field));
    // The claim tint is mixed against the scheme's fills, so it has to go again.
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
      // The tile "fades" and takes the owner's hue, lifted off it so the claim
      // reads against the ground — toward white on the dark board, the other
      // way on the light one. A closed circuit's tiles darken with its length.
      const mine = pick.owner === store.you;
      const k = pick.status === 'closed' ? 1 - circuitDarkening(pick.steps.length) : 1;
      const lift = pick.status === 'closed' ? this.board.liftClosed : this.board.lift;
      const ch = (c: number): number => Math.max(0, Math.min(255, (c + lift) * k));
      tiles.setTint(tile, ch(rgb[0]), ch(rgb[1]), ch(rgb[2]), mine ? 115 : 85);
    }
    // Interior wash: the free tiles a closed circuit encloses take its owner's
    // colour, fainter than the loop itself. Yours first, so it wins an overlap.
    const field = this.field;
    this.rivalInterior = new Set();
    if (!field) return;
    const closed = [...store.paths.values()].filter((p) => p.status === 'closed' && p.steps.length >= 3);
    closed.sort((a, b) => Number(b.owner === store.you) - Number(a.owner === store.you));
    const washed = new Set<number>();
    for (const path of closed) {
      const player = store.players.get(path.owner);
      if (!player) continue;
      let inside = this.interiors.get(path);
      if (!inside) {
        inside = tilesInsidePolygon(field, path.steps.map((s) => s.a));
        this.interiors.set(path, inside);
      }
      const mine = path.owner === store.you;
      if (!mine) for (const t of inside) this.rivalInterior.add(t);
      let rgb = colors.get(path.owner);
      if (!rgb) {
        rgb = parseColor(player.color);
        colors.set(path.owner, rgb);
      }
      const k = 1 - circuitDarkening(path.steps.length);
      const lift = this.board.liftClosed;
      const ch = (c: number): number => Math.max(0, Math.min(255, (c + lift) * k));
      const [r, g, b] = [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
      for (const t of inside) {
        if (washed.has(t) || store.occupancy.has(t)) continue;
        washed.add(t);
        tiles.setTint(t, r, g, b, mine ? 70 : 55);
      }
    }
  }

  /**
   * Your rule, sketched faintly on every tile nobody has touched and that is
   * not inside a rival's circuit — where a tap would take you. Only when
   * zoomed in; it fades out on the way back.
   */
  private drawPattern(toScreen: (x: number, y: number) => [number, number], box: Box): void {
    const field = this.field;
    const me = this.store.me;
    const scale = this.camera.scale;
    if (!field || !me || scale <= PATTERN_MIN_SCALE) return;
    const fade = Math.min(1, (scale - PATTERN_MIN_SCALE) / PATTERN_FADE);
    const table = chordTableFor(field, me.rule);
    const occupancy = this.store.occupancy;
    const ctx = this.ctx;
    ctx.beginPath();
    for (const i of tilesInBox(field, box, this.visible)) {
      if (occupancy.has(i) || this.rivalInterior.has(i)) continue;
      const n = tileChords(field, table, i).length;
      for (let c = 0; c < n; c++) {
        const [a, b] = worldChord(field, table, i, c);
        const [ax, ay] = toScreen(a.x, a.y);
        const [bx, by] = toScreen(b.x, b.y);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }
    ctx.strokeStyle = strandColor(this.board, me.color);
    ctx.lineWidth = Math.max(1, 0.06 * scale * this.dpr);
    ctx.globalAlpha = PATTERN_ALPHA * fade;
    ctx.stroke();
    ctx.globalAlpha = 1;
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
    this.drawPattern(toScreen, box);
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
        ctx.strokeStyle = this.board.haloCss;
        ctx.lineWidth = w + Math.max(2, 0.08 * s);
        ctx.stroke();
      }
      const ink = strandColor(this.board, owner.color, path.status === 'closed' ? circuitDarkening(path.steps.length) : 0);
      ctx.strokeStyle = ink;
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
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.lineWidth = Math.max(1, 0.05 * s);
        ctx.strokeStyle = this.board.inkCss;
        ctx.stroke();
      }
      if (path.status === 'stuck' && inView(last.b.x, last.b.y)) {
        const [hx, hy] = toScreen(last.b.x, last.b.y);
        const r = Math.max(3, 0.18 * s);
        ctx.strokeStyle = this.board.badCss;
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
