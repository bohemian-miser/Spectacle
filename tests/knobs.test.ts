import { describe, expect, it } from 'vitest';
import { BOT_TUNING, TUNING } from '../shared/game/brains';
import { botTuningOf, DEFAULT_BOT_OPTIONS } from '../shared/game/bots';
import { applyTuning, DEFAULT_KNOBS, headLimit, knobsFromEnv, retune, ROOM_FIXED_KNOBS, type Knobs } from '../shared/game/knobs';

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

describe('live tuning (brains/tuning.ts)', () => {
  it('sets every knob but mode and tickMs, all of them valid', () => {
    expect(Object.keys(TUNING).sort()).toEqual(
      Object.keys(DEFAULT_KNOBS)
        .filter((x) => x !== 'mode' && x !== 'tickMs')
        .sort(),
    );
    expect(applyTuning(DEFAULT_KNOBS, TUNING).ignored).toEqual([]);
    expect(Object.keys(botTuningOf({ botTuning: BOT_TUNING })).sort()).toEqual(Object.keys(BOT_TUNING).sort());
  });

  it('lays known, well-typed knobs over the base and ignores the rest', () => {
    const { knobs, ignored } = applyTuning(DEFAULT_KNOBS, {
      regrowDiscount: 0.5,
      flipOwnLines: false,
      crossingMode: 'tile',
      junctionPolicy: 'sideways',
      maxHeads: '3',
      baseStepMs: Number.NaN,
      mode: 'normal',
      tickMs: 10,
      nope: 1,
    });
    expect(knobs).toEqual({
      ...DEFAULT_KNOBS,
      regrowDiscount: 0.5,
      flipOwnLines: false,
      crossingMode: 'tile',
    });
    expect(ignored.sort()).toEqual(['baseStepMs', 'junctionPolicy', 'maxHeads', 'mode', 'nope', 'tickMs']);
    expect(applyTuning(DEFAULT_KNOBS, undefined)).toEqual({
      knobs: DEFAULT_KNOBS,
      ignored: [],
    });
    expect(applyTuning(DEFAULT_KNOBS, 7).ignored).toHaveLength(1);
  });

  it('env vars win over the tuning', () => {
    const tuned = applyTuning(DEFAULT_KNOBS, {
      regrowDiscount: 0.5,
      maxHeads: 4,
    }).knobs;
    expect(knobsFromEnv({ KNOB_REGROW_DISCOUNT: '0.9' }, tuned)).toMatchObject({
      regrowDiscount: 0.9,
      maxHeads: 4,
    });
  });

  it('a running room keeps its fixed knobs', () => {
    const room = k({ mode: 'normal', scoreTiles: true });
    const next = retune(
      room,
      k({
        mode: 'conquest',
        scoreTiles: false,
        tickMs: 10,
        regrowDiscount: 0.5,
      }),
    );
    for (const key of ROOM_FIXED_KNOBS) expect(next[key]).toBe(room[key]);
    expect(next.regrowDiscount).toBe(0.5);
  });

  it('bot tuning is range-checked', () => {
    expect(botTuningOf({ botTuning: { aggression: 2, rotateMs: -1 } })).toEqual({});
    expect(botTuningOf({ botTuning: { aggression: 0.5, rotateMs: 1000 } })).toEqual({ aggression: 0.5, rotateMs: 1000 });
    expect(botTuningOf({})).toEqual({});
    expect(DEFAULT_BOT_OPTIONS).toMatchObject(BOT_TUNING);
  });
});
