/**
 * The arena screen: the canvas, pointer handling (tap to start a line, drag to
 * pan, press-and-hold then drag to paint lines across the tiles you pass over,
 * wheel/pinch to zoom) and the HUD.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { tileAt } from '../../shared/game/field';
import { stepIntervalMs } from '../../shared/game/knobs';
import { describeRule } from '../../shared/game/rule';
import type { GameConnection } from './net';
import { Renderer } from './render';
import type { Store } from './store';
import { helpSeen, markHelpSeen } from './session';
import { boardTheme, useTheme } from './theme';
import { strandColor } from './tiles-layer';
import { SettingsButton } from './SettingsButton';
import { getSettings, updateSettings, useSettings } from './settings';
import { useStore } from './useStore';

export interface ArenaProps {
  readonly store: Store;
  readonly conn: GameConnection;
  onNewRule(): void;
}

interface PointerState {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** How far (px) it may wander and still be a tap or a hold — fingers jitter more. */
  slop: number;
}

/**
 * What the pointers are doing: `press` until a lone pointer moves (then it
 * pans), lifts (a tap) or holds still for `HOLD_MS` (then it paints); `pan`
 * also for two fingers or a right/middle/shift mouse drag, for the rest of
 * the gesture.
 */
interface Gesture {
  mode: 'idle' | 'press' | 'paint' | 'pan';
  /** The tile the pointer last entered while painting. */
  lastTile: number;
  /** The tile to tap next, once a head is free. */
  target: { tile: number; x: number; y: number } | null;
  /** performance.now() of the last paint tap. */
  lastSent: number;
  timer: number;
  /** The pending press-and-hold that turns a press into painting. */
  hold: number;
}

/** Paint taps at most this often — the server drops taps under 100 ms apart. */
const PAINT_TAP_MS = 120;
/** Hold a press this long without moving to paint instead of pan. */
const HOLD_MS = 300;

