/**
 * A small level-3 patch under the current rule, welded and traced with the
 * Spectre core's `analyze`: circuits coloured by length, tails in red. What
 * the rule will actually do on the floor, before you commit to it.
 *
 * It is a picture, not a control: zoomed in on the middle of the patch until
 * ~90% of the frame is tiles (the ragged rim is cropped away), with the
 * hexagons' rotation arrows and, on request, every edge's class number.
 */

import { useMemo, useState } from 'react';
import { pointInPolygon } from '../../shared/game/field';
import { ruleKey, type PlayerRule } from '../../shared/game/rule';
import { boardTheme, useTheme } from './theme';
import { seamLabelAt, signedArea } from './TileThumb';
import { cssRgb, directionArrow, typeFill } from './tiles-layer';
import {
  EDGE_CLASS_COLORS,
  analyze,
  buildSystem,
  circuitLengthRgb,
  flatten,
  leafOrder,
  leafPts,
  levelMirror,
  metaEdges,
  pathLength,
  rgbToCss,
  straightOutline,
  transPt,
  type Pt,
} from '../../shared/tiles';

export interface PatchPreviewProps {
  readonly rule: PlayerRule;
  readonly level?: number;
  /** Largest edge of the picture, in px. */
  readonly size?: number;
}

/** Width over height of the cropped frame. */
const ASPECT = 4 / 3;
/** Share of the frame the crop wants covered by tiles. */
const COVER = 0.97;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The biggest ASPECT box, anywhere in the patch, that is at least COVER
 * tiles. The patch is rasterised once into a summed-area table, so each
 * candidate box costs four lookups. The tiling alone decides it, so it is
 * per (family, level).
 */
function cropBox(polys: readonly (readonly Pt[])[], bounds: Box): Box {
  const R = 160;
  const cell = Math.max(bounds.w, bounds.h) / R;
  const cols = Math.ceil(bounds.w / cell) + 1;
  const rows = Math.ceil(bounds.h / cell) + 1;
  const on = new Uint8Array(cols * rows);
  for (const poly of polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of poly) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    const i0 = Math.max(0, Math.floor((minX - bounds.x) / cell));
    const i1 = Math.min(cols - 1, Math.ceil((maxX - bounds.x) / cell));
    const j0 = Math.max(0, Math.floor((minY - bounds.y) / cell));
    const j1 = Math.min(rows - 1, Math.ceil((maxY - bounds.y) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!on[j * cols + i] && pointInPolygon({ x: bounds.x + (i + 0.5) * cell, y: bounds.y + (j + 0.5) * cell }, poly)) on[j * cols + i] = 1;
      }
    }
  }
  // sat[(j)(cols+1) + i] = tiles in cells [0, i) × [0, j).
  const W = cols + 1;
  const sat = new Uint32Array(W * (rows + 1));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      sat[(j + 1) * W + i + 1] = on[j * cols + i] + sat[j * W + i + 1] + sat[(j + 1) * W + i] - sat[j * W + i];
    }
  }
  const covered = (i: number, j: number, w: number, h: number): number =>
    sat[(j + h) * W + i + w] - sat[j * W + i + w] - sat[(j + h) * W + i] + sat[j * W + i];

  let w = Math.min(cols, Math.floor(rows * ASPECT));
  for (; w > 8; w = Math.floor(w * 0.97)) {
    const h = Math.max(1, Math.round(w / ASPECT));
    let best = -1;
    let at = { i: 0, j: 0 };
    const step = Math.max(1, Math.floor(w / 16));
    for (let j = 0; j + h <= rows; j += step) {
      for (let i = 0; i + w <= cols; i += step) {
        const c = covered(i, j, w, h);
        if (c > best) {
          best = c;
          at = { i, j };
        }
      }
    }
    if (best >= COVER * w * h) return { x: bounds.x + at.i * cell, y: bounds.y + at.j * cell, w: w * cell, h: h * cell };
  }
  return bounds;
}

