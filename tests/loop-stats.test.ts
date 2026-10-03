/**
 * /status's "worst in the last minute" (server/loop-stats.ts): a stall must
 * stay on the page for a whole minute, whatever comes after it.
 */
import { describe, expect, it } from 'vitest';
import { WindowMax } from '../server/loop-stats';

describe('the worst loop pass in the last minute', () => {
  it('holds a stall for the whole minute across many quick passes, then lets it go', () => {
    const w = new WindowMax(60_000, 12);
    for (let t = 0; t < 59_000; t += 50) w.record(t, 2);
    // A stall a second before the minute mark: the old figure was zeroed at 60 s.
    w.record(59_000, 300);
    for (let t = 59_050; t < 119_000; t += 50) {
      w.record(t, 2);
      expect(w.max(t)).toBe(300);
    }
    expect(w.max(119_000)).toBe(300);
    // At most one bucket (5 s) past the minute it is gone; the quick passes remain.
    expect(w.max(120_000)).toBe(2);
  });

  it('keeps a pass longer than the window, stamped when it ended', () => {
    const w = new WindowMax(60_000);
    w.record(400_000, 300_000);
    expect(w.max(400_050)).toBe(300_000);
    expect(w.max(459_000)).toBe(300_000);
  });

  it('is 0 with nothing recorded, and survives a clock stepping back', () => {
    const w = new WindowMax(60_000);
    expect(w.max(1000)).toBe(0);
    w.record(10_000, 40);
    w.record(9_000, 70);
    expect(w.max(10_000)).toBe(70);
  });
});
