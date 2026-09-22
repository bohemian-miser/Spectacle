/**
 * The arena screen: the canvas, pointer handling (drag to pan, wheel/pinch to
 * zoom, tap to start a line) and the HUD.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { tileAt } from '../../shared/game/field';
import { stepIntervalMs } from '../../shared/game/knobs';
import { describeRule } from '../../shared/game/rule';
import type { GameConnection } from './net';
import { Renderer } from './render';
import type { Store } from './store';
import { boardTheme, useTheme } from './theme';
import { strandColor } from './tiles-layer';
import { ThemeToggle } from './ThemeToggle';
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
}

export function Arena({ store, conn, onNewRule }: ArenaProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const pointers = useRef(new Map<number, PointerState>());
  const pinchDist = useRef(0);
  const [showHelp, setShowHelp] = useState(true);
  const [theme] = useTheme();
  // `theme` is the dep, not the source: the palette follows what is on <html>.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scheme = useMemo(() => boardTheme(), [theme]);
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
    setShowHelp(false);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    pointers.current.set(e.pointerId, { id: e.pointerId, x, y, startX: x, startY: y, moved: false });
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
    if (Math.hypot(x - p.startX, y - p.startY) > 5) p.moved = true;
    if (pointers.current.size === 1) {
      r.panBy(dx, dy);
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
    if (p && !p.moved && pointers.current.size === 0) tap(p.x, p.y);
    pinchDist.current = 0;
  };

  const findMe = (): void => {
    const r = rendererRef.current;
    const mine = store.myPaths();
    const live = [...mine].reverse().find((p) => p.status === 'growing') ?? mine[mine.length - 1];
    if (!r || !live) {
      store.toast('You have no line yet — tap a tile', 'info');
      return;
    }
    const head = live.steps[live.steps.length - 1].b;
    r.centerOn(head.x, head.y);
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
  const status = parts.length ? `${parts.join(' · ')} · ${tiles} tiles · tap to add a line` : 'tap a tile to start a line';
  const speed = me && store.knobs ? (1000 / stepIntervalMs(store.knobs, me.score)).toFixed(1) : '–';

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
      />

      <div className="hud hud-me" style={{ ['--me' as string]: me ? strandColor(scheme, me.color) : 'var(--text)' }}>
        <div className="hud-name">
          <span className="swatch" /> {me?.name ?? '…'}
        </div>
        <div className="hud-score">{me?.score ?? 0}</div>
        <div className="hud-line">
          combo ×{(me?.combo ?? 1).toFixed(1)} · {speed} tiles/s · #{rank || '–'}
        </div>
        <div className="hud-line hud-status">{status}</div>
        <div className="hud-line hud-rule">
          <code>{me ? describeRule(me.rule) : ''}</code>
        </div>
        <div className="hud-actions">
          <button type="button" className="btn" onClick={findMe}>
            Find my line
          </button>
          <button type="button" className="btn" onClick={() => rendererRef.current?.fitToField()}>
            Whole arena
          </button>
          <button type="button" className="btn btn-accent" onClick={onNewRule}>
            New rule
          </button>
          <ThemeToggle />
        </div>
      </div>

      <div className="hud hud-board">
        <div className="hud-title">Arena · {store.players.size} playing</div>
        <ol>
          {board.slice(0, 10).map((p) => (
            <li key={p.id} className={p.id === store.you ? 'is-me' : ''}>
              <span className="swatch" style={{ background: strandColor(scheme, p.color) }} />
              <span className="board-name">{p.name}</span>
              <span className="board-score">{p.score}</span>
            </li>
          ))}
        </ol>
      </div>

      {showHelp && (
        <div className="hud hud-help">
          <b>Tap a tile</b> to start a line along your rule. It grows on its own, faster as you score.
          Close a loop for a combo bonus. Cross someone's line to cut it — they can cut yours.
          <div className="muted">Drag to pan · wheel or pinch to zoom</div>
          <button type="button" className="btn" onClick={() => setShowHelp(false)}>
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
