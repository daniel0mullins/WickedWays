# Data-Driven Formations + Roving Rats (Hollow House)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-07
**Branch:** `design/rust-engine-core`
**Related:** the scripted-ops DSL (`2026-07-06-rust-engine-scripted-ops-dsl-design.md`), the item-effects `onUse` hook (`2026-07-07-rust-engine-item-action-effects.md`), and the formation/encounter system ported in Phase-1 sub-plan 6c-3.
**Sibling sub-project:** the scene-driven NPC key (its own spec) — independent of this one.

## Goal

Add **roving Rat encounters** to Hollow House: a weak "Rat" farm mob that spawns via the encounter system in two formations (a single rat, a pair), drops a **rat tail** on defeat, and whose rat tail can be eaten to restore **+1 Sanity**. To do this the right way, make **formations authorable as data** (a first-party descriptor in the catalog) instead of native Rust per formation — consistent with the scripted-ops "first-party content as data" philosophy.

## Background

Formations are **native-only** today: `formation(key)` (`crates/wickedways-core/src/world/formations.rs`) resolves keys to `&'static dyn FormationBehavior`, and the *only* registered one is `conformance:wraith`, behind `#[cfg(any(test, feature="conformance"))]`. There is no `BehaviorScript::Formation` and no data path — a first-party formation would otherwise require hand-written Rust + a matching TS impl per formation. The rest of the encounter machinery already exists and is gate-proven: `World::maybe_spawn` (visited-once → occupant-suppression → threshold roll → weighted select → build → place with `origin="campaign"`), ported byte-for-byte from TS `EncounterTable.maybeSpawn` (`src/lib/encounter-table.ts:82-102`). The encounter *table* (formation keys + weights + `baseEncounterChance`) and per-room `spawnModifier` are already authorable.

The rat-tail's heal-on-eat is the **`onUse` scripted item hook** shipped in the item-effects sub-plan (laudanum is the template); drop-on-defeat is the existing `.mob({ drops })` → `on_knock_out` path.

## Architecture — data-driven formations

A formation is just "spawn these mob templates" — static data, no expressions or rng logic (the rng selection already lives in `maybe_spawn`). So this is a **data descriptor** (like `ItemDescriptor`), not an expression-DSL addition.

### New serializable types (serde + ts-rs)

```
MobSpec {                       // a serializable mob template
  name: String,
  stats: { health, sanity, energy },     // f64 each
  natural_attack: { stat: StatType, power: f64 },
  drops: Vec<String>,           // item behavior keys dropped on defeat
  base_escape_chance: f64,      // Mob default 50
  light_averse: bool,           // default false
  material_drops: Map<String, f64>,   // default {}
  actions_per_round: u32,       // Mob default
}

FormationDescriptor { mobs: Vec<MobSpec> }
```

The exact field set is pinned in the plan against the fields the `conformance:wraith` `build()` emits (the always-serialized `Mob` defaults: `base_escape_chance`, `material_drops`, `light_averse`, `natural_attack` — `formations.rs:53-74`), so a data-built mob is byte-identical to a native-built one.

### Catalog surface + resolution

- Extend the catalog: `Catalog.formations: BTreeMap<String, FormationDescriptor>` (alongside `items`/`aliases`/`behaviors`), threaded via `catalogFromRegistry` exactly as `behaviors` are. No `CampaignSnapshot` schema bump — descriptors are catalog data.
- `maybe_spawn` gains a **resolution seam** mirroring the scripted-behavior seams: resolve the selected key against the native `formation(key)` registry FIRST (keeps `conformance:wraith`); on `None`, look it up in `catalog.formations` and build `CharacterSnapshot`s from the descriptor. Unknown on both → the existing no-op / error path.
- `validate_mechanics` extends to verify every encounter-table formation key resolves (native or descriptor) at load — fail fast, like the other behavior families.

### Deterministic multi-mob ids

Native spawns use `campaign-mob:<name>`. A pair needs distinct, deterministic ids: the descriptor build assigns the first mob `campaign-mob:<name>` and each subsequent same-batch mob `campaign-mob:<name>#<index>` (index from 2), identically on both engines. The scheme is pinned in the plan; the differential fixture proves byte-identity.

### TS oracle / authoring

- The TS engine keeps its `Formation { build(view) }` interface (`encounter-table.ts:17-24`). A data-driven formation is provided by wrapping a `FormationDescriptor` in a `Formation` whose `build()` instantiates mobs from the specs (`descriptorToFormation(desc)`), registered via `defineRegistry({ formations })`. The **same descriptor data** is serialized into `Catalog.formations` for the Rust core. One data source; both engines build identically.
- Campaign authoring is unchanged for the table: `authorTemplate(..., { baseEncounterChance })`, `.formation(key, { weight })`, `.room(name, { spawnModifier })`. Hollow House adds a `hollowHouseFormations(): Record<string, FormationDescriptor>` (parallel to `hollowHouseBehaviors()`), threaded through the manifest/session like behaviors.

