# Rust Engine Core — Phase 1, Sub-plan 3a (Descriptor Catalog + Item Projection)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-30

## Goal

Establish the **descriptor catalog** — the behavior-data foundation that gives items (and later exits,
mobs, recipes) their identity — and use it to build the **read/projection half** of the item
subsystem: item resolution, `effectiveStat`, and the ViewModel's item-display fields. This is the
data/read side; the item *actions* (take/drop/equip/use/…) are the mutation half, deferred to
sub-plan **3b**, mirroring the sub-plan 1→2 (data→mutation) rhythm.

Parent specs:
- `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md` (7 invariants, A2 + two-tier
  extensibility, migration phases)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-world-foundation-design.md` (id-keyed
  `World`, 8-sub-plan decomposition)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-2-turn-loop-movement-design.md`
  (turn loop, movement, cue model, thin ViewModel, command-stream differential gate)

Builds on `design/rust-engine-core` @ `fdb8a17` (sub-plans 1+2 complete & merge-ready).

## Scope discovery: the registry is a prerequisite, but items need only its *data*

Reading the item subsystem and the registry/behavior-catalog mechanism established two facts that
reshape the Phase 1 ordering (the original decomposition put items at 3, the op-registry at 6):

1. **Items are ~90% registry-sourced.** A non-key `ItemSnapshot` carries only
   `{id, behaviorKey, durability?, modifier}`; the rest of an item's identity —
   `name, type, recipe, modifier, stat, slot, twoHanded, emitsLight, lore, presentation,
   maxDurability, keyCode, consumeOnUse, properties, immunities, grantsImmunity, teaches` — comes
   from the registry's item **factory/descriptor**, re-bound by `behaviorKey` at hydrate
   (`hydrateItem` → `registry.item(behaviorKey)()`). An `ItemSnapshot` alone cannot reconstruct an
   item. So the catalog must exist **before** items — not after.

2. **The part items need is descriptor *data*, not code.** The item *actions*
   (`pickUp`/`equip`/`use`/…) authored in the seed and Hollow House are `noop`; all real validation,
   cue emission, state mutation, durability, and capability enforcement live in the engine's `Item`
   class, which is reimplemented generically in Rust. So items need a **descriptor-data catalog**
   (`behaviorKey → descriptor`), not the full A2 op-registry (closures/scripting/6-hook mechanics).
   Genuinely code-shaped behavior — exit preconditions, win/lose conditions, mechanics, scene
   scripts — stays deferred to the later op-registry sub-plan (which also absorbs sub-plan 2's
   deferred `canPass`/locked-doors).

**Decision (approved): Option A.** Introduce a lightweight, **Rust-owned, serializable descriptor
catalog**, exported from the TS registry as a conformance artifact and loaded by both engines, and
build item *projection* on it now. This matches the parent spec's "campaigns as declarative data +
mechanics from an op-registry" split — the catalog is the declarative-data half.

## In scope (3a — data + read only)

### The descriptor catalog (new Rust-owned serialization format)

An `ItemDescriptor` data type mirroring the TS descriptor (`src/lib/inventory.ts:324-344`), typing
the fields 3a/3b/4/5 consume and carrying the complex ones as **inert `serde_json::Value`** until
their owning subsystem lands (the inert-as-Value principle from sub-plan 1):

```rust
pub struct ItemDescriptor {
    pub name: String,
    pub r#type: ItemType,          // enum: consumable|armor|weapon|throwable|accessory|key (lowercase)
    pub stat: StatType,            // reuse crate::stats::StatType
    pub modifier: i64,
    pub properties: ItemProperties,// { equippable, equipped, destroyable, usable, droppable? }
    pub slot: Option<SlotKind>,    // enum: hand|finger|wrist|head|torso|legs|feet (lowercase)
    pub two_handed: Option<bool>,
    pub emits_light: Option<bool>,
    pub max_durability: Option<i64>,
    pub lore: Option<String>,
    pub presentation: Option<Presentation>, // { image?, sound? } — AssetRef = Value passthrough
    pub key_code: Option<String>,
    pub consume_on_use: Option<bool>,
    // inert until 3b/4/5 — typed when consumed:
    pub recipe: Value,             // material composition (destroy/repair/craft → 3b/5)
    pub teaches: Value,            // CraftingRecipe granted on pickup (3b/5)
    pub immunities: Value,         // Status[] (4)
    pub grants_immunity: Value,    // { statuses, turns } (3b/4)
}
```

- `ItemType`, `SlotKind`, `ItemProperties`, `Presentation` are new typed structs/enums, serde
  byte-compatible with the TS shapes above, ts-rs-gated.
