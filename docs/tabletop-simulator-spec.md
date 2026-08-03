# Physical Tabletop Client Spec (the `physical-tabletop` surface)

> Companion to [`tabletop-display-design.md`](./tabletop-display-design.md) (the concept survey)
> and [`docs/superpowers/specs/2026-07-14-rust-phase-2c-tabletop-client-inputs.md`](./superpowers/specs/2026-07-14-rust-phase-2c-tabletop-client-inputs.md)
> (the inputs this design asks of the Phase 2c multiplayer sub-projects). Reconciled against the
> Phase 2c program (Rust everywhere + a Dioxus web client; TS surfaces retired in sub-project D,
> deleted in step F).

## Implementation status (built)

**Shape 1 (single-controller) is implemented** as an on-screen simulator: a Dioxus **surface** in
the shipped web client, `crates/wickedways-web/src/tabletop.rs` (`tabletop_app`), registered
alongside the CRT and point-and-click surfaces (`driver.rs` `SURFACE_INFOS` + `launcher.rs`). It
renders the fog-of-war map as chunky room tiles with a piece per party seat, a movement + action
rail, and per-seat dashboards.

- **Single piece** and **local hotseat multi-seat** both ship. A single-player game seats the
  genesis's Player 1; a party-builder adds up to 3 more explorers, joined via `driver::boot_hotseat`
  (`rebuild_single` + the `lobby` join builders + `BeginCampaign`) before the offline **`solo`**
  authority rotates every seat (start-turn → action → mob reactions → next player). Each piece is an
  actor; `driver::intent_to_command` stamps the active seat's `actor_id`.
- **The device boundary is real (P2 software).** The `TileMapper`/`IntentResolver`/`DeviceTransport`
  described below are now a crate — **`crates/wickedways-tabletop`**: the `protocol`
  (`DeviceCommand`/`DeviceEvent`), the pure `bridge::render` (engine state → device commands) and
  `bridge::resolve` (events → actor-tagged commands via `command_for`), a `DeviceTransport` trait +
  `FakeTransport`, and the shared fog-of-war `map` + party `roster`. The web surface **renders through
  it**: a `Signal<Vec<DeviceCommand>>` is the on-screen `SimulatorTransport`, and the board draws from
  those commands. The same crate drives real firmware by swapping the transport.
- **The serial link + host controller are built (P3 software).** `wickedways-tabletop::codec` is the
  COBS-framed JSON wire format (`encode_command` + a chunk-tolerant `FrameDecoder`), pure and wasm-safe.
  **`crates/wickedways-controller`** is the native host: a `SerialTransport: DeviceTransport`
  (`serialport`, `default-features = false` so it needs no `libudev-dev`) plus a binary that runs the
  engine solo and drives it through `bridge::render`/`resolve`. `cargo run -p wickedways-controller --
  <port> [baud]` talks to hardware; `--dry-run` runs the whole engine→bridge→codec loop with no device.
- **Verified** via the workspace gates (`cargo build`/`clippy -D warnings`/`fmt`/`test --workspace`,
  incl. the bridge crate's `render`/`resolve`/`codec` tests, the controller's session tests, and the
  live `--dry-run`) and live headless-Chromium drives of Hollow House (single-piece: reveal-on-light,
  encounter, dark-room conceal; multi-seat: 3 pieces across tiles with independent per-seat Sanity, and
  turn hand-off).

What remains is the **ESP32 tile firmware** itself (real e-ink tiles + NFC piece/lantern identity —
sketched in [`tabletop-firmware-sketch.md`](./tabletop-firmware-sketch.md)) and the optional
**networked Replica** (Shape 2). The sections below are the original design; status callouts mark
what's now built.

## Context

We want to drive a physical e-ink tabletop (color e-ink map tiles + player pieces) from the
engine. The board can be built in **two shapes**, and picking the shape is the first decision
because it determines which sub-projects the tabletop depends on:

- **Single-controller box — the default.** One controller (Pi-class SoC) *is* the session: it
  runs the single-player engine **`Authority`** and drives every tile, LED, dashboard, and
  piece-sensor as **I/O peripherals**. Tiles are *displays*, not *clients* — one resolver owns the
  truth, so **no replication is needed**. Depends on **sub-project A only** (the multi-seat command
  model), *not* B/C/D.
- **Networked physical `Replica` — optional, later.** The board joins a room server as one client,
  applies authoritative `Delta`s, and submits commands over the wire. This is the only reason to
  pull in B/C/D, and it buys exactly one thing: **remote/hybrid players or independent
  state-holding devices.** Deferred unless that's wanted.

The rest of this spec is organized around the **single-controller** shape, with the networked
shape called out where it diverges.

