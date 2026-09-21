/**
 * The rule lab from Spectre's Tails page, cut down to the two decisions a
 * player makes: which edge classes carry a line (chips), and how the lines
 * pair up inside each tile type (click a tile to cycle its non-crossing
 * matchings). Odd tiles are flagged: they are where your line will die.
 */

import { useMemo } from 'react';
import { describeRule, defaultRule, oddTypes, randomCleanRule, type PlayerRule } from '../../shared/game/rule';
import { mathRandomRng } from '../../shared/game/rng';
import {
  EDGE_CLASS_COLORS,
  FAMILY_DISPLAY_NAMES,
  connectionCount,
  familyMajors,
  leafOrder,
  nonCrossingForTile,
  validEdgeSubsets,
  type TileFamilyId,
} from '../../shared/tiles';
import { TileThumb } from './TileThumb';

export interface RuleEditorProps {
  readonly family: TileFamilyId;
  readonly rule: PlayerRule;
  readonly color?: string;
  onChange(rule: PlayerRule): void;
}

/** Keep each tile's matching if it is still legal under the new subset, else take the first legal one. */
function withSubset(family: TileFamilyId, subset: readonly number[], prev: readonly number[]): PlayerRule {
  const selected = new Set(subset);
  const matching = leafOrder(family).map((type, i) => {
    const allowed = nonCrossingForTile(family, type, selected);
    if (allowed.length === 0) return 0;
    return allowed.includes(prev[i]) ? prev[i] : allowed[0];
  });
  return { family, subset: [...subset].sort((a, b) => a - b), matching };
}

export function RuleEditor({ family, rule, color = '#ffffff', onChange }: RuleEditorProps): JSX.Element {
  const majors = familyMajors(family);
  const selected = useMemo(() => new Set(rule.subset), [rule.subset]);
  const odd = oddTypes(rule);
  const cleanMasks = useMemo(() => new Set(validEdgeSubsets(family).map((v) => v.edges.join(''))), [family]);
  const isClean = rule.subset.length > 0 && cleanMasks.has(rule.subset.join(''));

  const toggle = (major: number): void => {
    const next = selected.has(major) ? rule.subset.filter((m) => m !== major) : [...rule.subset, major];
    onChange(withSubset(family, next, rule.matching));
  };

  const cycle = (typeIndex: number, delta: number): void => {
    const type = leafOrder(family)[typeIndex];
    const allowed = nonCrossingForTile(family, type, selected);
    if (allowed.length <= 1) return;
    const at = Math.max(0, allowed.indexOf(rule.matching[typeIndex]));
    const matching = [...rule.matching];
    matching[typeIndex] = allowed[(at + delta + allowed.length) % allowed.length];
    onChange({ ...rule, matching });
  };

  return (
    <div className="rule-editor">
      <div className="rule-row">
        <span className="rule-label">Edge classes</span>
        <div className="chips">
          {majors.map((m) => (
            <button
              key={m}
              type="button"
              className={`chip${selected.has(m) ? ' is-on' : ''}`}
              style={{ ['--chip' as string]: EDGE_CLASS_COLORS[m] }}
              aria-pressed={selected.has(m)}
              onClick={() => toggle(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="rule-buttons">
          <button type="button" className="btn" onClick={() => onChange(randomCleanRule(family, mathRandomRng))}>
            Surprise me
          </button>
          <button type="button" className="btn" onClick={() => onChange(defaultRule(family))} title="The proven infinite-line rule">
            FASS
          </button>
          <button type="button" className="btn" onClick={() => onChange(withSubset(family, [], rule.matching))}>
            Clear
          </button>
        </div>
      </div>

      <div className="thumbs">
        {leafOrder(family).map((type, i) => {
          const n = connectionCount(family, type, selected);
          const allowed = nonCrossingForTile(family, type, selected);
          const isOdd = n % 2 === 1;
          return (
            <div key={type} className={`thumb-card${isOdd ? ' is-odd' : ''}`}>
              <TileThumb
                family={family}
                type={type}
                subset={rule.subset}
                matching={rule.matching[i]}
                color={color}
                size={92}
                onClick={allowed.length > 1 ? () => cycle(i, 1) : undefined}
                title={`${type}: ${isOdd ? 'odd — a tail' : allowed.length > 1 ? `${allowed.length} ways to pair, click to cycle` : n === 0 ? 'no lines' : 'one way to pair'}`}
              />
              <div className="thumb-caption">
                <span>{type}</span>
                {isOdd ? <span className="tag tag-bad">tail</span> : allowed.length > 1 ? <span className="tag">{allowed.indexOf(rule.matching[i]) + 1}/{allowed.length}</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rule-readout">
        <span>
          <b>{FAMILY_DISPLAY_NAMES[family]}</b> · rule <code>{describeRule(rule)}</code>
        </span>
        {rule.subset.length === 0 ? (
          <span className="tag tag-bad">no lines — pick some classes</span>
        ) : odd.length ? (
          <span className="tag tag-bad">
            {odd.length} tile type{odd.length > 1 ? 's' : ''} with tails ({odd.join(', ')}) — your line ends there
          </span>
        ) : (
          <span className="tag tag-good">{isClean ? 'clean: every tile pairs up' : 'every tile pairs up'}</span>
        )}
      </div>
    </div>
  );
}
