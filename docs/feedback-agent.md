# Player feedback → issues → agent PRs

A player presses **Feedback** in the game, writes what went wrong, and sends
it. Within about ten minutes a Gemini agent has read it against the code and
filed it as a GitHub issue (or added it to one that already covers it). The
owner hands an issue to the Gemini agent by labelling it `agent-ready`; it
opens a PR with tests and waits for CI to go green, and answers the owner's
and invited collaborators' comments on the issue and the PR. The issues are
public and written to stand alone, so a player's own coding agent can pick
one up too, which the modal invites them to do.

```
game client ──POST /feedback──▶ game server ──▶ gs://…-spectacle-feedback/new/<id>.json
                                                        │
               feedback-triage.yml, every 5 min:        ▼
               pull ──▶ triage (Gemini: file / add to / skip) ──▶ apply (→ triaged/<id>.json)
                                     │
                                     ▼
                           GitHub issue (label: feedback)
                                     │  owner adds `agent-ready`
                                     ▼
               gemini-agent.yml: branch, fix + tests, PR (agent:gemini), CI green
                                     │   (or a question on the issue)
                                     ▼
   owner / collaborator comments on the issue or PR, reviews ──▶ gemini-agent.yml: answer, push, CI
                                     │
                                     ▼
                              owner approves and merges
```

The same idea as Recipe Lanes' feedback triage and Gemini solver, adapted:
Spectacle has no database, so reports wait in a bucket; triage runs every
five minutes rather than daily; and both agents run with less within reach
(see "Safety").

## The pieces

| Piece | What it does |
|---|---|
| `client/src/FeedbackButton.tsx`, `client/src/feedback.ts` | The button (lobby header, arena HUD) and modal. Sends the message, an optional contact, and unless unticked where the player was: page, mode, room, board, rule, theme, renderer, viewport, browser. Shows the report's id afterwards. The Pages build posts to `SPECTACLE_ONLINE_URL`'s server, or offers a GitHub issue when that is unset. |
| `server/feedback.ts`, `POST /feedback` in `server/index.ts` | Validates (message ≤ 4000 chars, context fields whitelisted and capped, the rule checked by `validateRule`), rate-limits, and stores one JSON object per report under `FEEDBACK_URL`. CORS is open: there are no cookies to protect. |
| `scripts/feedback.ts` (`npm run feedback -- …`) | `pull`: the untriaged reports as the agent may see them. `mark`: the agent records a decision in `.triage/ledger.jsonl`. `apply`: moves decided reports to `triaged/`. |
| `.github/workflows/feedback-triage.yml` + `.github/gemini/feedback-triage.md` | The triage run and the agent's brief. |
| `.github/workflows/gemini-agent.yml` + `GEMINI.md`, `.gemini/agents/orchestrator.md`, `.gemini/commands/` | The agent and its brief. Woken by the owner's `agent-ready` label, a manual run, or a trusted comment: on an `agent-ready` issue (answered on the issue's open agent PR if it has one, else the issue is worked again) or on an agent PR, and a trusted review that isn't an approval. Model: `GEMINI_MODEL` variable, default `gemini-pro-latest`. |

### Storage

`FEEDBACK_URL` is `gs://bucket[/prefix]` (Cloud Run: the instance's own
service account, which may only *create* objects there) or a directory (dev,
the VM). A report is `new/<id>.json` until triaged, then
`triaged/<id>.json` with `triage: {status: filed, issue} | {status: skipped,
reason}`. Ids look like `20261002T093000Z-1a2b3c` and sort by time. If the
bucket write fails, the report goes to the log as a `feedback-unsaved` line
(without the contact) so it can be filed by hand.

### Limits

Per server process: `FEEDBACK_PER_ADDRESS` (3) reports per address and
`FEEDBACK_PER_WINDOW` (60) from everyone per `FEEDBACK_WINDOW_MS` (10 min).
The address is the first `X-Forwarded-For` hop, which can be forged; that
only dodges the per-address limit, and the total still holds. Triage takes
at most 30 reports per run.

## Safety

Reports are anonymous text, and both agents run with a shell
(`--approval-mode=yolo`), so the design assumes a report can contain a prompt
injection.

- **Triage never sees Google credentials.** `pull` and `apply` run in their
  own jobs; the agent's job has `GITHUB_TOKEN` (contents read, issues write)
  and the Gemini key, nothing else. The agent records decisions in a local
  ledger; `apply` only acts on ids that `pull` handed out.
- **Nothing public leaks.** `pull` drops the contact before the triage agent
  ever sees a report.
