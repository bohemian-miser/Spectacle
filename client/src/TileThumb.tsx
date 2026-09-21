/**
 * One tile under a rule, as SVG: the outline, a dot on every selected seam's
 * connection point (coloured by class), and the chords the chosen matching
 * draws. A tile with an odd number of points draws no chords and shows its
 * dangling stubs instead — the "tail" that will end a line.
 */

import { useMemo } from 'react';
import {
  EDGE_CLASS_COLORS,
  centroid,
  connectionPoints,
  enumerateMatchings,
  leafPts,
  straightOutline,
  type TileFamilyId,
  type TileTypeId,
} from '../../shared/tiles';

export interface TileThumbProps {
  readonly family: TileFamilyId;
  readonly type: TileTypeId;
  readonly subset: readonly number[];
  readonly matching: number;
  readonly size?: number;
  readonly color?: string;
  readonly onClick?: () => void;
  readonly title?: string;
}

export function TileThumb({ family, type, subset, matching, size = 96, color = '#ffffff', onClick, title }: TileThumbProps): JSX.Element {
  const pts = leafPts(family, type);
  const view = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = 0.35;
    const w = maxX - minX + 2 * pad;
    const h = maxY - minY + 2 * pad;
    const s = Math.max(w, h);
    return `${minX - pad - (s - w) / 2} ${minY - pad - (s - h) / 2} ${s} ${s}`;
  }, [pts]);
  const selected = useMemo(() => new Set(subset), [subset]);
  const cps = connectionPoints(family, type, selected);
  const even = cps.length >= 2 && cps.length % 2 === 0;
  const chords = even ? enumerateMatchings(cps.length)[matching] ?? [] : [];
  const c = centroid(pts);

  return (
    <svg
      className={`thumb${onClick ? ' is-clickable' : ''}${!even && cps.length > 0 ? ' is-odd' : ''}`}
      viewBox={view}
      width={size}
      height={size}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={title}
    >
      <title>{title ?? type}</title>
      <path d={straightOutline(pts)} className="thumb-outline" />
      {chords.map(([a, b], i) => (
        <line key={i} x1={cps[a].pt.x} y1={cps[a].pt.y} x2={cps[b].pt.x} y2={cps[b].pt.y} stroke={color} strokeWidth={0.16} strokeLinecap="round" />
      ))}
      {!even &&
        cps.map((cp, i) => (
          <line key={`t${i}`} x1={cp.pt.x} y1={cp.pt.y} x2={cp.pt.x + (c.x - cp.pt.x) * 0.35} y2={cp.pt.y + (c.y - cp.pt.y) * 0.35} stroke="#ff5c7a" strokeWidth={0.12} strokeDasharray="0.15 0.12" />
        ))}
      {cps.map((cp, i) => (
        <circle key={`d${i}`} cx={cp.pt.x} cy={cp.pt.y} r={0.14} fill={EDGE_CLASS_COLORS[cp.edge.major]} stroke="#0b0d12" strokeWidth={0.04} />
      ))}
    </svg>
  );
}
