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
