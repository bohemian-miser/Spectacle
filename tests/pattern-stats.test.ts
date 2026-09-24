/** Pattern stats: stints open, close on a rule change or departure, and fold into rows. */
import { describe, expect, it } from 'vitest';
import { defaultRule, describeRule, fassRule } from '../shared/game/rule';
import { PatternStats } from '../server/pattern-stats';

const a = defaultRule('hex');
const b = fassRule('hex');

describe('PatternStats', () => {
  it('tracks a stint per player and rule, and closes it on change or departure', () => {
    const s = new PatternStats(0);
    expect(s.sample(0, [{ mode: 'normal', players: [{ id: 'p1', bot: false, rule: a, score: 0 }] }])).toEqual([]);
    s.circuit('p1');
    s.sample(5000, [{ mode: 'normal', players: [{ id: 'p1', bot: false, rule: a, score: 40 }] }]);
    // Running stints show in the report.
    const live = s.report(5000).rows[0];
    expect(live).toMatchObject({ rule: describeRule(a), live: 1, stints: 1, ms: 5000, peakScore: 40, circuits: 1, finished: 0 });
    // A new rule closes the old stint (score as last seen) and opens another.
    const done = s.sample(6000, [{ mode: 'normal', players: [{ id: 'p1', bot: false, rule: b, score: 0 }] }]);
    expect(done).toEqual([{ mode: 'normal', rule: describeRule(a), bot: false, startedAt: 0, ms: 6000, finalScore: 40, peakScore: 40, circuits: 1 }]);
    // Gone from the sample: closed.
    const gone = s.sample(9000, []);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ rule: describeRule(b), ms: 3000 });
    const rows = s.report(9000).rows;
    expect(rows.map((r) => r.rule)).toEqual([describeRule(a), describeRule(b)]);
    expect(rows.every((r) => r.live === 0)).toBe(true);
  });

  it('keeps modes and bots apart, and survives a save and load', () => {
    const s = new PatternStats(0);
    s.sample(0, [
      { mode: 'normal', players: [{ id: 'p1', bot: false, rule: a, score: 0 }, { id: 'b1', bot: true, rule: a, score: 0 }] },
      { mode: 'conquest', players: [{ id: 'p2', bot: false, rule: a, score: 0 }] },
    ]);
    s.sample(1000, []);
    expect(s.report(1000).rows).toHaveLength(3);
    const again = new PatternStats(5000, JSON.parse(JSON.stringify(s.toFile())));
    expect(again.since).toBe(0);
    again.sample(5000, [{ mode: 'normal', players: [{ id: 'p9', bot: false, rule: a, score: 7 }] }]);
    again.sample(7000, []);
    const row = again.report(7000).rows.find((r) => r.mode === 'normal' && !r.bot)!;
    expect(row).toMatchObject({ stints: 2, finished: 2, ms: 3000, finalScoreSum: 7 });
  });
});