- **The fixer can't reach production.** It refuses to start unless a ruleset
  makes `main` take a reviewed pull request: a push to `main` deploys to
  Cloud Run and ships bot code that runs inside the servers. Its token is a
  one-hour GitHub App installation token for this repo only (contents, pull
  requests, issues; not workflows), minted just before it starts. Unlike
  Recipe Lanes, no background refresher keeps the app's private key in a
  process the agent could read. No Google credentials are on its runner.
- **Only trusted people steer it.** Only the owner's label starts it. Only
  comments by the owner and invited collaborators (author association
  `OWNER`, `MEMBER` or `COLLABORATOR`) wake it, and only theirs reach it:
  the workflow writes them to `.agent-input/` and the brief forbids fetching
  comment threads, so a stranger's comment never enters the agent's context.
  Trusted comments override the issue body; the body (often the triage
  agent's write-up of a player's report) is treated as data, never
  instructions.
- **Logs are scrubbed** of the Gemini key and the GitHub token before upload:
  artifacts on a public repo can be downloaded.
- What the agents *can* still do if subverted: the triage agent can file,
  edit or comment on issues. The fixer can push branches and open PRs, and
  can read its own one-hour token and the Gemini key.

## Labels

| Label | On | Meaning |
|---|---|---|
| `feedback` | issue | Filed by the triage agent from a player report. |
| `agent-ready` | issue | Owner: hand this to the Gemini agent. Applying it starts a run; trusted comments on it wake the agent again. |
| `agent:gemini` | PR | Opened by the Gemini agent; trusted comments and reviews on it wake the agent. |

The triage workflow creates the labels if they are missing. Everything the
agents write ends with `<!-- gemini-agent -->`.

## Setup (once, by the owner)

1. **Bucket.** Re-run the CI setup (idempotent); it now also makes the
   feedback bucket and its two grants, and prints the variable:

   ```bash
   PROJECT=spectacle-game ./deploy/gcp/setup-ci.sh
   gh variable set GCP_FEEDBACK_BUCKET --body spectacle-game-spectacle-feedback
   ```

   Then run *Deploy online arena to Cloud Run* once (Actions tab) so the
   servers get `FEEDBACK_URL`. Until then `POST /feedback` answers 503 and the
   modal offers a GitHub issue instead.

2. **Gemini key.** `gh secret set GEMINI_API_KEY` (Recipe Lanes' key works).

3. **GitHub App** for the fixer: either install the existing
   `recipelanes-agent` app on this repo too (github.com/settings/installations
   → the app → Configure → add Spectacle), or create a new app with
   Contents, Pull requests and Issues read/write and no webhook. Then:

   ```bash
   gh variable set AGENT_APP_ID --body <app id>     # recipelanes-agent: 4244739
   gh secret set AGENT_APP_PRIVATE_KEY < the-app-key.pem
   ```

4. **Protect `main`.** The fixer won't run without this. Admins (the owner)
   can still bypass it: merge with *bypass rules*, or `gh pr merge --admin`.

   ```bash
   gh api -X POST repos/bohemian-miser/Spectacle/rulesets --input - <<'EOF'
   {
     "name": "main: reviewed PRs only",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "pull_request", "parameters": {
           "required_approving_review_count": 1,
           "dismiss_stale_reviews_on_push": false,
           "require_code_owner_review": false,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false } }
     ]
   }
   EOF
   ```

5. Optional: `gh variable set SPECTACLE_ONLINE_URL --body https://…` so the
   GitHub Pages build links to (and sends feedback to) the online arena.

## Running it

- **Triage now:** Actions → *Feedback triage* → Run workflow. Most scheduled
  runs stop after one quick look at the bucket.
- **Fix an issue:** add `agent-ready` to it. Or Actions → *Gemini agent* →
  Run workflow, with the issue's number (it must carry `agent-ready`).
- **Answer it, or redirect it:** comment on the `agent-ready` issue. With no
  agent PR open yet, it works the issue again with your comment (e.g. after
  it asked you something); with one open, it updates that PR.
- **Ask for changes on its PR:** comment on the PR, or submit a review with
  inline comments. An approval doesn't wake it.
- **Change the model:** set the `GEMINI_MODEL` repo variable (default
  `gemini-pro-latest`, which follows Google's newest Pro release).
- **Who sent a report?** The issue carries its feedback id; the contact (if
  any) is only in the bucket:
  `gcloud storage cat gs://spectacle-game-spectacle-feedback/triaged/<id>.json`.
- **Re-triage a report:** move it back:
  `gcloud storage mv gs://…/triaged/<id>.json gs://…/new/<id>.json`.
- **Locally:** `FEEDBACK_URL=/tmp/fb npm run dev`, send some feedback, then
  `FEEDBACK_URL=/tmp/fb npm run feedback -- pull`.
- Agent transcripts are in each run's `gemini-*logs` artifact.
