/**
 * A small level-3 patch under the current rule, welded and traced with the
 * Spectre core's `analyze`: circuits coloured by length, tails in red. What
 * the rule will actually do on the floor, before you commit to it.
 */

import { useMemo } from 'react';
import { ruleKey, type PlayerRule } from '../../shared/game/rule';
import { boardTheme, useTheme } from './theme';
import { cssRgb, typeFill } from './tiles-layer';
import {
  analyze,
  buildSystem,
  circuitLengthRgb,
  flatten,
  leafOrder,
  leafPts,
  pathLength,
  rgbToCss,
  straightOutline,
  transPt,
  type Pt,
} from '../../shared/tiles';

export interface PatchPreviewProps {
  readonly rule: PlayerRule;
  readonly level?: number;
  readonly height?: number;
}

function polyD(points: readonly Pt[], closed: boolean): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x.toFixed(3)} ${points[i].y.toFixed(3)}`;
  return closed ? `${d} Z` : d;
}

export function PatchPreview({ rule, level = 3, height = 260 }: PatchPreviewProps): JSX.Element {
  const key = ruleKey(rule);
  const [theme] = useTheme();
  // The patch wears the same tile colours as the arena board, so the preview
  // looks like what you are about to play on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const board = useMemo(() => boardTheme(), [theme]);
  const model = useMemo(() => {
    const family = rule.family;
    const root = buildSystem(family, level)['Delta'];
    const instances = flatten(root);
    const matchingIndexByType: Record<string, number> = {};
    leafOrder(family).forEach((t, i) => (matchingIndexByType[t] = rule.matching[i] ?? 0));
    const result = analyze({ family, instances, selected: new Set(rule.subset), matchingIndexByType });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const tiles = instances.map((inst) => {
      const pts = leafPts(family, inst.type).map((p) => transPt(inst.xform, p));
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return { d: straightOutline(pts), fill: cssRgb(typeFill(inst.type, board.tileDim)) };
    });
    const circuits = result.circuits.map((p) => ({ d: polyD(p.points, true), len: pathLength(p) }));
    const tails = result.tails.map((p) => ({ d: polyD(p.points, false), len: pathLength(p) }));
    const longest = circuits.reduce((m, c) => Math.max(m, c.len), 0);
    const longestTail = tails.reduce((m, c) => Math.max(m, c.len), 0);
    return { tiles, circuits, tails, longest, longestTail, view: `${minX - 1} ${minY - 1} ${maxX - minX + 2} ${maxY - minY + 2}`, count: instances.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, level, board]);

  return (
    <div className="patch-preview">
      <svg viewBox={model.view} height={height} className="patch-svg" role="img" aria-label={`Level ${level} patch under rule`}>
        <g className="patch-tiles">
          {model.tiles.map((t, i) => (
            <path key={i} d={t.d} fill={t.fill} />
          ))}
        </g>
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {model.tails.map((t, i) => (
            <path key={`t${i}`} d={t.d} stroke={board.badCss} strokeWidth={0.14} strokeOpacity={0.8} strokeDasharray="0.3 0.2" />
          ))}
          {model.circuits.map((c, i) => (
            <path key={`c${i}`} d={c.d} stroke={rgbToCss(circuitLengthRgb(c.len))} strokeWidth={0.18} />
          ))}
        </g>
      </svg>
      <div className="patch-stats muted">
        level {level} · {model.count} tiles · <b>{model.circuits.length}</b> circuit{model.circuits.length === 1 ? '' : 's'}
        {model.longest ? ` (longest ${model.longest})` : ''} · <b>{model.tails.length}</b> open line{model.tails.length === 1 ? '' : 's'}
        {model.longestTail ? ` (longest ${model.longestTail})` : ''}
        {rule.subset.length === 0 ? ' · nothing drawn' : ''}
      </div>
    </div>
  );
}
