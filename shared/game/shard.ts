/**
 * Shards: every game server is one named shard (`a`, `b`, …) with its own
 * address, and every room lives on exactly one of them. The page is served
 * from one place (hexagon.rodeo); a shard is only where its socket goes —
 * `template` with `{shard}` replaced, e.g. `wss://{shard}.s.hexagon.rodeo/ws`.
 * A full shard refuses a join with `next`, and the client carries the join on
 * to that one; an invite link names its shard (`?s=`), so it always reaches
 * the room. Unset on a server (dev, tests, an older deploy): no shards, the
 * socket stays on the page's own host.
 */

export interface ShardInfo {
  /** This server's shard. */
  readonly name: string;
  /** Where a join goes when this one is full; absent on the last. */
  readonly next?: string;
  /** Socket address of any shard: `{shard}` stands for its name. */
  readonly template: string;
}

/** A shard name as links and tickets carry it: 1–8 of a–z and 0–9, else null. */
export function cleanShardName(raw: unknown): string | null {
  return typeof raw === 'string' && /^[a-z0-9]{1,8}$/.test(raw) ? raw : null;
}

/** A usable socket template: wss:// (or ws://), with `{shard}` in it. */
export function validShardTemplate(raw: unknown): raw is string {
  return typeof raw === 'string' && /^wss?:\/\/[^\s]*\{shard\}/.test(raw);
}

export function shardWsUrl(template: string, name: string): string {
  return template.replace('{shard}', name);
}
