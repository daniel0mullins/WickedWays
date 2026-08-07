# Position sensing: coil grid vs. coded laser fence (ADR)

> **Status:** design ADR, undecided. Specs two camera-free ways to answer *"which piece is on which
> tile"* on a physical board, for a sub-$100 consumer SKU. Extends the tile/NFC hardware in
> [`tabletop-prototype-bom.md`](./tabletop-prototype-bom.md) and the bridge in
> [`tabletop-firmware-sketch.md`](./tabletop-firmware-sketch.md). Both options plug into the *same*
> `wickedways-tabletop` bridge — this is a **transport/sensor** decision, nothing above the transport
> changes.
>
> ⚠️ **Costs here are estimates, not quotes, and an August 2026 review corrected several of them
> downward-optimistic.** Corrections are marked inline. No vendor quote has been obtained for any line
> item; no part of this ADR has been prototyped. Read every dollar figure as a planning placeholder
> pending a real quote. Commercial sequencing — and why the campaign is gated on audience, not on
> hardware — is in [`go-to-market-reality.md`](./go-to-market-reality.md).

## Context & constraints

- **Camera-free.** A camera solves position + identity in one sensor, but calibration drift, ambient
  light, and hands-over-the-board make it miserable at a play table. Both options here avoid it.
- **The game is tile-quantized.** The engine consumes `DeviceEvent::PieceMoved { dir }` — unit steps
  between adjacent tiles — not continuous `(x, y)`. The required spatial resolution is *"which tile,"*
  not millimetres. Any sensor that delivers more precision than that is paying for precision the engine
  discards.
- **Pieces cluster in combat.** Two or more pieces sit on adjacent tiles exactly when the game is most
  active. Robustness *under clustering* is the axis that decides this.
- **Cost ceiling.** Target retail ≤ $99 at ≥30% gross margin ⇒ **landed COGS ≤ ~$65** (healthier
  ~$30–40 once fulfilment/returns/support are counted). The display + compute are the customer's own
  phone/tablet (the shipped wasm web client) — $0 BOM — so this budget buys *sensing + pieces + mat*
  only.
- **New protocol surface (either option) — ⚠️ PROPOSED, NOT IMPLEMENTED.**
  `DeviceEvent::PieceOn { tile_id, actor_id }` — an absolute "piece X is now on tile Y" report, from
  which the controller derives the `dir` for `bridge::resolve` (or a `bridge` helper does, rejecting
  non-adjacent jumps as today). Absolute reports self-heal a missed frame; the existing relative
  `PieceMoved` stays for the discrete-tap tiers.

  **`PieceOn` does not exist in code.** Today `crates/wickedways-tabletop/src/protocol.rs` defines
  exactly four events — `PieceMoved`, `TileAction`, `Lantern`, `DiceRolled` — and eight commands
  (`Tile`, `Piece`, `Dashboard`, `Banner`, `Led`, `Sound`, `Resolution`, `Clear`). `PieceOn` and
  `TileIn` appear only in these design docs. Adding them is small, but statements elsewhere in this
  document that "the engine and bridge are untouched" describe the *intended* design, not the current
  build.

---

## Option A — Coil grid under the mat (sense *through* the surface)

One antenna coil per tile, under the mat; each piece carries a passive tag; a single reader is
time-multiplexed across the coils. The piece sits *on* its sensor, so there is no line of sight to
occlude and nothing to calibrate.

### Two tag flavors

- **NFC-UID matrix.** A reader IC (ST25R3916 / PN5180 class) muxed across PCB-etched coils via a
  74HC4067 16:1 analog mux. The coil that couples to a tag → position; the tag **UID → `actor_id`**
  (the existing `tag_to_actor` table). Reuses the NTAG tags already in the BOM.
- **LC-resonant tags (the e-chessboard approach).** Each piece holds a passive LC circuit tuned to a
  unique frequency; the board sweeps frequency per coil and reads identity + position. **This is how
  DGT / Chessnut electronic boards work — mass-produced, camera-free, calibration-free products that
  identify which piece is on which square.** That is the existence proof that the capability is real
  and manufacturable today.

  ⚠️ **Correction (Aug 2026): the price claim was wrong, and the comp cuts both ways.** An earlier
  draft said these retail "right around the $100 target." Actual: **Chessnut Air is ~$219–250** — 13″,
  cherry-wood frame, built-in LEDs, BLE, companion app, and *full piece recognition* (type and colour
  on every square, individual sensors per square). So:
  - **Good news for feasibility.** A polished consumer product ships exactly the sensing capability
    Option A describes, which strongly de-risks the *technology* choice.
  - **Bad news for pricing.** It sets the market's reference price for "smart board that knows which
    piece is where" at **~$250**, with a mature supply chain, tooling, and support behind it. Any
    Wicked Ways board must justify its delta over that number — see the collector-format caveats below,
    where the $1,199 flagship is ~5× this comp and the entire difference is a colour e-ink panel plus
    an IP with no existing audience.

