# Phase 2c — Physical-tabletop client: inputs to sub-projects A / B / C / D

**Date:** 2026-07-14
**Status:** input note (not a sub-project; cross-cutting)
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md)
**Feeds:** [A (command vocabulary)](./2026-07-14-rust-phase-2c-a-command-vocabulary-design.md),
[B (sync core)](./2026-07-14-rust-phase-2c-b-sync-core-design.md), C (axum server), D (Dioxus client)
**Origin:** [`docs/tabletop-display-design.md`](../../tabletop-display-design.md) +
[`docs/tabletop-simulator-spec.md`](../../tabletop-simulator-spec.md)

> **Status (post-migration).** The Rust migration and Phase 2c landed, and the tabletop client's
> **single-controller shape is built** — a Dioxus surface (`crates/wickedways-web/src/tabletop.rs`)
> with local hotseat multi-seat via `driver::boot_hotseat`. Resolved since this note was written:
> `placeLight`/`takeLight`, directional `move`, and the actor-tagged multi-seat `Command` model all
> shipped in `wickedways-core`; the `Delta` now carries `cues` (input #2's recommended option (a),
> so the networked path is unblocked); and the built dashboards use **option (b)** below — per-seat
> stats read straight from the replica (`coord.replica().characters`), sidestepping the still-open
> `status`-cue actor gap. Input #4 (engine-as-GM) is **demonstrated**: the hotseat runs on the solo
> authority as engine-GM (the pre-seated seat 0 is GM + Player 1, the engine drives mob reactions),
> so a co-op box needs no GM device. Inputs #3 (Membership N-seats, networked-only) and #5
> (dice-supply) remain open as noted.

## Why this note

A physical e-ink tabletop (map tiles + player pieces) can be deployed in **two shapes**, and the
distinction determines which sub-projects it depends on:

- **Single-controller box (the likely default).** One Arduino-class controller *is* the session:
  it runs the single-player engine **`Authority`** (`crates/wickedways-wasm/src/authority.rs`:
  `submit → ExecuteResult { cues }`, `view`, `snapshot`/`restore`) and drives every tile, LED,
  dashboard, and piece-sensor as **I/O peripherals**. Tiles are *displays*, not *clients* — there
  is one resolver, so **no replication is needed** (B/C/D are not prerequisites).
- **Networked physical `Replica` (only if you want it).** The board joins a room server as one
  client, applies authoritative `Delta`s, and submits commands over the wire — the path that
  buys **remote/hybrid players** or **independent state-holding devices**. This is the "after D"
  shape; it needs B/C/D.

**Both shapes are multi-actor** (several players take turns moving their own pieces), so **both
need sub-project A** — the actor-tagged command/seat model. That is the one piece of "multiplayer"
work even a single, self-contained box cannot skip. Each input below is tagged with the shape(s)
it affects; none should expand 2c's scope.

## Already covered — no action, just confirmations

- **`placeLight` / `takeLight`** are in A's engine-action table (slice **A1**). The physical
  "lantern prop" is just an actor-tagged `placeLight` at the actor's current room — **no new
  command shape needed**, as long as `placeLight` targets the actor's current room implicitly (it
  does: it moves an item into `room.light_source_ids`). Please keep it actor-scoped, not
  tile/coordinate-scoped — the board has no coordinates the core needs to know about.
- **Directional movement.** The tabletop derives a compass `Direction` from a piece drag and
  submits `{ kind: "move", dir }`; `ViewModel.exits` already carries `{ dir, toName }`. No core
  change.
- **Seat = actor.** The actor-tagged `Command` union + `command_actor_id` gating is exactly the
  primitive the board needs. No new identity state in the core (A already declines that).

## Inputs that need a decision

### 1. Actor identity on the physical surface — **(both shapes; A + the status mechanic)**

This is the sharpest, most tabletop-specific input, and it has an *input* half and an *output*
half.

**Input half — the piece *is* the `actor_id`.** On a physical table the identity tag in a piece's
base is the literal source of `actor_id`: `NFC tag → actor_id → { kind:"move", dir, actorId } →
authorize()`. Two consequences for A:
- **Identity-bearing piece detection is required, not presence-only.** Without a per-piece
  identity (NFC/RFID), the board cannot tag the command and the multi-seat model collapses to
  "assume the actor is whoever's turn it is" — a fragile hotseat. The `actor_id` field is what
  makes multi-seat real in hardware; keep it on *every* turn-action command (A already does).