## Determinism & the gate

- **Determinism:** the descriptor build is pure data instantiation (no rng inside build; ids from the fixed scheme). The spawn rng draws (threshold roll + weighted select) are unchanged and already gate-proven.
- **The gate is authority:** the descriptor (data) is the single source; Rust and the TS oracle build byte-identical `CharacterSnapshot`s. New differential coverage:
  - **formation-spawn fixture:** deterministic spawn of `rat-single` and `rat-pair` (construct with a threshold that always fires + weights that deterministically select each, so the outcome is roll-*value*-independent — per the **fixture rng rule**: a registered formation makes a setup `move` consume a threshold-roll draw before the genesis snapshot, so the fixture must be safe under the reseed offset). Asserts the built rats (stats, ids, drops, natural attack) match byte-for-byte, and the pair's two ids are distinct.
  - **rat-tail onUse:** covered by the item-effects `onUse` path; add a small fixture (or extend the laudanum-style coverage) proving eating a rat tail restores +1 Sanity and consumes it.
  - Register new `*.gen.test.ts` generators in `conformance/fixtures/vitest.config.ts`.
- **`no_std`:** the descriptor types + build stay `alloc`-only; `--no-default-features` builds.
- **ts-rs bindings** for `MobSpec`/`FormationDescriptor`; `bindings:check` green.

## Content (Hollow House)

- **Rat mob (farm mob):** Health 2, Sanity 2, Energy 3; `naturalAttack { Health, 1 }`; `drops: [rat-tail]`. Weak by design — the poker one-shots it (5 × mitigation ≥ 2); rats are a Sanity *faucet*, not a threat.
- **rat-tail item:** usable consumable; `onUse` → `emit(adjust(actor, "sanity", lit(1)))`, registered in `hollowHouseBehaviors()` by its behavior key. Not equippable, not a key (so the roving key-drop ban and the keys-in-loot ban are both irrelevant).
- **Formations:** `rat-single` = `[rat]`; `rat-pair` = `[rat, rat]`.
- **Enablement:** `baseEncounterChance: 20`; `.formation("rat-single", { weight: 3 })`, `.formation("rat-pair", { weight: 1 })` (pairs rarer); modest `spawnModifier` on the roamed rooms.
- **Where they rove:** a global rate; `maybe_spawn`'s existing **occupant-suppression** (no spawn while a live non-party occupant is present) keeps rats out of the Revenant (Cellar), Wraith (Nursery), and Foyer-NPC rooms automatically. Rats roam the Hall / Kitchen / Parlor / Landing.

## Scope / non-goals

- **Static formations only.** Descriptors are fixed mob lists — no view-reading/dynamic build. A future dynamic formation (like the wraith's `build(&CampaignView)`) can stay native; descriptors cover the common first-party case (rats and their ilk).
- No change to the encounter-table math, spawn suppression, escape, or drop-on-defeat mechanics — only a data path to `build()`.
- The scene-driven NPC key is a **separate sub-project/spec**; nothing here depends on it.
- No new mob AI / turns (mobs still act only via the solo-GM reaction, per the ported model).

## Edge cases

- **Pair id collision:** handled by the `#<index>` scheme; the fixture asserts distinct ids.
- **Occupant suppression:** rats won't stack onto a room already holding the Revenant/Wraith/NPC (existing rule) — no special-casing needed.
- **Roving key-drop ban:** rats drop a normal item (rat-tail), so the `addFormation` guard (`encounter-table.ts:57-69`) and the room-origin-only key-drop rule (`combat.rs`) are both non-issues.
- **Rat vs. the light rules:** rats are not `lightAverse`, so in a dark room they can't see the player (existing standoff) — consistent; they rove lit rooms.

## Testing strategy

- **Rust unit tests:** descriptor→`CharacterSnapshot` build (field-for-field vs. a native equivalent), the multi-mob id scheme, resolution seam (native-first, then descriptor, then unknown), `validate_mechanics` accepting/ rejecting formation keys.
- **Differential conformance:** the formation-spawn fixture (rat-single + rat-pair byte-identical) and the rat-tail onUse coverage — the acceptance bar.
- **`checks:phase2`** green end-to-end, including regenerated/added fixtures and `bindings:check`.

## Invariant check

- **Gate is authority** — descriptor data drives both engines; spawn fixture diffs byte-for-byte; fixes go in the build/interpreter, never goldens. ✅
- **Determinism** — pure data build, fixed id scheme, unchanged rng draws. ✅
- **`no_std`** — descriptor types + build are `alloc`-only. ✅
- **Serializable boundary** — `MobSpec`/`FormationDescriptor` are serde/ts-rs data; no live objects cross. ✅
- **Generated bindings** — ts-rs types, `bindings:check`-covered. ✅
- **First-party content as data** — formations join items/behaviors as authorable catalog data; zero native Rust per formation. ✅
