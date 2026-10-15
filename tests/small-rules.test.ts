import { describe, expect, it } from 'vitest';
import { BUILTIN_BRAINS, DEFAULT_BOT_OPTIONS, type BotActions } from '../shared/game/bots';
import { EDGE_LORD_MIN_STRAND, isSmallRule } from '../shared/game/brains/kinds';
import { longestStrand } from '../shared/game/brains/sense';
import { SMALL_RULES } from '../shared/game/brains/small-rules';
import { Engine } from '../shared/game/engine';
import { buildField } from '../shared/game/field';
import { DEFAULT_KNOBS } from '../shared/game/knobs';
import { describeRule, ruleFromCombo } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { chordTableFor } from '../shared/game/strand';
import { CAP, enumerableRules } from '../scripts/small-rules';

const HEX = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });

describe('SMALL_RULES (npm run small-rules)', () => {
  it('records the longest strand of every hex rule it lists', () => {
    for (const [combo, longest] of Object.entries(SMALL_RULES.hex)) {
      const [subset, digits] = combo.split(' · ');
      expect(longestStrand(HEX, chordTableFor(HEX, ruleFromCombo('hex', subset, digits))), combo).toBe(longest);
    }
  });

  it('leaves out no hex rule whose lines all stay short', () => {
    for (const rule of enumerableRules('hex')) {
      if (SMALL_RULES.hex[describeRule(rule)] !== undefined) continue;
      expect(longestStrand(HEX, chordTableFor(HEX, rule), CAP), describeRule(rule)).toBeGreaterThan(CAP);
    }
  });

  it('has every 15 below the Edge Lords’ bar, and keeps most 258s above it', () => {
    const hex = Object.entries(SMALL_RULES.hex);
    expect(hex.filter(([k]) => k.startsWith('15 ')).every(([, n]) => n < EDGE_LORD_MIN_STRAND)).toBe(true);
    expect(hex.filter(([k, n]) => k.startsWith('258 ') && n >= EDGE_LORD_MIN_STRAND).length).toBeGreaterThan(30);
  });
});

/** A brain that only picks a rule never moves. */
const NO_MOVES: BotActions = {
  tap: () => false,
  setRule: () => {},
  setActive: () => {},
  swapPattern: () => false,
};

describe('Edge Lords', () => {
  for (const family of ['hex', 'spectre'] as const) {
    it(`never pick a small rule (${family})`, () => {
      const field = family === 'hex' ? HEX : buildField({ family, level: 2, rootTile: 'Delta' });
      const engine = new Engine(field, DEFAULT_KNOBS, mulberry32(1));
      const rng = mulberry32(7);
      for (const kind of ['edgelord', 'lazylord']) {
        for (let i = 0; i < 300; i++) {
          const brain = BUILTIN_BRAINS.make(kind, `b${i}`, { board: engine, act: NO_MOVES, rng, options: DEFAULT_BOT_OPTIONS });
          expect(isSmallRule(brain.firstRule(), EDGE_LORD_MIN_STRAND)).toBe(false);
        }
      }
    });
  }
});
