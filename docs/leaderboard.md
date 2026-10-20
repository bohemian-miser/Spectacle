# The leaderboard

The lobby's **Leaderboard** tab (online only) is the rule lab with a box beside
the preview: the five fastest wins with the rule on show, at the size and in
the game mode picked under Play. "Use this rule" goes back to Play with it.

## What is kept

One record per won round (`server/wins.ts`, `WinRecord`): the game mode, the
board size, the winner's own rule (`ruleKey`), the time the round was played
(the room's ticked time, as `roundMs` in the `win` log line), when, the
winner's name, whether they were a bot, the names of everyone else at the
board, and whether it was a `?room=` link's room. A win's a win: bots' count,
and so do named rooms. Who else was there shows only when a row's
"with n" is opened.

`GET /wins?mode=normal&level=5&rule=<ruleKey>` answers `{ wins: [...] }`,
fastest first, at most five.

## Where it lives: `WINS_URL`

Unset: memory only. A file path: JSON lines, read back at startup (the VM's
compose file uses `/data/wins.jsonl`). `firestore://<project>`: a document per
win, so every Cloud Run instance sees every win within a minute (each serves a
board from memory and asks Firestore again at most once a minute, and at most
120 queries a minute all told).

Times are compared as they are: a tuning push that changes speeds or
`winFraction` makes later rounds faster or slower than earlier ones on the
same board.

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

Cost: a win is one write; reads are capped at 120 queries a minute per
instance, each returning at most five documents. Normal play stays well
inside Firestore's free daily quota (50k reads, 20k writes); a script walking
rules at the cap could pass it, at a few cents a day per instance.
