/**
 * The rule lab from Spectre's Tails page, made for playing: edge classes on
 * every tile (click one to switch its class on), and the pairing drawn by
 * hand — drag dot to dot. A tile is *drafting* until every dot is paired;
 * you can't enter the arena with a half-drawn tile.
 */

import { useEffect, useMemo, useState } from 'react';
import { applyPair, matchingToPairs, pairsToMatchingIndex, removePairAt, type Pair } from '../../shared/game/pairs';
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
  type TileTypeId,
} from '../../shared/tiles';
import { PatchPreview } from './PatchPreview';
import { TileThumb } from './TileThumb';

export interface RuleEditorProps {
  readonly family: TileFamilyId;
  readonly rule: PlayerRule;
  readonly color?: string;
  onChange(rule: PlayerRule): void;
  /** Types still being drawn (no complete pairing yet). */
  onDrafting?(types: readonly TileTypeId[]): void;
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

export function RuleEditor({ family, rule, color = '#ffffff', onChange, onDrafting }: RuleEditorProps): JSX.Element {
  const majors = familyMajors(family);
  const order = leafOrder(family);
  const selected = useMemo(() => new Set(rule.subset), [rule.subset]);
  const odd = oddTypes(rule);
  const cleanMasks = useMemo(() => new Set(validEdgeSubsets(family).map((v) => v.edges.join(''))), [family]);
  const isClean = rule.subset.length > 0 && cleanMasks.has(rule.subset.join(''));
  const [drafts, setDrafts] = useState<Partial<Record<TileTypeId, Pair[]>>>({});
  const [note, setNote] = useState<string | null>(null);
  const [showNumbers, setShowNumbers] = useState(true);

  const drafting = order.filter((t) => drafts[t] !== undefined);
  useEffect(() => {
    onDrafting?.(drafting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafting.join(',')]);

  const setRule = (next: PlayerRule): void => {
    setDrafts({});
    setNote(null);
    onChange(next);
  };

  const toggle = (major: number): void => {
    const next = selected.has(major) ? rule.subset.filter((m) => m !== major) : [...rule.subset, major];
    setRule(withSubset(family, next, rule.matching));
  };

  const pairsFor = (i: number): Pair[] => {
    const type = order[i];
    const d = drafts[type];
    if (d) return d;
    const n = connectionCount(family, type, selected);
    return matchingToPairs(n, rule.matching[i]);
  };

  const commit = (i: number, pairs: Pair[], n: number): void => {
    const type = order[i];
    if (pairs.length * 2 === n) {
      const idx = pairsToMatchingIndex(n, pairs);
      const matching = [...rule.matching];
      matching[i] = idx;
      setDrafts((d) => {
        const next = { ...d };
        delete next[type];
        return next;
      });
      setNote(null);
      onChange({ ...rule, matching });
    } else {
      setDrafts((d) => ({ ...d, [type]: pairs }));
    }
  };

  const pair = (i: number, a: number, b: number): void => {
    const n = connectionCount(family, order[i], selected);
    const r = applyPair(pairsFor(i), a, b, n);
    if (!r.ok) {
      setNote(r.reason === 'crossing' ? `That line would cross another on ${order[i]} — lines never cross inside a tile.` : null);
      return;
    }
    commit(i, r.pairs, n);
  };

  const unpair = (i: number, a: number): void => {
    const n = connectionCount(family, order[i], selected);
    const cur = pairsFor(i);
    const next = removePairAt(cur, a);
    if (next.length === cur.length) return;
    commit(i, next, n);
  };

  const cycle = (i: number): void => {
    const type = order[i];
    const allowed = nonCrossingForTile(family, type, selected);
    if (allowed.length <= 1) return;
    const at = Math.max(0, allowed.indexOf(rule.matching[i]));
    const matching = [...rule.matching];
    matching[i] = allowed[(at + 1) % allowed.length];
    setDrafts((d) => {
      const next = { ...d };
      delete next[type];
      return next;
    });
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
          <label className="check">
            <input type="checkbox" checked={showNumbers} onChange={(e) => setShowNumbers(e.target.checked)} /> numbers
          </label>
          <button type="button" className="btn" onClick={() => setRule(randomCleanRule(family, mathRandomRng))}>
            Surprise me
          </button>
          <button type="button" className="btn" onClick={() => setRule(defaultRule(family))} title="The proven infinite-line rule">
            FASS
          </button>
          <button type="button" className="btn" onClick={() => setRule(withSubset(family, [], rule.matching))}>
            Clear
          </button>
        </div>
      </div>

      <p className="muted rule-hint">
        Click an edge number to switch its class on everywhere. Drag from dot to dot to draw a line; click a dot to
        remove its line. Lines never cross inside a tile.
      </p>

      <div className="thumbs">
        {order.map((type, i) => {
          const n = connectionCount(family, type, selected);
          const allowed = nonCrossingForTile(family, type, selected);
          const isOdd = n % 2 === 1;
          const isDraft = drafts[type] !== undefined;
          const pairs = pairsFor(i);
          return (
            <div key={type} className={`thumb-card${isOdd ? ' is-odd' : ''}${isDraft ? ' is-draft' : ''}`}>
              <TileThumb
                family={family}
                type={type}
                subset={rule.subset}
                pairs={pairs}
                color={color}
                size={116}
                showNumbers={showNumbers}
                title={`${type}: ${isOdd ? 'odd — a tail' : n === 0 ? 'no lines' : `${n} dots, ${allowed.length} way${allowed.length === 1 ? '' : 's'} to pair`}`}
                onToggleClass={toggle}
                onPair={(a, b) => pair(i, a, b)}
                onUnpair={(a) => unpair(i, a)}
              />
              <div className="thumb-caption">
                <span>{type}</span>
                {isOdd ? (
                  <span className="tag tag-bad">tail</span>
                ) : isDraft ? (
                  <span className="tag tag-bad">{n - pairs.length * 2} dots left</span>
                ) : allowed.length > 1 ? (
                  <button type="button" className="tag tag-btn" title="Next pairing" onClick={() => cycle(i)}>
                    {allowed.indexOf(rule.matching[i]) + 1}/{allowed.length} ↻
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rule-readout">
        <span>
          <b>{FAMILY_DISPLAY_NAMES[family]}</b> · rule <code>{describeRule(rule)}</code>
        </span>
        {note ? (
          <span className="tag tag-bad">{note}</span>
        ) : drafting.length ? (
          <span className="tag tag-bad">finish pairing {drafting.join(', ')}</span>
        ) : rule.subset.length === 0 ? (
          <span className="tag tag-bad">no lines — pick some classes</span>
        ) : odd.length ? (
          <span className="tag tag-bad">
            {odd.length} tile type{odd.length > 1 ? 's' : ''} with tails ({odd.join(', ')}) — your line ends there
          </span>
        ) : (
          <span className="tag tag-good">{isClean ? 'clean: every tile pairs up' : 'every tile pairs up'}</span>
        )}
      </div>

      {drafting.length === 0 && <PatchPreview rule={rule} level={3} />}
    </div>
  );
}
