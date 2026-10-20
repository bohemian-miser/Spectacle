/**
 * BigQuery over plain REST, with the instance's own token (gcp.ts): every
 * shard streams its finished stints and won rounds into one dataset
 * (`STATS_BIGQUERY`, `project.dataset`), which keeps them for good, and
 * /patterns asks it for the totals. No SDK.
 *
 * Rows are buffered and sent every few seconds (`flush`); a failed send keeps
 * them for the next one, up to `MAX_PENDING` (then the oldest go — the game
 * never waits on its statistics). Each row carries an `insertId`, so a send
 * that succeeded but whose answer was lost isn't counted twice.
 */

const API = 'https://bigquery.googleapis.com/bigquery/v2';
const MAX_PENDING = 20_000;

export interface BigQuery {
  /** Queue a row for `table`; `id` makes a resend harmless. */
  add(table: string, id: string, row: Record<string, unknown>): void;
  /** Send what is queued (also on a timer). */
  flush(): Promise<void>;
  /** A standard-SQL query; `{dataset}` stands for `project.dataset`. Values come back as strings, as BigQuery sends them. */
  query(sql: string): Promise<Record<string, string | null>[]>;
}

/** `project.dataset` → its parts; anything else → null. */
export function parseDataset(raw: string): { project: string; dataset: string } | null {
  const m = /^([a-z][a-z0-9-]{4,61}[a-z0-9])\.([A-Za-z0-9_]{1,1024})$/.exec(raw);
  return m ? { project: m[1], dataset: m[2] } : null;
}

export function bigQuery(
  where: { project: string; dataset: string },
  token: () => Promise<string | null>,
  onError: (e: unknown) => void = () => {},
  fetchFn: typeof fetch = fetch,
): BigQuery {
  const pending = new Map<string, { insertId: string; json: Record<string, unknown> }[]>();
  let size = 0;
  let sending: Promise<void> | null = null;

  const call = async (path: string, body: unknown): Promise<unknown> => {
    const t = await token();
    if (!t) throw new Error('no credentials');
    const r = await fetchFn(`${API}/projects/${where.project}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`bigquery ${path.split('/').pop()}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const send = async (): Promise<void> => {
    for (const [table, rows] of [...pending]) {
      pending.delete(table);
      size -= rows.length;
      try {
        const res = (await call(`/datasets/${where.dataset}/tables/${table}/insertAll`, { rows })) as { insertErrors?: { index: number }[] };
        // Rows BigQuery turned down are dropped, not retried: they would fail again.
        if (res.insertErrors?.length) onError(new Error(`bigquery ${table}: ${res.insertErrors.length} rows refused`));
      } catch (e) {
        // Back in the queue ahead of anything added meanwhile, for the next flush.
        const since = pending.get(table) ?? [];
        const back = [...rows, ...since].slice(-MAX_PENDING);
        size += back.length - since.length;
        pending.set(table, back);
        onError(e);
        return;
      }
    }
  };

  return {
    add(table, id, row) {
      const list = pending.get(table) ?? [];
      list.push({ insertId: id, json: row });
      size++;
      if (list.length > MAX_PENDING) {
        list.shift();
        size--;
      }
      pending.set(table, list);
    },
    flush() {
      if (size === 0) return sending ?? Promise.resolve();
      sending ??= send().finally(() => (sending = null));
      return sending;
    },
    async query(sql) {
      const res = (await call('/queries', {
        query: sql.replaceAll('{dataset}', `\`${where.project}.${where.dataset}\``),
        useLegacySql: false,
        timeoutMs: 15_000,
      })) as { jobComplete?: boolean; schema?: { fields: { name: string }[] }; rows?: { f: { v: string | null }[] }[] };
      if (!res.jobComplete) throw new Error('bigquery query: still running after 15 s');
      const names = res.schema?.fields.map((f) => f.name) ?? [];
      return (res.rows ?? []).map((r) => Object.fromEntries(r.f.map((c, i) => [names[i], c.v])));
    },
  };
}
