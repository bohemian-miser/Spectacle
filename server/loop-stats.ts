/**
 * The worst of something over the last minute, for /status: how long a loop
 * pass took, and how long the loop went between passes. Kept in buckets, so
 * a value holds for the whole window (and at most one bucket longer). The
 * figure /status showed before was zeroed every 60 s, so a stall just before
 * the reset was gone a moment later.
 */
export class WindowMax {
  private readonly bucketMs: number;
  /** Oldest first: each bucket's start and the largest value recorded in it. */
  private readonly buckets: { start: number; max: number }[] = [];

  constructor(
    readonly windowMs = 60_000,
    buckets = 12,
  ) {
    this.bucketMs = windowMs / buckets;
  }

  /**
   * Note `value` at `now`. Record a long call when it *ends*: a stall longer
   * than the window, stamped with its start, would already be out of it.
   */
  record(now: number, value: number): void {
    const start = now - (now % this.bucketMs);
    const last = this.buckets[this.buckets.length - 1];
    // A clock that steps back lands in the newest bucket rather than out of order.
    if (last && start <= last.start) last.max = Math.max(last.max, value);
    else this.buckets.push({ start, max: value });
    this.prune(now);
  }

  /** The largest value recorded in the last `windowMs` (0 if none). */
  max(now: number): number {
    this.prune(now);
    let m = 0;
    for (const b of this.buckets) if (b.max > m) m = b.max;
    return m;
  }

  /** Drop buckets that ended a whole window ago: everything in them is at least that old. */
  private prune(now: number): void {
    while (this.buckets.length > 0 && this.buckets[0].start + this.bucketMs <= now - this.windowMs) this.buckets.shift();
  }
}