function polyD(points: readonly Pt[], closed: boolean): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x.toFixed(3)} ${points[i].y.toFixed(3)}`;
  return closed ? `${d} Z` : d;
}

export function PatchPreview({ rule, level = 3, size = 520 }: PatchPreviewProps): JSX.Element {
  const key = ruleKey(rule);
  const [theme] = useTheme();
  // The patch wears the same tile colours as the arena board, so the preview
  // looks like what you are about to play on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const board = useMemo(() => boardTheme(), [theme]);
  const [numbers, setNumbers] = useState(false);
  const family = rule.family;

  // The tiling itself: rule-independent, so it survives every edit.
  // Every substitution level is the mirror image of the one below, so at an
  // odd level each leaf comes out reflected against its tile thumb (edge
  // numbers running the other way round, the arrow on the far side).
  // `levelMirror` undoes that, so the patch lines up with the thumbs.
  const geo = useMemo(() => {
    const instances = flatten(buildSystem(family, level)['Delta'], levelMirror(level));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const polys = instances.map((inst) => {
      const pts = leafPts(family, inst.type).map((p) => transPt(inst.xform, p));
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return pts;
    });
    const crop = cropBox(polys, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    // Only what reaches into the frame gets drawn.
    const visible = (pts: readonly Pt[]): boolean =>
      pts.some((p) => p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) ||
      pointInPolygon({ x: crop.x + crop.w / 2, y: crop.y + crop.h / 2 }, pts);
    const shown = instances.map((inst, i) => ({ inst, pts: polys[i] })).filter(({ pts }) => visible(pts));
    // Class numbers sit just inside each seam; the font follows the tile's size.
    const labels = shown.flatMap(({ inst, pts }) => {
      const local = leafPts(family, inst.type);
      let ext = 0;
      for (const p of local) for (const q of local) ext = Math.max(ext, Math.hypot(p.x - q.x, p.y - q.y));
      const font = Math.max(0.4, 0.11 * ext);
      const orient = Math.sign(signedArea(local)) || 1;
      return metaEdges(family, inst.type).map((seam) => {
        const at = seamLabelAt(local, seam.edgeIndices, orient);
        const p = transPt(inst.xform, { x: at.x - at.nx * font * 0.85, y: at.y - at.ny * font * 0.85 });
        return { x: p.x, y: p.y, major: seam.major, font };
      });
    });
    return {
      instances,
      shown,
      labels,
      arrows: family === 'hex' ? shown.map(({ pts }) => straightOutline(directionArrow(pts))) : [],
      view: `${crop.x} ${crop.y} ${crop.w} ${crop.h}`,
      count: instances.length,
    };
  }, [family, level]);

  const fills = useMemo(
    () => geo.shown.map(({ inst, pts }) => ({ d: straightOutline(pts), fill: cssRgb(typeFill(inst.type, board.tileDim)) })),
    [geo, board],
  );

  const model = useMemo(() => {
    const matchingIndexByType: Record<string, number> = {};
    leafOrder(family).forEach((t, i) => (matchingIndexByType[t] = rule.matching[i] ?? 0));
    const result = analyze({ family, instances: geo.instances, selected: new Set(rule.subset), matchingIndexByType });
    const circuits = result.circuits.map((p) => ({ d: polyD(p.points, true), len: pathLength(p) }));
    const tails = result.tails.map((p) => ({ d: polyD(p.points, false), len: pathLength(p) }));
    // Every strand's path in one `d` each: the casing under them is a single
    // colour, so it costs two nodes instead of one per line.
    const circuitD = circuits.map((c) => c.d).join(' ');
    const tailD = tails.map((t) => t.d).join(' ');
    const longest = circuits.reduce((m, c) => Math.max(m, c.len), 0);
    const longestTail = tails.reduce((m, c) => Math.max(m, c.len), 0);
    return { circuits, tails, circuitD, tailD, longest, longestTail };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, geo]);
  const selected = new Set(rule.subset);

  return (
    <div className="patch-preview">
      <div className="patch-head">
        <label>
          <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} />
          Show edge numbers
        </label>
      </div>
      <svg
        viewBox={geo.view}
        className="patch-svg"
        style={{ maxWidth: size, aspectRatio: `${ASPECT}` }}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`Level ${level} patch under rule`}
      >
        <g className="patch-tiles">
          {fills.map((t, i) => (
            <path key={i} d={t.d} fill={t.fill} />
          ))}
        </g>
        <g className="patch-arrow">
          {geo.arrows.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {/* Cased, because a strand has to read on a white Gamma and on a
              yellow Xi alike, whatever colour its length gives it. */}
          <path d={model.tailD} stroke={board.haloCss} strokeWidth={0.34} strokeDasharray="0.3 0.2" />
          <path d={model.circuitD} stroke={board.haloCss} strokeWidth={0.4} />
          {model.tails.map((t, i) => (
            <path key={`t${i}`} d={t.d} stroke={board.badCss} strokeWidth={0.2} strokeDasharray="0.3 0.2" />
          ))}
          {model.circuits.map((c, i) => (
            <path key={`c${i}`} d={c.d} stroke={rgbToCss(circuitLengthRgb(c.len))} strokeWidth={0.24} />
          ))}
        </g>
        {numbers && (
          <g textAnchor="middle" dominantBaseline="central" fontWeight={700}>
            {geo.labels.map((l, i) => (
              <text key={i} x={l.x} y={l.y} fontSize={l.font} fill={EDGE_CLASS_COLORS[l.major]} fillOpacity={selected.has(l.major) ? 1 : 0.55}>
                {l.major}
              </text>
            ))}
          </g>
        )}
      </svg>
      <div className="patch-stats muted">
        level {level} · {geo.count} tiles · <b>{model.circuits.length}</b> circuit{model.circuits.length === 1 ? '' : 's'}
        {model.longest ? ` (longest ${model.longest})` : ''} · <b>{model.tails.length}</b> open line{model.tails.length === 1 ? '' : 's'}
        {model.longestTail ? ` (longest ${model.longestTail})` : ''}
        {rule.subset.length === 0 ? ' · nothing drawn' : ''}
      </div>
    </div>
  );
}
