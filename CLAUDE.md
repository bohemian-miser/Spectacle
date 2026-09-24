# Spectacle — working notes for Claude (and anyone else)

Read this first. It is the map of the project, the decisions that are settled,
and the traps. The README is the player/operator view; this is the engineer's.

## What the game is

A massively multiplayer strand-drawing game on hexagon and Spectre tilings,
grown out of the [Spectre](https://github.com/bohemian-miser/Spectre) explorer
(the Tails problem, edge classes, seams, matchings, FASS curves). Players
build a *rule* — which edge classes carry a line, and how the lines pair up
inside each tile type — then tap a tile; a line grows on its own following
their rule tile to tile. Circuits score, tails stop you, collisions kill
lines, and scoring is zero-sum (a line's points leave with it). Mechanics
first; balance later, through knobs.

## Layout

```
shared/tiles/     Spectre's web/src/core vendored VERBATIM (geom, families,
                  edges, tiles, matchings, circuits, outline, colors, subsets).
                  Never edit in place — re-copy from Spectre. Pure, no DOM.
shared/game/      The game. Pure TypeScript; runs in server, browser, tests.
  field.ts        One finite substitution patch (flatten order = tile index).
                  Vertex-neighbour CSR, hit grid, pointInPolygon, polygonArea.
  rule.ts         PlayerRule = (subset, matching index per leaf type).
                  validateRule (rejects crossing/out-of-range), defaultRule
                  (selection 15), fassRule (tests only — see "settled"), random
                  clean rules from the kernel.
  strand.ts       Per-rule chord tables; stepForward/continuations (the local
                  walk); chordsConflict; walkStrand (test oracle).
  pairs.ts        Hand-drawn pairings ↔ matching index; topological crossing.
  engine.ts       Authoritative simulation: players, paths, tap, tick, cuts,
                  circuits, zero-sum points, tap restrictions. Deterministic
                  given its Rng. No I/O.
  bots.ts         Bots: random clean rules, tap with a head to spare, aim
                  beside rivals, draw with any captured pattern.
  color.ts        mixHsl — a captured pattern's colour.
  knobs.ts        EVERY tunable, with KNOB_* env override (knobsFromEnv).
  protocol.ts     Wire types. Server → client: hello, welcome(+resume token),
                  events (step/wipe/circuit/score/status/join/leave/rule/
                  capture/convert/take/swap/active/split/refused). Client → server adds
                  `pattern` and `swap`.
server/index.ts   Node + ws. Rooms per game mode (`Room`: engine + bots +
                  clients), one 50 ms loop ticking them all, batched broadcast
                  per room, static dist/, resume tokens (RESUME_GRACE_MS),
                  env config, guard() round every message/tick, note() log.
                  tests/rooms.test.ts spawns it.
server/status-page.ts  /status (HTML, polls /status.json): rooms, players,
                  memory, loop time, joins/drops/errors, the recent log.
server/pattern-stats.ts  Which rules people play and how they score: a
                  stint per (player, rule), sampled once a second; rows per
                  (mode, rule, bot). /patterns(.json)?key=STATS_KEY, a JSON
                  `stint` line per finished stint on stdout, STATS_FILE.
client/src/       Vite + React.
  App.tsx         Mode (online | solo), connection lifecycle, rejoin/resume.
  session.ts      The tab's resume ticket (sessionStorage) and the
                  once-per-browser help flag (localStorage).
  net.ts          WebSocket GameConnection. local.ts: LocalConnection = the
                  same engine + bots inside the tab (solo mode / Pages build).
  store.ts        Applies events into plain mutable state; version counters.
  Lobby.tsx, RuleEditor.tsx, TileThumb.tsx (interactive SVG tile: edge
                  numbers, drag dot→dot), PatchPreview.tsx (level-3 analyze(),
                  cropped to ~97% tiles, arrows, edge-number toggle).
  Arena.tsx       Two stacked canvases + pointer handling + HUD. A lone
                  pointer taps, drags to pan, or held still for `HOLD_MS`
                  (300 ms) paints (each tile entered is the next tap, sent
                  once `store.hasFreeHead()`, ≥120 ms apart for the server's
                  100 ms throttle, refusals muted). Two fingers or
                  right/middle/shift-drag always pan.
  theme.ts        Light/dark: data-theme on <html>, localStorage, ?theme=,
                  and readBoardTheme() — the canvas half of the scheme, read
                  back out of the CSS tokens.
  settings.ts     Board display settings (localStorage): circuit style a–e
                  (?circuits= overrides), plain board and team colours (both
                  on by default). SettingsButton.tsx is
                  the ⚙ button + modal (theme, circuit colours, plain board).
  styles.css      Spectre's explorer tokens, both schemes, incl. the board
                  knobs (--tile-*, --board-*, --strand-darken).
  render.ts       Camera, tint sync, Canvas2D strand overlay.
  tiles-gl.ts     WebGL2 instanced tile layer. tiles-2d.ts: Canvas2D fallback.
  tiles-layer.ts  TileLayer interface, typeFill (Spectre's own tile palette),
                  colour helpers, directionArrow (a tile's rotation).
tests/            vitest. strand.test.ts pins the local walker against the
                  core's global analyze() — the most important test here.
                  resume.test.ts spawns the real server.
scripts/smoke.ts  Headless Chromium round (needs PW_EXE or playwright browsers).
scripts/readme-shots.ts  Regenerates docs/images/ (the README's screenshots).
deploy/gcp/       Cloud Run (CI workflow + setup-ci.sh, domain.sh), e2-micro VM
                  (create-vm.sh, startup.sh, compose with Caddy + Watchtower).
.github/workflows ci.yml (typecheck, tests, build, image build, smoke online +
                  solo), publish.yml (GHCR image), pages.yml (solo build),
                  deploy-cloudrun.yml (skipped until GCP_PROJECT var is set).
```

## Commands

```bash
npm install
npm run dev              # vite :5173 + server :8787 with 3 bots
npm test                 # vitest (≈1.5 s)
npm run typecheck
npm run build            # → dist/, served by the server
PORT=8787 BOTS=3 FIELD_LEVEL=5 npx tsx server/index.ts
PW_EXE=/opt/pw-browsers/chromium npx tsx scripts/smoke.ts http://localhost:8787/ out.png
PW_EXE=/opt/pw-browsers/chromium npx tsx scripts/smoke.ts "http://localhost:8787/?solo" out.png
npm run bench:field      # build time / size per level
```

Push to a `claude/...` branch, open a PR; CI must be green. Merging to main
publishes the image, deploys Pages, and (once configured) deploys Cloud Run.

## Settled decisions (don't relitigate without the owner)

- **No FASS preset, no hint.** The infinite-line rules (hex `128`, spectre
  `1278`) are for players to discover. `fassRule()` exists for tests only; the
  README must not name them. Default rule is selection `15`.
- **Server is authoritative**; clients only draw events. Field is
  deterministic from (family, level, rootTile) so only the spec travels.
- **One head, unlimited lines.** A player has one growing line at a time
  (`maxHeads: 1`) until they capture a pattern (then `headsWithCapture: 2`,
  plus one per further captured pattern up to `maxHeadsTotal: 12` while
  `headPerCapture` is on — `KNOB_HEAD_PER_CAPTURE=0` restores the flat 2);
  a tap past the limit is refused. Finished lines (stuck or
  closed) stay until cut — `maxLivePaths` / `maxCompletedCircuits` exist as
  knobs, default 0. Losing the head in a collision blocks the next tap for
  `respawnDelayMs` (500 ms, engine clock = summed tick dt).
- **One bot per room** (`BOTS=1` everywhere it is deployed).
- **Two game modes** (`knobs.mode`, per room): **Normal** (default in the
  lobby and on the server) and **Conquest (beta)** — everything described
  under "Captured patterns" below. In normal mode a rival line wholly inside
  your circuit is converted (`convertPath`): wiped (no `by`), your pattern 0
  sprouts on its tiles (`sprout` takes a tile list) and the first piece
  carries its points; a `convert` event carries `converted`, the count of
  distinct rules converted (`Player.converted`), and `headLimit` counts
  `patterns.length + converted` — so the heads match Conquest while
  `patterns` stays `[own]`. `DEFAULT_KNOBS.mode` stays `'conquest'` so the
  engine tests keep pinning it; normal-mode tests set `mode: 'normal'`.
- **Rooms.** The server keeps rooms per mode (`normal-1`, `conquest-1`, …),
  all sharing one `Field`. A join goes to the fullest room of its mode under
  `ROOM_SIZE` (10) humans (held-for-resume players count), else a new room
  (up to `MAX_ROOMS`, 80), else the emptiest. A room with no sockets doesn't
  tick; an extra one empty for `ROOM_IDLE_MS` closes (one per mode stays).
  Player ids are global, so a resume ticket finds its room. A `?room=name`
  link (`join.room`, cleaned by `cleanRoomName`) leads into that room
  whatever its mode and size cap, or opens a *named* room by that name;
  matchmaking never puts anyone in a named room, and named rooms close when
  idle. The arena's Invite button copies such a link.
- **Scaling: many self-contained processes, each with a hard ceiling.** A
  process's rooms share only its `Field` — no cross-process state — so
  Cloud Run can run many instances side by side (`SPECTACLE_MAX_INSTANCES`,
  default 30). Each open WebSocket counts against `--concurrency` (500), so
  Cloud Run sends new connections elsewhere once an instance holds that
  many. What keeps *one* instance from growing unbounded is
  `MAX_INSTANCE_PLAYERS` (default 400, `positiveInt` — a typo falls back to
  the default rather than disabling the cap; checked in the `join` handler
  before `roomForJoin`/`validateRule` do any work): at or past it, a join is
  refused with `error.code: 'full'` on the socket it came in on (not
  rerouted). A `join.resume` is exempt (checked first): it replaces a player
  already counted. `/healthz` reports `maxPlayers`/`atCapacity`. At level 6
  the field is ~540 MB RSS idle and 80 players across 9 rooms add ~30 MB and
  ~10% of a core (a local load test), so 400 is about half a vCPU inside
  `1Gi`; raise CPU with memory before raising the cap. **Named rooms and
  resume tickets are per process**: with more than one instance an invite
  can land on a different instance (empty room, same name) and a reconnect
  relies on best-effort session affinity (a miss is a new player). Making
  invites exact across instances needs routing by room (e.g. several
  one-instance services with the shard in the link) — open, owner's call.
- **Client fallback: never a silent dead end.** `error.code` (protocol.ts)
  gives the client a machine-readable reason instead of parsing text.
  `store.lastError` (a fresh object every time, even a repeat message, so a
  `useEffect` keyed on it always re-fires) drives two things in `App.tsx`:
  (1) a join refused while `!store.you` rolls the optimistic
  `joined.current`/`screen` back to the lobby with the reason shown
  (`notice`) instead of leaving `Arena` rendered with no player — this was a
  latent bug before `MAX_INSTANCE_PLAYERS` existed (an `'invalid rule'`
  refusal hit the same dead end) and is now much more reachable, hence
  fixing it here; (2) `STRUGGLE_ATTEMPTS` (3) failed reconnects flips
  `struggling`, which adds a **play bots instead** link — both to the
  lobby's "Connecting…" message and, mid-game, inside the "Reconnecting…"
  overlay — that calls `leaveToSolo` (`{t:'leave'}` best-effort, clears the
  session, `setMode('solo')`). Switching mode always goes through
  `changeMode`, which clears `notice` — a stale "arena full" banner must not
  survive into solo. `retry.current` keeps backing off and retrying in the
  background regardless, so it still recovers on its own if the server
  comes back.
  idle. The arena's share icon (beside the exit) copies such a link. It is one Node
  process by design (`--max-instances=1`): at level 6 the field is ~540 MB
  RSS idle and 80 players in 9 rooms add ~30 MB and ~10% of a core, hence
  `--memory=1Gi`.
- **Speed** in tiles/s: `(1000 / baseStepMs)(1 + score·speedPerPoint) /
  speedDivisor + speedOffset` (÷10, +5), capped at `maxSpeedFor` (500 at the
  242k-tile reference, log-scaled). `speedFor` / `stepIntervalMs`.
- **Zero-sum.** `path.points` leaves with the path. `stealFraction` default 0.
- **Collisions are mutual** (`mutualCut: true`): the hitter dies too.
- **You can't start** on a rival's line or inside a rival's closed circuit —
  nor on a tile your own line is on (see below). For rivals "on a line" is per chord, not per tile (`freeChord`):
  a tap takes the nearest chord of the tile that no line runs along or
  conflicts with (`pathMeets`, the same test a growing line uses), and is
  refused only when every chord there is blocked. The one exception: tapping the first chord of your stuck
  line that ran off the field's edge turns it round (`reverse` event; steps
  flip, it grows again). A line that runs edge to edge closes as a circuit
  whose polygon is the line plus the smaller arc of `fieldOutline` (`region`
  on the path, the `circuit` event and `PathWire`); use `pathPolygon()` for
  any "inside" test so both kinds of circuit count.
- **Your own lines don't stop you** (`overlapOwnLines: true`, the default).
  A growing line runs on over the top of your own lines, and a tap is per
  chord: your lines of the tapped pattern block only the chords they are on
  (`chordBlocked`), while one of another pattern still blocks its whole tile
  ("a different kind of path" — the owner's call). Layered lines are grown in
  over each other; a rival must cut each. If a line meets one of yours at its loose end on
  the same chord (same rule, not closed), `join` folds the other line in:
  `wipe` (no `by`) for it, then its steps re-sent as `step`s of the joiner,
  its points carried over, never re-scored. Two dead ends at the edge thus
  become one edge-to-edge claim. A line that runs off the edge with your
  loose end just behind its start turns round and joins it by itself
  (`joinBehind`) — no tap on the joint needed. With the knob off (the older
  mode), a growing line entering a tile where another of your lines conflicts (same test as a
  rival hit) goes `stuck` — no cut — and your own lines block taps per chord.
  Tests that pin the older mode set `overlapOwnLines: false`.
- **Flip, don't layer, across your own patterns** (`flipOwnLines: true`, the
  default, on top of `overlapOwnLines`). Your lines of different patterns
  never share a tile. Every path has a `wave` (tap order; pieces inherit the
  flipper's): where two of a player's patterns meet on a tile (`flipTile`,
  after the step lands — the mover can be either side), the higher wave wins.
  Each loser loses its steps on that tile (`splitOff` → `split` event: the
  path is replaced by runs of its old step indices, a loop opens by wrapping,
  first run keeps the id; `trimEnds` is the in-place fast path when only an
  end went), its points fold into the winner (zero-sum, nothing re-scored),
  and the winner's chords sprout there (`sprout`) as `spawned` pieces
  (`step.spawned`, `PathWire.spawned`) that grow both ways (`twoWay`). The
  loser's runs then `burn`: from each end next to a gap, a tile per owner
  step (same `stepIntervalMs` as growth), each tile flipping and sprouting,
  until the whole old line is the new pattern. Pieces flip whatever older
  pattern they reach, so a flip spreads through everything of yours it
  touches: recursive, at your speed, no stubs left at your other patterns.
  Newer always beats older, so it settles. Spawned lines don't count against
  heads (`headsInUse`) or trigger the respawn delay, but all of a player's
  pieces *share* `flipPieceHeads` (1) heads' worth of growth, round robin
  (`growPieces`) — without that a flip seeds dozens of free full-speed heads
  and a bot stress covered ~72k chords of a hex-5 board in 100 s. A piece
  that reaches a chord its own pattern already holds stops (running on would
  only double the line); two pieces meeting end to end join, the shorter
  folded into the longer (`foldInto`: `reverse`, steps, `reverse` — far
  fewer events than re-sending the long one). A burn whose pattern was
  swapped out stops; a taken line stops burning. An edge-to-edge claim is
  `closed` but not a loop — never wrap it (`loop = closed && !region`).
  `tests/flip.test.ts` replays a flip-heavy bot game into the client `Store`
  and checks it matches the engine line for line; keep it green when
  touching any of this. Tests that pin layering set `flipOwnLines: false`.
- **Captured patterns.** Closing a circuit (loop or edge-to-edge region)
  round a rival's line — every step's midpoint inside — takes that line's
  rule into your `patterns` (index 0 is always your own rule; captures are
  only appended, so a path's `pattern` index stays valid; a new rule clears
  them). The area is yours (`takeEnclosed`, default on): every rival line
  wholly inside — circuits, claims, growing lines — changes owner (`take`
  event: new `owner`, `pattern` = its index among yours) and its `points`
  move with it (two `score`s, zero-sum). A line whose pattern you can't hold
  (cap, or `captureOnEnclose` off) stays with the rival. A captured pattern draws in
  `mixHsl(yours, theirs, 1/3)`. `active` picks what a tap draws with; only
  the active pattern is sketched on the board. A path carries its own
  `rule`/`table` — use `path.table`, never the owner's, for anything about
  a path's chords (collisions, turning round). UI: sticky tabs on the left
  wall, bottom left; the active one is longer; keys 1–9. A captured slot
  can be swapped for a rule of the player's own (`swapPattern`, client
  `swap`): its lines are wiped (no `by`, points leave with them), then a
  `swap` event replaces the pattern in place — same index, same colour, same
  head — so path indices stay valid. Slot 0 never swaps; that is `setRule`.
  A rule held in another slot is refused.
- **Nothing in a message or a tick may throw the process down.** One Node
  process holds every room, so `guard()` logs an exception (every 10 s at
  most per source) instead. The welcome snapshot doesn't count towards
  `MAX_BUFFERED` (a client's `allowance`): on a busy board it alone can be
  bigger. `/status` is read-only and public — no ids or tokens on it.
- **Pattern stats are private.** A table of rules by score would give away
  the infinite-line rules, so it never goes on `/status`: `/patterns` 404s
  unless `STATS_KEY` is set and `?key=` matches. On Cloud Run the durable
  record is the log — one JSON line `{"message":"stint","stint":{…}}` per
  finished stint (rule in `describeRule` form, mode, bot, ms, final and peak
  score, circuits) — since memory and disk go with the instance, and with
  several instances `/patterns` shows only the one that answered; the log
  covers them all. `STATS_FILE` keeps the aggregate on the VM. Only players at the board are sampled, so a
  reconnect splits a stint in two.
- **Resume window is 5 min** (`RESUME_GRACE_MS` default 300 000).
- **Solo mode** is the same engine in the tab; the Pages build is solo-only.
- **Hosting**: GCP project `spectacle-game`, region `us-central1` (cheapest,
  and most players are in North America). Cloud Run (scale to zero) via CI is
  the intended path; the free e2-micro VM is the alternative. Session resume
  covers Cloud Run's hourly WebSocket cap.
- **Custom domain** = a Cloud Run domain mapping (`deploy/gcp/domain.sh`),
  bought from an outside registrar (Cloudflare suggested), records DNS-only.
  Not a load balancer (standing cost kills scale-to-zero), not Firebase
  Hosting (no WebSockets). The VM path takes `DOMAIN=` and Caddy does TLS.
- **CI auth is Workload Identity Federation, never a key.** The org enforces
  `constraints/iam.disableServiceAccountKeyCreation`, so a service-account key
  cannot be created at all — and shouldn't be. `setup-ci.sh` builds a pool
  whose attribute condition pins the trust to `bohemian-miser/Spectacle`;
  the deploy job needs `id-token: write` to mint the OIDC token. Everything
  `setup-ci.sh` prints is a *variable*, not a secret.
- **Vendored core** stays byte-identical to Spectre's.
- **Tile colours are Spectre's own table** (`TILE_PALETTES.bright`, the
  `colmap_orig` of the paper's figures): Xi yellow, the Gammas white. A type's
  colour is the same on the board, in the thumbs and in the patch preview, and
  the scheme only scales it (`--tile-dim`, 1 on light), so the hues never move.
  Don't invent fills — look them up.
- **Theme = Spectre's palette**, light by default. styles.css is the one place
  colours live; the canvas reads the `--tile-*` / `--board-*` / `--strand-darken`
  tokens through `readBoardTheme()` rather than keeping its own copy. Nothing
  auto-switches on `prefers-color-scheme` — the settings modal decides.

## Traps

- **Software WebGL.** This sandbox and CI runners have no GPU; WebGL runs on
  SwiftShader and 242k instances take seconds per frame. `tiles-gl.ts`
  detects software renderers on a *throwaway* canvas and falls back to
  Canvas2D. A canvas that ever had a WebGL context can't give a 2D one —
  hence the throwaway. `?gl=1` forces WebGL for visual checks (use a small
  solo level), `?gl=0` forbids it.
- **Smoke test selectors.** Two stacked canvases: use
  `.arena-canvas:not(.arena-tiles)` for pointer work. Scroll tiles into view
  before dragging dots; the headless viewport is 800 px tall.
- **`pkill` returns 144** and aborts a `&&` chain in the Bash tool; put it
  last or on its own.
- **Event order matters** for the resume test: `wipe` then `score` then `leave`.
- **`tapOntoOthers` defaults false** — tests that tap onto a rival must set it.
- **Bots compound.** Speed ∝ score and lines multiply; bots on the FASS rule
  can run away. That's tuning, not a bug — see knobs.
- **Point-in-polygon on the circuit's `a` points** decides "inside" (engine
  taps, `tilesInsidePolygon`). Tiles the loop passes through get the strong
  tint; the enclosed free tiles get a fainter wash, cached per closed path.
- **The rule pattern** (your chords, faint, on tiles no rival's line touches —
  your own lines' tiles included — and not inside a rival's circuit) draws on
  the overlay past `PATTERN_MIN_SCALE` (1.3 × `ARROW_MIN_SCALE`, divided by
  1.5 for 50% more render distance — it now shows before the direction
  arrows, not after) and fades in over the next 16 of scale.
- **A theme change has to reach the canvas.** CSS restyles the DOM by itself;
  the board does not. `Arena` hands the renderer the new `BoardTheme`, which
  re-fills the tile layer and invalidates the tints (their lift is per-scheme).
  A new colour on the board belongs in a token, not in a `.ts` literal.
- **A strand over the palette needs a casing.** Tiles are saturated now, so a
  line's own colour is not enough on its own: the arena haloes your line, and
  the rule lab's patch preview strokes every circuit and tail twice — the
  scheme's `haloCss` underneath (one joined `d` for all of them), the colour on
  top. Anything new drawn over tiles wants the same treatment.
- **Player colours are the server's** (`hsl(h, 90%, 62%)`, bright for the dark
  board). The light board deepens them with `strandColor()` — HUD swatches too,
  so the board and the leaderboard agree.
