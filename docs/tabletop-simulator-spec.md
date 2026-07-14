# `@wickedways/tabletop` — Physical Tabletop Client Spec

> Companion to [`tabletop-display-design.md`](./tabletop-display-design.md) (the concept
> survey). **Reconciled against** the Phase 2c program design
> ([`docs/superpowers/specs/2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./superpowers/specs/2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md)),
> which sets the endgame as **Rust everywhere + a single Dioxus web client**, with the
> TypeScript surfaces retired (sub-project D) and then deleted (step F). This spec targets the
> **durable seam**, not the retiring one.

## Context

We want to drive a physical e-ink tabletop (color e-ink map tiles + player pieces) from the
engine. The original design doc showed a tabletop is "just another presentation surface." But
Phase 2c changes *which layer* that surface should attach to: the TS `PlaySurface` /
`play-runtime` / `play-surface` stack is being ported to Dioxus and then deleted, and the
engine is going multi-seat (Authority/Replica + Delta + append-log over an axum WebSocket room
server). Building a permanent TS surface on the old stack would be building on ground that
step F removes. This spec re-anchors the tabletop on the seam that survives the migration.

## The durable seam (what to build against)

Phase 2c fixes a **serializable-only boundary** (master-design invariant 4): the engine and
surfaces know the concrete `Command` / `Delta` / `ViewModel` types; the transport
(`packages/transport-shared`) relays them as **opaque bytes**. Two roles share one
`wickedways-core` crate:

- **`Authority`** (server / single-player) — resolves commands, mutates state, computes deltas.
- **`Replica`** (multiplayer client) — applies authoritative `Delta`s and projects `ViewModel`s.
  Never resolves commands locally (no optimistic mutation, no rollback).

**A physical tabletop is a `Replica` with a physical projection.** It:
1. receives authoritative `Delta`s / `ViewModel`s and renders them onto tiles/pieces/LEDs, and
2. submits **actor-tagged `Command`s** (a piece move = a `move` command carrying that seat's
   `actorId`) up to the Authority via the same opaque transport a Dioxus client uses.

That is the integration contract. Everything below is organized around it.

> **Naming hazard (from #70):** "Authority" means *both* the single-player WASM engine handle
> (`crates/wickedways-wasm/src/authority.rs`) **and** the multiplayer sync authority
> (`src/lib/sync/authority.ts`, to become `SyncAuthority` in Rust, sub-project B). This spec
> means the **sync/server Authority** unless it says "engine Authority."

## Multiplayer is the fit, not a limitation

The tabletop maps onto the multi-seat model cleanly, and it resolves the single-player ceiling
the earlier draft apologized for:

- **Each player piece = a seat/actor.** Moving a piece submits a command tagged with that
  piece's `actorId` (sub-project A: the actor-tagged `Command` union in `src/lib/sync/types.ts`,
  with `selectArchetype` / `joinCampaign` / `leaveCampaign` / `transferGM` / `mobEscape` /
  `mobAttack` / `beginCampaign` arms and the `commandActorId` / `isTurnAction` / `isGmCommand`
  classifiers).
- **The table is one shared Replica.** All pieces render from the same authoritative view; there
  is no per-seat client — the physical board *is* the shared surface. (A GM tablet, if used, is a
  second Replica with GM-gated commands.)
- **GM model** (design-doc thread 2) now has a concrete home: engine-as-GM = no human GM seat;
  human GM = a GM-privileged actor whose commands pass the `isGmCommand` gate.

Because the board is a single shared Replica rather than N private clients, it sidesteps the
per-seat optimistic-UI concerns entirely — it only ever renders authoritative state.

## Consume `Delta`, don't re-diff `ViewModel`s

The earlier draft hand-rolled a before/after `ViewModel` diff to compute tile updates. Phase 2c
makes that redundant and slightly wrong: the sync core **already** computes authoritative
`Delta`s (`src/lib/sync/delta-computer.ts` → the Rust `Delta`, sub-project B) as
per-collection created/changed/removed classifications. The tabletop Replica should **apply the
`Delta` stream** and read the projected `ViewModel`, mapping deltas → device commands. No
client-side re-diffing.

- **Caveat / today's gap:** the *single-player* engine Authority
  (`authority.rs`) returns `ExecuteResult { cues }` with **no delta/log** (per #70's
  reconciliation table). So a *pre-sub-project-B* prototype has no `Delta` to consume and must
  fall back to `ViewModel` diffing. Treat that fallback as scaffolding, not the design.

## Transport-agnostic bridge logic (the durable, portable core)

Independent of TS-vs-Rust and DOM-vs-Dioxus, the tabletop needs bridge logic that is pure and
language-portable (it will ultimately live in Rust/Dioxus, sub-project D-adjacent):

- **`protocol`** — the device message union (surface ↔ device), unchanged in spirit:
  - Surface→device: `tile {tileId, roomId, label, image?, lit, concealed}`,
    `tileLamp {tileId, on}`, `led {tileId, effect: encounter|combat|reject|off}`,
    `piece {pieceId, tileId|null, glow: normal|fear|panic|ko}`,
    `dashboard {seat, fields: StatusField[], turn, maxTurns}`, `sound {ref}`,
    `resolution {outcome}`.
  - Device→surface: `pieceDrag {pieceId, dir}`, `tileAction {actorId, command}`,
    `lantern {tileId, placed}` (future light prop).
- **`TileMapper`** — `ViewModel` + map grid → tile render state, incl. a **collision-resolution
  pass**: the compass-delta embedding (`DIRECTION_DELTA`) can drop two rooms on one cell, so
  nudge deterministically to the nearest free cell and **log the nudge** (no silent overlap). A
  tile is `concealed` when `room.dark && !room.isLit` (mirror the dark short-circuit) until a
  `visibility {lit:true}` flips it.
- **`IntentResolver` → `CommandBuilder`** — **directional** input (input is directional, not
  tile-to-tile, because `ExitView` carries only `{dir, toName}` and the destination tile may be
  an unexplored stub). Resolve a `pieceDrag` to the nearest compass `Direction`; if it matches a
  `vm.exits` / `vm.lockedDoors` dir, emit a **`move` command tagged with the piece's `actorId`**;
  a locked-door dir still submits and lets the engine reject (surfacing `led "reject"`), keeping
  lock logic authoritative in the core.
- **`DeviceTransport`** — the swappable boundary; `SimulatorTransport` (screen) now,
  `Serial`/`WebSocketTransport` (firmware) later. This is *device* transport, distinct from the
  *sync* transport that carries `Command`/`Delta` to the Authority.

`sceneHotspots(vm)` / `inventoryActions(...)` (`packages/play-surface/src/pnc/affordances.ts`)
remain the right reference for deriving per-tile action affordances — but note they will be
re-expressed in the Dioxus client (D); reference them as the behavioral oracle, not a permanent
import.

## Rendering target: Dioxus web (per sub-project D)

The client is Dioxus web (DOM/CSS carryover keeps campaign-owned theming). The tabletop's
on-screen simulator therefore belongs as a **Dioxus component / route**, alongside the CRT and
point-and-click surfaces D reproduces — *not* a new permanent TS/Lit surface package that F
would delete.

## PC self-stats dependency (unchanged, still true)

A character's own Health/Sanity/Energy are not in the `ViewModel` (occupants/scope are *others*)
— they arrive via the **`status` cue** emitted by a campaign's status mechanic. So the seat
dashboard is fed by `status` cues; a campaign without a status mechanic shows only `vm.status`
(turn/location). This is why the reference campaign is **Hollow House**
(`packages/campaigns/src/hollow-house`) — dark rooms, a keyed door, a resident mob, *and* a
status-bar mechanic.

## Phasing (aligned to the A–F program)

The tabletop is **not** one of A–F; it is a new physical-client track that *depends on* them.

- **P0 — optional throwaway prototype (now, explicitly scaffolding).** A minimal TS/DOM
  simulator driving the **engine `GameSession`** (single-player, `ViewModel`-diff fallback since
  there's no `Delta` yet) to de-risk the *device* concerns only: tile placement + collision
  resolution, directional piece-drag → move, dark/lit reveal, dashboard from `status` cues. Built
  and discarded like the "throwaway Dioxus spike" #70 describes — **do not** land a permanent
  `packages/tabletop` on the retiring stack.
- **P1 — the real client (after A/B + D).** Implement the tabletop as a **Dioxus physical-Replica
  client**: apply the `Delta` stream, submit actor-tagged `Command`s over the sync transport,
  render via the `DeviceTransport` boundary. Each piece is a seat.
- **P2 — hardware transport.** `SerialTransport` to one ESP32 + one e-ink tile (device protocol
  over the wire; the Replica logic is unchanged).
- **P3 — full board.** N tiles + NFC piece/lantern sensing; and the two engine-gap decisions from
  the design doc — the `placeLight` command arm and the **dice-supply rng seam** — which now also
  have to hold under the **determinism invariant** #70 leans on (same seed + command sequence ⇒
  identical deltas), so a host-supplied roll must enter through the seeded rng, not around it.

## Verification

- **P0 prototype:** `FakeTransport` (records device commands, scripts device events) drives the
  prototype against a real single-player `GameSession` on Hollow House. Assert: startup reveal;
  directional drag → `move`; dark room stays `concealed` until a light action; encounter →
  `led`+`sound`; illegal move → `led "reject"` + piece snap-back; dashboard from `status` cues.
- **P1 client:** gated the Phase-2c way — a **differential harness**: same seed + actor-tagged
  command sequence yields identical `Delta`s / projected `ViewModel` whether driven through the
  tabletop Replica or the frozen `src/lib/sync/` oracle. Device-command mapping unit-tested off
  fixture deltas. Visual/e2e parity for the Dioxus simulator component.
- `pnpm checks` (and, for Rust, the differential gate) green. Update `README.md` when a real
  surface lands.

## Open questions (for the user)

1. **Build the P0 throwaway now, or wait for D?** P0 de-risks the *physical* interaction model
   (tiles, pieces, light) independently of the Rust/Dioxus migration, at the cost of throwaway TS.
   The alternative is to fold the tabletop entirely into the D (Dioxus client) spec and build
   nothing until A/B/D exist.
2. **Where does the tabletop track slot into A–F?** Naturally after D, but its *engine-gap* asks
   (the `placeLight` command arm, the dice-supply seam) touch sub-project A's command union — so
   they may want to be raised as A-spec inputs rather than deferred to P3.
3. **GM model for the physical table** (engine-as-GM vs. a GM-privileged actor with a tablet
   Replica) — this is a seat-model decision that belongs in the A spec, and it changes whether the
   board needs any GM hardware.