### Why it fits this game

- **Immune to occlusion and clustering** — each tile reads independently; adjacent pieces never merge.
- **Zero calibration, ever** — no alignment step at setup.
- **Identity + position, natively simultaneous** — no data-association tracking.
- **Resolution = tile pitch**, which is *exactly* what the engine wants — no wasted precision.
- **Passive pieces, no battery.**

### Costs & limits

- Continuous sub-tile position is not available (fine — the game doesn't want it).
- A powered board (vs. the Good/Better tiers' dumb mat), so it needs USB or a small cell.
- BOM scales with grid density: a 4×4 grid is one 16:1 mux; a finer grid adds muxes and PCB area.

### BOM against the $65 ceiling (4×4 = 16-cell board, BLE to phone)

| Part | ~COGS @ volume |
|---|---|
| PCB with 16 etched coils (~300 mm sq) | $12 |
| NFC/resonant reader IC | $4 |
| 74HC4067 16:1 analog mux | $1 |
| ESP32-C3 (BLE link to the phone web/native client) | $3 |
| Passive tags in piece bases ×8 | $3 |
| Printed mat overlay (room art) | $4 |
| Miniatures ×3 + lantern | $5 |
| LiPo + charge/protection + USB-C (or USB-only, −$3) | $5 |
| Box, insert, certification amortized | $6 |
| **Landed COGS** | **≈ $43** |

**Closes on paper:** $99 retail on ~$43 COGS ≈ **57% gross margin**, leaving headroom for
channel/fulfilment before the 30% floor. A finer (5×5/6×6) grid adds ~$1/mux + PCB area and still
lands under $55.

> ⚠️ **Same caveat as the collector BOM: these are estimates at an assumed volume that a first run
> won't have.** At a few hundred units, PCB, enclosure, packaging, and assembly all cost materially
> more per unit than budgeted here, and certification is a fixed cost spread over very few units. The
> *technology* choice is well de-risked by the Chessnut comp; the *unit economics* at low volume are
> not. Treat $43 as a target to validate with quotes, not a number to plan a price around.

---

## Option B — Coded laser fence (sense *across* the surface)

A rigid fence around the board houses spinning laser rangefinders that sweep the play area;
retroreflective **coded rings** on the piece bases carry identity. This is the tabletop shrink of
proven AGV self-location (SICK / Pepperl+Fuchs reflector-coded laser positioning). It is the more
*theatrical* option — a literal red sweep reading the board is deeply on-brand for horror.

### The two walls it hits

1. **Occlusion, worst during combat.** Any line-of-sight sensor loses a piece hidden behind another.
   Corner scanners with diverse sightlines mitigate full occlusion, but the harder failure is
   **merging**: two pieces on adjacent tiles collapse into one angular blob at range — and adjacency
   *is* combat. The sensor is weakest exactly when the game leans on it.
2. **Beam spot ≫ barcode stripe (physics, not engineering).** A cheap tabletop rangefinder's beam
   diverges ~0.5–1°, so its *spot* is ~3–5 mm at 300 mm. A readable wrapped code on a 25 mm base needs
   ~1.5 mm stripes. A 4 mm spot reading 1.5 mm stripes **optically low-passes the code into mush**,
   before sample-rate even enters. Range accuracy is fine (blob-finding tolerates blur), but *reading
   identity off the same beam* fails at tabletop range. Focused barcode-scanner optics fix it and blow
   the budget. In short: **a cheap laser is great at *where*, bad at *who*.**

### Iterations that make it workable

1. **De Bruijn ring, not a plain repeat.** Repeating the code around the base handles free piece
   rotation; a De Bruijn ring goes further — *any* contiguous window of *k* stripes is globally unique,
   so any visible arc yields **identity *and* absolute facing**, self-clocking and rotation-invariant.
   (A genuine upgrade to the "repeated barcode" idea, useful under any sensor.)
2. **Decouple identity from position.** Stop asking one beam to do both. Laser → blob detection
   (position, which it does well). Identity → an **NFC tap at placement** assigns the `actor_id`, then
   the tracker keeps it glued to that blob. Passive pieces, no battery. Cost: multi-object-tracking
   **data-association risk** on merge/split — but a turn-based game moves ~one piece per turn, so only
   the active blob is expected to move, which largely sidesteps ID-swapping.
3. **Retroreflective ink + short-range fence mounting** (~100–150 mm): ~100× return SNR and a smaller
   spot — what makes any optical coding barely feasible.
4. **Solid-state alternative:** a ring of fixed retroreflective photodiode pairs firing in sequence —
   no motors to whine/wobble/die, but coarse angular resolution (presence/position only, no code).

### BOM reality

| Part | ~COGS @ volume |
|---|---|
| Spinning rangefinder modules (LD06/LD19-class) ×4 for occlusion coverage | $60–80 |
| Fence structure + retroreflective piece rings | $10 |
| MCU + power + wiring | $8 |
| Mat + minis + tags | $12 |
| **Landed COGS** | **≈ $90–110** |

**Does not close** at $99 retail with four scanners. A **single central scanner** drops COGS to ~$45
(closes on paper) but reintroduces full occlusion — one piece shadows another with no second sightline.
The laser fence is fundamentally in tension with the $65 ceiling *and* with clustering.

---

## Option C — Inverted / modular-tile topology

Options A and B assume a *fixed* board (grid or panel) with the reader in the board and passive tags in
the pieces. Option C flips both: **the map is built from modular tiles laid down as the party explores,
and (optionally) the reader moves into the pieces.** It is less a third sensor than a different
*product* — a mass-market, endlessly-expandable modular board game — that solves position sensing as a
side effect.

### Two independent flips

1. **Modular, manually-placed tiles** (the valuable flip). The map is *emergent*: printed tiles are
   placed one at a time on reveal, so an unexplored room is the **absence of a tile**. Fog-of-war
   becomes physical, and the tile art is cheap print — no e-ink, no phone-glass compromise, art
   genuinely on the table. This is the Mansions-of-Madness-2e model, and it maps onto `PieceOn`: a tile
   UID → a campaign room; the engine owns the room-graph topology; the app *directs* placement on
   reveal; legality is checked against the graph, not physical adjacency.
2. **Reader-in-the-piece** (the contentious flip). Each piece carries an NFC reader + BLE + battery,
   reads the tile beneath it, and beacons "piece X on tile Y" (BLE *advertising* — no pairing, low
   power). Sensing becomes flawless — each piece self-reports, so **zero occlusion, calibration, or
   clustering ambiguity** — but the piece becomes a ~$14 powered device instead of a $2 passive token,
   with a charging ritual, a dead-piece-mid-game failure mode, and batteries in the most-handled part.

### The XOR at the heart of it

To auto-sense a piece on a *manually-placed* tile, something at the contact point must be the powered
reader — so you can have **cheap passive tiles** *or* **passive pieces, not both.** Flip 2 buys an
*unbounded* map (play anywhere, no baseboard) at the cost of powered pieces. The alternative keeps
pieces passive by **laying the modular tiles on the Option-A coil-grid baseboard** — reader shared in
the base, tiles cheap print, pieces passive — at the cost of a bounded, powered baseboard. So the real
decision axis is **bounded vs. unbounded map:**

| | C1 — smart pieces | C2 — modular tiles on a coil baseboard |
|---|---|---|
| Map size | **unbounded** (any table) | capped to the baseboard grid |
| Pieces | powered, ~$14, charged | **passive, ~$2, indestructible** |
| Tiles | cheap printed + tag | cheap printed (tag optional) |
| Baseboard | **none** | required (powered) |
| Sensing | flawless (self-read) | flawless (grid) |
| Failure mode | dead piece mid-game | none in the pieces |
| Mitigations | duty-cycle poll, sleep-when-lifted (accelerometer), swappable coin cell, ruggedized base | — |

### C1′ — mat-powered reactive pieces (resonant)

> ⚠️ **Sourcing correction (Aug 2026): this variant rests on a standard that lost.** The A4WP/PMA
> merger produced AirFuel, which *"failed to keep pace with Qi"*; Apple's Qi adoption effectively
> **ended Rezence as a market standard**. Consequence: there is no mainstream ~6.78 MHz resonant
> chipset ecosystem, reference design, or module to buy. C1′ therefore implies **custom RF engineering**
> — schedule and cost measured in engineer-months, not a BOM line. Additionally, the power-vs-NFC
> time-multiplexing below is **asserted, never bench-validated**. Treat C1′ as the most speculative
> item in this document.

The variant that rescues C1's battery flaw *and* buys a feature passive tokens can't. A **resonant
inductive mat** (~6.78 MHz ISM, AirFuel/Rezence-style — not tightly-coupled Qi) under the play area
powers the pieces while they're placed; a **supercapacitor buffers the lift-to-move gap**. The duty
cycle of the game aligns with the duty cycle of the power: a piece is energized exactly when it's
placed (and needs to sense), and coasts on the buffer for the few seconds it's airborne. **No lithium
cell, no charging cradle, no dead-piece-mid-game.**

- **Physics fits this case well.** Flat pieces = the ideal parallel-coil geometry (never tumbles into a
  bad orientation); the per-piece budget is tiny (~mW–tens of mW); and a bounded 5×5 mat is small
  enough for one or a few resonant coils to blanket with fairly uniform coupling (coverage uniformity is
  the hard part of large wireless-power surfaces — bounding the board helps yet again).
- **The prize is *output*, not just topping up sensing.** A mat-powered mini becomes an engine-driven
  **reactive** device on the existing `Piece { glow, active }` / `Led` channels: glow amber on your
  turn, pulse red in combat, flicker as an affliction takes hold, **haptically shudder** when struck. A
  monster that lights from within when it wakes. Living, battery-free minis — deeply on-brand.
- **The real cost: power vs. sensing interference.** A strong power field can swamp the 13.56 MHz NFC
  reads. *Mitigations:* **time-multiplex** (pulse power, blank it a few ms for a read — sensing is only
  needed a few times/sec and the supercap rides the blanks), frequency-plan/shield the sensing coils,
  and use **resin (not metal) piece bodies** (metal in an induction field = eddy-current heating +
  detuning). Efficiency is 30–60%, but at <1–2 W delivered the waste heat is small; the resonant
  transmitter needs FCC Part 15/18 EMI cert (a mat-side cost, consistent with collector-tier cert).
- **Decision gate — only if the pieces must be *active*.** If pieces are only *tracked*, stay passive
  C2: no mat power, cheaper, tougher. Reach for C1′ only when pieces need to **do** things (reactive
  output, or the unbounded/baseboard-free sensing of C1). Its virtue is directional: it moves complexity
  **off the many handled pieces onto the one shared mat.** A premium/halo feature; the mass-market SKU
  stays passive-C2 with no mat power.

### Why it's compelling regardless of flip 2

- **Cheapest art on the table** + **physical fog-of-war** (unexplored = no tile) — arguably a better
  mystery mechanic than reflective e-ink, for free.
- **Razor-and-blades:** base set once, cheap **tile-pack expansions forever** — each campaign is a ~$20
  print run, not a hardware run. Base-set COGS drops (no panel) → **mass-market ~$299–499**.
- **Occlusion-free sensing** either way.

### Cost sketch (base set) & engine fit

- Base station (Pi/ESP32 + BLE + wifi + audio + PSU): ~$60–80. BLE central = a base *device*, not iOS
  Safari (Web Bluetooth is Android/desktop only — consistent with the rest of this doc).
- **C1** smart pieces ×4: ~$14 parts each + charging cradle → ~$80–120. **C2**: the Option-A coil
  baseboard (~$43) + passive pieces (~$8 total).
- Modular printed tiles: ~$0.30–0.50 each; a 40-tile campaign ~ $20.
- **Engine fit — already specced:** `PieceOn { tile_id, actor_id }` is the event; a reveal cue tells the
  player which tile to place, and placing it *is* the physical response. A `ModularTileTransport`
  (BLE-advertising pieces, or the coil baseboard) implements `DeviceTransport`; everything above
  `bridge::resolve` is unchanged.

This is a **different SKU** from the e-ink collector — the mass-market, expandable volume product to the
collector's $1,199 halo, not a competitor on the same axis. The bounded-board + tile-churn rules (the
"collapsing house") that make this replayable are specced in
[`modular-map-design.md`](./modular-map-design.md).

---

## Where's the display? (a *separable* layer)

Position sensing answers *where a piece is*; it says nothing about *what the board looks like*. Those
are separate layers — both consume the same `DeviceCommand` stream — so either sensing option (A/B)
pairs with either display option below. The engine/bridge don't change; only the rendering target does.

`DeviceCommand` fan-out — which channel renders where:

| Channel | Renders on |
|---|---|
| `PieceOn` / `PieceMoved` (in) | the sensing layer (coil grid / laser fence) |
| `Tile`, `Dashboard`, `Banner`, `Resolution` (rich, slow) | the **display** (phone glass *or* on-board e-ink) |
| `Led` / piece `glow` (fast) | on-board LEDs — always, either way (e-ink/phone are too slow) |

### Display option 1 — bring-your-own-glass (the sub-$100 default)

No rich display on the board. `Tile`/`Dashboard`/`Banner`/`Resolution` render on each player's
**phone/tablet** (the shipped wasm web client); the board is a **printed** mat + minis + sensing. This
is what makes the SKU cheap — the display is $0 BOM because the customer owns it.

- **Real darkness is reclaimed with light, not screens.** A WS2812 layer under a translucent printed
  mat carries the fast `Led` channel *and* the darkness mechanic: `concealed` ⇒ LED off ⇒ that region
  of the table is physically dark. ~$3–5, folds onto the coil PCB.
- **Per-seat phones are a horror *feature*:** each client shows only that player's fog-of-war, sanity,
  and hidden afflictions — a single face-up board can't keep secrets. (A shared tablet "central map" is
  also supported; per-phone is the on-brand default.)
