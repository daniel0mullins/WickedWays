# Rust Engine Core — Phase 1 Design & Sub-plan 1 (World Foundation)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-06-30

## Goal

Begin Phase 1 of the Rust engine migration: port the stateful engine core. This document (1) fixes
the **object-graph representation** the whole phase depends on, (2) **decomposes Phase 1** into
ordered, conformance-gated sub-plans, and (3) details the **first sub-plan — World Foundation**: the
id-keyed entity store, the plain-data entity structs, the serde save/snapshot format, single-pass
genesis load, and the `ViewModel` projection.

Parent spec: `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md`. Phase 0 (toolchain,
ts-rs pipeline, differential harness, pure-leaf ports) is complete; this builds on it.

## Decision: the object graph is an id-keyed `World` (Approach A)

The current engine runs a **pointer-based** object graph at runtime but **already flattens to a
100%-id-based representation at the serialization boundary** — every entity carries a stable branded
id, `HydrateContext`/`EntityIndex` resolves id→instance, all 7 reference cycles are broken by id at
that layer, and every cross-entity mutation is an atomic two-sided update through symbol-gated
mutators.

Phase 1 **promotes that existing id-based model from the serialization layer to the runtime layer.**
A central `World` owns one store per entity type; entities reference each other by **branded id**,
never by pointer. This collapses the current pointer↔id two-world split into one, which makes serde,
snapshots, deltas, determinism, and cycle-freedom fall out for free (see the parent spec's invariants
1, 3, 5; the comparison that selected this over `Rc<RefCell>` is recorded there).

**Reference mapping (TS pointer → Rust id):**

| Entity | TS runtime ref | Rust representation |
|---|---|---|
| `Character.currentRoom` | `IRoom \| null` | `Option<RoomId>` |
| `Character.inventory` | `{ items: IItem[], keys: IItem[] }` | `Inventory { items: Vec<ItemId>, keys: Vec<ItemId> }` |
| `Character.equipment` | `Map<EquipmentSlot, IItem>` | `BTreeMap<EquipmentSlot, ItemId>` |
| `Character.campaign` | `ICampaign` (back-ref) | *dropped* — the `World`/`Campaign` owns the character; no back-pointer needed |
| `Room.occupants` | `Map<CharacterId, ICharacter>` | `BTreeSet<CharacterId>` |
| `Room.exits` | `Map<Direction, Exit>` | `BTreeMap<Direction, ExitId>` |
| `Room.loot` / `materials` / `lightSources` | `Map<Id, T>` | `BTreeSet<LootId>` / `BTreeSet<MaterialCacheId>` / `BTreeSet<ItemId>` |
| `Exit.{a,b}` | `IRoom, IRoom` | `endpoints: (RoomId, RoomId)` |
| `Item.heldBy` | `Character \| Loot \| null` | `HeldBy` enum: `Character(CharacterId) \| Loot(LootId) \| None` |
| `Loot.contents` | `IItem[]` | `Vec<ItemId>` |

**Stores use `BTreeMap`/`BTreeSet`, not `HashMap`/`HashSet`** — deterministic iteration order is
required by invariant 3 (the differential harness and replica convergence depend on it). Branded ids
are `String` newtypes (`struct CharacterId(String)`, …) to preserve byte-compatibility with the
existing string-id serialization format during the conformance period.

## Phase 1 decomposition (8 conformance-gated sub-plans)

Each sub-plan is its own spec→plan→execute cycle and ends at a working, differentially-tested engine
subset. Gate = feed identical `(seed, command sequence)` to the TS oracle and the Rust `World`, diff
cues + snapshot byte-for-byte.

1. **World Foundation** *(this document)* — stores, entity structs, serde save/snapshot, single-pass
   genesis load. Gate: snapshot round-trip identity. The `ViewModel` projection is **not** built here:
   it depends on the behavior/registry layer (item display data resolved by `behaviorKey`, exit
   `canPass`) and on computed `effectiveStat`/status — none derivable from the snapshot alone — so it
   is **grown incrementally** in sub-plans 2–4 as those inputs land (a widening parity gate, not one
   up-front gate).