export function Arena({ store, conn, onNewRule }: ArenaProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const pointers = useRef(new Map<number, PointerState>());
  const pinchDist = useRef(0);
  const gesture = useRef<Gesture>({ mode: 'idle', lastTile: -1, target: null, lastSent: 0, timer: 0, hold: 0 });
  const [showHelp, setShowHelp] = useState(() => !helpSeen());
  const hideHelp = (): void => {
    setShowHelp(false);
    markHelpSeen();
  };
  const [theme] = useTheme();
  // `theme` is the dep, not the source: the palette follows what is on <html>.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scheme = useMemo(() => boardTheme(), [theme]);
  const [settings] = useSettings();
  useStore(store);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const r = new Renderer(tileCanvasRef.current!, canvas, store);
    rendererRef.current = r;
    r.resize();
    if (store.field) {
      r.setField(store.field);
      r.fitToField();
    }
    r.start();
    const onResize = (): void => r.resize();
    window.addEventListener('resize', onResize);
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      r.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    const prune = setInterval(() => store.pruneToasts(), 1000);
    return () => {
      r.stop();
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('wheel', wheel);
      clearInterval(prune);
    };
  }, [store]);

  useEffect(() => {
    if (store.field && rendererRef.current) rendererRef.current.setField(store.field);
  }, [store.field]);

  // The board is canvas, not CSS: hand the renderer the new scheme itself.
  useEffect(() => {
    rendererRef.current?.setTheme(scheme);
  }, [scheme]);

  // Settings apply live, behind the open modal.
  useEffect(() => {
    rendererRef.current?.setSettings(settings);
  }, [settings]);

  // 1–9 pick a pattern, like clicking its tab; T toggles team colours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 't' || e.key === 'T') {
        updateSettings({ teams: !getSettings().teams });
        return;
      }
      const n = Number(e.key);
      const me = store.me;
      if (!me || !Number.isInteger(n) || n < 1 || n > me.patterns.length) return;
      if (n - 1 !== me.active) conn.send({ t: 'pattern', index: n - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, conn]);

  const tap = (sx: number, sy: number): void => {
    const r = rendererRef.current;
    if (!r || !store.field) return;
    const w = r.screenToWorld(sx, sy);
    const tile = tileAt(store.field, w);
    if (tile < 0) {
      store.toast('Nothing there', 'bad');
      return;
    }
    conn.send({ t: 'tap', tile, x: w.x, y: w.y });
    if (showHelp) hideHelp();
  };

  // Hold, then drag to paint: each tile the pointer enters becomes the target,
  // and it is tapped as soon as you have a head free (and the server's tap
  // throttle allows) — so a drag across a claimed area keeps starting lines.
  const paintTarget = (sx: number, sy: number): void => {
    const g = gesture.current;
    const r = rendererRef.current;
    if (!r || !store.field) return;
    const w = r.screenToWorld(sx, sy);
    const tile = tileAt(store.field, w);
    if (tile < 0 || tile === g.lastTile) return;
    g.lastTile = tile;
    g.target = { tile, x: w.x, y: w.y };
  };
  const paintFlush = (): void => {
    const g = gesture.current;
    const now = performance.now();
    if (!g.target || now - g.lastSent < PAINT_TAP_MS || !store.hasFreeHead()) return;
    g.lastSent = now;
    store.quietRefusalsUntil = Date.now() + 1500;
    conn.send({ t: 'tap', ...g.target });
    g.target = null;
    if (showHelp) hideHelp();
  };
  /** The cursor follows the gesture: arrow, grabbing hand, arrow-with-plus. */
  const showMode = (mode: Gesture['mode']): void => {
    if (canvasRef.current) canvasRef.current.dataset.mode = mode;
  };
  /** The hold came due: the tile under the pointer is the first target. */
  const paintStart = (sx: number, sy: number, touch: boolean): void => {
    const g = gesture.current;
    g.mode = 'paint';
    g.hold = 0;
    showMode('paint');
    if (touch) navigator.vibrate?.(15);
    paintTarget(sx, sy);
    paintFlush();
    g.timer = window.setInterval(paintFlush, PAINT_TAP_MS / 2);
  };
  /** Every tile under the segment, in order, so a quick flick skips none. */
  const paintSegment = (x0: number, y0: number, x1: number, y1: number): void => {
    const n = Math.min(64, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let i = 1; i <= n; i++) paintTarget(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
  };
  const endGesture = (): void => {
    const g = gesture.current;
    if (g.timer) window.clearInterval(g.timer);
    if (g.hold) window.clearTimeout(g.hold);
    showMode('idle');
    gesture.current = { mode: 'idle', lastTile: -1, target: null, lastSent: g.lastSent, timer: 0, hold: 0 };
  };
  useEffect(() => endGesture, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const touch = e.pointerType === 'touch';
    const p: PointerState = { id: e.pointerId, x, y, startX: x, startY: y, moved: false, slop: touch ? 10 : 5 };
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      // A drag pans; press and hold still to paint instead. Right, middle or
      // shift-drag always pans with a mouse.
      const pan = e.pointerType === 'mouse' && (e.button !== 0 || e.shiftKey);
      g.mode = pan ? 'pan' : 'press';
      showMode(g.mode);
      if (!pan) {
        g.hold = window.setTimeout(() => {
          if (gesture.current.mode === 'press' && !p.moved) paintStart(p.x, p.y, touch);
        }, HOLD_MS);
      }
    } else {
      if (g.timer) window.clearInterval(g.timer);
      if (g.hold) window.clearTimeout(g.hold);
      g.timer = 0;
      g.hold = 0;
      g.target = null;
      g.mode = 'pan';
      showMode('pan');
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const p = pointers.current.get(e.pointerId);
    const r = rendererRef.current;
    if (!p || !r) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - p.x;
    const dy = y - p.y;
    if (Math.hypot(x - p.startX, y - p.startY) > p.slop) p.moved = true;
    const g = gesture.current;
    if (pointers.current.size === 1) {
      if (g.mode === 'pan') r.panBy(dx, dy);
      else if (g.mode === 'paint') {
        paintSegment(p.x, p.y, x, y);
        paintFlush();
      } else if (g.mode === 'press' && p.moved) {
        // Moved before the hold came due: it's a pan, from where it started.
        window.clearTimeout(g.hold);
        g.hold = 0;
        g.mode = 'pan';
        showMode('pan');
        r.panBy(x - p.startX, y - p.startY);
      }
    } else if (pointers.current.size === 2) {
      p.x = x;
      p.y = y;
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist.current > 0) r.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist.current);
      pinchDist.current = d;
      r.panBy(dx / 2, dy / 2);
      return;
    }
    p.x = x;
    p.y = y;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    const press = gesture.current.mode === 'press';
    if (p && press && !p.moved && pointers.current.size === 0 && e.type === 'pointerup') tap(p.x, p.y);
    if (pointers.current.size === 0) endGesture();
    pinchDist.current = 0;
  };

  const me = store.me;
  const board = [...store.players.values()].sort((a, b) => b.score - a.score);
  const rank = me ? board.findIndex((p) => p.id === me.id) + 1 : 0;
  const mine = store.myPaths();
  const growing = mine.filter((p) => p.status === 'growing');
  const stuck = mine.filter((p) => p.status === 'stuck').length;
  const closed = mine.filter((p) => p.status === 'closed').length;
  const tiles = mine.reduce((n, p) => n + p.steps.length, 0);
  const parts: string[] = [];
  if (growing.length) parts.push(`${growing.length} growing`);
  if (stuck) parts.push(`${stuck} stuck`);
  if (closed) parts.push(`${closed} circuit${closed > 1 ? 's' : ''}`);
  const status = parts.length ? `${parts.join(' · ')} · ${tiles} tiles` : '';
  const top = board.slice(0, 8);
  const meRow = me && rank > top.length ? board[rank - 1] : null;
  const active = me ? (me.patterns[me.active] ?? me.patterns[0]) : undefined;
  const heads = store.heads();
  // A player's swatch colour: theirs, or their team's (you blue, the rest red).
  const swatch = (color: string, mine: boolean): string =>
    strandColor(scheme, settings.teams ? (mine ? scheme.teamMe : scheme.teamRival) : color);
  const speed = me && store.knobs && store.field ? (1000 / stepIntervalMs(store.knobs, me.score, store.field.count)).toFixed(1) : '–';

  return (
    <div className="arena">
      <canvas ref={tileCanvasRef} className="arena-canvas arena-tiles" aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="arena-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="hud hud-me" style={{ ['--me' as string]: me ? swatch(me.color, true) : 'var(--text)' }}>
        <div className="hud-name">
          <span className="swatch" /> {me?.name ?? '…'}
        </div>
        <div className="hud-score-row">
          <div className="hud-score">{me?.score ?? 0}</div>
          <span className="hud-heads" title="Heads free / total — lines you can start now">
            {heads.total === 0 ? '∞' : `${heads.free}/${heads.total}`} {heads.total === 1 ? 'head' : 'heads'}
          </span>
        </div>
        <div className="hud-line">
          combo ×{(me?.combo ?? 1).toFixed(1)} · {speed} tiles/s · #{rank || '–'}
        </div>
        {status && <div className="hud-line hud-status">{status}</div>}
        <div className="hud-line hud-rule">
          <code>{active ? describeRule(active.rule) : ''}</code>
          {active?.from !== undefined && <> · {active.fromName}'s</>}
        </div>
        <div className="hud-actions">
          <button type="button" className="btn btn-accent" onClick={onNewRule}>
            New rule
          </button>
          <SettingsButton />
        </div>
      </div>

      <div className="hud hud-board">
        <div className="hud-title">Leaderboard · {store.players.size} playing</div>
        <ol>
          {top.map((p, i) => (
            <BoardRow key={p.id} rank={i + 1} name={p.name} score={p.score} color={swatch(p.color, p.id === store.you)} me={p.id === store.you} />
          ))}
          {meRow && (
            <>
              <li className="board-gap">⋯</li>
              <BoardRow rank={rank} name={meRow.name} score={meRow.score} color={swatch(meRow.color, true)} me />
            </>
          )}
        </ol>
      </div>

      {me && me.patterns.length > 1 && (
        <div className="pattern-tabs" role="tablist" aria-label="Patterns">
          {me.patterns.map((q, i) => {
            const label = q.from === undefined ? 'Your pattern' : `${q.fromName || 'Someone'}'s pattern`;
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === me.active}
                aria-label={label}
                title={`${label} (${i + 1})`}
                className={`pattern-tab${i === me.active ? ' is-active' : ''}`}
                style={{ background: swatch(q.color, true) }}
                onClick={() => i !== me.active && conn.send({ t: 'pattern', index: i })}
              />
            );
          })}
        </div>
      )}

      {showHelp && (
        <div className="hud hud-help">
          <b>Tap a tile</b> to start a line along your rule. It grows on its own, faster as you score.
          Close a loop for a combo bonus. Cross someone's line to cut it — they can cut yours.
          Loop round someone's line to take its pattern.
          <div className="muted">
            Drag to pan · hold, then drag across tiles to keep starting lines · wheel or pinch to zoom · T: you blue, rivals red
          </div>
          <button type="button" className="btn" onClick={hideHelp}>
            Got it
          </button>
        </div>
      )}

      <div className="toasts">
        {store.toasts.map((t) => (
          <div key={t.id} className={`toast is-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>

      {!store.connected && <div className="overlay">Reconnecting…</div>}
    </div>
  );
}

function BoardRow({ rank, name, score, color, me }: { rank: number; name: string; score: number; color: string; me: boolean }): JSX.Element {
  return (
    <li className={me ? 'is-me' : ''}>
      <span className="board-rank">{rank}</span>
      <span className="swatch" style={{ background: color }} />
      <span className="board-name">{name}</span>
      <span className="board-score">{score}</span>
    </li>
  );
}
