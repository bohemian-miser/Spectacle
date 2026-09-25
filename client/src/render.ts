/**
 * Arena renderer: a tile layer in the bottom canvas (WebGL2 instanced, or
 * Canvas2D where WebGL is missing) and a Canvas2D overlay on top for the
 * live things — every path as a polyline, a pulsing head on each growing
 * one, a cross on each stuck one. Claimed tiles are tinted in the tile layer,
 * and a closed circuit washes the tiles it encloses in its owner's colour —
 * the washes stack, so a loop inside a loop shows deeper.
 * Zoomed in close, your own rule is sketched faintly over the free tiles.
 */

import { fieldOutline, pathPolygon, tilesInBox, tilesInsidePolygon, type Box, type Field } from '../../shared/game/field';
import { chordTableFor, tileChords, worldChord } from '../../shared/game/strand';
import { getSettings, type CircuitStyle, type Settings } from './settings';
import { circuitLengthRgb, rgbToHex } from '../../shared/tiles';
import type { Camera } from './camera';
import type { Burst, ClientPath, ClientPlayer, Store } from './store';
import { boardTheme, type BoardTheme } from './theme';
import { createCanvasTiles } from './tiles-2d';
import { createGlTiles } from './tiles-gl';
import {
  ARROW_MIN_SCALE,
  circuitColor,
  circuitShade,
  darkenCss,
  parseColor,
  strandColor,
  typeFill,
  type Rgb01,
  type TileLayer,
} from './tiles-layer';

/**
 * Scale at which your rule's pattern starts to show on the free tiles. It
 * fades in over the next `PATTERN_FADE` of scale, so it dims away as you
 * zoom back out. Scale is screen px per world unit (see `fitToField`), so
 * render distance is ∝ 1 / scale — dividing the plain 1.3 × `ARROW_MIN_SCALE`
 * threshold by 1.5 renders the pattern at 50% more distance (it now shows
 * before the direction arrows do, not after).
 */
const MAGMA: readonly (readonly [number, number, number])[] = [
  [252, 214, 120],
  [247, 146, 64],
  [222, 74, 76],
  [160, 44, 122],
  [84, 24, 112],
  [28, 12, 60],
];

export const PATTERN_MIN_SCALE = (ARROW_MIN_SCALE * 1.3) / 1.5;
const PATTERN_FADE = 16;
const PATTERN_ALPHA = 0.35;

/** How long a cut line takes to fade off the board, and a collision's sparks to die out (ms). */
const FADE_MS = 650;
const SPARK_MS = 480;
const SPARKS = 7;

/** Player name labels: font size (CSS px) and the gap kept from the screen's edge. */
const LABEL_PX = 12;
const LABEL_MARGIN = 6;

