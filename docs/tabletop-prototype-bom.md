# Tabletop prototype — parts list (BOM)

> Hardware to build a working prototype of the physical tabletop, driven by the same
> `DeviceCommand`/`DeviceEvent` protocol the on-screen simulator uses (see
> [`tabletop-firmware-sketch.md`](./tabletop-firmware-sketch.md)). Prices are **rough** (USD, 2026,
> hobby quantities) and vary by vendor/region — treat them as order-of-magnitude. Color e-ink is the
> cost driver.

## Two build tiers

- **Tier 0 — one-tile smoke test (~$60 + a laptop you own).** Proves the *`SerialTransport` + one tile*
  end-to-end: the engine + bridge run on your laptop; one ESP32 drives one e-ink tile, one NFC reader,
  and an LED strip over USB serial. Build this first to de-risk the P3 `SerialTransport` before buying
  four of everything.
- **Tier 1 — four-tile prototype (~$350–450).** A small controller (Raspberry Pi) runs the engine +
  bridge natively and drives four tiles, three pieces, a lantern, and per-seat dashboards. Enough to
  play the Foyer→Hall→… opening of Hollow House on real tiles with real pieces.

The list below is **Tier 1**; the Tier-0 subset is called out at the end.

## Architecture recap

One **controller** owns the engine (`wickedways-core`) + the bridge (`wickedways-tabletop`). Tiles and
pieces are dumb peripherals. Each subsystem maps to a protocol channel:

| Subsystem | Protocol | Direction |
|---|---|---|
| Color e-ink panel | `Tile`, `Resolution` | out (slow) |
| WS2812 LED ring | `Led`, `Piece.glow` | out (fast) |
| PN532 NFC reader | `PieceMoved`, `Lantern` | **in** |
| OLED seat readout | `Dashboard`, `Banner` | out |
| I2S speaker | `Sound` | out |

## BOM — Tier 1 (four-tile prototype)

### Controller (runs the engine + bridge)
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 1 | Raspberry Pi 5 (4 GB) | 1 | $60 | $60 | Native Rust (`cargo`); SPI + I²C + GPIO. A Pi 4 (~$45) works too. |
| 2 | microSD card, 32 GB | 1 | $8 | $8 | OS + the engine binary + genesis/catalog fixtures. |
| 3 | USB-C PSU (5 V/5 A) | 1 | $12 | $12 | Official Pi 5 supply. |

### Per-tile ×4 (map tiles)
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 4 | Color e-ink module — Waveshare 4″ Spectra-6 (E6), 7-colour, SPI | 4 | $40 | $160 | The room "floor." Reflective ⇒ a dark/`concealed` tile is genuinely unreadable. Slow refresh is fine (tiles change only on reveal). Cheaper alt: 5.65″ ACeP (~$50) or **monochrome** 2.9″ (~$18, faster) if colour isn't essential yet. |
| 5 | PN532 NFC/RFID module (I²C/SPI) | 4 | $7 | $28 | One under each tile — reads *which piece* (identity) is on *which tile* (position). |
| 6 | WS2812B LED ring (12-LED) or short strip | 4 | $3 | $12 | The fast channel: encounter/combat/reject/affliction glow, active-seat ring. |
| 7 | TCA9548A I²C multiplexer (8-ch) | 1 | $5 | $5 | PN532s (and OLEDs) share an I²C address — the mux fans them out. One covers 8 tiles. |
| 8 | 74AHCT125 level shifter | 1 | $2 | $2 | 3.3 V (Pi) → 5 V WS2812 data. |

### Pieces & props
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 9 | NTAG215 NFC tags (disc/sticker) | 8 | $0.40 | $3 | The tag UID → `actor_id`. 3 pieces + 1 lantern + spares. |
| 10 | Player-piece bodies (miniatures / 3D-printed tokens) | 3 | $2 | $6 | Any token with a flat base to seat a tag; reuse tabletop minis if you have them. |
| 11 | Lantern prop (token + tag) | 1 | $2 | $2 | Placing it lights a tile (`Lantern` → place-light). |

### Per-seat dashboards ×3
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 12 | SSD1306 0.96″ OLED (I²C) | 3 | $4 | $12 | HP / Sanity / afflictions per seat (`Dashboard`). Share the TCA9548A. |

### Audio (optional but high-atmosphere)
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 13 | MAX98357A I²S amplifier | 1 | $5 | $5 | Drives the cue sounds (`Sound`) + the sanity drone. Or skip and use the Pi's audio jack + a powered speaker. |
| 14 | Speaker 3 W / 4 Ω | 1 | $3 | $3 | |

### Power, wiring, structure
| # | Part | Qty | ~Unit | ~Sub | Notes |
|---|---|---|---|---|---|
| 15 | 5 V / 4 A supply (LEDs + e-ink) | 1 | $10 | $10 | Separate rail from the Pi; common ground. |
| 16 | Breadboards (or protoboard) | 2 | $4 | $8 | |
| 17 | Jumper-wire assortment (M-M, M-F, F-F) | 1 | $8 | $8 | |
| 18 | Header pins / SPI-CS wiring / misc | 1 | $5 | $5 | Each e-ink needs its own SPI CS line off the Pi. |
| 19 | Baseboard + standoffs (foam-board or laser-cut ply) | 1 | $15 | $15 | The tile grid substrate. |
| 20 | Felt + neodymium magnets (piece bases, tile seating) | 1 | $6 | $6 | Optional; keeps pieces registered on tiles. |

**Tier-1 estimate: ≈ $370** (call it **$350–450** with shipping and price variance).

## Tier 0 — one-tile smoke test (~$60)

Run the engine + bridge on a **laptop** (no Pi); one ESP32 drives one tile over USB serial.

| Part | Qty | ~Unit | Notes |
|---|---|---|---|
| ESP32-S3 dev board | 1 | $8 | Speaks the `DeviceCommand`/`DeviceEvent` protocol over USB-CDC. |
| Color e-ink module (4″ Spectra-6, or a mono 2.9″ at ~$18) | 1 | $40 | |
| PN532 NFC module | 1 | $7 | |
| WS2812B strip (8-LED) | 1 | $3 | |
| NTAG215 tags | 5 | $0.40 | pieces + lantern. |
| Jumper wires + breadboard | 1 | $6 | |

This exercises the whole loop for one tile: place a tagged piece → `PieceMoved` → `bridge::resolve` →
engine → `bridge::render` → paint the tile + LEDs. It's the cheapest way to validate the `SerialTransport`
you'd write in P3 before committing to a full board.

## Tools you'll need

Soldering iron + solder (most modules ship with unsoldered headers), wire strippers, a multimeter,
and the Raspberry Pi imager / `rustup` toolchain. No specialist gear beyond that.

## Notes & substitutions

- **Color e-ink is the budget lever.** Monochrome e-ink is far cheaper and refreshes in ~1 s (vs
  15–30 s), at the cost of the "reflective darkness" effect. Repurposed **electronic shelf labels
  (ESLs)** are another cheap route for a larger board.
- **Scaling to a full board:** e-ink, PN532, and LEDs scale linearly per tile; the TCA9548A handles 8
  I²C devices (chain a second mux beyond that), and past ~4 tiles you'll want a per-tile MCU (ESP32) on
  a shared bus (the firmware-sketch topology) rather than everything on the Pi's GPIO.
- **What's not on this list:** the dice tray / physical-dice input (the dice-supply rng seam is still an
  open engine question) and any GM device (the prototype runs **engine-as-GM**, so none is needed).