- **Trade-off:** the *art* isn't physically on the table — players look down at a printed mat + minis,
  and at their phone for the living room art.

### Display option 2 — large e-ink under a rigid mat (the premium "all on the table" build)

Put the art back on the table: one large e-ink panel (or a few medium ones) under a **clear rigid
cover** — acrylic / tempered glass, *that's* the "rigid mat" — with the coil grid as a separate thin
layer. This is the **only** option that restores *both* art-on-the-table **and** real reflective
darkness: an unlit e-ink region is genuinely unreadable until you bring light — the load-bearing horror
mechanic, native, no LED trickery needed (though LEDs still carry the fast channel).

- **⚠️ Refresh is a design-defining constraint, not a footnote.** Colour ACeP / Spectra-6 has **no
  partial refresh at all** (verified) and takes **~10–30 s** for a full-panel update. So *every single
  room reveal freezes and flashes the entire board* for up to half a minute. In a horror game the
  reveal is the core beat — this directly attacks pacing and tension, and it is the strongest
  functional argument against a single large colour panel. Any colour build must either accept that
  cadence as a deliberate ritual ("the house redraws itself"), tile the board so only one panel
  repaints, or use mono.
- **Color vs mono is really a refresh-*granularity* decision.** Because colour cannot partial-refresh,
  revealing one room redraws the *whole board*, slowly. **Mono** e-ink supports **partial/windowed**
  refresh (~0.3–1 s) — repaint just the room that changed. For a *single large* panel, **mono wins
  decisively on UX.** If color is a must,
  use a *few medium panels* so a reveal refreshes only the affected panel (the per-tile firmware
  topology, coarsened).
