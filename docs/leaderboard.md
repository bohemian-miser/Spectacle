# The leaderboard

The lobby's **Leaderboard** tab (online only): the fastest won rounds at a
board size, in the game mode picked under Play, with the winner's name, rule
and time; filtered by edge set or not, by **Bots** (a tap steps through
Everything, Only bots — bots' wins — and No bots — people's), and by
**Against** (who else was in the round: Anyone, Nobody, or Only bots). A
rule's row takes it back to Play. Hovering a row shows who played that round,
bots marked.

Every won round is recorded (`server/wins.ts`, `WinRecord`): mode, size, the
winner's own rule (`ruleKey`), the round's played time (the room's ticked
time, `roundMs` in the `win` log line), when, the winner's name, whether a
bot, everyone else at the board (`others`, and which of them were bots,
`otherBots`), and whether it was a `?room=` room. Its *company* (`companyOf`:
`alone`, `bots`, or `people`) is what Against filters on; a win recorded
before `otherBots` was kept counts as `people` if anyone else was there. A win's
a win: bots' and named rooms' count.

`GET /wins?mode=normal&level=5[&subset=258][&bots=only|none][&company=alone|bots]`
answers `{ wins: [...] }`, fastest first, at most 20. With `WINS_FIRESTORE`,
each combination of filters is a Firestore composite index, and the documents
carry `company` to filter on (`deploy/gcp/stats.sh` makes all eight; re-run it
after adding a filter — a query without its index fails, and the board falls
back to the answering shard's own wins).

The wins loaded from the logs (`shard: backfill`, before 2026-10-21) had no
names of who else was there: the people are worked out from the join/leave
lines, the bots counted from the `win` line — one bot is `hexbot` (Cloud Run
ran `BOTS=1`), more are each just `bot`.

Records live in memory and, with `WINS_FILE` set, in that file (one JSON line
each, read back at startup; the VM's compose file uses `/data/wins.jsonl`).
Without it they go with the process — on Cloud Run, with every new instance.

Times are compared as they are: a tuning push that changes speeds or
`winFraction` makes later rounds faster or slower than earlier ones.
