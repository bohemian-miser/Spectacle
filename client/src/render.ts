/**
 * Arena renderer: a tile layer in the bottom canvas (WebGL2 instanced, or
 * Canvas2D where WebGL is missing) and a Canvas2D overlay on top for the
 * live things — every path as a polyline, a pulsing head on each growing
 * one, a cross on each stuck one. Claimed tiles are tinted in the tile layer,
 * and a closed circuit washes the tiles it encloses in its owner's colour —
 * the washes stack, so a loop inside a loop shows deeper.
 * Zoomed in close, your own rule is sketched faintly over the free tiles.
 */

import { pathPolygon, tilesInBox, tilesInsidePolygon, type Box, type Field } from '../../shared/game/field';
import { chordTableFor, tileChords, worldChord } from '../../shared/game/strand';
import { circuitLengthRgb, rgbToHex } from '../../shared/tiles';
import type { Camera } from './camera';
import type { ClientPath, Store } from './store';
import { boardTheme, type BoardTheme } from './theme';
import { createCanvasTiles } from './tiles-2d';
import { createGlTiles } from './tiles-gl';
import {
  ARROW_MIN_SCALE,
  circuitColor,
  darkenCss,
  parseColor,
  strandColor,
  typeFill,
  type Rgb01,
  type TileLayer,
} from './tiles-layer';

/**
 * Scale at which your rule's pattern starts to show on the free tiles — a
 * little closer in than the direction arrows. It fades in over the next
 * `PATTERN_FADE` of scale, so it dims away as you zoom back out.
 */
/**
 * Circuit colouring, while we choose one (`?circuits=a…e`):
 *  a  owner ramp — hue ±110° round the owner's colour and lightness by length;
 *     each nesting level darkens the wash 14%.
 *  b  Spectre's length palette (`circuitLengthRgb`, as in the rule lab) for
 *     loops and washes alike; nesting darkens as in a.
 *  c  depth bands — loops on the owner ramp; the wash steps its hue 50° and
 *     its lightness down with every level of nesting.
 *  d  contour stripes — loops on the length palette; nesting levels alternate
 *     light and dark like a topographic map.
 *  e  depth heatmap — loops on the length palette; the wash is a magma scale
 *     by depth (yellow, orange, red, purple, near-black).
 */