- **Panel granularity — one big vs. several small.** Panel count is *decoupled* from the room grid: a
  board can be one seamless panel or a tiling of smaller ones (the prototype BOM's per-tile board is the
  fine-grained extreme). Several small panels **buy** (1) **regional refresh** — only the panel holding
  a revealed room repaints, which hands *color* e-ink the partial-refresh it otherwise can't do; (2)
  **swap-one serviceability** — a cracked $45 panel, not a $180 board; (3) **bezels-as-walls** — the
  game's discreteness turns inter-panel seams into room dividers, *if the map is laid out so no room
  crosses a seam*. They **cost**: with boutique modules, **more** than one big panel of equal area
  ($/area *rises* as panels shrink, and each drags its own driver IC + flex + bezel + assembly), plus
  seam-aligned map-layout constraints and more connectors to fail. The one regime where tiling gets
  *cheaper* is **commodity/salvaged ESLs** (dirt-cheap small e-ink) — but their proprietary RF
  interfaces and fixed sizes make that a maker route, not a clean product supply chain. **Net:** tiling
  doesn't rescue the $100 budget, but it's the *right* premium build for **color** (regional refresh) or
  for serviceability; **mono** — which already partial-refreshes — is simpler, seamless, and cheaper as
  **one** big panel. The software is agnostic either way (the firmware-sketch already addresses panels
  by `tile_id`).
