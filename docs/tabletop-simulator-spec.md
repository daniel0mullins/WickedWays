# `@wickedways/tabletop` — Physical Tabletop Client Spec

> Companion to [`tabletop-display-design.md`](./tabletop-display-design.md) (the concept survey)
> and [`docs/superpowers/specs/2026-07-14-rust-phase-2c-tabletop-client-inputs.md`](./superpowers/specs/2026-07-14-rust-phase-2c-tabletop-client-inputs.md)
> (the inputs this design asks of the Phase 2c multiplayer sub-projects). Reconciled against the
> Phase 2c program (Rust everywhere + a Dioxus web client; TS surfaces retired in sub-project D,
> deleted in step F).

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

`sceneHotspots(vm)` / `inventoryActions(...)` (`packages/play-surface/src/pnc/affordances.ts`)
are the behavioral reference for deriving per-tile action affordances — reference them as the
oracle, not a permanent import (they're TS, and F deletes TS).

## Dashboards & the `status`-cue attribution gap

The seat dashboards surface each player's Health/Sanity/Energy + Panic/Fear/KO, which are **not**
in the `ViewModel` (occupants/scope are *others*) — they arrive via the **`status` cue** from a
campaign's status mechanic. Two constraints:

- **Reference campaign is Hollow House** (`packages/campaigns/src/hollow-house`) — it has a
  status-bar mechanic (plus dark rooms, a keyed door, a resident mob).
- **Multi-seat routing gap:** only the `action` cue carries an actor; `status` does not, so it
  can't be routed to a specific seat. Baseline fix for the single-box: **drive each dashboard from
  a per-character view projection** (the one Authority holds every character's state) and treat the
  `status` cue as an animation trigger. (This is also how *secret* per-player info works without
  networking.) See the input note for the alternative — adding `subject`/`actorId` to the cue.

## Phasing

- **P0 — throwaway dev simulator (optional, now).** A TS/DOM `SimulatorTransport` driving the
  engine `GameSession` (single-player today) to de-risk the *device* concerns only: tile placement
  + collision resolution, directional piece-drag → move, dark/lit reveal, dashboards. Explicitly
  scaffolding — **do not** land a permanent TS `packages/tabletop` on the retiring stack.
- **P1 — the single-controller box (the real near-term product).** Bridge logic in Rust over the
  engine `Authority`, plus sub-project **A**'s actor-tagged multi-seat commands. `DeviceTransport`
  drives a simulator first (Dioxus, to align with the surviving UI stack), then a `SerialTransport`.
- **P2 — hardware.** ESP32 + e-ink tiles; NFC piece/lantern identity (the `actor_id` source).
- **P3 — full board + engine-gap decisions.** N tiles; the design-doc engine gaps now settled via
  the input note (`placeLight` is already in A1; dice-supply must enter through the seeded rng as
  command data, per the determinism invariant).
- **Optional later — networked Replica (Shape 2).** Only if remote/hybrid play is wanted; pulls in
  B/C/D.

## Verification

- **P0 simulator:** `FakeTransport` (records device commands, scripts device events) drives the
  prototype against a real single-player `GameSession` on Hollow House. Assert: startup reveal;
  directional drag → `move`; dark room stays `concealed` until a light action; encounter →
  `led`+`sound`; illegal move → `led "reject"` + piece snap-back; dashboards from per-character
  projection + `status` cue.
- **P1 box:** the bridge is tested against the engine `Authority` on a fixture campaign — commands
  resolve, cues route to the right tile/seat, `snapshot`/`restore` round-trips the board (tile→room
  assignments in the surface state). Actor-tagging: an out-of-turn command is rejected.
- **Shape 2 (if built):** the Phase-2c differential harness — same seed + command sequence yields
  identical `Delta`s / projected `ViewModel` through the Replica as through the frozen
  `src/lib/sync/` oracle.
- `pnpm checks` green; update `README.md` when a real surface lands.

## Open questions (for the user)

1. **Build the P0 throwaway simulator now, or go straight to the Rust P1 bridge?** P0 de-risks the
   physical interaction model independently of the migration, at the cost of throwaway TS.
2. **Confirm the single-controller box as the target** (vs. planning for networked play up front) —
   it's the cheaper, simpler default and needs only sub-project A, but forecloses remote players
   until Shape 2 is added.
3. **GM model** — engine-as-GM (no GM device) vs. a GM-privileged actor with a control device.
   Raised as an input to A; changes whether the board needs any GM hardware.
