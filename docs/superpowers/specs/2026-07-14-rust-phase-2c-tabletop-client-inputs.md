# Phase 2c — Physical-tabletop client: inputs to sub-projects A / B / C / D

**Date:** 2026-07-14
**Status:** input note (not a sub-project; cross-cutting)
**Program:** [`2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md`](./2026-07-14-rust-phase-2c-multiplayer-dioxus-program-design.md)
**Feeds:** [A (command vocabulary)](./2026-07-14-rust-phase-2c-a-command-vocabulary-design.md),
[B (sync core)](./2026-07-14-rust-phase-2c-b-sync-core-design.md), C (axum server), D (Dioxus client)
**Origin:** [`docs/tabletop-display-design.md`](../../tabletop-display-design.md) +
[`docs/tabletop-simulator-spec.md`](../../tabletop-simulator-spec.md)

## Why this note

A physical e-ink tabletop (map tiles + player pieces) is, architecturally, **a shared physical
`Replica`**: it applies authoritative `Delta`s, renders them to tiles/pieces/LEDs, and submits
**actor-tagged `Command`s** (a piece move = a `move` tagged with that piece's `actor_id`). That
maps onto the 2c multiplayer model almost exactly — **each piece is a seat/actor** — so most of
what the tabletop needs, A/B already build. This note raises only the handful of decisions the
tabletop use-case surfaces that A/B/C/D might otherwise settle in a way that closes the door on
it. None of these should expand 2c's scope; they are "decide with the physical Replica in mind."

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

### 1. Cue propagation to Replicas — the big one (B, and D)

**The tabletop's most atmospheric features run on presentation cues, not on state deltas.** Seat
dashboards are fed by the **`status`** cue; encounter LEDs + audio by the **`encounter`** cue;
tile reveal/conceal by the **`visibility`** cue; the endgame tile by **`resolution`**. In
single-player these arrive in `ExecuteResult { cues }`. But B's `SyncAuthority.submit` returns a
`SubmitResult` whose `LogEntry` carries a **`Delta`** (snapshot diff) — **cues are not in the
snapshot, so the diff does not carry them.** A `Replica` that only applies deltas therefore has
no cue stream.

**Decide (B/D):** either
- **(a)** cues ride alongside the delta in the log/broadcast (`LogEntry` or `CommandResult` gains
  an optional `cues: PresentationCue[]`), so every Replica receives them; or
- **(b)** Replicas **re-derive** the tabletop-relevant cues from the delta (e.g. a room's
  `is_lit` flip → `visibility`; a new live occupant in the delta → `encounter`) — cheaper on the
  wire but a second, drift-prone cue source that would need its own parity gate.

This is the single most important tabletop input and it is really a *general* Replica question
(the Dioxus client's audio/HUD hit the same wall). Recommend **(a)** and gating cue-parity the
same way B gates delta-parity. Flagging it in B so it isn't discovered during D.

### 2. Multi-seat, single-connection client (C — Membership)

A correctly assigns human↔seat ownership to **C** (`Membership.mayAct`, "server protocol state,
not in the snapshot"). The tabletop breaks the usual **1 identity ↔ 1 seat** assumption: the
physical board is **one device/connection acting as many actor seats** (every piece). Please make
`Membership` express **one identity owning/acting-as N character seats**, not just 1:1. This is a
C concern, raised now so the seat model isn't built 1:1-only.

### 3. Engine-as-GM: can the Authority hold the GM role? (A)

The design-doc "who is the GM" fork resolves, for a co-op physical table, to: **is a human GM
seat required, or can the engine drive mob turns itself?** The core is a "solo-GM, one-human"
loop today; A makes `gm_id` settable and gates GM commands (`mobAttack`/`mobEscape` are
actor-tagged and already driven internally by `run_mob_reactions`). **Decide (A):** whether a
campaign may run with the GM role held by the Authority itself (auto-issuing mob commands, no
human GM seat) vs. always requiring a GM actor. This determines whether a physical co-op table
needs *any* GM device — a real hardware consequence.

### 4. Dice-supply under the determinism invariant (A)

The design doc floated feeding **physical dice** into the engine. 2c's determinism invariant
(the differential gate: same seed + command sequence ⇒ identical deltas) constrains how:

- **Seed-at-start** (roll a physical die to seed the campaign rng) needs **zero** command change
  and preserves replayability — **recommended default**, no A work.
- **Per-action physical dice** (a sensed tray supplying a specific roll) cannot be injected at the
  Replica (Replicas draw no rng; the Authority owns it). If wanted, the roll must arrive **as
  command data** the Authority consumes instead of drawing rng — e.g. an optional `roll?` on the
  randomized commands (today just `mobEscape`) — **and** the differential corpus must include the
  roll-supplied variant. Flagging so A doesn't lock `mobEscape` to rng-only if per-action physical
  dice are a wanted future.

## Where the tabletop track sits

The tabletop client is **not** an A–F sub-project; it depends on them (A/B for the multi-seat
Command/Delta/Replica model, D for Dioxus rendering) and lands as a **physical-Replica variant
after D**. The only asks of A–F are the decisions above. Full detail and the device-side design
(protocol, tile mapping, directional drag, hardware phasing) live in
[`docs/tabletop-simulator-spec.md`](../../tabletop-simulator-spec.md).
