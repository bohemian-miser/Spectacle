<div align="center">

# ~Spectacle~ hexagon.rodeo

(I wanted to call it Spectacle after the Spectre tile, but 'hexagon.rodeo' was available as a domain! I couldn't say no...)

**A massively multiplayer strand-drawing game on hexagon and Spectre tilings.**

<h2>
  <a href="https://spectacle-iclxjyodzq-uc.a.run.app">▶&nbsp; Play the live arena</a>
</h2>

<a href="https://spectacle-iclxjyodzq-uc.a.run.app"><img alt="Play online" src="https://img.shields.io/badge/PLAY%20ONLINE-live%20arena-2f6fdb?style=for-the-badge"></a>
&nbsp;
<a href="https://bohemian-miser.github.io/Spectacle/"><img alt="Play solo" src="https://img.shields.io/badge/PLAY%20SOLO-in%20your%20browser-3aa655?style=for-the-badge"></a>

<sub>Online: everyone on one shared field, bots included. Solo: the same engine and bots running entirely in your tab, no server.</sub>

<br><br>

<a href="https://spectacle-iclxjyodzq-uc.a.run.app"><img src="docs/images/arena-hex.png" alt="A hexagon arena mid-game: coloured tiles, players' lines and closed circuits, the HUD and the leaderboard" width="100%"></a>

</div>

---

The [Spectre](https://github.com/bohemian-miser/Spectre) explorer's edge rules,
turned into an `.io`-style arena. Everyone shares one very large field of
tiles. You design your own **rule** — which edges carry a line, and how the
lines pair up inside each tile — then tap a tile. Your line grows from there on
its own, following *your* rule from tile to tile, faster the more you hold.
Close a loop and you score; run into a dead end and you stop; cross someone's
line and you both die.

## The game in 30 seconds

| | |
|---|---|
| 🧬 **Design a rule** | Switch edge classes on and drag dot to dot to pair them up inside each tile type. The preview shows the loops and loose ends your rule makes. |
| 👆 **Tap a tile** | Your line starts there and grows by itself, one tile per step, following your rule. Press-and-hold then drag to paint starts across an area. |
| ⭕ **Close circuits** | A line that comes back to where it began is a circuit: points for length and enclosed area, and your combo climbs. Run edge to edge and you claim the smaller side of the field. |
| ⚔️ **Cut and be cut** | Lines that cross both die, taking their points with them — scoring is zero-sum. You can't start on a rival's line; you have to grow into it. |
| 🏴 **Capture** | Close a circuit round a rival's line and it's yours. In **Normal** mode it turns into your own pattern on their tiles; in **Conquest (beta)** you take their pattern itself, a new way to draw. Either way, each new kind of line you capture is another head growing at once. |
| 🔍 **Discover** | Somewhere in the rule space are rules that draw one endless line. Nobody will tell you which. |

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/images/rule-tiles.png" alt="The rule lab: one card per tile type, edge class numbers round each tile and the pairing drawn as blue chords"></td>
<td width="50%"><img src="docs/images/rule-preview.png" alt="The level-3 patch preview: circuits and open lines the rule produces"></td>
</tr>
<tr>
<td><b>The rule lab.</b> Every edge wears its class number; click one to switch that class on everywhere, drag dot to dot to pair lines up. Odd tiles are tails.</td>
<td><b>The preview.</b> A level-3 patch drawn with your rule: closed circuits coloured by length, open lines in red. <i>Random solution</i> deals a random clean rule.</td>
</tr>
<tr>
<td><img src="docs/images/arena-closeup.png" alt="The arena zoomed in: hexagons with rotation arrows, the faint rule pattern and players' circuits"></td>
<td><img src="docs/images/arena-spectre-dark.png" alt="A Spectre-tiling arena in the dark theme"></td>
</tr>
<tr>
<td><b>Up close.</b> Each hexagon's arrow says which way it is turned; your rule's pattern is sketched faintly on the tiles still free.</td>
<td><b>Spectre tilings, dark theme.</b> The same game on the aperiodic Spectre monotile — every tile type in the explorer's own colours.</td>
</tr>
<tr>
<td><img src="docs/images/arena-teams.png" alt="Team colours: your lines blue, every rival red"></td>
<td><img src="docs/images/settings.png" alt="The settings panel over a live board"></td>
</tr>
<tr>
<td><b>Team colours</b> (on by default; press <kbd>T</kbd>): you in blue, everyone else in red.</td>
<td><b>Settings apply live</b> — theme, five circuit-colour styles, a plain board and team colours (both on by default).</td>
</tr>
</table>

## Controls

| Action | Mouse | Touch | Keys |
|---|---|---|---|
| Start a line | click a tile | tap a tile | |
| Paint starts across an area | hold still ~0.3 s, then drag | hold, then drag | |
| Pan | drag · right/middle/shift-drag | drag · two fingers | |
| Zoom | wheel | pinch | |
| Pick the pattern you draw with | click a tab (bottom left) | tap a tab | <kbd>1</kbd>–<kbd>9</kbd> |
| Team colours | ⚙ Settings | ⚙ Settings | <kbd>T</kbd> |

## The rules in full

1. **Name and rule.** The lobby is the Tails-problem rule lab: every edge of
   every tile wears its class number (click one to switch that class on), and
   you draw the pairing by hand — drag dot to dot, click a dot to remove its
   line; lines never cross inside a tile. A level-3 patch underneath shows the
   circuits (coloured by length) and open lines the rule produces. Tiles with
   an odd number of lines are flagged as *tails* — your line will end there. *Random solution* deals a
   random clean rule (one from the family's kernel, so every tile pairs up).
   The rules that draw one endless line exist; finding them is the game.
2. **Tap a tile.** It fades and takes your colour, and the chord nearest your tap
   starts growing out of one end, picked at random. Or **press and hold**
   (finger or mouse) for a moment, then drag: every tile you pass over becomes
   the next start, tapped as soon as you have a head free — sweep across an
   area you hold to keep filling it in. A plain drag pans (so do two fingers,
   or a right-, middle- or shift-drag); wheel or pinch zooms.
3. **It grows.** One tile per step; the step interval shrinks with your score
   (in tiles per second, `(1000 / baseStepMs) × (1 + score × speedPerPoint) / speedDivisor + speedOffset`
   — 5.5 tiles/s at score 0 — capped at `maxSpeed` = 500 tiles/s on a 242k-tile field, scaled by the
   log of the field's tile count). Each tile
   entered scores `pointsPerTile`. Scoring is zero-sum: every line carries the
   points it earned, and when the line goes (cut, abandoned, capped) so do its
   points — your score is what you hold on the board. `stealFraction` hands a
   share of a cut line's points to the cutter (default 0).
4. **Circuits.** If the line arrives back at its first chord it closes. You get
   `combo × (circuitBase + lengthWeight × length + areaWeight × enclosedArea)`,
   and your combo multiplier steps up for the next one. Closed circuits stay on
   the board.
5. **Tails.** No continuation (an odd tile, a junction under `junctionPolicy:
   'stop'`, or the edge of the field) leaves the line stuck. You have one head
   at a time (`maxHeads`, default 1): a tap while your line is still growing is
   refused, and once it closes, sticks or dies you tap again to start the next.
   Nothing you drew is dropped until someone cuts it (`maxLivePaths` and
   `maxCompletedCircuits` cap this if you want; both default to unlimited).
   Lines block chords, not tiles: a tap on a tile a line already runs through
   starts on the nearest chord of it that no line is on or crosses. The one
   exception is a line of another of your patterns, which keeps its whole
   tile. Tapping the first chord of a line that ran off the edge of the field
   turns it round to grow out of its other end. A line that runs edge to edge cuts the
   field in two and closes like a circuit, claiming the smaller side (scored
   on that side's area).
   A growing line runs on over the top of your own lines rather than stopping,
   so start one off to the side and grow it in: layered lines are defence in
   depth — a rival has to cut each of them. If it meets one of your lines'
   loose ends on the same chord, the two join into one line (nothing is scored
   twice); two lines that each ran off the edge join into one edge-to-edge
   line and claim their side. `overlapOwnLines` off (`KNOB_OVERLAP_OWN_LINES=0`)
   is the older mode: a line that runs into your own stops there, and your own
   lines block only the chords they are on, like a rival's.
   Your lines of *different* patterns never pile up on one tile, though:
   where two of them meet, the one you started later wins. The tile they met
   on flips to the newer pattern, and the flip then travels along the older
   line a tile at a time, at your speed, until all of it is the new pattern.
   Pieces of the new pattern sprout on every flipped tile and grow on by
   themselves (without taking up a head), flipping any older line of yours
   they reach, so the newest pattern you draw spreads through everything of
   yours it touches. All the pieces of your flips share one head's worth of
   speed between them (`flipPieceHeads`), so a flip spreads at your pace
   rather than all at once. `flipOwnLines` off (`KNOB_FLIP_OWN_LINES=0`)
   layers them instead.
   Losing your head in a collision costs `respawnDelayMs` (500 ms) before the
   next tap lands.
6. **Crossing.** When a line enters a tile where another player's chord crosses
   it (proper intersection, or a shared connection point — both are knobs),
   both lines die — the one that was hit and the one that hit it — each with
   its points, and both combos reset (`mutualCut`; off makes it one-sided).
   You cannot *start* on a rival's line or inside a rival's closed circuit
   (`tapOntoOthers`, `tapInsideRivalCircuits`); you have to grow into them.
   Closed circuits take their colour from their length — short loops pale,
   long ones deep, the hue walking round from the owner's colour as they grow
   — and wash the tiles they enclose in it. The washes stack and each level of
   nesting sinks deeper, so a circuit inside a circuit stands apart.
7. **Capture.** What happens depends on the game mode, picked in the lobby
   (`?mode=normal` or `?mode=conquest` preselects it). Online, each mode has
   its own rooms of up to 10 players; a new room opens when they fill.

   **Normal** (the default): close a circuit round a rival's line and it is
   converted — it leaves the board, and your own pattern sprouts on the
   tiles it held, carrying its points (zero-sum) and growing on from there
   like a flip's pieces. You never draw with anyone else's pattern, but each
   new kind of line you convert gives you another head, exactly as in
   Conquest.

   **Conquest (beta)**: close a circuit round a rival's line and you take its pattern
   (the rule that drew it) — and the area is yours: every rival line wholly
   inside, loops and claims included, changes hands with the points it
   carries (`takeEnclosed`; off, they keep their lines). The pattern becomes yours to draw with,
   in a colour two thirds yours and one third theirs. Your patterns sit as
   tabs on the left wall, bottom left — the one sticking out furthest is
   active, and your next tap draws with it (click a tab, or press 1–9). Only
   the active pattern is sketched on the tiles no rival has touched (your own
   included). Holding a captured
   pattern also gives you a second head (`headsWithCapture`, default 2): two
   lines growing at once, from any mix of your patterns. Every further kind
   of line you capture adds another head, up to 12 (`headPerCapture`,
   `maxHeadsTotal`; `KNOB_HEAD_PER_CAPTURE=0` turns it off)
   (`captureOnEnclose`, `maxCapturedPatterns`, default 11).
8. **New rule** = restart: your lines and captured patterns go, and (by
   default) your score too. Once you hold a captured pattern, the rule
   screen also offers **Swap for …**: the rule you just built takes that
   pattern's slot (and its head, and its colour), and every line drawn with
   the old pattern goes — with the points it had earned. Your own rule, its
   lines and your other patterns stay.

**Which way a tile is turned.** Every hexagon in the arena is the same regular
hexagon, so nothing in its outline says which of the six rotations it is sitting
in — while its edge classes are numbered from edge 0 round. Zoom in and each one
wears a faint arrow pointing at that edge; the tiles in the rule lab wear the
same arrow, so their numbers can be read straight off the board. (A Spectre's
outline already shows its rotation, so it goes without.)

**The colours are Spectre's.** Every tile type wears the colour it has in the
[Spectre](https://github.com/bohemian-miser/Spectre) explorer's original table —
Xi yellow, the Gammas white, Pi sky blue, Phi green — on the board, in the rule
lab and in the patch preview alike, and the panels around them use the
explorer's tokens, so the two sites look like one.

**Settings.** The ⚙ button in the lobby header (and in the arena HUD) opens a
small panel; every change applies at once, behind it. **Circuit colours**
picks how loops and the areas inside them are shaded (A owner ramp, B length
palette, C depth bands, D contour stripes, E depth heatmap; `?circuits=a…e`
forces one). **Plain board** hides the tile colours and arrows, leaving the
arena's edge, the faint tile outlines when zoomed in and your rule's pattern.

**Light or dark** (also in Settings) flips the whole game, board included: outlines, the halo on your line and how far the
tiles are sat back are part of the scheme, not just the panels. Light shows the
tile colours as they are; dark dims them together — the hues never move — so the
strands on top still carry. Light is the default; your choice is remembered in
this browser, and `?theme=dark` / `?theme=light` forces one for a link or a
screenshot.

Every number above is a knob in [`shared/game/knobs.ts`](shared/game/knobs.ts);
set any of them with `KNOB_<NAME>` environment variables
(`KNOB_BASE_STEP_MS=250 KNOB_CROSSING_MODE=tile …`). Mechanics first, balance
later.

## Infrastructure

```mermaid
flowchart LR
  subgraph players["Players"]
    B1["Browser<br/>React + Canvas / WebGL2"]
    B2["Browser (solo)<br/>engine + bots in the tab"]
  end
  subgraph gcp["GCP · spectacle-game · us-central1"]
    CR["Cloud Run<br/>Node + ws · rooms per mode<br/>50 ms tick · bots<br/>scales to zero"]
  end
  subgraph gh["GitHub"]
    CI["Actions: ci.yml<br/>typecheck · tests · build<br/>Docker · headless smoke"]
    PUB["publish.yml → GHCR image"]
    DEP["deploy-cloudrun.yml<br/>Workload Identity, no keys"]
    PG["pages.yml → GitHub Pages<br/>solo-only static build"]
  end
  B1 <-- "WebSocket /ws<br/>events + resume tokens" --> CR
  PG -. static files .-> B2
  CI --> PUB
  DEP -- "build + deploy on merge to main" --> CR
```

- **One authoritative server.** Node + [`ws`](https://github.com/websockets/ws)
  runs the engine on a 50 ms tick and broadcasts batched events. The field is
  deterministic from `(family, level, rootTile)`, so only that spec travels;
  clients draw lines from the event stream without knowing anyone's rule.
- **Cloud Run, scale to zero — and scale out.** None when idle, up to
  `SPECTACLE_MAX_INSTANCES` (default 30) under a surge; every instance is a
  self-contained pool of rooms (see "Scaling for a surge" below). The hourly
  WebSocket cap is invisible while one instance is running: the client
  reconnects and resumes the same player with a single-use token (kept for 5
  minutes). With several instances that resume, and `?room=` invite links,
  depend on reaching the same one — see the caveat below.
- **Keyless CI.** Every merge to `main` builds the image and deploys it through
  Workload Identity Federation pinned to this repository — there is no
  service-account key anywhere.
- **Pages.** The same engine and bots compiled into a static, solo-only build.
- **Alternative host.** A free `e2-micro` VM with Caddy (TLS) and Watchtower
  (auto-pull from GHCR) — see below.

## Running it yourself

```bash
npm install
npm run dev        # Vite client on :5173 (proxying /ws) + server on :8787 with 3 bots
```

Production: build the client and let the server serve it.

```bash
npm run build
PORT=8787 BOTS=1 npm start
# or
docker build -t spectacle . && docker run -p 8787:8787 -e BOTS=1 spectacle
```

Server environment:

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port |
| `FIELD_FAMILY` | `hex` | `hex` or `spectre` |
| `FIELD_LEVEL` | `6` | substitution level: hex 5 ≈ 31k tiles, 6 ≈ 242k; spectre 6 ≈ 273k |
| `FIELD_ROOT` | `Delta` | root tile of the patch |
| `BOTS` | `1` | bots per room: a number (that many wanderers) or kinds, e.g. `bridge+hunter:2+farmer` — see "Bots" below |
| `BOTS_NORMAL`, `BOTS_CONQUEST` | `BOTS` | the same, for one game mode's rooms |
| `BOT_ROTATE_MS` | `300000` | how long a rotator keeps a rule before starting over |
| `BOT_INFINITE_LINES` | `0` | `1` lets bots play the infinite-line rules (off: those are for players to find) |
| `ROOM_SIZE` | `10` | humans per room; the next joiner of that mode gets a new room |
| `MAX_ROOMS` | `80` | rooms at most, all modes; past it joiners share the emptiest room of their mode |
| `ROOM_IDLE_MS` | `60000` | an extra room nobody is in (or holding for) closes after this long |
| `MAX_INSTANCE_PLAYERS` | `400` | humans this **process** holds before it refuses new joins (`error.code: 'full'`) — see "Scaling for a surge" |
| `SEED` | random | RNG seed |
| `KNOB_*` | see knobs.ts | any gameplay knob |

`npm run bench:field` prints build time and size per level.

## Bots

Five kinds, mixed freely — on the server with `BOTS` (e.g.
`BOTS=bridge+hunter:2`; use `+` rather than commas in Cloud Run env vars),
in solo with the lobby's picker (or `/?solo&bots=bridge+farmer`):

| Kind | What it does |
|---|---|
| **Wanderer** | a random clean rule, random taps, now and then right beside a rival's line — the easy one |
| **Rotator** | a wanderer that starts over with a new rule every ~5 minutes (`BOT_ROTATE_MS`, ±25%) |
| **Hunter** | picks on the leader: looks ~40 steps ahead from the tiles round their lines and taps where its line would hit theirs soonest |
| **Farmer** | a rule that reliably closes small loops, a quiet corner of the board, and only taps where both ways round close without touching anyone |
| **Bridge** | a rule that draws long thin lines; plans one through the busiest stretch of board and keeps tapping its middle — rebuilding what gets cut, cutting what's in the way, and turning a half that ran off the edge round so it can finish as an edge-to-edge claim |

The farmer's and bridge's rules come from a scout that tries a spread of
clean rules on the field once (~0.2 s at hex level 6, at startup).
`npx tsx scripts/bot-arena.ts bridge,hunter:2 5 5` plays bots against each
other headless for 5 simulated minutes and prints scores, circuits,
collisions and what the bots cost per tick.

## Solo mode and GitHub Pages

The engine and the bots are plain shared code, so the whole game can run
inside one browser tab: pick *Solo, in this tab* in the lobby (or open
`/?solo`), choose the family, size and which bots, and play against them with
nothing shared. The static build on GitHub Pages
(`.github/workflows/pages.yml`, published from `main`) is solo-only and links
to the live arena when the repository variable `SPECTACLE_ONLINE_URL` is set.
Enable Pages with the source set to *GitHub Actions* once in the repo settings.

## Hosting the online arena

The server is one always-on process while anyone is playing. Two GCP options
ship in `deploy/gcp/`; pick by what you want to pay for idle time.

**Cloud Run — scales to zero.** Run `PROJECT=<gcp project> ./deploy/gcp/setup-ci.sh`
once; it creates a deployer service account, a Workload Identity pool that only
this repo may use, and prints the GitHub variables to add. Nothing it prints is
secret — GitHub's OIDC token is swapped for a short-lived GCP one at deploy
time, so there is no key to leak or rotate. From then on every merge to `main`
builds the image and deploys it (`.github/workflows/deploy-cloudrun.yml`) —
nobody needs GCP credentials day to day, and the workflow is skipped until
`GCP_PROJECT` is set.
`./deploy/gcp/cloudrun.sh` does the same by hand from a laptop. Either way:
one small instance is enough for ordinary traffic, none when idle, and Cloud
Run adds more on its own if a surge needs them (see "Scaling for a surge").
While people are connected you pay for the instances actually running; when
an instance's last player leaves it is retired after about fifteen idle
minutes, and idle costs nothing. The free tier covers roughly fifty
instance-hours a month. Cloud Run caps a
request, and so a WebSocket, at an hour; the client reconnects and resumes the
same player (`join.resume`, kept for `RESUME_GRACE_MS`, default 5 min), so
nobody notices. A page refresh does the same: the tab keeps its resume ticket
in `sessionStorage`, and the server rotates the token on every resume. Cold start is a few seconds for the first arrival.

*Watching it.* `/status` on the arena's address is a read-only page: rooms and
who is in them, memory, how long a loop pass takes, joins, drops and errors,
and the recent log (the same lines go to Cloud Run's logs). Every merge to
`main` redeploys, and a redeploy drops everyone connected and starts an empty
board, so merge when nobody is playing.

*Which patterns people play.* Set `STATS_KEY` and `/patterns?key=…` shows, per
rule and mode, how many stints (one player on one rule) it had, the time spent
on it, best and mean final score, and circuits — people and bots apart. It is
off without the key, and never on `/status`. Every finished stint is also one
JSON line in the logs (`jsonPayload.message="stint"` in Cloud Logging), which
outlives restarts and covers every instance (the page shows only the instance
that answered); on the VM, `STATS_FILE` keeps the table in a file.

*Private rooms.* `/?room=anything` puts everyone who opens it in the same room
(a new one by that name if none exists); matchmaking never sends strangers
in. The share icon beside the exit in the arena copies the link to the room you are in.

*A domain for Cloud Run.* Buy one anywhere — Cloudflare Registrar sells at
cost with free DNS — then run `DOMAIN=play.example.com ./deploy/gcp/domain.sh`
(`WWW=1` adds `www.`). The first run has you verify the root domain in Search
Console with a TXT record; the second creates a Cloud Run domain mapping and
prints the DNS records to add. Set them *DNS only* on Cloudflare (not
proxied). Google issues the certificate once they resolve. A mapping has no
standing cost, unlike a load balancer (~$18/month idle), and passes WebSockets
through; Firebase Hosting in front would not. Finally set
`SPECTACLE_ONLINE_URL` to the new address so the Pages build links to it.

**A free `e2-micro` VM — always on.** One `e2-micro` in `us-west1`,
`us-central1` or `us-east1` is in the always-free tier, so idle is free
anyway and there is nothing to scale down; it just keeps the arena warm.

1. Merges to `main` publish the image to `ghcr.io/bohemian-miser/spectacle`
   (`.github/workflows/publish.yml`). Make that package **public** once in the
   repo's Packages settings so the VM can pull it without credentials.
2. With `gcloud` logged in and a project selected:
   ```bash
   ./deploy/gcp/create-vm.sh                                  # HTTP on the VM's IP
   DOMAIN=spectacle.example.com ./deploy/gcp/create-vm.sh     # HTTPS via Caddy
   ```
   The startup script installs Docker, adds 1 GB of swap, and runs
   [`deploy/gcp/docker-compose.yml`](deploy/gcp/docker-compose.yml): the game,
   Caddy in front (TLS when a domain is set), and Watchtower, which pulls the
   new image within five minutes of a publish and restarts the game. A restart
   wipes the arena — fine for now, and the reason persistence is on the list.
3. Tune without redeploying: edit `/opt/spectacle/.env` on the VM (`BOTS`,
   `FIELD_*`, any `KNOB_*`), then `docker compose up -d` there.

Stop the VM: `gcloud compute instances stop spectacle --zone us-central1-a`.
Either way, egress beyond the free 1 GB/month is the only cost that scales
with players.

## Scaling for a surge

The game shares one authoritative field per player, so a room can't be split
across machines — but it doesn't need to be. Every room is entirely
self-contained (its own engine, its own players), so one server process can
run many independent rooms at once, and many server processes can each run
their own independent pool of rooms with nothing shared between them. Each
open WebSocket counts against an instance's `--concurrency` (default 500);
once an instance holds that many, Cloud Run sends new connections to another
instance or starts one (`SPECTACLE_MAX_INSTANCES`, default 30 — raising it
costs nothing while idle, since Cloud Run only bills for instances actually
running).

What keeps any *one* instance safe is `MAX_INSTANCE_PLAYERS` (default 400,
a little under `--concurrency` because lobby sockets count too): once an
instance is home to that many humans, it refuses the next join outright —
cheaply, before doing any of the work a real join takes — rather than
holding more than one vCPU and `--memory=1Gi` allow. The refusal comes back
on the socket the player is already connected on, so it is not rerouted; it
names itself (`error.code: 'full'`) so the client can offer bots.

**The catch with more than one instance.** A `?room=` invite link's room,
and a dropped player's resume ticket, live in the memory of one instance.
Cloud Run's session affinity is a best-effort cookie per browser, so a
reconnect usually gets back to the same instance but isn't guaranteed to
(a miss joins as a new player), and a *friend* following an invite has no
way to reach the inviter's instance at all — they can land on another one
and find an empty room of the same name. While traffic fits on one instance
(the usual case) none of this shows. Setting `SPECTACLE_MAX_INSTANCES=1`
keeps invites and resume exact, at the price of capping the online arena at
one instance's players (everyone past it is offered bots).

That refusal is also where the client's own fallback kicks in: the lobby
shows the reason and a **Play bots instead** link straight away, and if the
arena is simply unreachable (down, overloaded, a bad network) rather than
explicitly full, the client offers the same link after a few seconds of
failed reconnect attempts — both in the lobby and, mid-game, in the
"Reconnecting…" overlay. One click switches to the same engine and bots
running entirely in the tab: no server round trip, nothing to be too busy
for. It is the same code path as the *Solo, in this tab* button, so it is
exactly as reliable as `npm run build`. The GitHub Pages build
(`bohemian-miser.github.io/Spectacle`) is this same fallback with nothing to
overload in the first place — it is a static file, served from a CDN, with
no server behind it at all, so there is no meaningful traffic level that
takes it down. Sharing that link alongside the online one means a spike in
interest is never a reason nobody can play.

Ahead of an expected spike, without touching code:

- Raise `SPECTACLE_MAX_INSTANCES` (repo variable) well above the default 30
  if you expect enough concurrent players to need it — each instance holds
  up to `MAX_INSTANCE_PLAYERS`, so instances × that is the real ceiling.
- Set `SPECTACLE_MIN_INSTANCES` to 1 or more so the first arrivals never pay
  a cold start (a few seconds to build the field) while Cloud Run scales up
  from zero; unset (0) is the usual scale-to-zero default.
- `SPECTACLE_MAX_INSTANCE_PLAYERS` (default `400`), `SPECTACLE_CONCURRENCY`
  (default `500`) and the instance's size move together. A local load test
  measured 80 simulated players at ~10% of a core and ~30 MB on top of the
  ~540 MB a `FIELD_LEVEL=6` field costs at idle, so 400 players is about half
  of one vCPU and well inside `1Gi`. For more per instance, raise CPU as well
  as memory (e.g. `--cpu=2 --memory=2Gi` for a cap of 800).
- All of these are repo variables read by `.github/workflows/deploy-cloudrun.yml`,
  or `MAX_INSTANCES=… MIN_INSTANCES=… MEMORY=… CONCURRENCY=… MAX_INSTANCE_PLAYERS=… ./deploy/gcp/cloudrun.sh`
  by hand. `gcloud run services update spectacle --region … --update-env-vars MAX_INSTANCE_PLAYERS=…`
  changes a live service without a rebuild, but it starts a new revision
  (rooms reset) and the next CI deploy puts the repo variables back.

None of this needs guessing at "100,000 people" in advance: the defaults
already fail closed rather than falling over, the client already knows what
to do about it, and the knobs above are there for whenever real numbers say
to turn them up.

## How it is built

```
shared/tiles/   the Spectre core, vendored verbatim (geometry, families, seams,
                matchings, chords, kernel subsets) — runs identically in the
                server, the browser and the tests
shared/game/    field.ts     one finite patch: instances, vertex-neighbours, hit grid
                rule.ts      PlayerRule = (subset, matching), validation, random clean rules
                strand.ts    follow a strand tile to tile under a rule; conflict test
                engine.ts    the authoritative simulation (taps, ticks, circuits, cuts)
                knobs.ts     every tunable
                protocol.ts  wire types
server/         Node + ws: rooms per game mode (a new one every ROOM_SIZE humans),
                ticks each engine, broadcasts batched events per room,
                serves dist/. bots.ts is the opposition.
client/         Vite + React: lobby with the rule editor (interactive SVG
                tiles, level-3 preview), the arena — a WebGL2 instanced tile
                layer (Canvas2D fallback) under a Canvas2D strand overlay —
                tap/paint/pan/zoom and the HUD.
```

The server is authoritative and the field is deterministic from its spec, so a
client only ever receives the spec plus a stream of events (`step`, `wipe`,
`circuit`, `score`, …) with world-space geometry; it draws everyone's lines
without knowing everyone's rule.

Following a strand is purely local (the Infinite Map's tap-to-trace walk, per
player): a tile's chords depend only on its type and the rule, and consecutive
chords meet at a connection point on the shared seam. The unit tests pin this
walker against the Spectre core's global weld-and-trace (`analyze`) — the
circuits it finds walking from every chord are exactly the oracle's, on both
families.

## Tests

```bash
npm test                 # vitest: field, strand-vs-oracle, engine mechanics, rule validation
npm run typecheck
PW_EXE=/path/to/chromium npx tsx scripts/smoke.ts   # headless round against a running server
```

The README's screenshots come from `scripts/readme-shots.ts` (start a hex and a
spectre server with bots, then run it; the header of the script has the
commands) and live in `docs/images/`.

CI runs all three (the smoke job builds, starts the server with bots, plays a
round in Chromium and uploads screenshots).

## Next

- Tune the knobs (the point of having them): the score→speed curve currently
  rewards one long line heavily; circuit area vs length; wipe penalties.
- More than one live line, growing from both ends, or steering at junctions.
- A bigger field: the un-rooted engine from Spectre can make it effectively
  infinite; the renderer would go WebGL instanced as in the Infinite Map.
- Persistence, rooms/shards, spectating, a proper mobile layout.
