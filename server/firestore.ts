/**
 * The leaderboard's permanent home: one Firestore document per won round,
 * written by whichever shard it was won on, and the fastest read back for
 * `GET /wins` — so every shard shows the same board and none of it goes with
 * a restart. Plain REST with the instance's own token (gcp.ts), no SDK.
 * The queries need the composite indexes (mode, level, ms, at) and
 * (mode, level, subset, ms, at) on `wins` (deploy/gcp/stats.sh).
 */

import type { GameMode } from '../shared/game/knobs';
import type { WinRecord } from './wins';

type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { arrayValue: { values?: Value[] } };

export interface WinsRemote {
  add(r: WinRecord, shard: string): Promise<void>;
  /** The fastest `n` at (mode, level), of one edge set or (subset '') all. */
  top(mode: GameMode, level: number, subset: string, n: number): Promise<WinRecord[]>;
}

const str = (v: string): Value => ({ stringValue: v });
const int = (v: number): Value => ({ integerValue: String(Math.round(v)) });

/** The edge set of a `ruleKey` (`hex|0123|…` → `0123`). */
export function subsetOf(rule: string): string {
  return rule.split('|')[1] ?? '';
}

export function firestoreWins(project: string, token: () => Promise<string | null>, fetchFn: typeof fetch = fetch): WinsRemote {
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const call = async (url: string, body: unknown): Promise<unknown> => {
    const t = await token();
    if (!t) throw new Error('no credentials');
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`firestore: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  return {
    async add(r, shard) {
      await call(`${base}/wins`, {
        fields: {
          mode: str(r.mode),
          level: int(r.level),
          rule: str(r.rule),
          subset: str(subsetOf(r.rule)),
          ms: int(r.ms),
          at: int(r.at),
          name: str(r.name),
          bot: { booleanValue: r.bot },
          others: { arrayValue: { values: r.others.map(str) } },
          named: { booleanValue: r.named },
          shard: str(shard),
        },
      });
    },
    async top(mode, level, subset, n) {
      const eq = (field: string, value: Value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value } });
      const filters = [eq('mode', str(mode)), eq('level', int(level)), ...(subset ? [eq('subset', str(subset))] : [])];
      const res = (await call(`${base}:runQuery`, {
        structuredQuery: {
          from: [{ collectionId: 'wins' }],
          where: { compositeFilter: { op: 'AND', filters } },
          orderBy: [
            { field: { fieldPath: 'ms' }, direction: 'ASCENDING' },
            { field: { fieldPath: 'at' }, direction: 'ASCENDING' },
          ],
          limit: n,
        },
      })) as { document?: { fields: Record<string, Value> } }[];
      const out: WinRecord[] = [];
      for (const row of res) {
        const f = row.document?.fields;
        if (!f) continue;
        const s = (k: string): string => (f[k] as { stringValue?: string } | undefined)?.stringValue ?? '';
        const i = (k: string): number => Number((f[k] as { integerValue?: string } | undefined)?.integerValue ?? 0);
        const b = (k: string): boolean => (f[k] as { booleanValue?: boolean } | undefined)?.booleanValue === true;
        const others = ((f.others as { arrayValue?: { values?: Value[] } } | undefined)?.arrayValue?.values ?? []).map((v) => (v as { stringValue?: string }).stringValue ?? '');
        out.push({ mode: s('mode') as GameMode, level: i('level'), rule: s('rule'), ms: i('ms'), at: i('at'), name: s('name'), bot: b('bot'), others, named: b('named') });
      }
      return out;
    },
  };
}
