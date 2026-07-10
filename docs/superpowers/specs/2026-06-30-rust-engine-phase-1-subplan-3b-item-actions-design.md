# Rust Engine Core — Phase 1, Sub-plan 3b (Item Actions)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-30

## Goal

Add the **mutation half** of the item subsystem: the six player item actions (`take`, `drop`, `open`,
`equip`, `unequip`, `use`), building on 3a's descriptor catalog + resolution + widened ViewModel. This
also **retires the sub-plan-2/3a `view_thin` coexistence** by wiring the widened `view` into
`replay_commands`.

Parent specs:
- `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md`
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-world-foundation-design.md`
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-2-turn-loop-movement-design.md` (cue
  model, command-stream gate, `view_thin`)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-3a-descriptor-catalog-items-projection-design.md`
  (catalog, `resolve_item`, `effective_stat`, widened `view`, coexistence)

Builds on `design/rust-engine-core` @ `f5e6da6` (sub-plans 1+2+3a complete & merge-ready).

## Scope: the six item intents the play surface exposes

The player-facing item intents (`packages/play-runtime/src/intent.ts`) are exactly `take`, `drop`,
`open`, `equip`, `unequip`, `use`. Everything else is out of scope — no player intent exists for it,
or it belongs to a later subsystem (verified via the item-action exploration).

### In scope — new `Command` variants + `World` mutators (catalog-resolved)

Extend the `Command` enum (sub-plan 2: `StartTurn`/`EndTurn`/`Go`/`NextPlayer`) with six item commands,
each carrying a `targetId: String` (item or loot id), mirroring the session intents:

- **`take`** (`takeFromLootBox`, `player-character.ts:216-235`): **budgeted** (`pickUp` history via
  `addToInventory`); **visibility-gated** — `requireVisibleTarget("loot")` throws `ProceduralViolation`
  in a dark room (`!is_lit && !seesInDark`; `seesInDark` is false for players until sub-plan 4). Moves
  the item from the loot container's `content_ids` → the taker's `inventory.item_ids`, re-`CLAIM`.
  **Auto-opens** the container (adds its id to the `opened` set — see below).
- **`drop`** (`removeFromInventory`, `character.ts:583-604`): **budgeted** (`drop` history); throws for
  **keys** ("hand them over with transferKey"); rejects non-held items and **required items**
  (`droppable === false`). Removes the item from `inventory.item_ids` via `relinquishItem` — the item
  is **orphaned in the item store** (the engine does NOT place it into a room pile; `heldBy` is not
  serialized, so the only snapshot effect is the item leaving `inventory.item_ids`). *(The plan MUST
  confirm this against `relinquishItem`/the drop path and mirror the oracle exactly — the gate is the
  authority on the destination.)*
- **`equip`** (`character.ts:685-747`): **free** (no budget tick, no history); validates the item is
  held, `properties.equippable`, and has a `slot`; **two-handed** weapons occupy both hand slots;
  **auto-swap** evicts a conflicting occupant (unequipped, stays in inventory); sets the equipment
  slot-map entry; emits a **visibility-flip** cue if (un)equipping a light changes a dark room's lit
  state. The `equipped` state lives in the equipment slot map (the only persisted source; sub-plan 3a).
- **`unequip`** (`character.ts:756-773`): **free**; validates held + equipped; clears the item from
  every slot it occupies; visibility-flip cue.
- **`use`** (`inventory.ts:607-631`): **budgeted → consume**. Validates `properties.usable` and not KO
  (KO is sub-plan 4; no KO exists here, so it passes). The author `use` closure is **noop** in the
  conformance campaigns, and the engine applies **no** stat effect — so `use` = `CONSUME_VIA_USE`,
  which records a **`drop`** history entry, ticks the budget, and removes the item. (`grantsImmunity`
  → sub-plan 4.)
- **`open`** (`openLootBox`): **free**; marks the container **opened**. `opened` is **not World
  state** — it is session/harness state (`GameSession.opened`), so the conformance replay threads an
  `opened: BTreeSet<String>` (Open adds the id; Take auto-adds). `view.loot[].opened` (3a) reads it.

**Gating is a trivial pass-through** (no afflictions until sub-plan 4): `attemptAction` returns true
with no active affliction, so every item action proceeds normally (as movement did in sub-plan 2).
Budget/history tick points must match the TS byte-for-byte (`actions_this_round`, `history` are
snapshot fields).

### View consolidation (retire `view_thin`)

Wire the widened `view` (3a) into `replay_commands`: it gains `catalog` + `opened` params and emits the
widened `ViewModel` per step (the per-step key stays `viewThin` **or** is renamed to `view` — pick one
and regenerate goldens to match). **Delete `view_thin`/`ThinViewModel`/`ThinOccupant`/`ThinStatus`**
(now redundant) and **regenerate the turn-movement golden under `view`** (the turn-movement campaign
has no items, so the item fields are empty; occupants gain `health`). This pays down the 3a coexistence
in the sub-plan that makes `view` the sole projection.

### Multi-equip ordering (first-class fixture)

The 3a `equipped_names` derives from the equipment slot-map iteration (`BTreeMap` slot-key order) vs.
the TS `Map` insertion order — dormant in 3a (one equipped item). 3b's `equip` command exercises
**multiple equipped items**, so the conformance stream MUST equip ≥2 items and the gate MUST diff
`equippedNames` (and any other equipment-derived ordering) against the oracle. If they diverge, resolve
it (sort the comparator field, or match the engine's order) — the same order-partition concern as
`occupant_ids`. This is the primary risk this sub-plan must retire.

## Conformance

Extend the bespoke item campaign (3a) with an **item-action command stream** fed to the TS oracle
(driving the engine DIRECTLY — `pc.takeFromLootBox`, `pc.equip`, `pc.unequip`, `item.actions.use`,
`pc.removeFromInventory`, `pc.openLootBox` — as sub-plan 2 drove `go`/`nextPlayer`, NOT via
`GameSession.execute`, to keep one action per command) and the Rust `apply_command`. The stream:
`take` (from the loot container) → `equip` weapon → `equip` a second item (multi-equip ordering) →
`unequip` → `use` the consumable → `drop` an item → `open` → plus a **dark-room `take` that must be
blocked** (a `ProceduralViolation` both sides — the harness asserts the error, it is not a diffed
step). Per step, diff `{cues, snapshot, view}` byte-for-byte under canonical JSON. The replay threads
the `opened` set identically to `GameSession`.

Generators stay under the isolated fixtures config (no main-gate regeneration); restore any
pre-existing fixtures `fixtures:gen` clobbers.

## Testing

- **Rust unit tests:** each action's state mutation (inventory/equipment/loot/opened), cue emission
  (`action` pickUp/drop, visibility-flip), history append (`pickUp`/`drop`), budget tick (budgeted vs
  free), and capability enforcement (equip non-equippable → `Err`; drop key/required → `Err`; use
  non-usable → `Err`; take in dark → `Err`); two-handed equip occupies both hands; auto-swap;
  multi-equip `equipped_names`; `use` consume removes + records drop.
- **Differential conformance:** the item-action command stream above (cues + snapshot + view), exact
  canonical-JSON equality (invariant 3), plus the regenerated turn-movement gate under `view`.
- **ts-rs drift:** the `Command` additions are not exported (internal); the consolidated `view` binding
  stays green.

## Non-goals (3b)

- **`repair` / `destroy`** — both touch the campaign materials pool (`withdrawMaterials`/`canAfford`;
  `DEPOSIT_MATERIALS`) → **sub-plan 5** (crafting/materials). `recipe`/`teaches` stay inert `Value`.
- **`attack` / `takeDamage` / durability decrement / armor wear** → **sub-plan 4** (combat).
- **Affliction gate fizzle/KO, `use`'s `grantsImmunity`, `seesInDark`** → **sub-plan 4**.
- **`read` / `placeLight` / `takeLight` / `transferKey` / `consumeKey`** — no player intent
  (engine-internal or future); not modeled.
- **`teaches` → discoverRecipe** on pickup → **sub-plan 5** (recipes). Take does not discover recipes
  here (the conformance items carry no `teaches`).
- **Exit `canPass` / keyed doors / scenes / mechanics** → the op-registry sub-plan.

## Carried-forward notes honored / created here

- **Retires** the 3a coexistence (`view_thin` deleted; turn-movement golden regenerated under `view`).
- **Retires** the multi-equip ordering watch (now a first-class fixture).
- **`i64`→`bigint`** binding decision remains the deferred pre-Phase-2 pass; keep integer-typed.
- **`opened` set** is harness state (mirrors `GameSession.opened`) — not World, not serialized.

## Risks & open questions

- **Drop destination.** Confirm `removeFromInventory`/`relinquishItem` orphans the item (vs. a room
  drop pile) and mirror exactly; the snapshot effect is item-leaves-`inventory.item_ids`. The gate is
  the authority.
- **Multi-equip / equipped-map ordering.** The primary divergence risk (BTreeMap slot-key vs TS Map
  insertion). The stream must exercise it; resolve via comparator field-sort or order-matching.
- **`take` visibility gate.** Uses `is_lit` (sub-plan 2) + `seesInDark` (false for players until 4).
  Confirm the dark-room block matches the oracle; the stream includes a dark-room take.
- **`use` consume records `drop`.** The `use` path emits a `drop` history entry (via
  `CONSUME_VIA_USE`), not a `use` entry — mirror this precisely (it is a snapshot field).
- **Turn-advancement bundling.** The TS `GameSession` bundles turn advancement with time-advancing
  intents; the conformance drives the engine directly (one action per command) with explicit
  `NextPlayer`/`StartTurn`, avoiding that bundling — same approach as sub-plan 2.
- **View key rename.** Deleting `view_thin` + regenerating the turn-movement golden is a cross-gate
  change; do it atomically within one task so no task leaves a red gate.