- **Hexagons all look alike.** Every hex tile is the same regular hexagon, so
  only `directionArrow` (pointing at edge 0, which the rule numbers run from)
  says which rotation one is in; TileThumb draws the same dart as the legend.
  Spectres show their rotation in their outline and get none. Both layers draw
  it above the claim tint and only past `ARROW_MIN_SCALE` — below that it is
  speckle. In WebGL it is one instanced pass over the whole transform buffer
  (the shape is identical for every leaf type).
- **`fieldOutline` is ~1.5 s at hex level 6.** The server and solo build it at
  startup so the first edge-to-edge claim doesn't stall a tick.
- **Every circuit is coloured by length** (`circuitColor`): log length walks
  the hue across 220° (centred on the owner's colour) and the lightness from
  84% to 26%, plus up to ±14° per circuit id. The colour is final — no lift,
  no darkening (`--tile-lift-closed` is unused on the board now). Interior
  washes stack with Porter–Duff "over", outermost first, and each extra level
  of nesting sinks the wash 14% deeper, so nesting reads even in one hue.
- **Settings apply live.** The modal never has a Save: every control writes
  through `updateSettings` / `setTheme`, and `Arena` hands the renderer the new
  `Settings` (`setSettings`), which drops the per-path look cache and re-tints.
  The plain board swaps every tile fill for the ground colour, turns off the
  arrows (`TileLayer.setArrows`) and strokes `fieldOutline` on the overlay; the
  zoomed-in tile outlines and your rule's pattern stay. On a level-6 arena the
  first plain frame pays the ~1.5 s outline build in the browser.
- **Team colours** (`settings.teams`, key T in the arena, or the modal): every
  line of yours draws in `--team-me` (blue), every rival's in `--team-rival`
  (red) — board, washes, sparks, HUD swatches and pattern tabs alike. Circuits
  keep the team hue and shade only by length (`circuitShade`); the circuit
  style's own hues are ignored while it is on. Go through `Renderer.colorOf`,
  not `store.pathColor`, for anything drawn per path.
- **Name labels** (`Renderer.drawNames`): each player's name floats in a
  pill over one of their tiles — at most one label per player on screen. A
  label sticks to its step while that step is on screen and still theirs;
  otherwise it moves to their step nearest the screen's centre whose pill
  doesn't cover another's (so a crowded player may go unlabelled).
- **Resume tokens are single use.** Every `welcome` carries a fresh token and
  the old one dies (only its SHA-256 is kept server-side). A resume can take
  over a player whose old socket is still open — a refresh usually beats the
  old page's close — so `tryResume` renames the old client before closing it,
  or its close handler would unhook the new one. The ticket lives in
  `sessionStorage`: per tab, gone with the tab, never sent as a cookie.
- **`tests/resume.test.ts` used to flake** (~1 in 5): the resume window only
  opens once the *server's* close handler has detached the player, so a
  reconnect fired straight after `ws.close()` legitimately got a new player.
  The test waits for the closing handshake and a round-trip now; keep that if
  you touch it.

## Verification bar before pushing

typecheck + tests + build + both smoke rounds locally; for renderer changes
force `?gl=1` at solo level 3 and look at the screenshot — in both schemes
(`?theme=dark`, `?theme=light`) when colours are involved. CI repeats the
first four and builds the Docker image.

## Next / open

- Balance knobs: score→speed curve, circuit area vs length, steal share.
- Shared growth budget across a player's lines.
- Infinite field via Spectre's un-rooted engine; binary wire format;
  persistence; rooms.
