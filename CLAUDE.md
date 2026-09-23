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
                  capture/take/active/refused). Client → server adds `pattern`.
server/index.ts   Node + ws. One arena, 50 ms tick, batched broadcast, static
                  dist/, resume tokens (RESUME_GRACE_MS), bots, env config.
client/src/       Vite + React.
  App.tsx         Mode (online | solo), connection lifecycle, rejoin/resume.
  session.ts      The tab's resume ticket (sessionStorage) and the
                  once-per-browser help flag (localStorage).
  net.ts          WebSocket GameConnection. local.ts: LocalConnection = the
                  same engine + bots inside the tab (solo mode / Pages build).
  store.ts        Applies events into plain mutable state; version counters.
  Lobby.tsx, RuleEditor.tsx, TileThumb.tsx (interactive SVG tile: edge
                  numbers, drag dot→dot), PatchPreview.tsx (level-3 analyze()).
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
                  (?circuits= overrides), plain board. SettingsButton.tsx is
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
deploy/gcp/       Cloud Run (CI workflow + setup-ci.sh), e2-micro VM
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
- **One bot on the server** (`BOTS=1` everywhere it is deployed).
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
  never share a tile: a line you started (growing, or its tap) reaching a tile
  one of your lines of another pattern is on removes that whole line (`wipe`,
  no `by`; its points fold into the flipper — zero-sum, nothing re-scored),
  redraws every tile it was on with the flipper's chords (`sprout`: every
  chord there no line meets, strung into runs) and each run becomes a
  `spawned` line (`step.spawned`, `PathWire.spawned`) that grows outward from
  both ends (`twoWay`: turns round once when its head stops). Spawned lines
  don't count against heads (`headsInUse`) or trigger respawn delay, and they
  never flip anything — they stop at another of your patterns. That is what
  keeps it from cascading: a soak with flipping pieces ran to ~80k pieces in
  five minutes on hex. Same-pattern meetings (joins, running over) are
  unchanged. Tests that pin layering set `flipOwnLines: false`.
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
  wall, bottom left; the active one is longer; keys 1–9.
- **Resume window is 5 min** (`RESUME_GRACE_MS` default 300 000).
- **Solo mode** is the same engine in the tab; the Pages build is solo-only.
- **Hosting**: GCP project `spectacle-game`, region `us-central1` (cheapest,
  and most players are in North America). Cloud Run (scale to zero) via CI is
  the intended path; the free e2-micro VM is the alternative. Session resume
  covers Cloud Run's hourly WebSocket cap.
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