/** Where a player's name floats: one step of one of their lines. */
interface LabelAnchor {
  readonly path: number;
  readonly step: number;
}

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
  /** How circuits are coloured (see `settings.ts`). */
  private style: CircuitStyle = getSettings().circuitStyle;
  /** The plain board: tiles in the ground colour, no arrows, the arena's edge drawn. */
  private plain = getSettings().plainTiles;
  /** Team colours: yours blue, everyone else red. */
  private teams = getSettings().teams;
  /** A closed circuit's enclosed tiles; a closed path never changes, so once is enough. */
  private readonly interiors = new WeakMap<ClientPath, readonly number[]>();
  /** A closed path's colour and darkening, keyed on the owner colour it was made from. */
  private looks = new WeakMap<ClientPath, readonly [string, readonly [string, number]]>();
  private readonly rgbCache = new Map<string, [number, number, number]>();
  /** Tiles inside anyone else's closed circuit (rebuilt with the tints). */
  private rivalInterior = new Set<number>();
  private readonly visible: number[] = [];
  /** Each player's name sits on one of their tiles; it stays put while that tile is on screen. */
  private readonly labelAnchors = new Map<string, LabelAnchor>();
  private readonly labelWidths = new Map<string, number>();

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
    this.tiles.setArrows(!this.plain);
    this.lastGeometry = -1;
  }

  private fills(field: Field): Rgb01[] {
    return field.leafTypes.map((type) => (this.plain ? this.board.bg : typeFill(type, this.board.tileDim)));
  }

  /** Repaint in another scheme: new tile fills, ground and ink, and fresh tints. */
  setTheme(board: BoardTheme): void {
    this.board = board;
    if (this.field) this.tiles?.setTheme(board, this.fills(this.field));
    // The claim tint is mixed against the scheme's fills, so it has to go again.
    this.lastGeometry = -1;
  }

  /** Apply the display settings: circuit colouring and the plain board, live. */
  setSettings(s: Settings): void {
    if (s.circuitStyle !== this.style) {
      this.style = s.circuitStyle;
      this.looks = new WeakMap();
      this.lastGeometry = -1;
    }
    if (s.teams !== this.teams) {
      this.teams = s.teams;
      this.looks = new WeakMap();
      this.lastGeometry = -1;
    }
    if (s.plainTiles !== this.plain) {
      this.plain = s.plainTiles;
      if (this.field) this.tiles?.setTheme(this.board, this.fills(this.field));
      this.tiles?.setArrows(!this.plain);
      this.lastGeometry = -1;
    }
  }

  /** The colour a path draws in: its pattern's, or its team's with team colours on. */
  private colorOf(path: ClientPath): string | undefined {
    if (this.teams) return this.teamColor(path.owner === this.store.you);
    return this.store.pathColor(path);
  }

  private teamColor(mine: boolean): string {
    return mine ? this.board.teamMe : this.board.teamRival;
  }

  private lengthPalette(): boolean {
    return !this.teams && this.style === 'b' || this.style === 'd' || this.style === 'e';
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
    // Team colours keep the plain wash: the other styles bring in hues of their own.
    switch (this.teams ? 'a' : this.style) {
      case 'c': {
        const base = this.colorOf(inner) ?? 'hsl(0, 90%, 62%)';
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
    const color = this.colorOf(path);
    if (!color) return [255, 255, 255];
    const closed = path.status === 'closed';
    const [css, dark] = closed ? this.closedLook(path, color) : [color, 0];
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
      this.teams
        ? circuitShade(color, path.steps.length)
        : this.lengthPalette()
          ? rgbToHex(circuitLengthRgb(path.steps.length))
          : circuitColor(color, path.steps.length, path.id),
      0,
    ];
    this.looks.set(path, [color, look]);
    return look;
  }

  /**
   * Your active pattern, sketched faintly on every tile no rival's line touches and that
   * is not inside a rival's circuit — your own tiles included. Only when
   * zoomed in; it fades out on the way back.
   */
  private drawPattern(toScreen: (x: number, y: number) => [number, number], box: Box): void {
    const field = this.field;
    const me = this.store.me;
    const scale = this.camera.scale;
    if (!field || !me || scale <= PATTERN_MIN_SCALE) return;
    const fade = Math.min(1, (scale - PATTERN_MIN_SCALE) / PATTERN_FADE);
    const pattern = me.patterns[me.active] ?? { rule: me.rule, color: me.color };
    const table = chordTableFor(field, pattern.rule);
    const occupancy = this.store.occupancy;
    const ctx = this.ctx;
    ctx.beginPath();
    for (const i of tilesInBox(field, box, this.visible)) {
      if (this.rivalInterior.has(i)) continue;
      const occ = occupancy.get(i);
      if (occ && [...occ].some((q) => q.owner !== me.id)) continue;
      const n = tileChords(field, table, i).length;
      for (let c = 0; c < n; c++) {
        const [a, b] = worldChord(field, table, i, c);
        const [ax, ay] = toScreen(a.x, a.y);
        const [bx, by] = toScreen(b.x, b.y);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }
    ctx.strokeStyle = strandColor(this.board, this.teams ? this.board.teamMe : pattern.color);
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

  /** The arena's edge, for the plain board (where no tile fill shows it). */
  private drawOutline(toScreen: (x: number, y: number) => [number, number]): void {
    const field = this.field;
    if (!field) return;
    const ring = fieldOutline(field);
    if (ring.length < 3) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k < ring.length; k++) {
      const [x, y] = toScreen(ring[k].x, ring[k].y);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = this.board.inkCss;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1.5, 0.08 * this.camera.scale * this.dpr);
    ctx.stroke();
    ctx.globalAlpha = 1;
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
    if (this.plain) this.drawOutline(toScreen);
    this.drawPattern(toScreen, box);
    /** `fade` < 1: a line cut in a collision on its way out (no head, no cross). */
    const drawPath = (path: ClientPath, mine: boolean, fade = 1, color = this.colorOf(path)): void => {
      if (!color || path.steps.length === 0) return;
      ctx.globalAlpha = fade;
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
          ? strandColor(this.board, color)
          : darkenCss(this.closedLook(path, color)[0], 0.3);
      ctx.strokeStyle = ink;
      ctx.lineWidth = w;
      ctx.globalAlpha = (path.status === 'stuck' ? 0.6 : 1) * fade;
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (fade < 1) return;
      const last = path.steps[path.steps.length - 1];
      if (path.status === 'growing') {
        // A line growing both ways has a head at its start too.
        const heads = path.back ? [last.b, path.steps[0].a] : [last.b];
        const pulse = 1 + 0.35 * Math.sin(t / 160);
        for (const h of heads) {
          if (!inView(h.x, h.y)) continue;
          const [hx, hy] = toScreen(h.x, h.y);
          ctx.beginPath();
          ctx.arc(hx, hy, Math.max(3, 0.22 * s) * pulse, 0, Math.PI * 2);
          ctx.fillStyle = ink;
          ctx.fill();
          ctx.lineWidth = Math.max(1, 0.05 * s);
          ctx.strokeStyle = this.board.inkCss;
          ctx.stroke();
        }
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
    const now = performance.now();
    if (store.dying.length > 0) {
      store.dying = store.dying.filter((d) => now - d.born < FADE_MS);
      for (const d of store.dying) {
        const k = 1 - (now - d.born) / FADE_MS;
        drawPath(d.path, d.mine, k * k, this.teams ? this.teamColor(d.mine) : d.color);
      }
    }
    if (store.bursts.length > 0) {
      store.bursts = store.bursts.filter((b) => now - b.born < SPARK_MS);
      for (const b of store.bursts) if (inView(b.at.x, b.at.y)) this.drawBurst(b, now, toScreen);
    }
    this.drawNames(toScreen);
  }

  /**
   * Each player's name, floating over one of their tiles — one label per
   * player on screen at most. A label stays on its tile while that tile is in
   * view (and the line still theirs); otherwise it moves to their tile
   * nearest the middle of the screen whose label doesn't cover another's.
   */
  private drawNames(toScreen: (x: number, y: number) => [number, number]): void {
    const store = this.store;
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.overlay.width;
    const H = this.overlay.height;
    const px = LABEL_PX * dpr;
    const margin = LABEL_MARGIN * dpr;
    const lift = Math.max(16, 0.6 * this.camera.scale) * dpr;
    ctx.font = `600 ${px}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const widthOf = (name: string): number => {
      const key = `${px}|${name}`;
      let w = this.labelWidths.get(key);
      if (w === undefined) {
        w = ctx.measureText(name).width;
        if (this.labelWidths.size > 256) this.labelWidths.clear();
        this.labelWidths.set(key, w);
      }
      return w;
    };
    type Rect = readonly [number, number, number, number];
    const placed: Rect[] = [];
    /** The label's box for an anchor at screen (x, y), or null if it would leave the screen. */
    const rectAt = (x: number, y: number, w: number): Rect | null => {
      const cy = y - lift;
      const r: Rect = [x - w / 2 - 6 * dpr, cy - px / 2 - 3 * dpr, x + w / 2 + 6 * dpr, cy + px / 2 + 3 * dpr];
      if (r[0] < margin || r[1] < margin || r[2] > W - margin || r[3] > H - margin) return null;
      return r;
    };
    const free = (r: Rect): boolean => placed.every((q) => r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3]);
    const pointOf = (path: ClientPath, i: number): [number, number] => {
      const st = path.steps[i];
      return toScreen((st.a.x + st.b.x) / 2, (st.a.y + st.b.y) / 2);
    };
    const labels: { player: ClientPlayer; rect: Rect; x: number; y: number }[] = [];
    const pending: ClientPlayer[] = [];
    // Labels that can stay where they were go down first, so they don't jump.
    for (const player of store.players.values()) {
      const anchor = this.labelAnchors.get(player.id);
      const path = anchor && store.paths.get(anchor.path);
      if (!anchor || !path || path.owner !== player.id || anchor.step >= path.steps.length) {
        pending.push(player);
        continue;
      }
      const [x, y] = pointOf(path, anchor.step);
      const r = rectAt(x, y, widthOf(player.name));
      if (!r || !free(r)) {
        pending.push(player);
        continue;
      }
      placed.push(r);
      labels.push({ player, rect: r, x, y });
    }
    if (pending.length > 0) {
      const byOwner = new Map<string, ClientPath[]>();
      for (const path of store.paths.values()) {
        const list = byOwner.get(path.owner);
        if (list) list.push(path);
        else byOwner.set(path.owner, [path]);
      }
      for (const player of pending) {
        this.labelAnchors.delete(player.id);
        const paths = byOwner.get(player.id);
        if (!paths) continue;
        const w = widthOf(player.name);
        let best: { anchor: LabelAnchor; rect: Rect; x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const path of paths) {
          for (let i = 0; i < path.steps.length; i++) {
            const [x, y] = pointOf(path, i);
            const d = (x - W / 2) ** 2 + (y - H / 2) ** 2;
            if (d >= bestD) continue;
            const r = rectAt(x, y, w);
            if (!r || !free(r)) continue;
            best = { anchor: { path: path.id, step: i }, rect: r, x, y };
            bestD = d;
          }
        }
        if (!best) continue;
        this.labelAnchors.set(player.id, best.anchor);
        placed.push(best.rect);
        labels.push({ player, rect: best.rect, x: best.x, y: best.y });
      }
    }
    for (const id of this.labelAnchors.keys()) if (!store.players.has(id)) this.labelAnchors.delete(id);
    for (const { player, rect, x, y } of labels) {
      const mine = player.id === store.you;
      const ink = strandColor(this.board, this.teams ? this.teamColor(mine) : player.color);
      const cy = (rect[1] + rect[3]) / 2;
      // A short tick from the label down to the tile it belongs to.
      ctx.beginPath();
      ctx.moveTo(x, rect[3]);
      ctx.lineTo(x, y);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
      // A pill in the ground colour, so the name reads over the saturated tiles.
      ctx.beginPath();
      ctx.roundRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1], (rect[3] - rect[1]) / 2);
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = this.board.bgCss;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.fillText(player.name, x, cy);
    }
  }

  /**
   * A collision's kaput: a quick flash and a few sparks flung out from where
   * the lines met, slowing as they go and burning out. Each cut line throws
   * its own, in its own colour, so a two-way crash sprays both.
   */
  private drawBurst(b: Burst, now: number, toScreen: (x: number, y: number) => [number, number]): void {
    const ctx = this.ctx;
    const u = (now - b.born) / SPARK_MS;
    const [cx, cy] = toScreen(b.at.x, b.at.y);
    // Tiny on the board, but never smaller than a few pixels when zoomed out.
    const reach = Math.max(18 * this.dpr, 1.2 * this.camera.scale * this.dpr);
    const w = Math.max(2 * this.dpr, 0.08 * this.camera.scale * this.dpr);
    const ink = strandColor(this.board, this.teams ? this.teamColor(b.mine) : b.color);
    // The pop: a ring that swells and thins out in the first third.
    if (u < 0.35) {
      const f = u / 0.35;
      ctx.beginPath();
      ctx.arc(cx, cy, reach * (0.12 + 0.38 * f), 0, Math.PI * 2);
      ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = this.board.haloCss;
      ctx.lineWidth = w * (1 - f) * 2 + w;
      ctx.stroke();
      ctx.strokeStyle = ink;
      ctx.lineWidth = w * (1 - f) * 2;
      ctx.stroke();
    }
    const out = 1 - (1 - u) * (1 - u) * (1 - u); // ease out: fast, then drifting
    const tail = 0.3 * (1 - u);
    let r = Math.imul(b.seed + 1, 2654435761) >>> 0;
    const rand = (): number => {
      r = (Math.imul(r ^ (r >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
      return r / 4294967296;
    };
    const turn = rand() * Math.PI * 2;
    ctx.beginPath();
    for (let i = 0; i < SPARKS; i++) {
      const ang = turn + ((i + rand() * 0.7) / SPARKS) * Math.PI * 2;
      const len = reach * (0.55 + 0.45 * rand());
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const d1 = len * out;
      const d0 = Math.max(0, d1 - len * tail);
      ctx.moveTo(cx + dx * d0, cy + dy * d0);
      ctx.lineTo(cx + dx * d1, cy + dy * d1);
    }
    // Cased like a strand, so the sparks show over the saturated tiles.
    const k = 1 - u * 0.6;
    ctx.globalAlpha = 1 - u * u;
    ctx.strokeStyle = this.board.haloCss;
    ctx.lineWidth = w * k + Math.max(2, w * 0.8);
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = w * k;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

}
