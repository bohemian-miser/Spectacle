# Player feedback → issues → agent PRs

A player presses **Feedback** in the game, writes what went wrong, and sends
it. Within about ten minutes a Gemini agent has read it against the code and
filed it as a GitHub issue (or added it to one that already covers it). The
owner hands an issue to the Gemini fixer by labelling it `agent-ready`; the
fixer opens a PR with tests and waits for CI to go green, and answers the
owner's comments and reviews on that PR. The issues are
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
               gemini-issue-solver.yml: branch, fix + tests, PR (agent:gemini), CI green
                                     │
                                     ▼
            owner comments / reviews ──▶ gemini-comment-responder.yml: answer, push, CI
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
| `.github/workflows/gemini-issue-solver.yml` + `GEMINI.md`, `.gemini/agents/orchestrator.md`, `.gemini/commands/resolve-issue.toml` | The fixer and its brief. |
| `.github/workflows/gemini-comment-responder.yml` + `.gemini/commands/address-comment.toml` | Wakes the fixer when the owner comments on or reviews (anything but an approval) one of its PRs. The thread is filtered to the owner's comments before the agent sees it. |

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
- **Nothing public leaks.** `pull` drops the contact, and an infinite-line
  rule in the context is replaced by a placeholder (they are for players to
  find). Both briefs forbid naming one, even when a player's message does.
- **The fixer can't reach production.** It refuses to start unless a ruleset
  makes `main` take a reviewed pull request: a push to `main` deploys to
  Cloud Run and ships bot code that runs inside the servers. Its token is a
  one-hour GitHub App installation token for this repo only (contents, pull
  requests, issues; not workflows), minted just before it starts. Unlike
  Recipe Lanes, no background refresher keeps the app's private key in a
  process the agent could read. No Google credentials are on its runner.
- **Only the owner's label starts the fixer** (`github.event.sender.login ==
  github.repository_owner`), and only the owner's comments wake the
  responder, which is handed a queue of the owner's comments alone (filtered
  in the workflow, outside the model). The owner's comments on an issue
  override its body; nobody else's text is treated as instructions.
- **Logs are scrubbed** of the Gemini key and the GitHub token before upload:
  artifacts on a public repo can be downloaded.
- What the agents *can* still do if subverted: the triage agent can file,
  edit or comment on issues. The fixer can push branches and open PRs, and
  can read its own one-hour token and the Gemini key.

## Labels

| Label | On | Meaning |
|---|---|---|
| `feedback` | issue | Filed by the triage agent from a player report. |
| `agent-ready` | issue | Owner: hand this to the Gemini fixer. Applying it starts a run. |
| `agent:gemini` | PR | Opened by the Gemini fixer; the owner's comments on it wake the responder. |

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
- **Fix an issue:** add `agent-ready` to it. Or Actions → *Gemini issue
  solver* → Run workflow, with a number or blank for the oldest eligible.
- **Ask for changes:** comment on the agent's PR, or submit a review with
  inline comments. An approval doesn't wake it.
- **Who sent a report?** The issue carries its feedback id; the contact (if
  any) is only in the bucket:
  `gcloud storage cat gs://spectacle-game-spectacle-feedback/triaged/<id>.json`.
- **Re-triage a report:** move it back:
  `gcloud storage mv gs://…/triaged/<id>.json gs://…/new/<id>.json`.
- **Locally:** `FEEDBACK_URL=/tmp/fb npm run dev`, send some feedback, then
  `FEEDBACK_URL=/tmp/fb npm run feedback -- pull`.
- Agent transcripts are in each run's `gemini-*logs` artifact.