2. **Turn loop + movement/exits/visibility** — round/turn advance, startup cues, `go`, occupancy,
   exits, locked-door visibility, lighting.
3. **Items** — take/drop/equip/unequip/use, capability enforcement, durability + repair, keys,
   required-item drop rules.
4. **Combat & character state** — stats, `attack`/`takeDamage` (reuses the Phase 0 mitigation port),
   modifiers, status effects + consequences, afflictions, immunity, mobs + encounters + reactions.
5. **Loot, crafting, materials, codex** — looting, recipes + yields, material economy, lore reads.
6. **Mechanics op-registry (A2)** — 6-hook/6-effect framework, `CampaignView`, first-party ops,
   mechanic state persistence, selection-by-key + config.
7. **Victory / outcome resolution** — end conditions, outcome cues + narration, finished state.
8. **Authority / resolver / delta** — authorize + dispatch (`match`) + delta compute/apply, the full
   submit→authorize→apply→diff→commit loop.

After #8 the Rust core runs a full single-player campaign in authority mode and passes the whole
conformance corpus — the precondition for Phase 2 (cutover).

---

## Sub-plan 1: World Foundation — detailed design

This sub-plan adds **structure and load only** — no mutations, commands, turn loop, cues, or
`ViewModel` projection (those begin in sub-plan 2). It is the substrate every later sub-plan mutates.

### The `World`

```rust
pub struct World {
    pub characters: BTreeMap<CharacterId, Character>,
    pub rooms: BTreeMap<RoomId, Room>,
    pub items: BTreeMap<ItemId, Item>,
    pub loot: BTreeMap<LootId, Loot>,
    pub material_caches: BTreeMap<MaterialCacheId, MaterialCache>,
    pub exits: BTreeMap<ExitId, Exit>,
    pub campaign: CampaignState, // party ids, gm id, active character, codex, round/maxRounds,
                                 // known recipes, archetypes, mechanic instances, outcome/finished
}
```

`CampaignState` holds the campaign-level fields (the non-entity data from `Campaign`): `party:
Vec<CharacterId>`, `gm: CharacterId`, `active_character: CharacterId`, `round`, `max_rounds`,
`codex`, `outcome`, `finished`, plus recipe/archetype/mechanic catalogs (the latter two carried as
plain data now; their behavior is wired in sub-plans 5–6).

### Entity structs

Each entity is a plain `#[derive(Serialize, Deserialize, Clone)]` struct mirroring the **existing TS
snapshot types** (`src/lib/serialization/types.ts`: `CharacterSnapshot`, `RoomSnapshot`,
`ItemSnapshot`, `LootSnapshot`, `MaterialCacheSnapshot`, plus exit/codex shapes) **field-for-field**,
with object references replaced per the mapping table above. The serialization snapshot types — not
the runtime classes — are the authoritative field list, because the snapshot is what crosses the
conformance boundary. The character kind hierarchy (PC/NPC/Mob/Combatant) is modeled as a struct with
a `kind`/role enum carrying variant-specific data, mirroring the snapshot's discriminator rather than
a Rust trait hierarchy.

The implementation plan transcribes these field lists from `serialization/types.ts`; this spec fixes
the *shape* (id-keyed, serde, BTree collections), not every field.

### Single-pass genesis load (a simplification the model buys us)

```rust
impl World {
    pub fn from_snapshot(snap: CampaignSnapshot) -> Result<World, LoadError>;
    pub fn to_snapshot(&self) -> CampaignSnapshot;
}
```

Because references are ids, **the TS two-pass hydrate (`constructBare*` then `[HYDRATE]` wiring via
`HydrateContext`) collapses to a single pass**: deserialize each entity directly into its store; no
back-reference wiring step exists, because there are no back-pointers to wire. This removes an entire
class of the engine's current machinery.

