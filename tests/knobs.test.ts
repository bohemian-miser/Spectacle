import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOBS, headLimit, knobsFromEnv, type Knobs } from '../shared/game/knobs';

const k = (over: Partial<Knobs> = {}): Knobs => ({ ...DEFAULT_KNOBS, ...over });

describe('headLimit', () => {
  it('one head, two with a capture, then one more per captured pattern up to 12', () => {
    expect(headLimit(k(), 1)).toBe(1);
    expect(headLimit(k(), 2)).toBe(2);
    expect(headLimit(k(), 3)).toBe(3);
    expect(headLimit(k(), 12)).toBe(12);
    expect(headLimit(k(), 20)).toBe(12);
  });

  it('the default capture cap lets you reach the ceiling', () => {
    expect(headLimit(k(), 1 + DEFAULT_KNOBS.maxCapturedPatterns)).toBe(DEFAULT_KNOBS.maxHeadsTotal);
  });

  it('headPerCapture off: a flat headsWithCapture', () => {
    expect(headLimit(k({ headPerCapture: false }), 5)).toBe(2);
  });

  it('maxHeadsTotal 0 means no ceiling; it never drops below headsWithCapture', () => {
    expect(headLimit(k({ maxHeadsTotal: 0 }), 20)).toBe(20);
    expect(headLimit(k({ headsWithCapture: 4, maxHeadsTotal: 3 }), 2)).toBe(4);
  });

  it('is an env flag', () => {
    expect(knobsFromEnv({ KNOB_HEAD_PER_CAPTURE: '0', KNOB_MAX_HEADS_TOTAL: '6' })).toMatchObject({ headPerCapture: false, maxHeadsTotal: 6 });
  });
});
