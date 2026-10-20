# The leaderboard

The lobby's **Leaderboard** tab (online only): the fastest won rounds at a
board size, in the game mode picked under Play, with the winner's name, rule
and time; filtered by edge set or not. A rule's row takes it back to Play.
Hovering a name shows who else was in the round.

Every won round is recorded (`server/wins.ts`, `WinRecord`): mode, size, the
winner's own rule (`ruleKey`), the round's played time (the room's ticked
time, `roundMs` in the `win` log line), when, the winner's name, whether a
bot, everyone else at the board, and whether it was a `?room=` room. A win's
a win: bots' and named rooms' count.

`GET /wins?mode=normal&level=5[&subset=258]` answers `{ wins: [...] }`,
fastest first, at most 20.

Records live in memory and, with `WINS_FILE` set, in that file (one JSON line
each, read back at startup; the VM's compose file uses `/data/wins.jsonl`).
Without it they go with the process — on Cloud Run, with every new instance.

Times are compared as they are: a tuning push that changes speeds or
`winFraction` makes later rounds faster or slower than earlier ones.