**Conformance constraint:** during Phase 1 the Rust `CampaignSnapshot` serde representation must be
**JSON-compatible with the existing TS snapshot format** — a TS-produced snapshot must deserialize
into the Rust `World`, and `to_snapshot()` must re-serialize to JSON that diffs clean against the TS
snapshot. (After Phase 2 cutover, Rust owns the format outright.) This is invariant 1 operating in
the migration direction: the new core conforms to the one existing format until it replaces it.

### `ViewModel` projection — deferred (not in this sub-plan)

`World::view()` is **not** built here. The TS `ViewModel` (`packages/play-runtime/src/viewmodel.ts`)
is not a pure function of the snapshot: item `name`/`properties`/`lore`/`presentation`/`aliases` are
resolved from the item's **behavior via `behaviorKey`** (the snapshot stores only the key); occupant
`health` is the computed `effectiveStat(Health)` and `defeated` is the derived `status.includes(KO)`;
and exit classification into `exits` vs `lockedDoors` calls `exit.canPass(pc)` (exit behavior). Those
inputs are introduced in sub-plans 2 (room/exits/`canPass`), 3 (item behavior catalog), and 4
(`effectiveStat`/status), so the projection — and its parity gate — grows there.

### Conformance gate for this sub-plan

Behavior isn't exercised yet, so the gate is **snapshot round-trip identity** over real campaign
snapshots (not generated command streams):

1. **Fixtures (TS side):** a small TS harness serializes representative campaigns at genesis —
   Hollow House and the seed world — to `CampaignSnapshot` JSON.
2. **Snapshot round-trip:** Rust `from_snapshot(json)` → `to_snapshot()` → JSON must equal the input
   snapshot JSON under **canonical (key-sorted) comparison** on both sides. This alone proves the
   full data model, the id-keyed representation, serde, and byte-compatibility with the existing TS
   snapshot format.

These fixtures extend the existing `conformance/` suite and the Phase 0 gate (supplemented for
Phase 1).

### Testing

- **Rust unit tests:** store construction, id newtype serde round-trips, `HeldBy`/tagged-enum serde,
  a hand-built `World` → `to_snapshot()` smoke test.
- **serde round-trip property test (`proptest`):** `to_snapshot(from_snapshot(s)) == s` for generated
  snapshots over the Rust types (structural identity).
- **Differential conformance:** the load/round-trip fixtures above.
- Continue asserting exact equality (canonical-JSON), per invariant 3.

## Non-goals (this sub-plan)

- **No mutations, commands, turn loop, cues, combat, or `ViewModel` projection** — structure and
  load only. The `World` is built from a snapshot and re-serialized, never advanced or projected.
  (Sub-plan 2 onward; `ViewModel` grows across sub-plans 2–4.)
- **No authority/delta/sync** (sub-plan 8).
- **No new save format** — Rust conforms to the existing TS snapshot JSON during Phase 1.
- **No WASM cutover** — `GameSession`/consumers still run the TS engine (Phase 2).

## Risks & open questions

- **Snapshot field fidelity.** The exact field lists (especially `CharacterSnapshot`'s
  kind-discriminator and per-kind fields, and how `equipment`/`inventory` serialize) must be
  transcribed precisely from `serialization/types.ts`; a missing/renamed field fails round-trip.
  Plan task: read `serialization/types.ts` first and mirror it.
- **Canonical JSON for diffing.** `BTreeMap` gives deterministic Rust output, but the TS snapshot may
  emit object keys in insertion order; the conformance comparison must canonicalize (sort keys) on
  both sides before diffing. Decide the canonicalization helper in the plan.
- **`ViewModel` projection is deferred (resolved).** Confirmed *not* derivable from the snapshot
  alone — it needs the behavior/registry layer, `effectiveStat`, and status derivation — so it moves
  to sub-plans 2–4 (see "ViewModel projection — deferred" above). No action this sub-plan.
- **Character-kind modeling.** Struct-with-kind-enum vs separate structs per kind — resolve against
  the actual `CharacterSnapshot` discriminator shape in the plan.
- **`CampaignState` catalog data.** Recipes/archetypes/mechanic instances are carried as plain data
  now and given behavior in later sub-plans; ensure their snapshot fields round-trip even though
  unused this sub-plan.