- **Turn-gating becomes free physical feedback.** A's `authorize` gate (`actor_id ==
  active_character_id`) turns an out-of-turn piece nudge into a `denied` → a reject LED/buzzer,
  with no turn logic in the controller. Inverted, the always-known active character lets the board
  **pre-light whose turn it is**. Both are pure consequences of the actor-tagged model — no extra
  core work, just noting the board leans on it.

**Output half — only the `action` cue carries an actor; `status` does not.** Of the six
`PresentationCue` kinds (`crates/wickedways-core/src/presentation.rs:84`), exactly one is actor-attributed:
`action` has `actor: EntityRef`. The rest are scoped to a **room** (`encounter`, `visibility`),
the **campaign** (`resolution`), or nothing (`mechanic`, `status`). For a shared board that is
mostly *good* — room/campaign cues route to a tile or the whole board with no per-player logic,
and `action.actor` gives clean per-piece feedback (pulse *that* player's piece LED, sound from
*their* tile). **The gap:** the **`status`** cue (`{ kind:"status"; fields: StatusField[] }`)
feeds the per-seat Sanity/Fear/Panic dashboards but carries **no actor** — so in a multi-seat game
you cannot tell *whose* dashboard a `status` cue is for. Resolve one of:
- **(a)** add actor attribution to the `status` cue (`subject: EntityRef` / `actorId`) so the
  emitting mechanic names whose status it is — a small mechanic/cue-shape change; or
- **(b)** drive dashboards from a **per-character view projection** (each seat gets its own
  filtered `ViewModel`/snapshot readout) and treat the `status` cue as a mere *animation trigger*
  ("something changed, flash"), values from the projection.

For the single-controller box, **(b)** is the natural baseline — the one Authority already holds
every character's state and can project a per-seat readout to each dashboard peripheral (the same
move that makes *secret* per-player info possible without any networking). **(a)** is the cleaner
fix if the status mechanic / cue shape is being touched anyway. **(Built: the hotseat surface takes
(b))** — `party_roster` in `tabletop.rs` reads each seat's `stats.health`/`sanity`/`afflictions`
from `coord.replica().characters` for the per-seat cards, and the `status` cue drives only the shared
campaign banner. **(a)** stays the recommended long-term fix.

### 2. Cue delivery to the board — **(networked shape only; B/D)**

For the **single-controller box this is a non-issue**: `Authority.submit` returns
`ExecuteResult { cues }`, so the controller has the `status` / `encounter` / `visibility` /
`resolution` stream directly. It only bites the **networked `Replica`**: B's `SyncAuthority.submit`
returns a `SubmitResult` whose `LogEntry` carries a **`Delta`** (snapshot diff), and **cues are
not in the snapshot**, so a delta-only `Replica` has no cue stream. If the networked shape is
pursued, decide (B/D): **(a)** cues ride the log/broadcast (`LogEntry`/`CommandResult` gains
optional `cues: PresentationCue[]`), or **(b)** Replicas re-derive cues from the delta (cheaper
wire, drift-prone, needs its own parity gate). Recommend **(a)**; it is a *general* Replica
question — the Dioxus client's audio/HUD hit the same wall — so worth settling in B, not
discovering in D.

### 3. Multi-seat, single-connection client — **(networked shape only; C — Membership)**

A correctly assigns human↔seat ownership to **C** (`Membership.mayAct`, "server protocol state,
not in the snapshot"). A networked board breaks the usual **1 identity ↔ 1 seat** assumption: it
is **one device/connection acting as many actor seats** (every piece). Please make `Membership`
express **one identity owning/acting-as N character seats**, not just 1:1. (The single-controller
box sidesteps this entirely — it never joins a server.)

### 4. Engine-as-GM: can the Authority hold the GM role? — **(both shapes; A)**

The design-doc "who is the GM" fork resolves, for a co-op physical table, to: **is a human GM
seat required, or can the engine drive mob turns itself?** The core is a "solo-GM, one-human" loop
today; A makes `gm_id` settable and gates GM commands (`mobAttack`/`mobEscape` are actor-tagged and
already driven internally by `run_mob_reactions`). **Decide (A):** whether a campaign may run with
the GM role held by the Authority itself (auto-issuing mob commands, no human GM seat) vs. always
requiring a GM actor. This determines whether a physical co-op table needs *any* GM device — a real
hardware consequence.

### 5. Dice-supply under the determinism invariant — **(both shapes; A)**

The design doc floated feeding **physical dice** into the engine. 2c's determinism invariant
(same seed + command sequence ⇒ identical deltas) constrains how:
- **Seed-at-start** (roll a physical die to seed the campaign rng) needs **zero** command change
  and preserves replayability — **recommended default**, no A work.
- **Per-action physical dice** (a sensed tray supplying a specific roll) cannot bypass the rng
  owner (the Authority). If wanted, the roll must arrive **as command data** the Authority consumes
  instead of drawing rng — e.g. an optional `roll?` on the randomized commands (today just
  `mobEscape`) — **and** the differential corpus must include the roll-supplied variant. Flagging so
  A doesn't lock `mobEscape` to rng-only if per-action physical dice are a wanted future.

## Where the tabletop track sits

The tabletop client is **not** an A–F sub-project. In its likely **single-controller** shape it
rides the single-player `Authority` and depends on **A alone** (the actor-tagged command/seat
model) — B/C/D are not required. Only the optional **networked** shape (remote players, independent
devices) makes it a physical `Replica` after D, pulling in B (cue delivery) and C (multi-seat
Membership). Full device-side design (protocol, tile mapping, directional drag, hardware phasing)
lives in [`docs/tabletop-simulator-spec.md`](../../tabletop-simulator-spec.md).
