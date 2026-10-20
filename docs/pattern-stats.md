# Pattern stats

Which rules (patterns) get played, how far they spread, which win rounds,
and how much of their play is bots'.

## Where they come from

Every server samples each player at the board once a second. A *stint* is one
player on one rule within one round: it starts when they join, pick a rule
or a new round begins, and ends (`end`) when they pick another (`rule`),
leave (`left`), the round ends (`round`: someone won it), or the server
shuts down (`shutdown`) (`server/pattern-stats.ts`). Each finished stint is
logged as one JSON line:

```json
{"message":"stint","stint":{"mode":"normal","level":6,"rule":"258 · 001000110","bot":true,
 "startedAt":1791339975121,"ms":15006,"finalScore":42,"peakScore":42,"circuits":2,
 "boardTiles":242144,"peakTiles":42,"peakCoverage":0.000173,"won":false,"end":"round"}}
```

A round is won when one player's lines cover `winFraction` of the board
(0.9 by default; the engine's `win` event). Each win is logged too:

```json
{"message":"win","win":{"mode":"normal","level":6,"round":3,"rule":"03456 · 000000000",
 "bot":true,"kind":"wanderer","tiles":217930,"boardTiles":242144,"coverage":0.9,
 "roundMs":1963000,"humans":2,"bots":1}}
```

`rule` is the winner's own rule (captured patterns may have helped),
`kind` the bot's kind (`null` for a person), `round` counts rounds in that
room since it opened, `roundMs` is the time played in the round (a room
nobody is in stands still and doesn't count), and `humans`/`bots` are who
was at the board.

- `rule` is `describeRule` form: the edge classes, then the matching per tile type.
- `peakCoverage` is the most of the board the stint held at once: tiles its
  lines were on ÷ tiles on the board (0–1), so stints on different board
  sizes compare. `peakTiles` / `boardTiles` are the raw counts.
- `bot` says whether a bot played it. `ms` is how long the stint lasted.
- `won` says whether the stint won its round.

Every server also writes each finished stint and won round straight to
BigQuery (`STATS_BIGQUERY`, server/bigquery.ts) — every shard, the VM
included — into `PROJECT.spectacle.stints` and `PROJECT.spectacle.wins`,
kept for good. They have the fields above as columns, plus `shard` and the
time (`endedAt`, `wonAt`; both tables are partitioned by day). A `wins` row
also has the winner's `name`, `others` at the board, `named` (a link's
room), and `ruleKey` / `subset` (the leaderboard's form). Stints and wins
from before this (from 2026-09-25) were loaded from the logs; those wins
have no names.

You can read them in three places:

- **`/patterns`** (and `/patterns.json`): with `STATS_BIGQUERY` set, the
  all-time totals from every shard (asked of BigQuery at most once a
  minute), with the answering server's running stints on top. Without it,
  that process's own since it started. A table per rule (uses, time, bot
  share of the time, wins, best and mean coverage), then people and bots.
- **BigQuery**: the queries below.
- **Cloud Logging**: `jsonPayload.message="stint"` (or `"win"`), Cloud Run
  only, kept 30 days.

## Queries

Replace `PROJECT` with the GCP project id. In the BigQuery console, or with
`bq query --use_legacy_sql=false '…'`.

### Per rule: uses, time, bot share, coverage

```sql
SELECT
  mode, rule,
  COUNT(*)                                   AS uses,
  COUNTIF(NOT bot)                           AS human_uses,
  COUNTIF(won)                               AS wins,
  COUNTIF(won AND bot)                       AS bot_wins,
  ROUND(SUM(ms) / 3.6e6, 2)                  AS hours,
  ROUND(100 * SAFE_DIVIDE(SUM(IF(bot, ms, 0)), SUM(ms)), 1) AS bot_time_pct,
  ROUND(100 * MAX(peakCoverage), 2)          AS best_cover_pct,
  ROUND(100 * AVG(peakCoverage), 2)          AS mean_cover_pct,
  ROUND(100 * APPROX_QUANTILES(peakCoverage, 2)[OFFSET(1)], 2) AS median_cover_pct
FROM `PROJECT.spectacle.stints`
WHERE endedAt > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY mode, rule
ORDER BY uses DESC;
```

### Uses per day

```sql
SELECT DATE(endedAt) AS day, rule, COUNT(*) AS uses, COUNTIF(NOT bot) AS human_uses
FROM `PROJECT.spectacle.stints`
GROUP BY day, rule
ORDER BY day DESC, uses DESC;
```

### Rounds won: by whom, and how fast

```sql
SELECT mode, rule, IF(bot, kind, 'person') AS winner,
       COUNT(*) AS wins,
       ROUND(AVG(roundMs) / 60000, 1) AS mean_minutes,
       ROUND(MIN(roundMs) / 60000, 1) AS fastest_minutes,
       ROUND(AVG(humans), 1) AS mean_humans
FROM `PROJECT.spectacle.wins`
GROUP BY mode, rule, winner
ORDER BY wins DESC;
```

### Bots' share of the wins, per day

```sql
SELECT DATE(wonAt) AS day, COUNT(*) AS rounds,
       ROUND(100 * COUNTIF(bot) / COUNT(*), 1) AS bot_win_pct
FROM `PROJECT.spectacle.wins`
GROUP BY day
ORDER BY day DESC;
```

### The biggest single uses

```sql
SELECT endedAt, rule, bot, level, shard,
       ROUND(100 * peakCoverage, 2) AS cover_pct,
       ROUND(ms / 60000, 1) AS minutes
FROM `PROJECT.spectacle.stints`
ORDER BY peakCoverage DESC
LIMIT 50;
```

## Caveats

- A reconnect splits a stint in two, since only players at the board are
  sampled. So does a round's end, on purpose.
- Sampling is once a second, so a stint shorter than that may not show.
- Coverage is tiles held, any line status (growing, stuck or closed), which
  is the score under `scoreTiles`.
