# Progression, capture and walls — design triage

Three idea clusters, each with a few versions, pros/cons, and a verdict. Grounded
in the engine as it is today (`shared/game/engine.ts`, `rule.ts`, `knobs.ts`);
numbers below come from the vendored core on a level-4 field.

Facts the designs lean on:

| fact | hex | spectre |
|---|---|---|
| edge classes | 0 1 2 3 4 5 6 8 (no 7) | 0 – 8 |
| clean (tail-free) rules, the kernel | 15 · 128 · 258 · 01346 · 03456 · 023468 · 01234568 | 15 · 0136 · 0356 · 1278 · 2578 · 023678 · 01235678 |
| common edges (ends per tile) | 5 ≈ 1.5, 2 ≈ 1.5, 1 ≈ 1.0, 3 ≈ 0.8 | 5 ≈ 1.35, 2 ≈ 1.3, 1 ≈ 0.9, 3 ≈ 0.7 |
| rare edges | 0 ≈ 0.5, 4 / 6 / 8 ≈ 0.25 | 0 ≈ 0.45, 4 / 6 / 7 / 8 ≈ 0.2 |
| pairings of the default rule 15 | 4 | 4 |
| pairings of a 3-edge kernel rule | 32 / 64 | 32 / 64 |
| pairings of the full set | 1.95 M | 625 k |

Two consequences:

1. **Kernel rules are not nested.** `15` is inside nothing but the full set. A
   player who "starts with 1,5 and adds an edge" always walks through rules
   with tails (`125`, `158`, …). So the thing that unlocks must be a *palette*
   of edges the rule may use, and the rule stays any subset of the palette.
   With palette `{1,5}` the only clean rule is `15`; the first two rare edges
   a hex player adds decide whether `128` / `258` are even reachable.
2. **Unlocking edges does not leak the infinite line.** A 3-edge rule still has
   32 pairings, and only one of them is the FASS curve. The "no hint" decision
   holds as long as prices are per *edge*, never per *rule*, and the editor
   never names the kernel.

Everything below also wants one engine change: **a path carries its own chord
table** (`Path.table`, `cutRivals` reads `other.table` instead of the rival's
current one). Today a rule change wipes the board precisely because old steps
would be re-interpreted under the new table. Per-path tables make "switch rule
for the next line" free, which unlock-and-use, learned rules and captured
lines all need. The `resetScoreOnRule` knob stays for the case the owner wants
a restart anyway.

---

## 1. Play to unlock

### A. Edge palette, bought with on-board score (recommended)

Start with palette `{1,5}` (the default rule). Any other edge class can be
bought; the price escalates per purchase (`unlockBase × unlockGrowth^n`), the
player chooses which edge. Paying **cashes in lines**: the cost is drained from
`path.points` oldest-first, so the paid-for lines stay on the board as walls
but carry nothing a cutter could take. Score drops by the price; speed drops
with it (`stepIntervalMs`).

- **Pro** a real decision every time: spend now (safe, slower, more options)
  or keep growing (faster, at risk). It is a hedge against being cut.
- **Pro** self-balancing against the score→speed snowball, because the leader
  who buys gets slower.
- **Pro** minimal state: `player.palette: number[]`, one purchase message,
  `validateRule` gains "subset ⊆ palette". The rule lab greys locked edges
  and shows their price on the number.
- **Pro** preserves discovery (see fact 2); the choice of *which* rare edge to
  buy is itself the puzzle.
- **Con** points are zero-sum, so spending destroys score from the arena
  (deflationary). Acceptable: it already vanishes on a cut.
- **Con** a player with a wiped board can't buy anything; early game is
  a long time on `15`. Mitigate with a low first price (≈ one small circuit).
- **Con** no persistence yet, so the palette is per session (resume token
  keeps it). Fine until accounts exist.

### A′. Same, but a palette *size* cap instead of specific edges

Start with 2 slots; buy a third, fourth, … slot; swap edges in and out freely.

