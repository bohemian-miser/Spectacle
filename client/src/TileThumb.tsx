/**
 * One tile under a rule, as an interactive SVG:
 *  - every physical edge wears its class number (faint until the class is
 *    on); click a number, or the edge, to toggle that class;
 *  - a dot sits on every selected seam's connection point; drag from one
 *    dot to another to pair them with a line, click a dot to unpair it;
 *  - a tile with an odd number of dots can't pair up and shows its stubs.
 */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Pair } from '../../shared/game/pairs';
import { boardTheme, useTheme } from './theme';
import { cssRgb, directionArrow, typeFill } from './tiles-layer';
import {
  EDGE_CLASS_COLORS,
  centroid,
  connectionPoints,
  edgeLabels,
  leafPts,
  parseEdgeLabel,
  straightOutline,
  type Pt,
  type TileFamilyId,
  type TileTypeId,
} from '../../shared/tiles';

export interface TileThumbProps {
  readonly family: TileFamilyId;
  readonly type: TileTypeId;
  readonly subset: readonly number[];
  /** Pairs of connection-point indices to draw (may be incomplete). */
  readonly pairs: readonly Pair[];
  readonly size?: number;
  readonly color?: string;
  readonly showNumbers?: boolean;
  readonly title?: string;
  onToggleClass?(major: number): void;
  onPair?(a: number, b: number): void;
  onUnpair?(a: number): void;
}

const DOT_R = 0.16;
const HIT_R = 0.34;

export function TileThumb(props: TileThumbProps): JSX.Element {
  const { family, type, subset, pairs, size = 110, color = 'currentColor', showNumbers = true, title, onToggleClass, onPair, onUnpair } = props;
  // The thumb wears the board's own fill for this tile type, so subscribing to
  // the theme is what repaints it.
  useTheme();
  const fill = cssRgb(typeFill(type, boardTheme().tileDim));
  const pts = leafPts(family, type);
  const labels = edgeLabels(family, type);
  const c = centroid(pts);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);

  const view = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = showNumbers ? 0.75 : 0.35;
    const w = maxX - minX + 2 * pad;
    const h = maxY - minY + 2 * pad;
    const s = Math.max(w, h);
    return `${minX - pad - (s - w) / 2} ${minY - pad - (s - h) / 2} ${s} ${s}`;
  }, [pts, showNumbers]);

  const selected = useMemo(() => new Set(subset), [subset]);
  const cps = connectionPoints(family, type, selected);
  const n = cps.length;
  const even = n >= 2 && n % 2 === 0;
  const paired = new Set<number>();
  for (const [a, b] of pairs) paired.add(a).add(b);

  const toSvg = (e: ReactPointerEvent): Pt => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  const dotAt = (p: Pt): number => {
    let best = -1;
    let bestD = HIT_R * HIT_R;
    cps.forEach((cp, i) => {
      const d = (cp.pt.x - p.x) ** 2 + (cp.pt.y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!even || !onPair) return;
    const p = toSvg(e);
    const i = dotAt(p);
    if (i < 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: i, x: p.x, y: p.y });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const p = toSvg(e);
    setDrag({ ...drag, x: p.x, y: p.y });
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const to = dotAt(toSvg(e));
    setDrag(null);
    if (to < 0) return;
    if (to === drag.from) onUnpair?.(to);
    else onPair?.(drag.from, to);
  };

  return (
    <svg
      ref={svgRef}
      className={`thumb${even && onPair ? ' is-drawable' : ''}${!even && n > 0 ? ' is-odd' : ''}`}
      viewBox={view}
      width={size}
      height={size}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
      aria-label={title}
      data-type={type}
      data-pairs={JSON.stringify(pairs)}
    >
      <title>{title ?? type}</title>
      <path d={straightOutline(pts)} className="thumb-outline" fill={fill} />
      {/* The same arrow the board draws on a hexagon: it points at edge 0, so
          the numbers below can be read off a tile out there. */}
      {family === 'hex' && <path d={straightOutline(directionArrow(pts))} className="thumb-arrow" />}

      {/* Edges: clickable, with their class number outside. */}
      {labels.map((raw, i) => {
        const { major } = parseEdgeLabel(raw);
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = mx - c.x;
        const dy = my - c.y;
        const len = Math.hypot(dx, dy) || 1;
        const on = selected.has(major);
        const col = EDGE_CLASS_COLORS[major];
        return (
          <g
            key={i}
            className={`thumb-edge${on ? ' is-on' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleClass?.(major);
            }}
          >
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={col} strokeWidth={on ? 0.12 : 0.06} strokeOpacity={on ? 0.9 : 0.35} strokeLinecap="round" />
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={0.4} />
            {showNumbers && (
              <text x={mx + (dx / len) * 0.42} y={my + (dy / len) * 0.42} fontSize={0.36} fill={col} fillOpacity={on ? 1 : 0.5} textAnchor="middle" dominantBaseline="central" fontWeight={700}>
                {major}
              </text>
            )}
          </g>
        );
      })}

      {/* Chords drawn so far. */}
      {pairs.map(([a, b], i) =>
        cps[a] && cps[b] ? (
          <line key={`c${i}`} x1={cps[a].pt.x} y1={cps[a].pt.y} x2={cps[b].pt.x} y2={cps[b].pt.y} stroke={color} strokeWidth={0.16} strokeLinecap="round" />
        ) : null,
      )}
      {drag && cps[drag.from] && (
        <line x1={cps[drag.from].pt.x} y1={cps[drag.from].pt.y} x2={drag.x} y2={drag.y} stroke={color} strokeWidth={0.14} strokeDasharray="0.12 0.1" strokeLinecap="round" />
      )}

      {/* Odd tiles: stubs that never meet. */}
      {!even &&
        cps.map((cp, i) => (
          <line key={`t${i}`} className="thumb-stub" x1={cp.pt.x} y1={cp.pt.y} x2={cp.pt.x + (c.x - cp.pt.x) * 0.35} y2={cp.pt.y + (c.y - cp.pt.y) * 0.35} strokeWidth={0.12} strokeDasharray="0.15 0.12" />
        ))}

      {/* Dots (drawn last so they sit on top; hollow when unpaired). */}
      {cps.map((cp, i) => {
        const isPaired = paired.has(i);
        return (
          <g key={`d${i}`} className="thumb-dot">
            <circle cx={cp.pt.x} cy={cp.pt.y} r={HIT_R} fill="transparent" />
            <circle
              cx={cp.pt.x}
              cy={cp.pt.y}
              r={DOT_R}
              className={isPaired || !even ? undefined : 'is-hollow'}
              fill={EDGE_CLASS_COLORS[cp.edge.major]}
              stroke={EDGE_CLASS_COLORS[cp.edge.major]}
              strokeWidth={0.06}
            />
          </g>
        );
      })}
    </svg>
  );
}
