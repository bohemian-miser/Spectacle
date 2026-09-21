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

1. **Name and rule.** The lobby is the Tails-problem rule lab: switch edge classes
   on, click a tile to cycle how its lines pair up. Tiles with an odd number of
   lines are flagged as *tails* — your line will end there. *Surprise me* deals a
   random clean rule (one from the family's kernel, so every tile pairs up);
   *FASS* is the proven infinite-line rule (`128 · 010100000` on hexagons,
   `1278 · 0101000000` on Tile(1,1)).
2. **Tap a tile.** It fades and takes your colour, and the chord nearest your tap
   starts growing out of one end, picked at random.
3. **It grows.** One tile per step; the step interval shrinks with your score
   (`baseStepMs / (1 + score × speedPerPoint)`, floored at `minStepMs`). Each tile
   entered scores `pointsPerTile`.
4. **Circuits.** If the line arrives back at its first chord it closes. You get
   `combo × (circuitBase + lengthWeight × length + areaWeight × enclosedArea)`,
   and your combo multiplier steps up for the next one. Closed circuits stay on
   the board (the last few).
5. **Tails.** No continuation (an odd tile, a junction under `junctionPolicy:
   'stop'`, or the edge of the field) leaves the line stuck. Tap again to start a
   new one; the old one is dropped.
6. **Crossing.** When a line enters a tile where another player's chord crosses
   it (proper intersection, or a shared connection point — both are knobs),
   that player's whole path is wiped and their combo resets. Tapping straight
   onto a rival's tile is allowed and works the same way.
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
| `FIELD_LEVEL` | `5` | substitution level: hex 5 ≈ 31k tiles, 6 ≈ 242k; spectre 5 ≈ 35k |
| `FIELD_ROOT` | `Delta` | root tile of the patch |
| `BOTS` | `0` | bot players (random clean rules, occasionally aggressive) |
| `SEED` | random | RNG seed |
| `KNOB_*` | see knobs.ts | any gameplay knob |

`npm run bench:field` prints build time and size per level.

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
client/         Vite + React: lobby with the rule editor (SVG tile thumbnails),
                Canvas2D arena with pan/zoom/tap and the HUD.
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
  rewards a long FASS line heavily; circuit area vs length; wipe penalties.
- More than one live line, growing from both ends, or steering at junctions.
- A bigger field: the un-rooted engine from Spectre can make it effectively
  infinite; the renderer would go WebGL instanced as in the Infinite Map.
- Persistence, rooms/shards, spectating, a proper mobile layout.