> **Naming (from #70):** "Authority" is overloaded — the single-player **engine** `Authority`
> (`crates/wickedways-wasm/src/authority.rs`: `submit → ExecuteResult { cues }`, `view`,
> `snapshot`/`restore`) and the multiplayer **`SyncAuthority`** (sub-project B). The
> single-controller box uses the **engine** `Authority`; the networked shape uses `SyncAuthority`.

## Shape 1 — the single-controller box (default)

The controller runs the engine `Authority` natively (Rust on the SoC) and treats the board as
peripherals over a device bus. The integration is deliberately small:

- **State in:** `Authority.view()` → `ViewModel` each turn (room, occupants, exits, lit-state);
  `Authority.submit(command)` → `ExecuteResult { cues, mobAttacks? }`. **Cues arrive directly** —
  no propagation problem — so `status` / `encounter` / `visibility` / `resolution` all feed the
  board straight from `submit`.
- **Commands out:** the board submits **actor-tagged commands** (sub-project A). Multiple players
  take turns, so this is genuinely multi-actor even on one box — see *Actor identity* below.
- **Persistence:** `Authority.snapshot()` / `restore()` to an SD card. Combined with e-ink holding
  its image unpowered, the board *remembers the explored dungeon between game nights* (design-doc
  thread 4).
- **No `Delta`, no `Replica`, no server.** Those exist only to sync independent resolvers over a
  network; a single box has one resolver.

### Actor identity — the one multiplayer piece a single box still needs

A physical multi-seat table needs sub-project **A**'s actor-tagged commands. The killer
correspondence: **the identity tag in a piece's base *is* the `actor_id`** —
`NFC tag → actor_id → { kind:"move", dir, actorId } → authorize()`. Consequences:

- **Identity-bearing piece detection (NFC/RFID), not presence-only** — without per-piece identity
  the board can't tag commands and multi-seat collapses to fragile hotseat.
- **Turn-gating is free feedback** — A's `authorize` (`actor_id == active_character_id`) turns an
  out-of-turn nudge into a reject LED/buzzer; inverted, the known active character lets the board
  **pre-light whose turn it is**.

Full detail (and the `status`-cue attribution gap below) is in the [Phase 2c input note](./superpowers/specs/2026-07-14-rust-phase-2c-tabletop-client-inputs.md).

## Shape 2 — the networked physical Replica (optional, after D)

Only if remote players / independent devices are wanted. The board becomes a **`Replica`**:
applies authoritative `Delta`s (from B's `SyncAuthority` over an axum WebSocket, sub-project C)
and submits actor-tagged commands over the opaque transport a Dioxus client uses (D). Two things
change vs. Shape 1:

- **Consume `Delta`, don't re-diff** — the sync core already computes authoritative deltas; the
  Replica applies them and reads the projected `ViewModel`. No client-side diffing.
- **Cue delivery becomes a real question** — B's `LogEntry` carries a `Delta` (snapshot diff), and
  **cues are not in the snapshot**. This is the input note's networked-only ask (cues ride the log
  vs. re-derived from deltas). Shape 1 never hits this.

The board is a *single shared* Replica (everyone sees one board), so it sidesteps per-seat
optimistic-UI concerns — it only renders authoritative state.

## Transport-agnostic bridge logic (shared by both shapes)

The bridge is pure and language-portable; its durable home is **Rust, co-located with the engine
`Authority`** on the controller (a TS/DOM version is only dev scaffolding — see Phasing).

- **`protocol`** — the device message union (bridge ↔ device):
  - Bridge→device: `tile {tileId, roomId, label, image?, lit, concealed}`,
    `tileLamp {tileId, on}`, `led {tileId, effect: encounter|combat|reject|off}`,
    `piece {pieceId, tileId|null, glow: normal|fear|panic|ko}`,
    `dashboard {seat, fields: StatusField[], turn, maxTurns}`, `sound {ref}`, `resolution {outcome}`.
  - Device→bridge: `pieceDrag {pieceId, dir}`, `tileAction {actorId, command}`,
    `lantern {tileId, placed}` (light prop).
- **`TileMapper`** — `ViewModel` + map grid → tile render state, incl. a **collision-resolution
  pass** (the compass-delta embedding, `DIRECTION_DELTA`, can drop two rooms on one cell → nudge
  deterministically to the nearest free cell and **log the nudge**). A tile is `concealed` when
  `room.dark && !room.isLit` until a `visibility {lit:true}` flips it.
- **`IntentResolver` → `CommandBuilder`** — **directional** input (not tile-to-tile: `ExitView`
  carries only `{dir, toName}` and the destination tile may be an unexplored stub). Resolve a
  `pieceDrag` to the nearest compass `Direction`; if it matches a `vm.exits` / `vm.lockedDoors`
  dir, emit a **`move` command tagged with the piece's `actorId`**; a locked-door dir still submits
  and lets the engine reject (surfacing `led "reject"`), keeping lock logic authoritative in the
  core.
- **`DeviceTransport`** — the swappable boundary: `SimulatorTransport` (screen) for dev,
  `Serial`/`WebSocketTransport` (firmware) for hardware. Distinct from the *sync* transport of
  Shape 2.

`scene_hotspots(vm)` / `inventory_actions(...)` (`crates/wickedways-web/src/affordances.rs`) derive
the per-tile action affordances — and the built surface **imports them directly** (they are Rust,
not the retired TS `affordances.ts`).

## Dashboards & the `status`-cue attribution gap

The seat dashboards surface each player's Health/Sanity/Energy + Panic/Fear/KO, which are **not**
in the `ViewModel` (occupants/scope are *others*) — they arrive via the **`status` cue** from a
campaign's status mechanic. Two constraints:

- **Reference campaign is Hollow House** (`conformance/fixtures/hollow-house.toml`, compiled to the
  bundled `hollow-house.genesis.json` + `.catalog.json`) — it has a status-bar mechanic (plus dark
  rooms, a keyed door, a resident mob).
- **Multi-seat routing gap:** only the `action` cue carries an actor; `status` does not, so it
  can't be routed to a specific seat. **(Built)** the surface drives each seat card from a
  per-character read of the replica — `party_roster` in `tabletop.rs` pulls every seat's
  `stats.health`/`sanity`/`afflictions` from `coord.replica().characters`, and the `status` cue
  drives only the shared campaign banner. (This is also how *secret* per-player info would work
  without networking.) The cleaner long-term fix — adding `subject`/`actorId` to the cue — is still
  open (see the input note).

## Phasing

- **P0 — throwaway TS dev simulator.** ✅ **Skipped (moot).** The TS stack was deleted in step F, so
  there was nothing to de-risk on it; P1 was built directly in Rust/Dioxus instead.
- **P1 — the single-controller surface.** ✅ **Done.** The Dioxus `physical-tabletop` surface
  (`crates/wickedways-web/src/tabletop.rs`) over the offline `solo` authority, with single-piece and
  local hotseat multi-seat (`driver::boot_hotseat`), a party-builder, per-seat dashboards, piece
  coloring by affliction, and a Pass hand-off. Reuses `driver`/`map`/`affordances`/`narrator`/`audio`.
- **P2 — firmware / hardware.** 🔨 **Software done; hardware remaining.** The pure bridge logic lifted
  out of the surface into `crates/wickedways-tabletop` (`protocol`, `bridge`, `map`, `roster`,
  `command_for`), and the real `DeviceTransport` now exists: `codec` (COBS-framed JSON) +
  `crates/wickedways-controller`'s native `SerialTransport` and host binary, verified end-to-end via
  `--dry-run`. What's left is swapping the on-screen renderer for ESP32 + e-ink tiles and PN532 NFC
  piece/lantern identity (the `actor_id` source) — the firmware in
  [`tabletop-firmware-sketch.md`](./tabletop-firmware-sketch.md), with parts in
  [`tabletop-prototype-bom.md`](./tabletop-prototype-bom.md).
- **P3 — full board + engine-gap decisions.** ⏳ N tiles; the design-doc engine gaps are settled per
  the input note (`placeLight` landed in the core; dice-supply must enter through the seeded rng as
  command data, per the determinism invariant).
- **Optional — networked Replica (Shape 2).** ⏳ Only if remote/hybrid play is wanted; pulls in
  B/C/D. The client already has the `Multi` (WebSocket) path — the tabletop surface runs on it today
  as one seat per device.

## Verification

- **Workspace gates (P1, done):** `cargo build -p wickedways-web --target wasm32-unknown-unknown`,
  `cargo clippy … -D warnings`, `cargo fmt --all --check`, `cargo test --workspace` — including the
  launcher bootability gate, the `map.rs` layout tests, and the surface's seat/movement unit tests.
- **Live drive (P1, done):** `dx build`/`dx serve` + headless Chromium against Hollow House. Single
  piece: tiles reveal and grow on movement, encounter fires, a dark room stays concealed until lit.
  Multi-seat: the party-builder seats 3 explorers → 3 pieces + 3 dashboards → the active seat moves
  to a new tile while others stay (independent per-seat Sanity) → Pass rotates the active seat.
- **P2/Shape 2 (when built):** device-protocol tests against the engine `Authority`; and, for the
  networked Replica, the Phase-2c differential harness (same seed + command sequence ⇒ identical
  `Delta`s / projected `ViewModel`).
- **(Done)** the firmware bridge landed as its own crates — `wickedways-tabletop` (bridge + codec) and
  `wickedways-controller` (native `SerialTransport` + host binary), both listed in `README.md`.

## Resolved decisions

1. **P0 throwaway vs. Rust P1** → built P1 in Rust/Dioxus directly; no throwaway TS (the stack was
   already deleted).
2. **Single-controller box as the target** → confirmed and built (Shape 1). The networked Replica
   (Shape 2) stays optional; remote play would be added later, not up front.
3. **GM model** → **engine-as-GM.** The hotseat runs on the `solo` authority: the pre-seated seat 0
   is GM + Player 1 and the engine drives mob reactions, so a co-op box needs no GM device.
