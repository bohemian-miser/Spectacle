/**
 * Arena renderer: a tile layer in the bottom canvas (WebGL2 instanced, or
 * Canvas2D where WebGL is missing) and a Canvas2D overlay on top for the
 * live things — every path as a polyline, a pulsing head on each growing
 * one someone steers (not on a flip's pieces), a cross on each stuck one.
 * The lines sit on a cached layer, redrawn only when the board or the camera
 * moved (see `drawOverlay`); heads, fades and sparks draw every frame.
 * Claimed tiles are tinted in the tile layer, and a closed circuit washes the
 * tiles it encloses in its owner's colour — the washes stack, so a loop
 * inside a loop shows deeper.
 * Zoomed in close, your own rule is sketched faintly over the free tiles.
 */

import { fieldOutline, tileAt, tileCenter, tilePolygon, tilesEnclosed, tilesInBox, type Box, type Field } from '../../shared/game/field';
import { fassRule } from '../../shared/game/rule';
import { flipOrder, flippedBy, type FlipOrder } from './celebration';
import { chordTableFor, tileChords, worldChord, type ChordTable } from '../../shared/game/strand';
import { getSettings, type CircuitStyle, type Settings } from './settings';
import { circuitLengthRgb, rgbToHex, type Pt } from '../../shared/tiles';
import type { Camera } from './camera';
import type { Burst, ClientPath, ClientPlayer, Coalesce, Store, Win } from './store';
import type { PathStepWire } from '../../shared/game/protocol';
import { spectreView, viewChord, viewOutline, viewPoint, viewPolygon, viewStep, viewTap, viewTileAt, type SpectreView } from './spectre-view';
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
/** A rule change's motes: gathering to the tiles that carry on, then fading into them. */
const COALESCE_MS = 1100;
/** …and the pulse of the end state it bought: in as the motes gather, out as the lines take over. */
const GHOST_FROM_MS = 150;
const GHOST_MS = 1900;
const SPARKS = 7;

/** Least time between two rebuilds of the tile tints while the board is busy (ms). */
const TINT_MIN_MS = 200;

/**
 * A new circuit's wash spreads in from its line a ring of tiles at a time:
 * `RING_MS` a ring, faster for a big one so none takes over `REVEAL_MS`.
 */
const RING_MS = 14;
const REVEAL_MS = 800;

/** How long a player whose name found no place waits before the next search (ms). */
const LABEL_RETRY_MS = 300;

/** Player name labels: font size (CSS px) and the gap kept from the screen's edge. */
const LABEL_PX = 12;
const LABEL_MARGIN = 6;

/**
 * A board change redraws the lines layer at most once per this many times
 * what its last redraw took (see `drawOverlay`).
 */
const LINES_BUDGET = 3;

/** A line's points closer than this (device px, x + y) to the last one drawn are skipped (see `trace`). */
const TRACE_MIN_PX = 1;

/** How long the board takes to morph between hexagons and Spectres (ms). */
const MORPH_MS = 1200;
/**
 * A won round (`drawWin`): the board veils over and the winner's pattern
 * shows on every tile (`WIN_IN_MS`), then the infinite line flips it all
 * from the winner's loose end, accelerating (`WIN_SPREAD_MS`); once the
 * fresh board is in (`restart`) it fades away (`WIN_FADE_MS`). The engine's
 * `winCelebrateMs` is how long it holds still for this.
 */
const WIN_IN_MS = 1000;
const WIN_SPREAD_MS = 5000;
const WIN_FADE_MS = 1500;
const WIN_VEIL = 0.88;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A cached overlay layer and what it was drawn for. */
interface Layer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly ctx: CanvasRenderingContext2D;
  /** Camera, size and looks it was drawn for. */
  view: string;
  /** Store versions it was drawn for. */
  board: string;
  /** When it was drawn (frame time) and how long that took (ms). */
  at: number;
  cost: number;
}

/** Where a player's name floats: one step of one of their lines. */
interface LabelAnchor {
  readonly path: number;
  readonly step: number;
}

export class Renderer {
  readonly camera: Camera = { x: 0, y: 0, scale: 10 };
  /** A switch's end-state paths, built once per view (`drawGhost`). */
  private readonly ghostPaths = new WeakMap<Coalesce, { t: number; line: Path2D; fill: Path2D }>();
  /** A switch's motes carried into the view they play in (`drawCoalesce`). */
  private readonly viewMotes = new WeakMap<Coalesce, { t: number; from: readonly Pt[]; to: readonly (Pt | null)[] }>();
  private ctx: CanvasRenderingContext2D;
  private tiles: TileLayer | null = null;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private field: Field | null = null;
  private frameHandle = 0;
  private lastFrameAt = 0;
  private lastGeometry = -1;
  private lastTintsVersion = -1;
  private lastClosedVersion = -1;
  /** Tiles whose lines changed since the last tint pass (the store fills it). */
  private readonly touched: Set<number>;
  /** Each washed tile's tint, from the last time the closed lines changed. */
  private wash = new Map<number, [number, number, number, number]>();
  private lastTintAt = -Infinity;
  private board: BoardTheme = boardTheme();
  /** How circuits are coloured (see `settings.ts`). */
  private style: CircuitStyle = getSettings().circuitStyle;
  /** The plain board: tiles in the ground colour, no arrows, the arena's edge drawn. */
  private plain = getSettings().plainTiles;
  /** Team colours: yours blue, everyone else red. */
  private teams = getSettings().teams;
  /** The Spectre view of a hexagon board (see `spectre-view.ts`): wanted, built, and how far across the board is. */
  private spectres = getSettings().spectres;
  private view: SpectreView | null = null;
  /** 0 = hexagons, 1 = Spectres; between them while the morph plays. */
  private viewT = 0;
  private morph: { from: number; to: number; start: number } | null = null;
  private readonly stepScratch: number[] = [];
  /** A closed circuit's enclosed tiles; a closed path never changes, so once is enough. */
  private readonly interiors = new WeakMap<ClientPath, { tiles: readonly number[]; rings: readonly number[] }>();
  /** A closed path's colour and darkening, keyed on the owner colour it was made from. */
  private looks = new WeakMap<ClientPath, readonly [string, readonly [string, number]]>();
  private readonly rgbCache = new Map<string, [number, number, number]>();
  /** Bumped by anything that changes how lines look (theme, settings). */
  private looksEpoch = 0;
  /** Bumped by each tint rebuild (it works out `rivalInterior`, which the pattern skips). */
  private tintEpoch = 0;
  /** The lines layer (see `drawOverlay`). */
  private lines: Layer | null = null;
  /** The plain board's outline, which only changes with the camera. */
  private outline: Layer | null = null;
  /** Where the heads were when the lines were drawn: screen x, y pairs by ink. */
  private headSpots = new Map<string, number[]>();
  /** Line colours by the colour they come from (see `inkOf`). */
  private readonly inks = new Map<string, string>();
  /** Tiles inside anyone else's closed circuit, and how many such circuits (kept with the washes). */
  private readonly rivalInterior = new Map<number, number>();
  /** The closed lines the washes were last worked out for, as they were then. */
  private readonly closedSeen = new Map<ClientPath, { owner: string; pattern: number; inside: readonly number[]; shown: number }>();
  /** Circuits whose wash is still spreading in from the line (see `RING_MS`). */
  private reveals: { path: ClientPath; rings: readonly number[]; start: number }[] = [];
  /** Tile → the closed lines round it (the washes' layers). */
  private readonly cover = new Map<number, ClientPath[]>();
  private readonly visible: number[] = [];
  /** Each player's name sits on one of their tiles; it stays put while that tile is on screen. */
  private readonly labelAnchors = new Map<string, LabelAnchor>();
  private readonly labelWidths = new Map<string, number>();
  /** A player whose name found no place: when to look again (the search walks all their steps). */
  private readonly labelRetry = new Map<string, number>();
  /** The win being played (see `drawWin`): its flip order, chords and the layer it builds up. */
  private celebration: {
    readonly win: Win;
    readonly plan: FlipOrder;
    readonly winner: ChordTable;
    readonly fass: ChordTable;
    readonly hue: number;
    /** When it started playing: after the flip order was worked out (~0.25 s at level 6). */
    readonly start: number;
    layer: Layer;
    /** How many of `plan.order` the layer shows flipped. */
    drawn: number;
  } | null = null;

