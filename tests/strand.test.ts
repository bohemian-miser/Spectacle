import { describe, expect, it } from 'vitest';
import { buildField, tileNeighbours } from '../shared/game/field';
import { fassRule, randomCleanRule, ruleFromCombo, type PlayerRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor, tileChords, walkStrand } from '../shared/game/strand';
import { analyze, flatten, buildSystem, pathLength, type TileFamilyId } from '../shared/tiles';

/**
 * Oracle: the Spectre core's global weld-and-trace (`analyze`) on the same
 * patch must find exactly the circuits the local walker finds when started
 * from every chord.
 */
function compare(family: TileFamilyId, level: number, rule: PlayerRule) {
  const spec = { family, level, rootTile: 'Delta' as const };
  const field = buildField(spec);
  const table = chordTableFor(field, rule);

  const sys = buildSystem(family, level);
  const instances = flatten(sys['Delta']);
  const matchingIndexByType: Record<string, number> = {};
  field.leafTypes.forEach((t, i) => (matchingIndexByType[t] = rule.matching[i]));
  const oracle = analyze({ family, instances, selected: new Set(rule.subset), matchingIndexByType });

  const seen = new Set<string>();
  const circuitLengths: number[] = [];
  let tails = 0;
  for (let i = 0; i < field.count; i++) {
    const chords = tileChords(field, table, i);
    for (let c = 0; c < chords.length; c++) {
      if (seen.has(`${i}/${c}`)) continue;
      const walk = walkStrand(field, table, i, c, 1);
      for (const s of walk.steps) seen.add(`${s.tile}/${s.chord}`);
      if (walk.closed) circuitLengths.push(walk.steps.length);
      else {
        expect(walk.stoppedAt).not.toBe('junction');
        tails++;
      }
    }
  }
  const oracleLengths = oracle.circuits.map(pathLength).sort((a, b) => a - b);
  expect(circuitLengths.sort((a, b) => a - b)).toEqual(oracleLengths);
  return { circuits: circuitLengths.length, tails, oracleTails: oracle.tails.length };
}

describe('strand walking matches the global circuit analysis', () => {
  it('hex 128 FASS rule at level 3', () => {
    const r = compare('hex', 3, fassRule('hex'));
    expect(r.circuits + r.tails).toBeGreaterThan(0);
  });
  it('hex: a rule with circuits', () => {
    // Selection 15 has finite loops on the spectre; on hexes pick a kernel rule.
    const rng = mulberry32(7);
    for (let k = 0; k < 4; k++) compare('hex', 3, randomCleanRule('hex', rng));
  });
  it('spectre 1278 FASS rule at level 3', () => {
    compare('spectre', 3, fassRule('spectre'));
  });
  it('spectre selection 15 (finite circuits of length 3, 6, 9)', () => {
    const r = compare('spectre', 3, ruleFromCombo('spectre', '15', '0000000000'));
    expect(r.circuits).toBeGreaterThan(0);
  });
  it('spectre random clean rules (junction-free ones)', () => {
    const rng = mulberry32(3);
    let done = 0;
    for (let k = 0; k < 8 && done < 3; k++) {
      const rule = randomCleanRule('spectre', rng);
      if (rule.subset.includes(0)) continue; // class 0 makes vertex junctions
      compare('spectre', 3, rule);
      done++;
    }
    expect(done).toBeGreaterThan(0);
  });
  it('every tile has neighbours', () => {
    const field = buildField({ family: 'hex', level: 2, rootTile: 'Delta' });
    for (let i = 0; i < field.count; i++) expect(tileNeighbours(field, i).length).toBeGreaterThan(0);
  });
});