- **Pro** never a dead purchase (a rare edge bought alone is useless in A).
- **Pro** the end state (8 slots = the full set = 1.9 M pairings, "draw
  anything") is a natural ceiling, and the 3-slot tier is where the game is.
- **Con** swapping makes the palette non-committal; A's "I am a 2-5-8 player"
  identity is stronger and reads on the board.
- **Verdict** as a *variant knob* of A (`paletteMode: 'edges' | 'slots'`),
  not a separate system. Slots suit progression across sessions; specific
  edges suit a single arena's arc.

### B. Lifetime-earned thresholds (nothing spent)

Track `earned` = sum of positive score deltas; palette grows at thresholds.

- **Pro** pure progression, no bookkeeping on paths, nothing to lose.
- **Con** no decision, and it compounds the existing snowball: the leader
  earns faster *and* unlocks faster. Nothing pulls a runaway player back.
- **Con** meaningless in a session without persistence — everyone starts
  over next visit.
- **Verdict** better as the account-level meta-progression later (rooms,
  persistence), not as arena gameplay.

### C. Toll per edge, paid as you draw

No unlocks. Each edge class has a per-step toll; a step's net is
`pointsPerTile − toll(edge crossed)`.

- **Pro** continuous, no ladder; expresses "each line costs something
  unique" directly; a way to tax the infinite-line edges if they run away.
- **Con** a line that shrinks your score as it grows is unreadable; where do
  the tolls go in a zero-sum game; nothing to *unlock*, so no arc.
- **Verdict** not progression. Keep as a future balance knob (`edgeToll[]`).

### D. Ink — a per-line budget bought with progress

Each line has a budget of tiles; tile types cost different ink; progress buys
a bigger tank. `maxPathLength` made per line and per tile type.

- **Pro** caps the FASS runaway by construction; "longer costs more per
  tile" is a natural curve.
- **Con** another meter on the HUD; it limits the best thing in the game
  (an endless line) instead of making it a discovery; orthogonal to edges.
- **Verdict** hold. If the infinite line proves to be the balance problem,
  this beats tolls.

### E. Pairing (matching) unlocks

Edges free; on tiles with 4+ connections only pairing 0 until the "pairing
editor" for that type is bought.

- **Con** the default rule only has a choice on two types; a per-type ladder
  toward the FASS pairing is a hint by construction; it fights the rule lab.
- **Verdict** no.

### F. Capture as the *only* progression

See §2. Verdict there: excellent as a second source, too sparse as the only one.

### Ranking

| | moment-to-moment gameplay | progression arc | discovery kept | snowball | cost |
|---|---|---|---|---|---|
| A edges, spend score | **best** (buy vs grow) | good, one arena | yes | damped | small |
| A′ slots | good | **best** across sessions | yes | damped | small |
| B thresholds | none | good with accounts | yes | worse | tiny |
| C tolls | poor | none | yes | tunable | small |
| D ink | ok | ok | weak | fixes it | medium |
| E pairings | poor | guided | **no** | — | medium |
| F capture only | great when it fires | sparse | see §2 | — | medium |

**Build A now, with A′ as a mode knob.** Bots must play under the same
palette: start on `15`, buy a random affordable edge when they can, then
re-roll a clean rule *within the palette* (`randomCleanRule` filtered).

---

## 2. Surround a rival's line → use their pattern

**Definition.** When a circuit closes, any rival path whose every step point
lies strictly inside the new polygon is *captured* (bbox reject, then the
existing `pointInPolygon`; the test runs once, at `closeCircuit`). A rival
line can only be inside your circuit if it was there first, or slipped through
a wall where the two rules' chords don't touch — so capture is a deliberate
act: draw a loop around a line without touching it (a touch is a mutual cut).

Three things capture can do; they stack.

### C1. Learn the rule

The rival's `PlayerRule` joins your **deck**. Your next tap can use any deck
rule (the lobby's rule lab becomes "rules you hold" + "edit"). Needs per-path
tables (above). Learned rules ignore your palette — you didn't buy it, you
took it.

- **Pro** progression that comes from play, with a story ("I boxed in psi and
  now I draw like psi").
- **Pro** teaches rules by example on the board, which the lab can't.
- **Con** bots draw random clean rules, one in seven of which is the infinite
  line, so a bot will hand out the FASS rule. Either accept it (the player
  had to trap it) or keep `fassRule` out of the bots' pool. Owner's call.
- **Con** `rule` events already carry the rule; captured rules travel the same
  way, so the client learns nothing it couldn't already read off the board —
  a player who reverse-engineers a rival's pattern by eye gets the same thing.

### C2. Take the line

Ownership of the captured path moves to you: colour, points (zero-sum, the
points move rather than vanish), occupancy. A growing captured line freezes
(`stuck`). A captured *circuit* keeps its wash, now yours.

- **Pro** the strongest visual reward in the game; Go-shaped.
- **Pro** gives circuits a purpose beyond the bonus; today the interior is
  only a no-tap zone.
- **Con** ownership change is a new event (`capture: path, from, to`) and the
  store must re-key its per-owner lists. Modest.

### C3. Wipe and steal

`dropPath(by = you)` with steal fraction 1 for captures.

- **Pro** four lines of code.
- **Con** loses the walls and the story. Fallback knob only.

**Is it enough of a mechanic on its own?** No. It only fires when a rival's
line sits still long enough to be enclosed, which with one bot and a sparse
arena is rare, and the deck it fills is only as varied as the rivals. But
paired with A it is the *second* way to fill the deck, and the two pull in
opposite directions in a good way: buying is safe and slow, capturing is
risky and fast. **Do C1 + C2, knob for C3.**

---

## 3. Stronger walls, damage, health

Today every hit is fatal to the whole path, on both sides. Circuits are the
held capital and die to a single touch; nothing you draw *inside* your circuit
protects it. Three models, in ascending order of texture.

### W1. Circuit hit points

`path.hp = 1 + floor(length / circuitHpPerLength)` for closed circuits, 1 for
open lines. A hit deals `damage = 1 + floor(attackerLength / tailDamageStep)`
("longer tails do more damage"), the attacker dies (mutual cut unchanged).
`hp ≤ 0` wipes.

- **Pro** two knobs, one field on `Path`, one afternoon. Readable as stroke
  weight.
- **Con** no spatial texture: every wall tile equal, nothing to build. A big
  loop is strong *because* it is big, which the bonus already rewards.

### W2. Stacking — hp is how many of your paths share the tile

No new state: `occupancy.get(tile)` filtered by owner. Reinforce by drawing
another of your lines through the wall (own paths never conflict, so retracing
your own circuit is legal today). A hit peels `damage` layers at that tile —
each layer is a whole path, wiped as now.

- **Pro** emergent, zero engine state, and reinforcing costs the one thing
  the one-head rule makes scarce: your time.
- **Con** exposes an exploit that exists **today**: retracing your own closed
  circuit closes it again and pays the bonus again, with a higher combo.
  Whatever else happens, `closeCircuit` should refuse a bonus for a loop
  whose (tile, chord) set equals one you already hold (`reinforceBonus`
  knob, default 0). Do this regardless of which wall model ships.
- **Con** wall thickness is hard to see unless the renderer draws stacked
  strokes per tile (the store already has occupancy per tile).

### W3. Inward depth — the owner's proposal (recommended, phased)

For a closed circuit, `hp(tile) = 1 + d(tile)` where `d` is the hop count from
that wall tile *inward* through tiles occupied by the owner to the first free
interior tile (`tilesInsidePolygon` gives the interior; a BFS seeded from the
free interior tiles at distance 0). A bare loop has `d = 0` everywhere, so
hp 1 = today's behaviour. Lines drawn just inside the wall thicken it; a
fully filled fortress hits `wallHpMax`.

Per-tile damage persists on the path (`damage: Map<tile, n>`), so repeated
pokes at the same tile work; each poke costs the attacker its line and a
respawn. `damage = 1 + floor(attackerLength / tailDamageStep)`: a long run-up
punches a thick wall in one go but is exposed for longer.

When a tile's damage reaches its hp, the circuit **breaks there**. Two
outcomes, in order of ambition:

1. **Wipe** (today): the whole path goes with its points. Ship first.
2. **Breach**: the hit step is removed, the cyclic step list is rotated so the
   gap is at the ends, status becomes `stuck`, the circuit bonus (tracked
   separately as `path.bonus`) leaves, the wash goes, tapping inside is
   allowed again. The owner can re-close by tapping the gap tile — the walker
   follows the same rule and retraces the loop (own paths don't conflict),
   which lands on the W2 exploit above, so the reinforce rule is a
   prerequisite. Needs one new event (`reshape: path, steps`).

- **Pro** exactly the fortress arc asked for: circuits become something you
  build up, attacks scale with commitment, open lines stay fragile so the
  fast cutting game is untouched.
- **Pro** computable: BFS over the interior once per close, re-run when the
  owner's occupancy inside that bbox changes (cache per closed path, like the
  client's interior cache).
- **Con** wire cost: hp per step must reach the client for rendering; send a
  `walls: path, hp[]` event on close and on change, bytes per step.
- **Con** a giant circuit with a single line inside is no stronger — only a
  ring hugging the inside of the wall is. That is the right incentive but it
  needs to be visible (stroke weight per step, cracks for damage).
- **Open** does damage heal? Start with no; `wallRegenMs` if fortresses turn
  out too easy to grind down.

### Ranking

| | build/attack texture | readability | engine | risk |
|---|---|---|---|---|
| W1 hp by length | none | high | tiny | rewards size twice |
| W2 stacking | good, emergent | low until rendered | none | exposes retrace exploit |
| W3 depth | **best** | medium (needs per-step weight) | medium | most new state |

**Ship W1's knobs first (tail damage, circuit hp) since W3 needs them anyway,
then W3 with wipe-on-break, then breach.** Fix the retrace bonus now.

---

## How they fit together

- **Deck of rules** is the spine: bought edges expand what you can *build*,
  captures expand what you *hold*, per-path tables let you switch without a
  wipe. One `rules` event replaces today's `rule`.
- **Circuits** become the fortress economy: they hold points, they capture,
  they thicken from the inside, and they take commitment to break.
- **Open lines** stay as they are: fast, fragile, one head, mutual cut.
- Nothing above names a rule or a kernel to the player; the FASS line stays a
  discovery unless a bot draws it inside your loop.

### Suggested order

1. Per-path chord tables; refuse the duplicate-circuit bonus. (No visible
   change; unblocks everything.)
2. Palette unlocks (A, `paletteMode` knob), bots buying too, rule lab greys
   locked edges with prices.
3. Capture on close (C1 + C2, C3 as knob), `capture` event, deck UI.
4. Tail damage + circuit hp (W1 knobs), then inward depth (W3) with
   wipe-on-break, per-step weight in the renderer, then breach.
5. Balance pass over the new knobs: unlock prices, tail damage step, hp cap.

### New knobs (names as they would land in `knobs.ts`)

`paletteStart`, `paletteMode`, `unlockBase`, `unlockGrowth`, `captureMode`
(`learn` | `take` | `wipe` flags), `reinforceBonus`, `tailDamageStep`,
`circuitHpPerLength`, `wallHpMax`, `wallRegenMs`, `breachMode`
(`wipe` | `open`).
