# The leaderboard

The lobby's **Leaderboard** tab (online only) is the rule lab with a box beside
the preview: the five fastest wins with the rule on show, per board size, in
the game mode picked under Play. "Play this rule" goes back to Play with it.

## What is kept

One record per won round (`server/wins.ts`, `WinRecord`): the game mode, the
board size, the winner's own rule (`ruleKey`), the time the round was played
(the room's ticked time, as `roundMs` in the `win` log line), when, the
winner's name, whether they were a bot, the names of everyone else at the
board, and whether it was a `?room=` link's room. A win's a win: bots' count,
and so do named rooms. Who else was there shows only behind each row's
`+n` / `alone`.

`GET /wins?mode=normal&level=5&rule=<ruleKey>` answers `{ wins: [...] }`,
fastest first, at most five.

## Where it lives: `WINS_URL`

- unset: memory only, gone on a restart (dev, tests);
- a file path: one JSON line per win, read back at startup. The VM's compose
  file points it at `/data/wins.jsonl` on the `spectacle_data` volume;
- `firestore://<project>`: one Firestore document per win in the `wins`
  collection, over REST with the instance's own token, no SDK. Each instance
  serves a board from memory and asks Firestore again at most once a minute,
  so a win on another instance shows within a minute.

## Firestore setup (Cloud Run)

Once, on the project (`spectacle-game`):

```bash
P=spectacle-game
gcloud services enable firestore.googleapis.com --project $P
gcloud firestore databases create --location=us-central1 --project $P
# The servers run as the default compute account (CLAUDE.md, "Next / open").
PNUM=$(gcloud projects describe $P --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $P \
  --member="serviceAccount:${PNUM}-compute@developer.gserviceaccount.com" --role=roles/datastore.user
# The one query: a board's wins by time.
gcloud firestore indexes composite create --project $P --collection-group=wins \
  --query-scope=COLLECTION --field-config=field-path=board,order=ascending \
  --field-config=field-path=ms,order=ascending
```

Then set the repository variable `GCP_WINS_PROJECT` to the project id; the next
Cloud Run deploy passes `WINS_URL=firestore://<project>`. Until the index is
built the query fails: the server logs `wins: could not read wins` and serves
what that instance has seen.

Cost: a win is one write, a board read at most one query a minute per
instance returning up to five documents, well inside Firestore's free daily
quota (50k reads, 20k writes).