  constructor(
    private readonly tileCanvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly store: Store,
  ) {
    this.ctx = overlay.getContext('2d')!;
    this.touched = store.watchTiles();
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
    // A new board starts as hexagons (a fresh view is built for it if wanted), with no morph to play.
    this.view = null;
    this.viewT = 0;
    this.morph = null;
    if (this.spectres) this.applyView(true, false);
  }

  /**
   * Show the board as Spectres (or as hexagons again), morphing between the
   * two unless told not to (or the player prefers reduced motion). Only a
   * hexagon board has a Spectre view; the view is built on first use.
   */
  private applyView(on: boolean, animate: boolean): void {
    this.spectres = on;
    const field = this.field;
    if (!field || !this.tiles || field.family !== 'hex') return;
    if (on && !this.view) {
      try {
        this.view = spectreView(field);
      } catch (err) {
        console.warn('No Spectre view of this board', err);
        return;
      }
      this.tiles.setView(this.view);
    }
    if (!this.view) return;
    const to = on ? 1 : 0;
    if (animate && !prefersReducedMotion()) {
      this.morph = { from: this.viewT, to, start: performance.now() };
    } else {
      this.morph = null;
      this.viewT = to;
      this.tiles.setMorph(to);
    }
  }

  /** How far across to the Spectre view the board is drawn right now (0 = hexagons). */
  get morphT(): number {
    return this.view ? this.viewT : 0;
  }

  private fills(field: Field): Rgb01[] {
    return field.leafTypes.map((type) => (this.plain ? this.board.bg : typeFill(type, this.board.tileDim)));
  }

  /** Repaint in another scheme: new tile fills, ground and ink, and fresh tints. */
  setTheme(board: BoardTheme): void {
    this.board = board;
    this.inks.clear();
    this.looksEpoch++;
    if (this.field) this.tiles?.setTheme(board, this.fills(this.field));
    // The claim tint is mixed against the scheme's fills, so it has to go again.
    this.lastGeometry = -1;
  }