- **Catalog** = `BTreeMap<String /*behaviorKey*/, ItemDescriptor>`. **Aliases** =
  `BTreeMap<String /*behaviorKey*/, Vec<String>>` (the campaign `ALIASES` record).
- The catalog + aliases are a **new format Rust owns** (descriptors aren't serialized today), so
  invariant 1 runs forward: the Rust types generate the TS bindings, and the **conformance harness
  exports the TS registry's descriptors + aliases to `*.catalog.json` + `*.aliases.json`** that both
  engines load. Keys are self-contained in the snapshot (`kind:"key"` carries name/keyCode/
  consumeOnUse) and need no catalog entry.

### Item resolution

A resolver: given an `ItemSnapshot` + the catalog, produce the item's effective identity — descriptor
data merged with the per-instance `durability`/`modifier` from the snapshot, plus derived
`is_broken = max_durability.is_some() && durability == Some(0)`. Keys resolve from their snapshot
fields directly (type = key; properties all false; not equippable/usable/destroyable/droppable).

### `effectiveStat`

`effective_stat(character, stat)` = base `stats[stat]` + Σ `modifier` of the character's **equipped
accessory** items whose `stat` matches (mirrors `character.ts:903-913`): an item contributes iff its
resolved `type == accessory`, it is equipped, and its `stat == stat`. **Equipped-ness is derived from
the character's equipment slot map** (`CharacterSnapshot.equipment: slot → itemId`), which is the only
persisted source of truth — `properties.equipped` is *not* serialized (the catalog's static value is
just the initial `false`). The TS keeps `properties.equipped` in sync with the slot map at runtime;
the Rust reads the map directly. Deferred from sub-plan 2.

### ViewModel widening (read side)

Grow the thin ViewModel toward the full `packages/play-runtime/src/viewmodel.ts` shape, adding the
fields the catalog + `effectiveStat` now unblock:

- **occupants**: add `health` = `effective_stat(occupant, Health)`. (`defeated`/`image` still
  deferred — `defeated` needs KO status, sub-plan 4.)
- **loot**: `[{ id, description, opened, contents: [ScopeEntity] }]` (contents resolved via catalog).
- **inventory**: `{ items: [ScopeEntity], keys: [ScopeEntity], equippedNames: [String], slots }`.
- **item ScopeEntity display**: `{ id, name, aliases, kind:"item", image?, equippable, usable,
  hasLore, droppable }` resolved from the catalog (`name`/`properties`/`lore`/`presentation`) +
  aliases table (`aliasesFor(behaviorKey, name, aliases)` = unique lowercased name + table aliases).
- **scope**: occupants + loot contents + inventory items + keys + loot containers (the union the TS
  `view()` builds).
- **status**: `health` = `effective_stat(active, Health)`, `sanity` = `effective_stat(active, Sanity)`.

`opened` loot state: the engine tracks no opened flag (the TS `view()` takes an `openedLootIds` set);
3a threads an `opened_loot_ids` input through the projection like the TS signature, defaulting empty.

### Conformance

Extend the bespoke conformance campaign (from sub-plan 2's `turn-movement.gen.test.ts`, or a new
sibling generator) with **item content at genesis**: a weapon, an **equipped accessory** (to exercise
`effectiveStat`), a usable consumable, a **key**, and a **loot container** with contents. The TS
harness:

1. exports the registry's item descriptors + aliases to `*.catalog.json` + `*.aliases.json`;
2. serializes the started campaign snapshot and the **full TS `view()`** (the widened ViewModel) as
   the golden.

The Rust gate loads `(snapshot + catalog + aliases)`, computes the widened ViewModel, and diffs it
(and the snapshot) against the golden under canonical JSON. 3a needs no new commands — it is a
**projection parity** gate (static genesis, or reuse a trivial movement step); item *action* command
streams are 3b. Generators stay under the isolated fixtures config (no main-gate regeneration).

## Testing

- **Rust unit tests:** `ItemDescriptor`/`ItemType`/`SlotKind`/`ItemProperties`/`Presentation` serde
  byte-shape; catalog + aliases load/round-trip; item resolution (item variant merges
  durability/modifier; `is_broken`; key variant); `effective_stat` (base; +equipped-accessory
  matching stat; ignores non-accessory / unequipped / wrong-stat / broken); ViewModel item display
  (equippable/usable/hasLore/droppable/aliases), loot, inventory, scope, status health/sanity.
- **Differential conformance:** the projection-parity gate above (widened ViewModel + snapshot),
  exact canonical-JSON equality (invariant 3).
- **ts-rs binding drift:** new exported types (`ItemDescriptor`, `ItemType`, `SlotKind`,
  `ItemProperties`, `Presentation`, the widened ViewModel structs) regenerate cleanly;
  `bindings:check` stays green.

## Non-goals (3a)

- **No item actions / mutations** — take/drop/equip/unequip/use/repair/read/transferKey/consumeKey/
  destroy/placeLight/takeLight, their cues, history (`pickUp`/`drop`), and budget rules are **sub-plan
  3b**. 3a only *reads/projects* item state.
- **No durability decrement** (combat — sub-plan 4); `repair` is 3b.
- **No `defeated`/KO** in occupants (needs status — sub-plan 4).
- **No exit/scene/mechanic/condition/recipe behavior** (the code-shaped op-registry — later sub-plan;
  also where sub-plan 2's deferred `canPass`/locked-doors lands). The catalog carries only item
  descriptor *data*.
- **No crafting** (recipe/materials economy — sub-plan 5); `recipe`/`teaches` stay inert `Value`.

## Carried-forward notes honored here

- **`i64`→`bigint` binding decision** (from sub-plan 2): `ItemDescriptor` adds more `i64` fields
  (`modifier`, `max_durability`). Keep integer-typed (no `f64`); the bindings type-strategy remains
  the deferred pre-Phase-2 decision (recommend `u32`/`i32` for small counts → `number`). Do not
  resolve piecemeal here.
- **ViewModel "widening gate"** (from sub-plan 1/2): 3a widens occupants(+health)/loot/inventory/
  scope/status; `defeated`/`image`/`encounter` continue to land with their dependencies (4).

## Risks & open questions

- **Catalog export fidelity.** The TS harness must export descriptor fields exactly as the Rust
  `ItemDescriptor` expects (field names, enum tag strings, optional omission). A missing/renamed field
  fails the load or the parity diff. Plan task: define the Rust type first, then write the exporter to
  match, and assert the catalog round-trips.
- **`effectiveStat` equipped-ness source (resolved).** Derive equipped-ness from the equipment slot
  map (the only persisted source); `properties.equipped` is not serialized. The plan must verify this
  matches the oracle for an equipped accessory (the conformance campaign includes one for exactly this
  reason).
- **`presentation.image`/`sound` (`AssetRef`).** Opaque passthrough (`Value`); confirm the
  conformance campaign's items either carry none or carry values that round-trip byte-identically.
- **`opened` loot state.** Not engine state; threaded as an input set. The genesis gate uses empty;
  3b's `take`/`open` actions exercise it.
- **Number-normalization in the comparator** (carried from sub-plan 1): the new descriptor integers
  (`modifier`, `maxDurability`) stay integer-typed so no fractional representation can arise.

## Build notes (post-implementation)

- **ViewModel coexistence (execution decision).** To keep every task's gate green, the widened `view`
  was added ALONGSIDE the sub-plan-2 `view_thin` rather than widening one struct in place: the
  turn-movement gate stays on `view_thin`; the items-projection gate uses `view`. Consolidation
  (delete `view_thin`, regenerate the turn-movement golden under `view`) is **deferred to sub-plan 3b**,
  to be paired with wiring `view` into `replay_commands`. (Widening in place would have red-lit the
  turn-movement gate from the view-widening task until the golden regenerate, which itself needs the
  catalog plumbing — a circular dependency.)
- **Key `droppable` correction (gate-found).** The projection-parity gate revealed that a key projects
  `droppable: true` in the view: TS `createKey` omits `droppable` (`undefined`), and the ViewModel
  computes `droppable !== false` = `true`. `resolve_item`'s Key arm therefore resolves
  `droppable: None` (not `Some(false)`); key un-droppability is enforced by the action layer's key
  type-check, not by `properties.droppable`. (This reversed an earlier task's reviewed guess — the
  differential gate is the authority.)
- **`effective_stat` source (verified).** Equipped-ness is read from the equipment slot map; this is
  provably equivalent to the TS `inventory.items`-filtered-by-`properties.equipped` because `equip()`
  throws unless the item is held, keeping equipped ⊆ inventory.
- **Deferred decisions (carried).** `i64`→`bigint` binding strategy + `ts(optional)` retro-fix for
  sub-plan-2 optionals → the pre-Phase-2 binding pass (decide once, apply uniformly; recommend
  `u32`/`i32` for small bounded counts). `equipped_names` ordering (equipment BTreeMap slot-key order
  vs TS Map insertion order) is dormant here (corpus equips one item) and must become a first-class
  multi-equip conformance fixture in 3b.
