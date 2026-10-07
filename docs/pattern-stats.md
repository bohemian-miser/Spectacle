# Pattern stats

Which rules (patterns) get played, how far they spread, and how much of
their play is bots'.

## Where they come from

Every server samples each player at the board once a second. A *stint* is one
player on one rule: it starts when they join or pick a rule, and ends when
they pick another, leave, or the server shuts down
(`server/pattern-stats.ts`). Each finished stint is logged as one JSON line:

```json
{"message":"stint","stint":{"mode":"normal","level":6,"rule":"258 · 001000110","bot":true,
 "startedAt":1791339975121,"ms":15006,"finalScore":42,"peakScore":42,"circuits":2,
 "boardTiles":242144,"peakTiles":42,"peakCoverage":0.000173}}
```

- `rule` is `describeRule` form: the edge classes, then the matching per tile type.
- `peakCoverage` is the most of the board the stint held at once: tiles its
  lines were on ÷ tiles on the board (0–1), so stints on different board
  sizes compare. `peakTiles` / `boardTiles` are the raw counts.
- `bot` says whether a bot played it. `ms` is how long the stint lasted.

You can read them in three places:

- **`/patterns`** (and `/patterns.json`) on a server: the totals since that
  process started (or since `STATS_FILE` began, on the VM). There's a table
  per rule (uses, time, bot share of the time, best and mean coverage), then
  people and bots separately. With several Cloud Run instances it shows only
  the one that answered.
- **Cloud Logging**: `jsonPayload.message="stint"`, kept 30 days.
- **BigQuery**, once `deploy/gcp/stats-sink.sh` has run (`setup-ci.sh` runs
  it): every stint from every instance, kept indefinitely, in
  `PROJECT.spectacle_stats.run_googleapis_com_stdout`. Stints logged before
  the sink existed aren't copied in. A server older than the coverage fields
  logs stints without them, and those rows have `NULL` coverage.

## Queries

Replace `PROJECT` with the GCP project id. In the BigQuery console, or with
`bq query --use_legacy_sql=false '…'`.

### Per rule: uses, time, bot share, coverage

```sql
WITH s AS (
  SELECT jsonPayload.stint.*
  FROM `PROJECT.spectacle_stats.run_googleapis_com_stdout`
  WHERE jsonPayload.message = 'stint'
    AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
)
SELECT
  mode, rule,
  COUNT(*)                                   AS uses,
  COUNTIF(NOT bot)                           AS human_uses,
  ROUND(SUM(ms) / 3.6e6, 2)                  AS hours,
  ROUND(100 * SAFE_DIVIDE(SUM(IF(bot, ms, 0)), SUM(ms)), 1) AS bot_time_pct,
  ROUND(100 * MAX(peakCoverage), 2)          AS best_cover_pct,
  ROUND(100 * AVG(peakCoverage), 2)          AS mean_cover_pct,
  ROUND(100 * APPROX_QUANTILES(peakCoverage, 2)[OFFSET(1)], 2) AS median_cover_pct
FROM s
GROUP BY mode, rule
ORDER BY uses DESC;
```

### Uses per day

```sql
SELECT DATE(timestamp) AS day, jsonPayload.stint.rule AS rule,
       COUNT(*) AS uses, COUNTIF(NOT jsonPayload.stint.bot) AS human_uses
FROM `PROJECT.spectacle_stats.run_googleapis_com_stdout`
WHERE jsonPayload.message = 'stint'
GROUP BY day, rule
ORDER BY day DESC, uses DESC;
```

### The biggest single uses

```sql
SELECT timestamp, jsonPayload.stint.rule AS rule, jsonPayload.stint.bot AS bot,
       jsonPayload.stint.level AS level,
       ROUND(100 * jsonPayload.stint.peakCoverage, 2) AS cover_pct,
       ROUND(jsonPayload.stint.ms / 60000, 1) AS minutes
FROM `PROJECT.spectacle_stats.run_googleapis_com_stdout`
WHERE jsonPayload.message = 'stint'
ORDER BY jsonPayload.stint.peakCoverage DESC
LIMIT 50;
```

## Caveats

- A reconnect splits a stint in two, since only players at the board are
  sampled.
- Sampling is once a second, so a stint shorter than that may not show.
- Coverage is tiles held, any line status (growing, stuck or closed), which
  is the score under `scoreTiles`.