- **Stacking is the integration risk.** A coil grid couples through *non-metallic* layers, but an
  e-ink **TFT backplane may attenuate/detune** the 13.56 MHz field. Safer stack: coils as a thin
  flex / transparent-conductor layer **between the e-ink and the clear cover** (right under the piece),
  *not* beneath the e-ink. Validate coupling through the actual cover before committing. The rigid cover
  also protects the fragile e-ink and gives pieces a flat surface.
- **Cost reality — this is a premium SKU, not the $99 product.** Large e-ink is the cost driver and
  scales *nonlinearly* with area:

  ⚠️ **Corrected Aug 2026** — the colour panel prices below were 40–60% low; verified retail for the
  13.3″ Spectra 6 is **$326–500**, which pushes the colour row well past a "$199–299 deluxe edition."

  | Panel | ~Landed COGS | Verdict |
  |---|---|---|
  | Large **color** (13″ Spectra-6, ⚠️ ~~$180–200~~ → **$326–500** panel) | **$400–600+** | far past $100; realistically a four-figure SKU, not a $199–299 "deluxe" |
  | Large **mono** (10–13″, ~$90–130 panel — *unverified, treat as the colour figure was*) | **$90–120** | at/over the ceiling — realistically a ~$129–149 SKU |
  | Repurposed **ESL** / salvaged e-reader panels | cheaper | not a productizable supply chain |

