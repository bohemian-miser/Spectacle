# Spectacle

A massively multiplayer strand-drawing game on hexagon and Spectre tilings —
the [Spectre](https://github.com/bohemian-miser/Spectre) explorer's edge rules
turned into an `.io`-style arena.

Everyone shares one very large field of tiles. You make your own **rule** — which
edge classes carry a line, and how the lines pair up inside each tile type — then
tap a tile. Your line grows from there on its own, following *your* rule from
tile to tile, faster as you score. Close a loop for a bonus. Run into a tail and
you stop. Cross someone's line and it disappears — and they can do the same to
you.

## How it plays

1. **Name and rule.** The lobby is the Tails-problem rule lab: every edge of
   every tile wears its class number (click one to switch that class on), and
   you draw the pairing by hand — drag dot to dot, click a dot to remove its
   line; lines never cross inside a tile. A level-3 patch underneath shows the
   circuits (coloured by length) and open lines the rule produces. Tiles with
   an odd number of lines are flagged as *tails* — your line will end there. *Surprise me* deals a
   random clean rule (one from the family's kernel, so every tile pairs up).
   The rules that draw one endless line exist; finding them is the game.
2. **Tap a tile.** It fades and takes your colour, and the chord nearest your tap
   starts growing out of one end, picked at random.
3. **It grows.** One tile per step; the step interval shrinks with your score
   (`baseStepMs / (1 + score × speedPerPoint)`, floored at `minStepMs`). Each tile
   entered scores `pointsPerTile`. Scoring is zero-sum: every line carries the
   points it earned, and when the line goes (cut, abandoned, capped) so do its
   points — your score is what you hold on the board. `stealFraction` hands a
   share of a cut line's points to the cutter (default 0).
4. **Circuits.** If the line arrives back at its first chord it closes. You get
   `combo × (circuitBase + lengthWeight × length + areaWeight × enclosedArea)`,
   and your combo multiplier steps up for the next one. Closed circuits stay on
   the board.
5. **Tails.** No continuation (an odd tile, a junction under `junctionPolicy:
   'stop'`, or the edge of the field) leaves the line stuck. Tap elsewhere to
   start another: every tap adds a line, all of them grow at once, and nothing
   you drew is dropped until someone cuts it (`maxLivePaths` and
   `maxCompletedCircuits` cap this if you want; both default to unlimited).
6. **Crossing.** When a line enters a tile where another player's chord crosses
   it (proper intersection, or a shared connection point — both are knobs),
   that player's whole path is wiped, with its points, and their combo resets.
   You cannot *start* on a rival's line or inside a rival's closed circuit
   (`tapOntoOthers`, `tapInsideRivalCircuits`); you have to grow into them.
   Closed circuits darken with their length on the board.
7. **New rule** = restart: your lines go, and (by default) your score too.

Every number above is a knob in [`shared/game/knobs.ts`](shared/game/knobs.ts);
set any of them with `KNOB_<NAME>` environment variables
(`KNOB_BASE_STEP_MS=250 KNOB_CROSSING_MODE=tile …`). Mechanics first, balance
later.

## Running it

```bash
npm install
npm run dev        # Vite client on :5173 (proxying /ws) + server on :8787 with 3 bots
```

Production: build the client and let the server serve it.

```bash
npm run build
PORT=8787 BOTS=2 npm start
# or
docker build -t spectacle . && docker run -p 8787:8787 -e BOTS=2 spectacle
```

Server environment:

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port |
| `FIELD_FAMILY` | `hex` | `hex` or `spectre` |
| `FIELD_LEVEL` | `6` | substitution level: hex 5 ≈ 31k tiles, 6 ≈ 242k; spectre 6 ≈ 273k |
| `FIELD_ROOT` | `Delta` | root tile of the patch |
| `BOTS` | `0` | bot players (random clean rules, occasionally aggressive) |
| `SEED` | random | RNG seed |
| `KNOB_*` | see knobs.ts | any gameplay knob |

`npm run bench:field` prints build time and size per level.

## Solo mode and GitHub Pages

The engine and the bots are plain shared code, so the whole game can run
inside one browser tab: pick *Solo, in this tab* in the lobby (or open
`/?solo`), choose the family, size and bot count, and play against bots with
nothing shared. The static build on GitHub Pages
(`.github/workflows/pages.yml`, published from `main`) is solo-only and links
to the live arena when the repository variable `SPECTACLE_ONLINE_URL` is set.
Enable Pages with the source set to *GitHub Actions* once in the repo settings.

## Hosting the online arena

The server is one always-on process while anyone is playing. Two GCP options
ship in `deploy/gcp/`; pick by what you want to pay for idle time.

**Cloud Run — scales to zero.** `./deploy/gcp/cloudrun.sh` builds the
Dockerfile with Cloud Build and deploys one instance at most, none when idle.
While people are connected you pay for one small instance; when the last one
leaves it is retired after about fifteen idle minutes, and idle costs nothing.
The free tier covers roughly fifty instance-hours a month. Cloud Run caps a
request, and so a WebSocket, at an hour; the client reconnects and resumes the
same player (`join.resume`, kept for `RESUME_GRACE_MS`, default 90 s), so
nobody notices. Cold start is a few seconds for the first arrival.

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
server/         Node + ws: one arena, ticks the engine, broadcasts batched events,
                serves dist/. bots.ts is the opposition.
client/         Vite + React: lobby with the rule editor (interactive SVG
                tiles, level-3 preview), the arena — a WebGL2 instanced tile
                layer (Canvas2D fallback) under a Canvas2D strand overlay —
                pan/zoom/tap and the HUD.
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

CI runs all three (the smoke job builds, starts the server with bots, plays a
round in Chromium and uploads screenshots).

## Next

- Tune the knobs (the point of having them): the score→speed curve currently
  rewards one long line heavily; circuit area vs length; wipe penalties.
- More than one live line, growing from both ends, or steering at junctions.
- A bigger field: the un-rooted engine from Spectre can make it effectively
  infinite; the renderer would go WebGL instanced as in the Infinite Map.
- Persistence, rooms/shards, spectating, a proper mobile layout.
