/**
 * The end of a won round (the `win` event), worked out once: in what order
 * the infinite line flips the board. Pure, no DOM.
 *
 * It starts on the tile at the loose end of the winner's longest line and
 * grows both ways along the infinite-line rule (hex `128`), a chord a step:
 * a tile flips when the line first reaches it. On a Psi-rooted hexagon
 * board that rule draws one single line through every tile, so the line
 * alone flips the whole board, filling it in the curve's own fractal order;
 * on other boards it leaves strands it never meets, and those tiles flip
 * after, spreading tile to tile from the ones it reached.
 *
 * The flip accelerates: a tile `d` steps out flips at `sqrt(d / D)` of the
 * spread's time (`D` the furthest), so the line starts slow and the last of
 * the board goes in a rush.
 */

import { tileNeighbours, type Field } from '../../shared/game/field';
import { SNAP_EPSILON, tileChords, worldChord, type ChordTable } from '../../shared/game/strand';

export interface FlipOrder {
  /** Tiles in the order they flip. */
  readonly order: Int32Array;
  /** Each tile's place in `order`. */
  readonly rank: Int32Array;
  /** When `order[j]` flips, as a fraction (0–1) of the spread, non-decreasing. */
  readonly at: Float32Array;
}

export function flipOrder(field: Field, table: ChordTable, start: number): FlipOrder {
  const n = field.count;
  // Every tile's chord ends, flat: tile i's are xy[2 * from[i]] … up to from[i + 1].
  const from = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) from[i + 1] = from[i] + 2 * tileChords(field, table, i).length;
  const xy = new Float64Array(2 * from[n]);
  for (let i = 0; i < n; i++) {
    const chords = tileChords(field, table, i).length;
    for (let c = 0; c < chords; c++) {
      const [a, b] = worldChord(field, table, i, c);
      const o = 2 * (from[i] + 2 * c);
      xy[o] = a.x;
      xy[o + 1] = a.y;
      xy[o + 2] = b.x;
      xy[o + 3] = b.y;
    }
  }
  // Chord c of tile i is chord node from[i] / 2 + c; its ends are xy[4 * node …].
  const tileOf = new Int32Array(from[n] / 2);
  for (let i = 0; i < n; i++) for (let v = from[i] / 2; v < from[i + 1] / 2; v++) tileOf[v] = i;
  const seen = new Uint8Array(tileOf.length);
  const dist = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  let len = 0;
  const first = start >= 0 && start < n ? start : 0;
  // Along the line: each chord leads on to the chord across each of its ends, a step at a time.
  let front: number[] = [];
  for (let v = from[first] / 2; v < from[first + 1] / 2; v++) (seen[v] = 1), front.push(v);
  dist[first] = 0;
  order[len++] = first;
  let next: number[] = [];
  let d = 1;
  /** The chords of tile t with an end at (x, y), not yet reached, join the next front. */
  const look = (t: number, x: number, y: number): void => {
    for (let w = from[t] / 2; w < from[t + 1] / 2; w++) {
      if (seen[w]) continue;
      const o = 4 * w;
      if (
        !(Math.abs(xy[o] - x) < SNAP_EPSILON && Math.abs(xy[o + 1] - y) < SNAP_EPSILON) &&
        !(Math.abs(xy[o + 2] - x) < SNAP_EPSILON && Math.abs(xy[o + 3] - y) < SNAP_EPSILON)
      )
        continue;
      seen[w] = 1;
      next.push(w);
      if (dist[t] < 0) {
        dist[t] = d;
        order[len++] = t;
      }
    }
  };
  for (; front.length > 0; d++) {
    for (const v of front) {
      const i = tileOf[v];
      const around = tileNeighbours(field, i);
      for (let e = 4 * v; e < 4 * v + 4; e += 2) {
        look(i, xy[e], xy[e + 1]);
        for (let m = 0; m < around.length; m++) look(around[m], xy[e], xy[e + 1]);
      }
    }
    front = next;
    next = [];
  }
  // Whatever the line never met: tile to tile from what it did.
  for (let head = 0; head < len && len < n; head++) {
    const i = order[head];
    for (const t of tileNeighbours(field, i)) {
      if (dist[t] >= 0) continue;
      dist[t] = dist[i] + 1;
      order[len++] = t;
    }
  }
  // A board in pieces (none yet): anything left goes last.
  for (let i = 0; len < n && i < n; i++) if (dist[i] < 0) (dist[i] = dist[order[len - 1]] + 1), (order[len++] = i);
  // The second pass appends in distance order only per source: sort to be sure.
  const sorted = Int32Array.from(order).sort((a, b) => dist[a] - dist[b] || 0);
  const far = Math.max(1, dist[sorted[n - 1]]);
  const rank = new Int32Array(n);
  const at = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    rank[sorted[j]] = j;
    at[j] = Math.sqrt(dist[sorted[j]] / far);
  }
  return { order: sorted, rank, at };
}

/** How many of `at` are ≤ `p` (it is non-decreasing). */
export function flippedBy(at: Float32Array, p: number): number {
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