type CircuitStyle = 'a' | 'b' | 'c' | 'd' | 'e';
const CIRCUIT_STYLE: CircuitStyle = (() => {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('circuits');
  return v === 'b' || v === 'c' || v === 'd' || v === 'e' ? v : 'a';
})();
const LENGTH_PALETTE = CIRCUIT_STYLE === 'b' || CIRCUIT_STYLE === 'd' || CIRCUIT_STYLE === 'e';
const MAGMA: readonly (readonly [number, number, number])[] = [
  [252, 214, 120],
  [247, 146, 64],
  [222, 74, 76],
  [160, 44, 122],
  [84, 24, 112],
  [28, 12, 60],
];

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
  /** A closed path's colour and darkening, keyed on the owner colour it was made from. */
  private readonly looks = new WeakMap<ClientPath, readonly [string, readonly [string, number]]>();
  private readonly rgbCache = new Map<string, [number, number, number]>();
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
      const [r, g, b] = this.tintOf(pick);
      tiles.setTint(tile, r, g, b, pick.status === 'closed' ? (pick.owner === store.you ? 175 : 150) : pick.owner === store.you ? 115 : 85);
    }
    // Interior wash: the free tiles a closed circuit encloses take its owner's
    // colour, fainter than the loop itself. Washes stack: outer circuits go
    // down first and each one inside lays its colour over them, so nesting
    // deepens the tile rather than hiding behind the first loop to claim it.
    const field = this.field;
    this.rivalInterior = new Set();
    if (!field) return;
    const closed: { path: ClientPath; inside: readonly number[] }[] = [];
    for (const path of store.paths.values()) {
      if (path.status !== 'closed' || path.steps.length < 2 || !store.players.has(path.owner)) continue;
      let inside = this.interiors.get(path);
      if (!inside) {
        inside = tilesInsidePolygon(field, pathPolygon(path));
        this.interiors.set(path, inside);
      }
      if (path.owner !== store.you) for (const t of inside) this.rivalInterior.add(t);
      closed.push({ path, inside });
    }
    closed.sort((a, b) => b.inside.length - a.inside.length);
    const wash = new Map<number, [number, number, number, number, number]>();
    const innermost = new Map<number, ClientPath>();
    for (const { path, inside } of closed) {
      const [r, g, b] = this.tintOf(path);
      const a = path.owner === store.you ? 0.42 : 0.34;
      for (const t of inside) {
        if (store.occupancy.has(t)) continue;
        innermost.set(t, path);
        const under = wash.get(t);
        if (!under) {
          wash.set(t, [r, g, b, a, 1]);
          continue;
        }
        // Porter–Duff "over": this loop's colour on top of what is already there.
        const ua = under[3] * (1 - a);
        const oa = a + ua;
        under[0] = (r * a + under[0] * ua) / oa;
        under[1] = (g * a + under[1] * ua) / oa;
        under[2] = (b * a + under[2] * ua) / oa;
        under[3] = oa;
        under[4]++;
      }
    }
    // Each level of nesting also sinks the wash a step deeper, so depth reads
    // even where two nested loops happen to share a hue.
    for (const [t, [r, g, b, a, depth]] of wash) {
      const tint = this.washTint(r, g, b, a, depth, innermost.get(t)!);
      tiles.setTint(t, tint[0], tint[1], tint[2], tint[3]);
    }
  }

  /** A washed tile's final tint under the chosen circuit style (0..255 channels + strength). */
  private washTint(r: number, g: number, b: number, a: number, depth: number, inner: ClientPath): [number, number, number, number] {
    switch (CIRCUIT_STYLE) {
      case 'c': {
        const base = this.store.players.get(inner.owner)?.color ?? 'hsl(0, 90%, 62%)';
        const m = /hsl\(\s*([\d.]+)/.exec(base);
        const h = ((m ? Number(m[1]) : 0) + 50 * depth) % 360;
        const [cr, cg, cb] = parseColor(`hsl(${h.toFixed(1)}, 85%, ${Math.max(22, 76 - 12 * (depth - 1))}%)`);
        return [cr, cg, cb, Math.min(240, (0.62 + 0.1 * (depth - 1)) * 255)];
      }
      case 'd': {
        const [ir, ig, ib] = this.tintOf(inner);
        const k = depth % 2 === 1 ? 1.35 : 0.45;
        const ch = (c: number): number => Math.max(0, Math.min(255, c * k));
        return [ch(ir), ch(ig), ch(ib), Math.min(240, 0.78 * 255)];
      }
      case 'e': {
        const [mr, mg, mb] = MAGMA[Math.min(MAGMA.length - 1, depth - 1)];
        return [mr, mg, mb, Math.min(240, (0.68 + 0.06 * (depth - 1)) * 255)];
      }
      default: {
        const k = Math.max(0.45, 1 - 0.14 * (depth - 1));
        return [r * k, g * k, b * k, Math.min(230, a * 255)];
      }
    }
  }

  /**
   * A claimed tile's tint: the owner's colour, lifted off it so the claim reads
   * against the ground — toward white on the dark board, the other way on the
   * light one. A closed circuit's tiles darken with its length; your own
   * circuits each lean their hue a little and darken over a wider range.
   */
  private tintOf(path: ClientPath): [number, number, number] {
    const player = this.store.players.get(path.owner);
    if (!player) return [255, 255, 255];
    const closed = path.status === 'closed';
    const [css, dark] = closed ? this.closedLook(path, player.color) : [player.color, 0];
    let rgb = this.rgbCache.get(css);
    if (!rgb) {
      rgb = parseColor(css);
      this.rgbCache.set(css, rgb);
    }
    const k = 1 - dark;
    // A circuit carries its lightness in the colour itself (the length ramp).
    const lift = closed ? 0 : this.board.lift;
    const ch = (c: number): number => Math.max(0, Math.min(255, (c + lift) * k));
    return [ch(rgb[0]), ch(rgb[1]), ch(rgb[2])];
  }

  /** A closed path's colour (the length ramp) and extra darkening (none, today). */
  private closedLook(path: ClientPath, color: string): readonly [string, number] {
    const hit = this.looks.get(path);
    if (hit && hit[0] === color) return hit[1];
    const look: [string, number] = [
      LENGTH_PALETTE ? rgbToHex(circuitLengthRgb(path.steps.length)) : circuitColor(color, path.steps.length, path.id),
      0,
    ];
    this.looks.set(path, [color, look]);
    return look;
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
      // A loop joins back to its start; an edge-to-edge claim ends at the edge.
      if (path.status === 'closed' && pen && !path.region) {
        const first = path.steps[0];
        const [ax, ay] = toScreen(first.a.x, first.a.y);
        ctx.lineTo(ax, ay);
      }
      if (mine) {
        ctx.strokeStyle = this.board.haloCss;
        ctx.lineWidth = w + Math.max(2, 0.08 * s);
        ctx.stroke();
      }
      const ink =
        path.status !== 'closed'
          ? strandColor(this.board, owner.color)
          : darkenCss(this.closedLook(path, owner.color)[0], 0.3);
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