**Product framing: the coil grid is the constant; the display is the SKU tier.** Coil grid + phone =
the ~$99 hero (cheap, robust, private per-player info, LED darkness). Coil grid + large **mono** e-ink
+ rigid cover = a ~$129–149 "everything's on the table" edition with native reflective darkness. Large
**color** e-ink is an enthusiast/deluxe tier above that. All three share one sensing layer, one bridge,
one engine.

| Axis | Phone glass | Large e-ink + rigid cover |
|---|---|---|
| Art physically on the table | no | **yes** |
| Real reflective darkness | via LEDs only | **native** (+ LEDs for the fast channel) |
| Per-player hidden info | **yes** (per-seat) | no (face-up; phones can still supplement) |
| Refresh | **instant** | slow (mono partial ~1 s / color full ~15–30 s) |
| Fits $99 retail | **yes** | no — premium ($129 mono / $199+ color) |
| BOM driver | $0 (customer's device) | the panel |

## Comparison

| Axis | A — Coil grid | B — Laser fence (iterated) |
|---|---|---|
| Occlusion / clustering | **immune** | weakest in combat |
| Calibration | **none, ever** | per-setup alignment |
| Identity + position together | **native, simultaneous** | needs the decouple hack |
| Spatial resolution | per-tile (**exactly what's needed**) | continuous (mostly discarded) |
| Pieces | passive, no battery | passive, no battery |
| Moving parts | **none** | motors (or coarse solid-state) |
| Aesthetic | invisible / "magical" | **dramatic red sweep** |
| Fits $65 landed COGS | **yes (~$43)** | no with 4 scanners; ~$45 single but occluded |
| Protocol change | `PieceOn { tile_id, actor_id }` | `PieceOn` + placement-time NFC tap |

## Decision (recommended)

**Adopt Option A (coil grid), NFC-UID flavor first.** For a tile-quantized game where pieces cluster
in combat, the grid wins on every axis that matters — occlusion, calibration, cluster-robustness — and
delivers identity+position natively at exactly the engine's resolution. The e-chessboard industry
proves the **capability** is manufacturable and consumer-priced (~$219–250 retail for Chessnut Air);
it does *not* prove the $43 COGS at a first run's volume, which still needs quotes. NFC-UID reuses the tags already in the BOM and the existing
`tag_to_actor` table; LC-resonant is a later cost-down (cheaper passive pieces, no per-tag silicon)
once volume justifies custom-tuned tags.

**Keep the laser fence as an aesthetic upgrade path, not the base sensor.** Its unique asset is
theatre, not accuracy. If a future premium SKU wants the red-sweep drama, run the laser as a
*presence/position* layer with identity from NFC-at-placement — never ask one cheap beam to read a
wrapped barcode.

Either way the engine and bridge are untouched above the transport: a `CoilGridTransport` (or
`LaserFenceTransport`) implements `DeviceTransport`, emits `PieceOn`, and everything from
`bridge::resolve` up — authorize, the solo loop, the dice seam — already exists.

**Option C (modular tiles) is a different product, not a competitor on this axis.** It reframes the
board as an expandable, mass-market game and is the strongest path if "art physically on the table +
cheap expansions" matters more than a single premium surface. Prefer its **C2** form (modular tiles on
the Option-A coil baseboard) to keep pieces passive; reserve **C1** (smart, powered pieces) only when an
unbounded, baseboard-free map is a product pillar. It reuses the same `PieceOn` seam — so A and C2 share
a sensing layer and differ only in whether the map is a fixed mat or placed tiles on that mat.

## Collector format (flagship SKU)

The deluxe instantiation of the recommendation: **coil-grid sensing (Option A) under a single large
*color* e-ink panel (display option 2), with a dimmable frontlight.** This is the one build where the
physical pieces are unambiguously justified — the shared art lives *on the table*, so eyes and hands
stay there and the phone is demoted to an optional private HUD (secret sanity, afflictions, GM
whispers). It is the app-driven-horror pattern (Mansions of Madness 2e) with the board's art made live.

**"Backlight" is really a frontlight — and that's a feature.** Color e-ink is reflective; a light
*behind* it does nothing. An edge-lit **frontlight** *above* the panel (Kindle-style) washes the
surface and is **dimmable**: the engine drives it as a lighting channel (the lantern brightens the
board, sanity-loss dims it) and can kill it to reach genuine reflective darkness (frontlight off ⇒ the
room is unreadable until light is brought). Ambiance control *and* the load-bearing darkness mechanic
from one part.

**The stack moves the coil/TFT coupling risk** flagged in display option 2 — sensing sits *above*
the panel, so the TFT backplane never sees the 13.56 MHz field:

```
pieces → cover glass → transparent coil layer (ITO/mesh) → frontlight guide → color e-ink (reflective)
```

NFC couples through glass + frontlight (both non-metallic); the rigid cover doubles as structural
protection for the fragile panel.

> ⚠️ **UNVALIDATED — this is the collector build's weakest link, and it trades one risk for another.**
> An earlier draft claimed this stack "resolves" the coupling risk. More accurately it *relocates* it:
> the TFT is no longer in the field, but the sensing coils must now be **transparent**, and transparent
> conductors (ITO/fine mesh) have far higher sheet resistance than copper. Since **Q ∝ 1/R**, and an
> NFC **reader** antenna wants **Q > 20**, this is a hard constraint — with a design paradox on top:
> enlarging the loop to raise inductance *also* lengthens the conductor and raises resistance, so Q
> does not simply improve with area. A reader antenna (which must energise a tag) is a harder case than
> a tag antenna.
>
> **The $35 line item for this layer is invented — there is no quote behind it.** Before any collector
> board is committed, this needs a **bench spike**: build one transparent coil at the intended size,
> measure Q and read range through the actual cover glass and frontlight guide, with the e-ink panel
> powered underneath. If Q can't be made workable, the fallbacks are copper coils *below* the panel
> (reintroducing the TFT problem), a non-transparent grid in the bezel, or abandoning the
> sensing-over-display combination entirely.

### BOM (13.3″ Spectra-6, self-contained; rough 2026, low-volume/hand-assembled)

> ⚠️ **Corrected Aug 2026 — the original BOM understated its largest line by 40–60%, and three others
> are understated at this run size. None of these figures are quotes.**

| Group | Part | ~COGS |
|---|---|---|
| Display | 13.3″ Spectra-6 7-color e-ink panel — ⚠️ was **$190**; retail-verified **$326–500** | **$330–500** |
| | IT8951-class e-ink controller (may already be included in module pricing above) | $30 |
| Sensing | Transparent coil grid layer (laminated) — ⚠️ **invented figure, unvalidated** (see Q-factor note) | $35? |
| | NFC reader IC + 16:1 mux | $8 |
| Light & sound | Dimmable warm frontlight (guide + LED + driver) | $20 |
| | WS2812 accent/edge glow (fast channel) | $5 |
| | I²S amp + speaker (cues + sanity drone) | $12 |
| Compute & power | Raspberry Pi (CM/4-class) — runs the engine standalone | $50 |
| | PSU + internal LiPo + charge/protection | $18 |
| Physical set | Cover glass / rigid bezel | $12 |
| | Sculpted minis ×4 + lantern, NFC-tagged bases | $32 |
| | Metal/resin dice + NFC dice tray (the dice-supply seam) | $22 |
| Finish | Collector enclosure (wood/resin, magnetic lid, fitted foam) + packaging — ⚠️ understated | $65+ |
| | Numbered plate + premium printed manual | $10 |
| Overhead | EMC / safety / battery certification (amortized) — ⚠️ low for an intentional radiator | $30+ |
| | Assembly & test (hand-built) — ⚠️ understated (2–4 h skilled labour) | $42+ |
| | **Landed COGS — original estimate** | ~~≈ $581~~ |
| | **Landed COGS — corrected** | **≈ $700–860** |

**The four corrections, and why:**

1. **Panel $190 → $330–500.** Retail-verified. This alone moves COGS ~$140–310.
2. **"Volume pricing" does not apply at 500 units.** 500 is *prototype scale*. Injection tooling
   doesn't amortise; a hand-built wood/resin enclosure with magnetic lid and fitted foam is not $65 at
   that quantity. Assembly of a laminated glass/coil/frontlight/e-ink/Pi/battery stack is 2–4 h of
   skilled labour, not $42.
3. **Certification is low.** $30/unit × 500 = $15k total for a device that is an intentional radiator
   (BLE/NFC) with a lithium cell — FCC Part 15 + CE/UKCA + UN38.3. If the C1′ powered mat ever ships,
   Part 18 testing adds materially.
4. **Sole-source supply risk.** E Ink is the only maker of Spectra 6 film; Waveshare/Good Display are
   module resellers. **A 500-unit order carries no allocation leverage** — you buy near retail, through
   distributors, with no second source. If supply tightens, the flagship has no fallback panel.

### Pricing (crowdfunded, numbered limited run)

| SKU | Panel | Corrected COGS | **Retail** | Corrected gross |
|---|---|---|---|---|
| Flagship — "Numbered Edition" | 13.3″ color | **~$700–860** | **$1,199** | ⚠️ **~28–42%** (was claimed ~52%) |
| Compact collector | 7.3″ color | ~$500–600 | **$849** | ~29–41% (was claimed ~48%) |
| Cost-down: phone-driven (drop the Pi; board is a BLE peripheral) | either | −$50 | −$100 | — |

- **The corrected flagship margin sits at or below the 30% floor**, *before* heavy/fragile fulfilment,
  ~8–10% platform fees, and returns. On the pessimistic panel price the unit is close to
  break-even after fulfilment. The $1,199 anchor does not survive its own BOM without either a
  materially cheaper panel (a real quote, or a smaller/mono panel) or a higher price.
- **The competitive frame is unfavourable.** Chessnut Air delivers equivalent piece-recognition
  sensing, in wood, with LEDs and an app, at **~$219–250** (see Option A). The flagship asks ~5× that
  for a colour e-ink surface plus an IP with, as of Aug 2026, **under 100 subscribers**.
- The panel is ~45–55% of corrected COGS, so **a cracked panel is a severe warranty liability** —
  budget the enclosure to protect it and plan a service-swap path.
- **Every reveal repaints the whole board.** Spectra 6 has **no partial refresh** and takes ~10–30 s
  full-panel. This is not a footnote — see the refresh constraint under display option 2.
- This is a **limited numbered run, crowdfunded** (the panel MOQ needs pre-funding). ⚠️ **A 500-unit
  flagship run implies a ~$600k raise**, which is not achievable at the current audience size — see
  [`go-to-market-reality.md`](./go-to-market-reality.md). Campaign plan:
  [`kickstarter-campaign-plan.md`](./kickstarter-campaign-plan.md).

## Open questions

- **Grid density:** 4×4 vs 5×5/6×6 — how many rooms must a single board show at once vs. re-lay-out per
  campaign? Drives PCB area + mux count (the main cost lever).
- **`PieceOn` vs `PieceMoved` in the bridge:** derive `dir` controller-side from successive `PieceOn`s
  (absolute, self-healing) or keep the relative event? Leaning absolute for the grid, relative for the
  discrete-tap tiers — the bridge can accept both.
- **Powered-board packaging:** USB-tethered (cheapest, −$3, but a cable on the table) vs. internal LiPo
  (cordless, adds cell + charge safety/cert). Same trade-off flagged for "The Lantern" tier.
- **Display tier at launch:** ship phone-glass only ($99) and hold large-e-ink as a later premium SKU,
  or launch both? The mono-e-ink coil-over-display stack (the TFT-coupling risk above) is the one piece
  that needs a hardware spike before it can be committed.
- **Fixed board vs. modular tiles (Option C):** is the product a single premium surface (A/B + display
  options) or an expandable modular-tile game (C)? These are different SKUs with different economics —
  and if C, the bounded-vs-unbounded map choice (C2 passive-pieces-on-a-baseboard vs. C1 smart pieces)
  decides whether pieces stay battery-free.
