# Tabletop firmware sketch (P2/P3)

> A **firmware design sketch** — the *ESP32 tile firmware* is not compiled in this repo. The **host end
> of the link is built**: `wickedways-controller` runs the engine + bridge and speaks this exact
> protocol over serial (see [the software-side section](#the-software-side-p3--built) below). This
> document shows how the transport-agnostic bridge (`crates/wickedways-tabletop`) reaches real hardware:
> the same `DeviceCommand`/`DeviceEvent` protocol the on-screen simulator uses, spoken over a serial
> link to an ESP32 driving color e-ink tiles and NFC readers. See
> [`tabletop-simulator-spec.md`](./tabletop-simulator-spec.md) (P2) for how this fits the phasing, and
> [`tabletop-prototype-bom.md`](./tabletop-prototype-bom.md) for the parts to build it.

## The shape

```
   ┌─────────────────────── controller (Pi / ESP32-S3) ────────────────────────┐
   │  wickedways-core engine (SyncAuthority, solo)                              │
   │        │ ViewModel + roster + map                                         │
   │  wickedways-tabletop::bridge::render  ──► Vec<DeviceCommand>              │
   │        │                                          ▲ DeviceEvent           │
   │  DeviceTransport  (SerialTransport)  ◄────────────┘  bridge::resolve      │
   └────────────────────────────┬──────────────────────────────────────────────┘
                                │  COBS-framed JSON (or postcard) over UART/USB
   ┌────────────────────────────┴──────────────────────────────────────────────┐
   │  tile MCUs (ESP32 + Spectra-6 e-ink + WS2812 ring + PN532 NFC), on a bus   │
   └───────────────────────────────────────────────────────────────────────────┘
```

The controller owns the engine and the bridge; the tiles are dumb peripherals. A `SerialTransport`
(the P2/P3 sibling of the web `SimulatorTransport`) implements `DeviceTransport`: `send` frames each
`DeviceCommand` down the bus; `poll` decodes inbound `DeviceEvent`s.

## Wire framing

- **Transport:** UART/USB-CDC, one line per message, **COBS**-framed so a `0x00` delimiter can never
  appear mid-payload. (postcard/`serde` is a good binary alternative to the JSON the protocol already
  derives.)
- **Addressing:** the tile MCU whose configured `tile_id == cmd.tile_id` acts on a `Tile`/`Led` command;
  `Piece`/`Dashboard`/`Banner` fan out to the tile/seat panel that owns them.

## Outbound: `DeviceCommand` → hardware

| Command | Hardware action | Channel |
|---|---|---|
| `Tile { label, lit, concealed, remains }` | render the room's art on the e-ink panel; `concealed` ⇒ paint the "unlit" plate | **e-ink (slow)** |
| `Piece { tile_id, glow, active }` | (simulator draws a token; on hardware the *physical* piece is the token — used to validate expected position) | — |
| `Led { effect }` / piece `glow` | WS2812 ring: encounter pulse, combat flash, `reject` red, Fear amber, Panic strobe, active-seat ring | **LED (fast)** |
| `Dashboard { health, sanity, afflictions }` | the seat's small OLED/e-ink readout | e-ink/OLED |
| `Sound { asset }` | play the resolved cue on the table speaker (I2S DAC) | audio |
| `Resolution` / `Clear` | endgame plate / wipe the board | e-ink |

**e-ink is slow (~15–30 s full refresh), so `Tile` fires only on reveals/state changes** — infrequent
and deliberate. All live feedback (encounter, combat, reject, affliction glow, whose-turn ring) rides
the **LED fast channel**, never e-ink. Reflective e-ink is also *why* darkness is physically real: a
`concealed` tile has no backlight, so you literally can't read it until a light is brought.

## Inbound: NFC → `DeviceEvent`

The crux: **the NFC tag in a piece's base encodes its `actor_id`.** Each tile has a PN532; the firmware
continuously reports which tag sits on which tile.

```
on tag T detected on tile B (was on tile A):
    dir  = compass_of(A → B)        # invert the fog-of-war grid delta; reject non-unit steps
    emit DeviceEvent::PieceMoved { actor_id: tag_to_actor(T), dir }
```

The controller feeds that to `bridge::resolve`, which builds `Command::Move { actor_id, .. }` and
submits it. The engine's `authorize` gate does the rest:

- **Wrong turn / locked door / no exit** ⇒ `resolve` returns `Err` (or the submit is `Denied`) ⇒ the
  controller sends `Led { tile_id: B, effect: Reject }` (red flash) — no turn logic lives in firmware.
- **Legal** ⇒ the delta's new state re-renders via `render` → `DeviceCommand`s back out.

`tag_to_actor` is a small controller-side table (tag UID → `"player:<name>"`) built when pieces are
paired; a non-character **lantern** tag emits `DeviceEvent::Lantern { placed }` (→ a place-light on the
board, P3). Contextual actions (attack/take/…) arrive as `TileAction { actor_id, intent }` from tile
buttons or an item-NFC tap — their exact hardware form is the open P3 question.

## Debouncing & validation (firmware concerns, not the bridge's)

- **Settle** each NFC read (a piece hovering between cells, or lifted mid-move) before emitting a
  `PieceMoved`.
- **Reject non-adjacent placements** (a piece dropped two tiles over) at the firmware or via the
  engine's exit check — surfaced as a `reject` LED, never a fabricated multi-step move.
- **Idempotent redraws:** the bridge re-emits the full board each turn, so a tile that missed a frame
  self-heals on the next `Tile` command.

## The software side (P3) — built

The host/controller software now exists (the ESP32 firmware above is still a sketch):

- **`wickedways-tabletop::codec`** — the COBS-framed JSON wire format (`encode_command` +
  `FrameDecoder`), kept pure and wasm-safe in the bridge crate and covered by the normal test gate.
- **`wickedways-controller`** — a workspace crate: the native `SerialTransport: DeviceTransport`
  (`serialport`, opened by explicit path with `default-features = false` so it needs no `libudev-dev`)
  plus the host controller binary wiring an in-process solo `SyncAuthority` → `bridge::render`/`resolve`
  → transport. `cargo run -p wickedways-controller -- <port> [baud]` drives real hardware;
  `--dry-run` runs the whole engine→bridge→codec loop (paint the opening board, apply one piece move,
  repaint) with no device attached.

Resolved since:

- The **dice-supply** seam is built. A `DeviceEvent::DiceRolled { sides, values }` (a dice tray, or a
  manual entry) resolves to `Command::SupplyDice`, which loads the engine's shared dice tray; the next
  `World::draw_die` of that size consumes it (a literal physical outcome), else the seeded rng rolls
  ("Roll for me"). Its first consumer is a **mob d20 to-hit** roll (crit/hit/miss/stumble). Supplied
  dice are recorded command data, so replay stays deterministic. On hardware, a dice-tray MCU (or NFC
  dice) emits `DiceRolled` on the same COBS link.

Still open:

- The `TileAction` hardware affordance (tile buttons vs. item taps) — the protocol carries it, but no
  hardware form is decided.
- The ESP32 tile firmware itself (this document).
