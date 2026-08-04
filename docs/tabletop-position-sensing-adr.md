# Position sensing: coil grid vs. coded laser fence (ADR)

> **Status:** design ADR, undecided. Specs two camera-free ways to answer *"which piece is on which
> tile"* on a physical board, for a sub-$100 consumer SKU. Extends the tile/NFC hardware in
> [`tabletop-prototype-bom.md`](./tabletop-prototype-bom.md) and the bridge in
> [`tabletop-firmware-sketch.md`](./tabletop-firmware-sketch.md). Both options plug into the *same*
> `wickedways-tabletop` bridge — this is a **transport/sensor** decision, nothing above the transport
> changes.

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
- **New protocol surface (either option):** `DeviceEvent::PieceOn { tile_id, actor_id }` — an absolute
  "piece X is now on tile Y" report, from which the controller derives the `dir` for
  `bridge::resolve` (or a `bridge` helper does, rejecting non-adjacent jumps as today). Absolute
  reports self-heal a missed frame; the existing relative `PieceMoved` stays for the discrete-tap tiers.

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
  DGT / Chessnut electronic boards work — a mass-produced, camera-free, calibration-free product that
  identifies which piece is on which square, retailing right around the $100 target.** That is the
  existence proof that the capability *and* the price point are real today.

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

**Closes comfortably:** $99 retail on ~$43 COGS ≈ **57% gross margin**, leaving real headroom for
channel/fulfilment before the 30% floor. A finer (5×5/6×6) grid adds ~$1/mux + PCB area and still
lands under $55.

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

- **Color vs mono is really a refresh-*granularity* decision.** Color ACeP / Spectra-6 needs a
  **full-panel** refresh (~15–30 s, no partial update) — so revealing one room redraws the *whole
  board*, slowly. **Mono** e-ink supports **partial/windowed** refresh (~0.3–1 s) — repaint just the
  room that changed. For a *single large* panel, **mono wins decisively on UX.** If color is a must,
  use a *few medium panels* so a reveal refreshes only the affected panel (the per-tile firmware
  topology, coarsened).
- **Stacking is the integration risk.** A coil grid couples through *non-metallic* layers, but an
  e-ink **TFT backplane may attenuate/detune** the 13.56 MHz field. Safer stack: coils as a thin
  flex / transparent-conductor layer **between the e-ink and the clear cover** (right under the piece),
  *not* beneath the e-ink. Validate coupling through the actual cover before committing. The rigid cover
  also protects the fragile e-ink and gives pieces a flat surface.
- **Cost reality — this is a premium SKU, not the $99 product.** Large e-ink is the cost driver and
  scales *nonlinearly* with area:

  | Panel | ~Landed COGS | Verdict |
  |---|---|---|
  | Large **color** (13″ Spectra-6, ~$180–200 panel) | **$150–250** | blows $100 — a $199–299 "deluxe" edition only |
  | Large **mono** (10–13″, ~$90–130 panel) | **$90–120** | at/over the ceiling — realistically a ~$129–149 SKU |
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
delivers identity+position natively at exactly the engine's resolution, at a COGS the e-chessboard
industry has already proven at this price. NFC-UID reuses the tags already in the BOM and the existing
`tag_to_actor` table; LC-resonant is a later cost-down (cheaper passive pieces, no per-tag silicon)
once volume justifies custom-tuned tags.

**Keep the laser fence as an aesthetic upgrade path, not the base sensor.** Its unique asset is
theatre, not accuracy. If a future premium SKU wants the red-sweep drama, run the laser as a
*presence/position* layer with identity from NFC-at-placement — never ask one cheap beam to read a
wrapped barcode.

Either way the engine and bridge are untouched above the transport: a `CoilGridTransport` (or
`LaserFenceTransport`) implements `DeviceTransport`, emits `PieceOn`, and everything from
`bridge::resolve` up — authorize, the solo loop, the dice seam — already exists.

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