  /** Apply the display settings: circuit colouring and the plain board, live. */
  setSettings(s: Settings): void {
    this.looksEpoch++;
    if (s.circuitStyle !== this.style) {
      this.style = s.circuitStyle;
      this.looks = new WeakMap();
      this.inks.clear();
      this.lastGeometry = -1;
    }
    if (s.teams !== this.teams) {
      this.teams = s.teams;
      this.looks = new WeakMap();
      this.inks.clear();
      this.lastGeometry = -1;
    }
    if (s.plainTiles !== this.plain) {
      this.plain = s.plainTiles;
      if (this.field) this.tiles?.setTheme(this.board, this.fills(this.field));
      this.tiles?.setArrows(!this.plain);
      this.lastGeometry = -1;
    }
    if (s.spectres !== this.spectres) this.applyView(s.spectres, true);
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

  /**
   * The tile under screen point (sx, sy) and the world point to send with a
   * tap there, or null off the board. In the Spectre view the tile is the one
   * whose piece is under the pointer, and the point names the chord nearest
   * the tap as the player sees it (the server picks chords in hexagon
   * geometry, by distance).
   */
  pick(sx: number, sy: number): { tile: number; x: number; y: number } | null {
    const field = this.field;
    if (!field) return null;
    const w = this.screenToWorld(sx, sy);
    if (this.view && this.viewT >= 0.5) {
      const tile = viewTileAt(this.view, w, this.viewT);
      if (tile < 0) return null;
      const me = this.store.me;
      const rule = me ? (me.patterns[me.active]?.rule ?? me.rule) : undefined;
      if (!rule) return { tile, x: w.x, y: w.y };
      const p = viewTap(this.view, chordTableFor(field, rule), tile, w, this.viewT);
      return { tile, x: p.x, y: p.y };
    }
    const tile = tileAt(field, w);
    return tile < 0 ? null : { tile, x: w.x, y: w.y };
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
    this.store.unwatchTiles(this.touched);
    this.tiles?.dispose();
    this.tiles = null;
  }

  private viewBox(): Box {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.width, this.height);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  /**
   * Push the claimed-tile tints into the tile layer when paths or players
   * changed — at most every `TINT_MIN_MS`. Only the tiles the store says were
   * touched are re-tinted: a busy board has over a hundred thousand claimed
   * tiles, and walking them all every rebuild took a phone-killing ~150 ms.
   * The circuit washes are worked out again only when the closed lines
   * changed, and everything goes again when the players, theme or settings
   * did. The line itself is drawn every frame, so a tint a few frames late
   * doesn't show.
   */
  private syncTints(now: number): void {
    const tiles = this.tiles;
    if (!tiles) return;
    const store = this.store;
    const full = this.lastGeometry === -1 || store.tintsVersion !== this.lastTintsVersion;
    const washes = full || store.closedVersion !== this.lastClosedVersion;
    // A wash spreading in from its line moves every frame; its passes only touch the new ring.
    const revealing = this.reveals.length > 0;
    if (!full && !washes && this.touched.size === 0 && !revealing) return;
    if (now - this.lastTintAt < TINT_MIN_MS && this.lastGeometry !== -1 && !revealing) return;
    this.lastTintAt = now;
    this.lastGeometry = store.geometryVersion;
    this.lastTintsVersion = store.tintsVersion;
    this.lastClosedVersion = store.closedVersion;
    // One colour per path, not per tile: a long line covers thousands.
    const tintMemo = new Map<ClientPath, [number, number, number]>();
    const tintOf = (path: ClientPath): [number, number, number] => {
      let rgb = tintMemo.get(path);
      if (!rgb) tintMemo.set(path, (rgb = this.tintOf(path)));
      return rgb;
    };
    const touched = this.touched;
    if (washes) this.washes(full, tintOf, touched, now);
    if (this.reveals.length > 0) this.reveal(now, tintOf, touched);
    // Your pattern skips rival circuits' interiors, which the washes work out.
    if (washes || revealing) this.tintEpoch++;
    const tint = (tile: number): void => {
      const paths = store.occupancy.get(tile);
      if (paths) {
        // Your own claim wins the tint; otherwise the first path on the tile.
        let pick: ClientPath | null = null;
        for (const p of paths) {
          if (p.owner === store.you) {
            pick = p;
            break;
          }
          if (pick === null) pick = p;
        }
        if (pick !== null) {
          const [r, g, b] = tintOf(pick);
          tiles.setTint(tile, r, g, b, pick.status === 'closed' ? (pick.owner === store.you ? 175 : 150) : pick.owner === store.you ? 115 : 85);
          return;
        }
      }
      // A free tile inside circuits takes their wash.
      const w = this.wash.get(tile);
      if (w) tiles.setTint(tile, w[0], w[1], w[2], w[3]);
      else if (!full) tiles.setTint(tile, 0, 0, 0, 0);
    };
    if (full) {
      tiles.clearTints();
      for (const tile of store.occupancy.keys()) tint(tile);
      for (const tile of this.wash.keys()) if (!store.occupancy.has(tile)) tint(tile);
    } else {
      for (const tile of touched) tint(tile);
    }
    touched.clear();
  }

  /**
   * Interior wash: the tiles a closed circuit encloses take its owner's
   * colour, fainter than the loop itself (a tile with a line on it shows the
   * line's tint instead). Washes stack: outer circuits go down first and each
   * one inside lays its colour over them, so nesting deepens the tile rather
   * than hiding behind the first loop to claim it. Flip pieces close circuits
   * all the time, so only the tiles inside the circuits that closed, opened,
   * went or changed hands since last time are worked out again (all of them
   * when `full`); those go into `touched`. Keeps `rivalInterior` too. A
   * circuit's inside is found by filling in from its line (`tilesEnclosed`),
   * ring by ring, and a circuit that just closed shows it that way: its wash
   * spreads in from the line (`reveal`).
   */
  private washes(full: boolean, tintOf: (path: ClientPath) => [number, number, number], touched: Set<number>, now: number): void {
    const store = this.store;
    const field = this.field;
    if (full) {
      this.closedSeen.clear();
      this.cover.clear();
      this.wash.clear();
      this.rivalInterior.clear();
      this.reveals = [];
    }
    if (!field) return;
    const redo = new Set<number>();
    const live = new Set<ClientPath>();
    for (const path of store.paths.values()) {
      if (path.status !== 'closed' || path.steps.length < 2 || !store.players.has(path.owner)) continue;
      live.add(path);
      const seen = this.closedSeen.get(path);
      if (seen && seen.owner === path.owner && seen.pattern === path.pattern) continue;
      if (seen) this.coverTiles(path, seen.inside.slice(0, seen.shown), seen.owner, false, redo);
      let inside = this.interiors.get(path);
      if (!inside) {
        inside = tilesEnclosed(field, path.steps, path.region);
        this.interiors.set(path, inside);
      }
      // A circuit just closed spreads in from its line; anything else (a
      // line changing hands, a fresh board) shows at once.
      const spread = !seen && !full && inside.rings.length > 1;
      const shown = spread ? inside.rings[1] : inside.tiles.length;
      this.coverTiles(path, inside.tiles.slice(0, shown), path.owner, true, redo);
      this.closedSeen.set(path, { owner: path.owner, pattern: path.pattern, inside: inside.tiles, shown });
      if (spread) this.reveals.push({ path, rings: inside.rings, start: now });
    }
    for (const [path, seen] of [...this.closedSeen]) {
      if (live.has(path)) continue;
      this.coverTiles(path, seen.inside.slice(0, seen.shown), seen.owner, false, redo);
      this.closedSeen.delete(path);
    }
    this.recompose(redo, tintOf, touched);
  }

  /** Spread the newest circuits' washes on to the rings now due. */
  private reveal(now: number, tintOf: (path: ClientPath) => [number, number, number], touched: Set<number>): void {
    const redo = new Set<number>();
    this.reveals = this.reveals.filter(({ path, rings, start }) => {
      const seen = this.closedSeen.get(path);
      if (!seen || seen.owner !== path.owner) return false;
      const ring = Math.floor((now - start) / Math.min(RING_MS, REVEAL_MS / rings.length)) + 1;
      const target = ring >= rings.length ? seen.inside.length : rings[ring];
      if (target > seen.shown) {
        this.coverTiles(path, seen.inside.slice(seen.shown, target), seen.owner, true, redo);
        seen.shown = target;
      }
      return seen.shown < seen.inside.length;
    });
    this.recompose(redo, tintOf, touched);
  }

  /** Lay `path`'s wash on `tiles` (or take it off), keeping `rivalInterior`; the tiles go in `redo`. */
  private coverTiles(path: ClientPath, tiles: readonly number[], owner: string, on: boolean, redo: Set<number>): void {
    const rival = owner !== this.store.you;
    for (const t of tiles) {
      redo.add(t);
      const list = this.cover.get(t);
      if (on) {
        if (list) list.push(path);
        else this.cover.set(t, [path]);
      } else if (list) {
        const i = list.indexOf(path);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.cover.delete(t);
      }
      if (!rival) continue;
      const n = (this.rivalInterior.get(t) ?? 0) + (on ? 1 : -1);
      if (n > 0) this.rivalInterior.set(t, n);
      else this.rivalInterior.delete(t);
    }
  }

  /** Work out the wash of each tile in `redo` again from the circuits round it; they go in `touched`. */
  private recompose(redo: Iterable<number>, tintOf: (path: ClientPath) => [number, number, number], touched: Set<number>): void {
    const store = this.store;
    const size = (path: ClientPath): number => this.closedSeen.get(path)!.inside.length;
    for (const t of redo) {
      touched.add(t);
      const list = this.cover.get(t);
      if (!list) {
        this.wash.delete(t);
        continue;
      }
      // Outermost (most tiles inside) first; equal ones oldest first.
      const layers = list.length === 1 ? list : [...list].sort((a, b) => size(b) - size(a) || a.id - b.id);
      let r = 0, g = 0, b = 0, a = 0;
      for (const path of layers) {
        const [pr, pg, pb] = tintOf(path);
        const pa = path.owner === store.you ? 0.42 : 0.34;
        if (a === 0) {
          [r, g, b, a] = [pr, pg, pb, pa];
          continue;
        }
        // Porter–Duff "over": this loop's colour on top of what is already there.
        const ua = a * (1 - pa);
        const oa = pa + ua;
        r = (pr * pa + r * ua) / oa;
        g = (pg * pa + g * ua) / oa;
        b = (pb * pa + b * ua) / oa;
        a = oa;
      }
      // Each level of nesting also sinks the wash a step deeper, so depth reads
      // even where two nested loops happen to share a hue.
      this.wash.set(t, this.washTint(r, g, b, a, layers.length, layers[layers.length - 1]));
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

  /**
   * The colour a path's line is stroked in: its colour deepened for the
   * board, or for a circuit its length colour darkened. Parsing colour
   * strings per path per frame showed up in a busy frame's profile, so the
   * answers are kept (cleared with the theme and settings).
   */
  private inkOf(path: ClientPath, color: string): string {
    const closed = path.status === 'closed';
    const from = closed ? this.closedLook(path, color)[0] : color;
    const key = closed ? `c${from}` : from;
    let ink = this.inks.get(key);
    if (ink === undefined) {
      ink = closed ? darkenCss(from, 0.3) : strandColor(this.board, from);
      if (this.inks.size > 4096) this.inks.clear();
      this.inks.set(key, ink);
    }
    return ink;
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
  private drawPattern(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], box: Box): void {
    const field = this.field;
    const me = this.store.me;
    const scale = this.camera.scale;
    if (!field || !me || scale <= PATTERN_MIN_SCALE) return;
    const fade = Math.min(1, (scale - PATTERN_MIN_SCALE) / PATTERN_FADE);
    const pattern = me.patterns[me.active] ?? { rule: me.rule, color: me.color };
    const table = chordTableFor(field, pattern.rule);
    const occupancy = this.store.occupancy;
    const view = this.viewT > 0 ? this.view : null;
    const pts = this.stepScratch;
    ctx.beginPath();
    for (const i of tilesInBox(field, box, this.visible)) {
      if (this.rivalInterior.has(i)) continue;
      const occ = occupancy.get(i);
      if (occ && [...occ].some((q) => q.owner !== me.id)) continue;
      const n = tileChords(field, table, i).length;
      for (let c = 0; c < n; c++) {
        if (view) {
          viewChord(view, table, i, c, this.viewT, pts);
          for (let k = 0; k < pts.length; k += 2) {
            const [x, y] = toScreen(pts[k], pts[k + 1]);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          continue;
        }
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
    if (this.morph) {
      const m = this.morph;
      const s = Math.min(1, (t - m.start) / MORPH_MS);
      const e = s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2; // ease in-out
      this.viewT = m.from + (m.to - m.from) * e;
      this.tiles.setMorph(this.viewT);
      if (s >= 1) this.morph = null;
    }
    this.syncTints(t);
    // Both layers are cheap to call every frame: WebGL redraws in one pass,
    // the 2D layer caches its tiles by camera and only re-blits.
    this.tiles.draw(this.camera, this.width, this.height, this.dpr);
    this.drawOverlay(t);
  }

  /** The arena's edge, for the plain board (where no tile fill shows it). Not while the board is morphing. */
  private drawOutline(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number]): void {
    const field = this.field;
    if (!field) return;
    const t = this.morphT;
    if (t > 0 && t < 1) return;
    const ring = t >= 1 && this.view ? viewOutline(this.view) : fieldOutline(field);
    if (ring.length < 3) return;
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

  /** An offscreen canvas the size of the overlay, for a cached layer. */
  private layer(W: number, H: number): Layer {
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    return { canvas, ctx: canvas.getContext('2d') as CanvasRenderingContext2D, view: '', board: '', at: -Infinity, cost: 0 };
  }

  /**
   * The points a step draws, as flat `x, y` pairs: its chord's ends on the
   * hexagons, or where the Spectre view puts them (`viewStep`), two or three
   * points, part way across during the morph.
   */
  private stepPts(path: ClientPath, step: PathStepWire, out: number[]): number[] {
    const table = this.view && this.viewT > 0 ? this.store.pathTable(path) : undefined;
    if (table) return viewStep(this.view!, table, step, this.viewT, out);
    out.length = 0;
    out.push(step.a.x, step.a.y, step.b.x, step.b.y);
    return out;
  }

  /** Where a step starts (`end` 0) or ends (1), as drawn. */
  private stepEnd(path: ClientPath, step: PathStepWire, end: 0 | 1): Pt {
    if (!this.view || this.viewT <= 0) return end === 0 ? step.a : step.b;
    const pts = this.stepPts(path, step, this.stepScratch);
    return end === 0 ? { x: pts[0], y: pts[1] } : { x: pts[pts.length - 2], y: pts[pts.length - 1] };
  }

  /** The middle of a step as drawn (a label's anchor). */
  private stepMid(path: ClientPath, step: PathStepWire): Pt {
    if (!this.view || this.viewT <= 0) return { x: (step.a.x + step.b.x) / 2, y: (step.a.y + step.b.y) / 2 };
    const pts = this.stepPts(path, step, this.stepScratch);
    const k = pts.length === 6 ? 2 : 0;
    return { x: (pts[k] + pts[k + 2]) / 2, y: (pts[k + 1] + pts[k + 3]) / 2 };
  }

  /** A hex-world point that no step pins down (sparks, motes), as the view draws it. */
  private viewPt(p: Pt): Pt {
    return this.view && this.viewT > 0 ? viewPoint(this.view, p, this.viewT) : p;
  }

  /** Trace a path's polyline (the parts in view) into `into`; false if none of it is. */
  private trace(
    path: ClientPath,
    into: Path2D | CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => [number, number],
    inView: (x: number, y: number) => boolean,
  ): boolean {
    let pen = false;
    let any = false;
    // The last point drawn, and the last point reached (drawn or not): zoomed
    // out a step is under a pixel, and a busy board has a hundred thousand of
    // them, so points closer than `TRACE_MIN_PX` to the last one drawn wait
    // until the line has gone far enough, or ends.
    let lx = 0, ly = 0, px = 0, py = 0;
    let owed = false;
    let prev: PathStepWire | null = null;
    const pts = this.stepScratch;
    let first: [number, number] | null = null;
    for (const st of path.steps) {
      this.stepPts(path, st, pts);
      let visible = false;
      for (let k = 0; k < pts.length; k += 2) if (inView(pts[k], pts[k + 1])) visible = true;
      if (!visible) {
        if (owed) into.lineTo(px, py);
        pen = owed = false;
        continue;
      }
      // Each step starts where the last one ended; only a break (or the
      // first step) needs its start.
      if (!pen || prev === null || prev.b.x !== st.a.x || prev.b.y !== st.a.y) {
        if (owed) into.lineTo(px, py);
        [lx, ly] = toScreen(pts[0], pts[1]);
        if (pen) into.lineTo(lx, ly);
        else into.moveTo(lx, ly);
        owed = false;
      }
      if (!first) first = toScreen(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) {
        [px, py] = toScreen(pts[k], pts[k + 1]);
        if (Math.abs(px - lx) + Math.abs(py - ly) >= TRACE_MIN_PX) {
          into.lineTo(px, py);
          lx = px;
          ly = py;
          owed = false;
        } else owed = true;
      }
      prev = st;
      pen = any = true;
    }
    if (owed) into.lineTo(px, py);
    // A loop joins back to its start; an edge-to-edge claim ends at the edge.
    if (path.status === 'closed' && pen && !path.region) {
      const [ax, ay] = first ?? toScreen(path.steps[0].a.x, path.steps[0].a.y);
      into.lineTo(ax, ay);
    }
    return any;
  }

  /**
   * Everything that holds still between board changes, into the lines
   * canvas: the arena's edge, your pattern, every line, the stuck crosses —
   * and where the heads are (`headSpots`), which pulse on top every frame.
   */
  private drawLines(
    ctx: CanvasRenderingContext2D,
    toScreen: (x: number, y: number) => [number, number],
    inView: (x: number, y: number) => boolean,
    box: Box,
    w: number,
    wMine: number,
    view: string,
  ): void {
    const store = this.store;
    const s = this.camera.scale * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.plain) {
      // Thousands of short segments: slow to stroke, so kept per camera.
      const W = ctx.canvas.width;
      const H = ctx.canvas.height;
      const o = (this.outline ??= this.layer(W, H));
      if (o.canvas.width !== W || o.canvas.height !== H) Object.assign(o, this.layer(W, H));
      if (o.view !== view) {
        o.view = view;
        o.ctx.setTransform(1, 0, 0, 1, 0, 0);
        o.ctx.clearRect(0, 0, W, H);
        o.ctx.lineCap = 'round';
        o.ctx.lineJoin = 'round';
        this.drawOutline(o.ctx, toScreen);
      }
      ctx.drawImage(o.canvas as CanvasImageSource, 0, 0);
    }
    this.drawPattern(ctx, toScreen, box);
    // Every line of one look goes into one Path2D and is stroked once: a
    // flip storm leaves thousands of pieces, and a stroke each (a style
    // change and a raster pass) added up. Team colours make that two or
    // three strokes for the whole board.
    type Batch = { line: Path2D; ink: string; mine: boolean; stuck: boolean };
    const batches = new Map<string, Batch>();
    const halo = new Path2D();
    let haloAny = false;
    const crosses = new Path2D();
    let crossAny = false;
    const crossR = Math.max(3, 0.18 * s);
    const heads = new Map<string, number[]>();
    for (const path of store.paths.values()) {
      const color = this.colorOf(path);
      if (!color || path.steps.length === 0) continue;
      const mine = path.owner === store.you;
      const ink = this.inkOf(path, color);
      const stuck = path.status === 'stuck';
      const key = `${mine ? 1 : 0}${stuck ? 1 : 0}${ink}`;
      let b = batches.get(key);
      if (!b) {
        b = { line: new Path2D(), ink, mine, stuck };
        batches.set(key, b);
      }
      if (!this.trace(path, b.line, toScreen, inView)) continue;
      if (mine) {
        this.trace(path, halo, toScreen, inView);
        haloAny = true;
      }
      const last = path.steps[path.steps.length - 1];
      const tip = this.stepEnd(path, last, 1);
      // Only a line someone is steering gets a head. A flip's pieces
      // (`spawned`) grow a few at a time, round robin; hundreds of pulsing
      // dots on them said nothing and cost a lot.
      if (path.status === 'growing' && !path.spawned) {
        // A line growing both ways has a head at its start too.
        const ends = path.back ? [tip, this.stepEnd(path, path.steps[0], 0)] : [tip];
        for (const h of ends) {
          if (!inView(h.x, h.y)) continue;
          let spots = heads.get(ink);
          if (!spots) heads.set(ink, (spots = []));
          spots.push(...toScreen(h.x, h.y));
        }
      }
      if (stuck && inView(tip.x, tip.y)) {
        const [hx, hy] = toScreen(tip.x, tip.y);
        crosses.moveTo(hx - crossR, hy - crossR);
        crosses.lineTo(hx + crossR, hy + crossR);
        crosses.moveTo(hx + crossR, hy - crossR);
        crosses.lineTo(hx - crossR, hy + crossR);
        crossAny = true;
      }
    }
    this.headSpots = heads;
    // Rivals' lines, then the halo under yours, then yours.
    const strokeBatches = (mine: boolean): void => {
      for (const b of batches.values()) {
        if (b.mine !== mine) continue;
        ctx.globalAlpha = b.stuck ? 0.6 : 1;
        ctx.strokeStyle = b.ink;
        ctx.lineWidth = mine ? wMine : w;
        ctx.stroke(b.line);
      }
      ctx.globalAlpha = 1;
    };
    strokeBatches(false);
    if (haloAny) {
      ctx.strokeStyle = this.board.haloCss;
      ctx.lineWidth = wMine + Math.max(2, 0.08 * s);
      ctx.stroke(halo);
    }
    strokeBatches(true);
    if (crossAny) {
      ctx.strokeStyle = this.board.badCss;
      ctx.lineWidth = Math.max(1.5, 0.06 * s);
      ctx.stroke(crosses);
    }
  }

  private drawOverlay(t: number): void {
    const ctx = this.ctx;
    const store = this.store;
    const s = this.camera.scale * this.dpr;
    const W = this.overlay.width;
    const H = this.overlay.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
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
    const w = Math.max(1.5, 0.14 * s);
    const wMine = w * 1.35;
    // The lines only change with the board or the camera, but stroking them
    // (and the plain board's long outline) was most of a busy frame; redrawn
    // at 60 fps they cost it every frame. They go to a canvas of their own
    // that is redrawn when something changed and otherwise just copied.
    // A board change redraws them no more often than `LINES_BUDGET` times
    // what the last redraw cost, so a busy board can't spend every frame on
    // them: cheap redraws still happen every frame, a 30 ms one about every
    // 90 ms. A camera move redraws at once — panning must not lag.
    const cam = this.camera;
    const view = `${cam.x}|${cam.y}|${cam.scale}|${W}x${H}|${this.looksEpoch}|${this.morphT}`;
    const board = `${store.geometryVersion}|${store.version}|${this.tintEpoch}`;
    const lines = (this.lines ??= this.layer(W, H));
    if (lines.canvas.width !== W || lines.canvas.height !== H) Object.assign(lines, this.layer(W, H));
    if (lines.view !== view || (lines.board !== board && t - lines.at >= LINES_BUDGET * lines.cost)) {
      const t0 = performance.now();
      lines.view = view;
      lines.board = board;
      lines.at = t;
      this.drawLines(lines.ctx, toScreen, inView, box, w, wMine, view);
      lines.cost = performance.now() - t0;
    }
    ctx.drawImage(lines.canvas as CanvasImageSource, 0, 0);
    // Heads pulse, so they are drawn every frame over the cached lines.
    const headR = Math.max(3, 0.22 * s) * (1 + 0.35 * Math.sin(t / 160));
    ctx.lineWidth = Math.max(1, 0.05 * s);
    ctx.strokeStyle = this.board.inkCss;
    for (const [ink, pts] of this.headSpots) {
      ctx.beginPath();
      for (let k = 0; k < pts.length; k += 2) {
        ctx.moveTo(pts[k] + headR, pts[k + 1]);
        ctx.arc(pts[k], pts[k + 1], headR, 0, Math.PI * 2);
      }
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.stroke();
    }
    /** A line cut in a collision, fading out on its way off the board (no head, no cross). */
    const drawDying = (path: ClientPath, mine: boolean, fade: number, color: string): void => {
      if (path.steps.length === 0) return;
      const lw = mine ? wMine : w;
      ctx.globalAlpha = fade;
      ctx.beginPath();
      if (!this.trace(path, ctx, toScreen, inView)) return void (ctx.globalAlpha = 1);
      if (mine) {
        ctx.strokeStyle = this.board.haloCss;
        ctx.lineWidth = lw + Math.max(2, 0.08 * s);
        ctx.stroke();
      }
      ctx.strokeStyle = this.inkOf(path, color);
      ctx.lineWidth = lw;
      ctx.globalAlpha = (path.status === 'stuck' ? 0.6 : 1) * fade;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const now = performance.now();
    if (store.dying.length > 0) {
      store.dying = store.dying.filter((d) => now - d.born < FADE_MS);
      for (const d of store.dying) {
        const k = 1 - (now - d.born) / FADE_MS;
        drawDying(d.path, d.mine, k * k, this.teams ? this.teamColor(d.mine) : d.color);
      }
    }
    if (store.bursts.length > 0) {
      store.bursts = store.bursts.filter((b) => now - b.born < SPARK_MS);
      for (const b of store.bursts) {
        const at = this.viewPt(b.at);
        if (inView(at.x, at.y)) this.drawBurst(b, at, now, toScreen);
      }
    }
    if (store.coalesce.length > 0) {
      store.coalesce = store.coalesce.filter((c) => now - c.born < Math.max(COALESCE_MS, c.ghost.length ? GHOST_MS : 0));
      for (const c of store.coalesce) this.drawCoalesce(c, now, toScreen, inView);
    }
    this.drawNames(toScreen);
    if (store.win) this.drawWin(store.win, now, box, toScreen);
  }

  /**
   * A won round. Over a veil, every tile shows the winner's pattern; then,
   * from the loose end of their longest line, the infinite line (hex `128`)
   * flips the board tile by tile — each flipped tile takes a colour that
   * walks the spectrum as it spreads, with the line drawn over it — faster
   * and faster, until it has everything. When the fresh board arrives it
   * all fades away over it. The tiles accumulate on a layer of their own:
   * a frame draws only the tiles that flipped since the last, and a camera
   * move redraws what is in view.
   */
  private drawWin(win: Win, now: number, box: Box, toScreen: (x: number, y: number) => [number, number]): void {
    const field = this.field;
    if (!field) return;
    const fade = win.restartAt === undefined ? 1 : 1 - (now - win.restartAt) / WIN_FADE_MS;
    if (fade <= 0) {
      this.store.win = null;
      this.celebration = null;
      return;
    }
    const W = this.overlay.width;
    const H = this.overlay.height;
    let c = this.celebration;
    if (!c || c.win !== win) {
      const fass = chordTableFor(field, fassRule(field.family));
      const plan = flipOrder(field, fass, win.tail);
      const hue = Number(/hsl\(\s*([\d.]+)/.exec(win.color)?.[1] ?? 0);
      c = this.celebration = { win, plan, winner: chordTableFor(field, win.rule), fass, hue, start: performance.now(), layer: this.layer(W, H), drawn: 0 };
    }
    const t = now - c.start;
    const shown = Math.min(1, Math.max(0, t / WIN_IN_MS)) * fade;
    const p = t < WIN_IN_MS ? -1 : prefersReducedMotion() ? 1 : Math.min(1, (t - WIN_IN_MS) / WIN_SPREAD_MS);
    const k = p < 0 ? 0 : flippedBy(c.plan.at, p);
    const L = c.layer;
    if (L.canvas.width !== W || L.canvas.height !== H) Object.assign(L, this.layer(W, H));
    const cam = this.camera;
    const view = `${cam.x}|${cam.y}|${cam.scale}|${W}x${H}|${this.morphT}|${this.looksEpoch}`;
    const s = cam.scale * this.dpr;
    const pad = 2;
    const inBox = (i: number): boolean => {
      const q = tileCenter(field, i);
      return q.x > box.minX - pad && q.x < box.maxX + pad && q.y > box.minY - pad && q.y < box.maxY + pad;
    };
    const lctx = L.ctx;
    const pts = this.stepScratch;
    const viewOn = this.view && this.viewT > 0 ? this.view : null;
    const chords = (into: Path2D, table: ChordTable, i: number): void => {
      const n = tileChords(field, table, i).length;
      for (let ch = 0; ch < n; ch++) {
        if (viewOn) {
          viewChord(viewOn, table, i, ch, this.viewT, pts);
          for (let m = 0; m < pts.length; m += 2) {
            const [x, y] = toScreen(pts[m], pts[m + 1]);
            if (m === 0) into.moveTo(x, y);
            else into.lineTo(x, y);
          }
          continue;
        }
        const [a, b] = worldChord(field, table, i, ch);
        const [ax, ay] = toScreen(a.x, a.y);
        const [bx, by] = toScreen(b.x, b.y);
        into.moveTo(ax, ay);
        into.lineTo(bx, by);
      }
    };
    const poly: Pt[] = [];
    const outline = (into: Path2D, i: number): void => {
      // Tiles a few pixels across: a square does, and costs far less.
      if (s < 3) {
        const q = toScreen(tileCenter(field, i).x, tileCenter(field, i).y);
        const r = Math.max(0.75, 1.05 * s);
        into.rect(q[0] - r, q[1] - r, 2 * r, 2 * r);
        return;
      }
      const shapes: Pt[][] = [];
      if (viewOn) for (let piece = viewOn.first[i]; piece < viewOn.first[i + 1]; piece++) shapes.push([...viewPolygon(viewOn, piece, this.viewT, poly)]);
      else shapes.push(tilePolygon(field, i));
      for (const shape of shapes) {
        shape.forEach((q, m) => {
          const [x, y] = toScreen(q.x, q.y);
          if (m === 0) into.moveTo(x, y);
          else into.lineTo(x, y);
        });
        into.closePath();
      }
    };
    const n = c.plan.order.length;
    /** Flipped tiles `tiles` (order indices), filled by where they come in the spread, the line over them. */
    const flip = (js: Iterable<number>): void => {
      const fills = new Map<number, Path2D>();
      const line = new Path2D();
      for (const j of js) {
        const i = c!.plan.order[j];
        const band = Math.floor((24 * j) / n);
        let f = fills.get(band);
        if (!f) fills.set(band, (f = new Path2D()));
        outline(f, i);
        if (s >= 1.5) chords(line, c!.fass, i);
      }
      for (const [band, f] of fills) {
        lctx.fillStyle = `hsl(${(c!.hue + (300 * band) / 24) % 360}, 85%, 58%)`;
        lctx.fill(f);
      }
      lctx.strokeStyle = this.board.inkCss;
      lctx.lineWidth = Math.max(1, 0.16 * s);
      lctx.lineCap = 'round';
      lctx.stroke(line);
    };
    if (L.view !== view) {
      L.view = view;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, W, H);
      const visible = tilesInBox(field, box, this.visible);
      const theirs = new Path2D();
      const flipped: number[] = [];
      for (const i of visible) {
        const j = c.plan.rank[i];
        if (j < k) flipped.push(j);
        else if (s >= 1.5) chords(theirs, c.winner, i);
      }
      lctx.strokeStyle = strandColor(this.board, this.teams ? this.teamColor(win.id === this.store.you) : win.color);
      lctx.lineWidth = Math.max(1, 0.12 * s);
      lctx.lineCap = 'round';
      lctx.stroke(theirs);
      flip(flipped);
    } else if (k > c.drawn) {
      const fresh: number[] = [];
      for (let j = c.drawn; j < k; j++) if (inBox(c.plan.order[j])) fresh.push(j);
      flip(fresh);
    }
    c.drawn = k;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = WIN_VEIL * shown;
    ctx.fillStyle = this.board.bgCss;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = shown;
    ctx.drawImage(L.canvas as CanvasImageSource, 0, 0);
    ctx.globalAlpha = 1;
  }

  /**
   * A rule change: a faint mote on every tile the old lines held drifts to
   * the nearest tile the new lines start on and melts into it, so the old
   * territory's energy visibly gathers into what carries on. A mote with
   * nowhere to go fades where it is. One fill per switch, only while it plays.
   */
  private drawCoalesce(c: Coalesce, now: number, toScreen: (x: number, y: number) => [number, number], inView: (x: number, y: number) => boolean): void {
    const ctx = this.ctx;
    if (c.ghost.length > 0) this.drawGhost(c, now);
    const u = Math.min(1, (now - c.born) / COALESCE_MS);
    const move = Math.min(1, u / 0.75);
    const e = move < 0.5 ? 4 * move * move * move : 1 - (-2 * move + 2) ** 3 / 2; // ease in-out
    const fade = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
    const r = Math.max(1.5 * this.dpr, 0.2 * this.camera.scale * this.dpr);
    const ink = strandColor(this.board, this.teams ? this.teamColor(c.mine) : c.color);
    const glow = new Path2D();
    const core = new Path2D();
    // The motes sit on tile centres; the Spectre view moves them with their tiles.
    let motes: { from: readonly Pt[]; to: readonly (Pt | null)[] } = c;
    if (this.view && this.viewT > 0) {
      let m = this.viewMotes.get(c);
      if (!m || m.t !== this.viewT) {
        m = { t: this.viewT, from: c.from.map((p) => this.viewPt(p)), to: c.to.map((p) => (p ? this.viewPt(p) : null)) };
        this.viewMotes.set(c, m);
      }
      motes = m;
    }
    for (let k = 0; k < motes.from.length; k++) {
      const a = motes.from[k];
      const b = motes.to[k] ?? a;
      const x = a.x + (b.x - a.x) * e;
      const y = a.y + (b.y - a.y) * e;
      if (!inView(x, y)) continue;
      const [sx, sy] = toScreen(x, y);
      glow.moveTo(sx + r * 2, sy);
      glow.arc(sx, sy, r * 2, 0, Math.PI * 2);
      core.moveTo(sx + r, sy);
      core.arc(sx, sy, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.12 * fade;
    ctx.fill(glow);
    ctx.globalAlpha = 0.4 * fade;
    ctx.fill(core);
    ctx.globalAlpha = 1;
  }

  /**
   * The end state a rule change bought — every circuit and line the new rule
   * will regrow into, whole — as one soft pulse: it swells while the motes
   * gather and fades as the real lines take over. Its paths are built once
   * per switch in board units and only transformed each frame.
   */
  private drawGhost(c: Coalesce, now: number): void {
    const v = (now - c.born - GHOST_FROM_MS) / (GHOST_MS - GHOST_FROM_MS);
    if (v <= 0 || v >= 1) return;
    const pulse = Math.sin(Math.PI * v) ** 2;
    let g = this.ghostPaths.get(c);
    const t = this.morphT;
    if (!g || g.t !== t) {
      const line = new Path2D();
      const fill = new Path2D();
      const table = t > 0 ? this.store.players.get(c.owner)?.patterns[0]?.rule : undefined;
      const chords: ChordTable | undefined = table && this.field ? chordTableFor(this.field, table) : undefined;
      const scratch = this.stepScratch;
      for (const q of c.ghost) {
        const loop = q.kind === 1;
        let pts: readonly Pt[] = loop ? q.pts.slice(0, -1) : q.pts;
        if (chords && this.view) {
          // In the Spectre view the circuit runs through the pieces' dots.
          const drawn: Pt[] = [];
          q.steps.forEach((st, i) => {
            viewStep(this.view!, chords, st, t, scratch);
            // Each step ends where the next starts; a line keeps its last end.
            const upto = !loop && i === q.steps.length - 1 ? scratch.length : scratch.length - 2;
            for (let k = 0; k < upto; k += 2) drawn.push({ x: scratch[k], y: scratch[k + 1] });
          });
          pts = drawn;
        }
        pts.forEach((p, k) => (k ? line.lineTo(p.x, p.y) : line.moveTo(p.x, p.y)));
        if (loop) {
          line.closePath();
          pts.forEach((p, k) => (k ? fill.lineTo(p.x, p.y) : fill.moveTo(p.x, p.y)));
          fill.closePath();
        }
      }
      this.ghostPaths.set(c, (g = { t, line, fill }));
    }
    const ctx = this.ctx;
    const k = this.camera.scale * this.dpr;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, (this.width / 2 - this.camera.x * this.camera.scale) * this.dpr, (this.height / 2 - this.camera.y * this.camera.scale) * this.dpr);
    const ink = strandColor(this.board, this.teams ? this.teamColor(c.mine) : c.color);
    const w = Math.max(2.5 * this.dpr, 0.16 * k) / k;
    ctx.globalAlpha = 0.12 * pulse;
    ctx.fillStyle = ink;
    ctx.fill(g.fill);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.5 * pulse;
    ctx.strokeStyle = this.board.haloCss;
    ctx.lineWidth = w * 2.2;
    ctx.stroke(g.line);
    ctx.globalAlpha = 0.75 * pulse;
    ctx.strokeStyle = ink;
    ctx.lineWidth = w;
    ctx.stroke(g.line);
    ctx.restore();
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
      const m = this.stepMid(path, path.steps[i]);
      return toScreen(m.x, m.y);
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
    const now = performance.now();
    const search = pending.filter((player) => {
      this.labelAnchors.delete(player.id);
      return (this.labelRetry.get(player.id) ?? 0) <= now;
    });
    if (search.length > 0) {
      const byOwner = new Map<string, ClientPath[]>();
      for (const path of store.paths.values()) {
        const list = byOwner.get(path.owner);
        if (list) list.push(path);
        else byOwner.set(path.owner, [path]);
      }
      for (const player of search) {
        const paths = byOwner.get(player.id);
        if (!paths) {
          this.labelRetry.set(player.id, now + LABEL_RETRY_MS);
          continue;
        }
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
        if (!best) {
          this.labelRetry.set(player.id, now + LABEL_RETRY_MS);
          continue;
        }
        this.labelRetry.delete(player.id);
        this.labelAnchors.set(player.id, best.anchor);
        placed.push(best.rect);
        labels.push({ player, rect: best.rect, x: best.x, y: best.y });
      }
    }
    for (const id of this.labelAnchors.keys()) if (!store.players.has(id)) this.labelAnchors.delete(id);
    for (const id of this.labelRetry.keys()) if (!store.players.has(id)) this.labelRetry.delete(id);
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
  private drawBurst(b: Burst, at: Pt, now: number, toScreen: (x: number, y: number) => [number, number]): void {
    const ctx = this.ctx;
    const u = (now - b.born) / SPARK_MS;
    const [cx, cy] = toScreen(at.x, at.y);
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
