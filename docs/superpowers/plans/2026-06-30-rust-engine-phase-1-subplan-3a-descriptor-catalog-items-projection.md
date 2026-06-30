# Rust Engine Core — Phase 1, Sub-plan 3a (Descriptor Catalog + Item Projection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Rust-owned item **descriptor catalog**, item **resolution**, **`effectiveStat`**, and the ViewModel's **item-display widening** (read side only), validated by a projection-parity differential gate against the TS oracle.

**Architecture:** A `Catalog { items: BTreeMap<behaviorKey, ItemDescriptor>, aliases: BTreeMap<behaviorKey, Vec<String>> }` is loaded alongside the snapshot (a new conformance artifact exported from the TS registry). Resolution/`effectiveStat`/the ViewModel projection take `&Catalog`. The single ViewModel struct **widens** (per the widening-gate philosophy): occupants gain `health`, and `loot`/`inventory`/`scope` + `status.health/sanity` are added. No item *mutations* (those are sub-plan 3b).

**Tech Stack:** Rust (edition 2021), serde 1 + serde_json 1, ts-rs 10.1, wasm-bindgen 0.2 / wasm-pack 0.15 (`--target nodejs`), TypeScript + vitest 4, pnpm 9.15.6.

## Global Constraints

- **Commit only on the existing branch `design/rust-engine-core`.** Never create, switch, or rename a branch.
- **`no_std`-friendly core.** `wickedways-core` builds with `--no-default-features`; use `alloc::{string::String, vec::Vec, collections::BTreeMap}` — never `std::` in library code. The gate runs `cargo build -p wickedways-core --no-default-features`.
- **serde byte-compatibility.** New types match the TS shapes: `#[serde(rename_all = "camelCase")]` on structs; `rename_all` to exact tag strings on enums; `#[serde(default, skip_serializing_if = "Option::is_none")]` on optionals; `#[serde(tag = "kind")]` on the existing `ItemSnapshot` enum (unchanged). The descriptor catalog/aliases are a **new Rust-owned format** the TS harness exports to match.
- **Integer fields integer-typed** (`i64`); never `f64`. The `i64`→`bigint` binding mismatch stays the deferred pre-Phase-2 decision — do NOT switch to `i32` piecemeal here.
- **Inert-as-Value.** Descriptor fields not consumed by 3a (`recipe`, `teaches`, `immunities`, `grants_immunity`) are carried as `serde_json::Value` passthrough; they are typed when their subsystem lands (3b/4/5).
- **Generated bindings are build artifacts (invariant 7).** New exported types carry ts-rs derives behind `feature = "ts"`, wired into the existing bindings export (see `crates/wickedways-core/src/stats.rs`); `pnpm run bindings:check` stays green.
- **Do NOT run `pnpm run fixtures:gen` casually** — it regenerates ALL fixtures with fresh UUIDs and clobbers committed ones. When a task must regenerate, restore the fixtures it should not have touched (`git checkout -- <path>`) and verify `git status`.
- **Do NOT Read subagent JSONL transcript output files.** `.superpowers/` is gitignored.

---

## File structure

**Created (Rust, `crates/wickedways-core/src/world/`):**
- `descriptor.rs` — `ItemType`, `SlotKind`, `ItemProperties`, `Presentation`, `ItemDescriptor`, `Catalog`.
- `resolve.rs` — `ResolvedItem` + `Catalog::resolve_item` (or `World`-level resolver).

**Modified:**
- `crates/wickedways-core/src/world/mod.rs` — `pub mod descriptor; pub mod resolve;`.
- `crates/wickedways-core/src/world/view.rs` — widen the ViewModel (`ScopeEntity`, `LootView`, `Inventory`; `effective_stat`; `view` takes `&Catalog` + aliases + opened-loot).
- `crates/wickedways-core/src/world/character_stats.rs` (or in `view.rs`/a new `stats_eff.rs`) — `effective_stat`.
- `crates/wickedways-wasm/src/lib.rs` — `replay_commands` gains `catalog_json`/`aliases_json`; add `view_model(snapshot, catalog, aliases, opened_loot)` entrypoint.
- `package.json` — `fixtures:gen` includes the new 3a generator.

**Created (conformance, TS):**
- `conformance/fixtures/items-projection.gen.test.ts` — exports catalog+aliases, builds a bespoke item campaign, writes the golden (isolated config).
- `conformance/fixtures/items-projection.{start.snapshot,catalog,aliases,golden}.json` — committed.
- `conformance/items-projection.test.ts` — Rust-projection differential test.
- Regenerated: `conformance/fixtures/turn-movement.golden.json` (widened view; item fields empty).

---

## Task 1: Descriptor primitive types

**Files:**
- Create: `crates/wickedways-core/src/world/descriptor.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (`pub mod descriptor;`), `crates/wickedways-core/src/stats.rs` (bindings export)
- Test: in `descriptor.rs`

**Interfaces — Produces:** `ItemType` (`#[serde(rename_all="lowercase")]`: Consumable, Armor, Weapon, Throwable, Accessory, Key), `SlotKind` (`rename_all="lowercase"`: Hand, Finger, Wrist, Head, Torso, Legs, Feet), `ItemProperties` (`camelCase`: `equippable: bool, equipped: bool, destroyable: bool, usable: bool, droppable: Option<bool>`), `Presentation` (`camelCase`: `image: Option<Value>, sound: Option<Value>`). All `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]` + ts-rs gated.

**Reference (mirror exactly):** `src/lib/inventory.ts:18-25` (`ItemType`), `:140-148` (`ItemProperties`), `src/lib/equipment.ts:6-14` (`SlotKind`), `src/lib/presentation.ts:9-14` (`Presentation`).

- [ ] **Step 1: Write failing serde tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn item_type_serializes_lowercase() {
        assert_eq!(serde_json::to_value(ItemType::Accessory).unwrap(), serde_json::json!("accessory"));
        assert_eq!(serde_json::to_value(ItemType::Weapon).unwrap(), serde_json::json!("weapon"));
    }
    #[test]
    fn slot_kind_serializes_lowercase() {
        assert_eq!(serde_json::to_value(SlotKind::Hand).unwrap(), serde_json::json!("hand"));
    }
    #[test]
    fn item_properties_omits_absent_droppable() {
        let p = ItemProperties { equippable: true, equipped: false, destroyable: true, usable: false, droppable: None };
        assert_eq!(serde_json::to_value(&p).unwrap(),
            serde_json::json!({ "equippable": true, "equipped": false, "destroyable": true, "usable": false }));
    }
    #[test]
    fn item_properties_emits_present_droppable_false() {
        let p = ItemProperties { equippable: false, equipped: false, destroyable: false, usable: false, droppable: Some(false) };
        assert_eq!(serde_json::to_value(&p).unwrap()["droppable"], serde_json::json!(false));
    }
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core descriptor`. Expected: FAIL (undefined).

- [ ] **Step 3: Implement the primitives**

```rust
//! Item descriptor primitives — the data half of an item's identity, sourced
//! from the campaign's registry (the catalog), not the per-instance snapshot.
//! JSON byte-compatible with `src/lib/inventory.ts` + `src/lib/equipment.ts`.
use alloc::string::String;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum ItemType { Consumable, Armor, Weapon, Throwable, Accessory, Key }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum SlotKind { Hand, Finger, Wrist, Head, Torso, Legs, Feet }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub equippable: bool,
    pub equipped: bool,
    pub destroyable: bool,
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub droppable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub image: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub sound: Option<serde_json::Value>,
}
```

Add `pub mod descriptor;` to `world/mod.rs`. Wire the four new exported types into the bindings export in `stats.rs` (follow the existing pattern). `serde_json::Value` lacks `ts_rs::TS`, so `Option<Value>` fields need `#[cfg_attr(feature="ts", ts(type="unknown"))]` (same deviation as sub-plan 2's cue `sound`).

- [ ] **Step 4: Run + no_std + bindings** — `cargo test -p wickedways-core` ; `cargo build -p wickedways-core --no-default-features` ; `pnpm run bindings:gen && pnpm run bindings:check`. Expected: PASS + green.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/descriptor.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/stats.rs generated/
git commit -m "feat(core): item descriptor primitives — ItemType/SlotKind/ItemProperties/Presentation (sub-plan 3a)"
```

---

## Task 2: ItemDescriptor + Catalog + Aliases

**Files:**
- Modify: `crates/wickedways-core/src/world/descriptor.rs`, `crates/wickedways-core/src/stats.rs` (bindings)
- Test: in `descriptor.rs`

**Interfaces — Produces:** `ItemDescriptor` (camelCase; typed 3a fields + inert `Value` for `recipe`/`teaches`/`immunities`/`grants_immunity`), `Catalog { items: BTreeMap<String, ItemDescriptor>, aliases: BTreeMap<String, Vec<String>> }`. `Catalog` derives `Default`.

**Reference:** `src/lib/inventory.ts:324-344` (`ItemDescriptor`). The catalog/aliases JSON format is **new and Rust-owned** — the TS harness (Task 7) exports to match it.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn item_descriptor_roundtrips_with_inert_value_fields() {
    let json = serde_json::json!({
        "name": "Iron Poker", "type": "weapon", "stat": "health", "modifier": 5,
        "properties": { "equippable": true, "equipped": false, "destroyable": true, "usable": false },
        "slot": "hand", "maxDurability": 8,
        "recipe": { "metal": 1 }, "teaches": null, "immunities": [], "grantsImmunity": null
    });
    let d: ItemDescriptor = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(d.name, "Iron Poker");
    assert_eq!(d.r#type, ItemType::Weapon);
    assert_eq!(d.max_durability, Some(8));
    assert_eq!(d.recipe, serde_json::json!({ "metal": 1 })); // inert passthrough
    assert_eq!(serde_json::to_value(&d).unwrap(), json);     // byte round-trip
}

#[test]
fn catalog_loads_and_resolves_key() {
    let cat: Catalog = serde_json::from_value(serde_json::json!({
        "items": { "items/poker": { "name": "Iron Poker", "type": "weapon", "stat": "health",
            "modifier": 5, "properties": {"equippable":true,"equipped":false,"destroyable":true,"usable":false},
            "recipe": {}, "teaches": null, "immunities": [], "grantsImmunity": null } },
        "aliases": { "items/poker": ["poker", "iron"] }
    })).unwrap();
    assert_eq!(cat.items.get("items/poker").unwrap().name, "Iron Poker");
    assert_eq!(cat.aliases.get("items/poker").unwrap(), &vec!["poker".to_string(), "iron".to_string()]);
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core descriptor`. Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
use alloc::vec::Vec;
use alloc::collections::BTreeMap;
use crate::stats::StatType;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ItemDescriptor {
    pub name: String,
    pub r#type: ItemType,
    pub stat: StatType,
    pub modifier: i64,
    pub properties: ItemProperties,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<SlotKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub two_handed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emits_light: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_durability: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lore: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Presentation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consume_on_use: Option<bool>,
    // inert until 3b/4/5 — typed when their subsystem lands:
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub recipe: serde_json::Value,
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub teaches: serde_json::Value,
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub immunities: serde_json::Value,
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub grants_immunity: serde_json::Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Catalog {
    pub items: BTreeMap<String, ItemDescriptor>,
    pub aliases: BTreeMap<String, Vec<String>>,
}
```

> The inert `Value` fields are required (not optional) so the round-trip is byte-exact against the exporter; the exporter (Task 7) emits `null`/`{}`/`[]` for them as the TS descriptor dictates. If the exporter omits an absent field instead of emitting `null`, switch that field to `#[serde(default)] Value` and confirm the round-trip — the plan's Task 7 exporter and this type must agree; reconcile by making both emit the same shape.

- [ ] **Step 4: Run + no_std + bindings** — as Task 1 Step 4. Expected: PASS + green.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/descriptor.rs crates/wickedways-core/src/stats.rs generated/
git commit -m "feat(core): ItemDescriptor + Catalog (descriptor-data catalog) (sub-plan 3a)"
```

---

## Task 3: Item resolution

**Files:**
- Create: `crates/wickedways-core/src/world/resolve.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs`
- Test: in `resolve.rs`

**Interfaces — Produces:** `ResolvedItem { id: String, name: String, r#type: ItemType, stat: StatType, modifier: i64, properties: ItemProperties, slot: Option<SlotKind>, durability: Option<i64>, max_durability: Option<i64>, is_broken: bool, lore: Option<String>, presentation: Option<Presentation>, key_code: Option<String> }` and `fn resolve_item(snap: &ItemSnapshot, cat: &Catalog) -> Result<ResolvedItem, ProceduralViolation>`. (Not serialized — an internal projection helper.)

**Reference:** `src/lib/inventory.ts` `hydrateItem` (:723-734) + `[HYDRATE]` (:443-448) + `isBroken` (:403-405).

- [ ] **Step 1: Write failing tests** — item variant merges per-instance `durability`/`modifier` over the descriptor; `is_broken` true iff `max_durability.is_some() && durability == Some(0)`; key variant resolves from snapshot (type=Key, all properties false, no slot); unknown `behaviorKey` → `Err`. (Build `ItemSnapshot::Item { behaviorKey:"items/poker", durability:Some(0), modifier:5 }` against a catalog with `items/poker` maxDurability 8 → is_broken true; durability Some(8) → false.)

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core resolve`. Expected: FAIL.

- [ ] **Step 3: Implement** `resolve_item`: for `ItemSnapshot::Item`, look up `cat.items[behaviorKey]` (else `ProceduralViolation`), copy descriptor fields, override `modifier` with the snapshot's, set `durability` from the snapshot (descriptor's `max_durability` bounds it), compute `is_broken`. For `ItemSnapshot::Key`, build a `ResolvedItem` with `r#type=Key`, `properties { equippable:false, equipped:false, destroyable:false, usable:false, droppable:Some(false) }`, `key_code` from the snapshot, no slot/durability. Add `pub mod resolve;`.

> Confirm the exact `ItemSnapshot` variant field names in `world/snapshot.rs` (sub-plan 1) and match them. `modifier` precedence: the snapshot's per-instance `modifier` wins over the descriptor's (mirrors `[HYDRATE]` setting `this.modifier = data.modifier`).

- [ ] **Step 4: Run + no_std** — `cargo test -p wickedways-core` ; `cargo build -p wickedways-core --no-default-features`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/resolve.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): item resolution (snapshot + catalog -> ResolvedItem) (sub-plan 3a)"
```

---

## Task 4: `effectiveStat`

**Files:**
- Modify: `crates/wickedways-core/src/world/resolve.rs` (or a new `stats_eff.rs`), `crates/wickedways-core/src/world/mod.rs`
- Test: co-located

**Interfaces — Produces:** `World::effective_stat(&self, character: &CharacterId, stat: StatType, cat: &Catalog) -> i64`.

**Reference:** `src/lib/character/character.ts:903-913`. Equipped-ness is derived from the **equipment slot map** (`CharacterSnapshot.equipment: BTreeMap<String, ItemId>`), the only persisted source — NOT `properties.equipped`.

- [ ] **Step 1: Write failing tests** — base stat with no equipment = base; one equipped **accessory** whose `stat` matches adds its `modifier`; an equipped **non-accessory** (weapon) does NOT contribute; an accessory in inventory but **not in the equipment map** does NOT contribute; an equipped accessory with a **different stat** does NOT contribute. (Use a hand-built `World` + `Catalog`; put the accessory's item id in the character's `equipment` map.)

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core effective_stat`. Expected: FAIL.

- [ ] **Step 3: Implement** — sum over the character's equipment slot-map item ids: resolve each via the catalog; include iff `resolved.r#type == Accessory && resolved.stat == stat`; add `resolved.modifier`. Return `base_stat + bonus`. Read the base from `CharacterSnapshot.stats` (the `Stats` struct keyed by `StatType`). De-duplicate two-handed items that occupy two slots (an item id appearing in both hands counts once — match the TS, which iterates inventory items, not slots; confirm and mirror).

> The TS iterates `inventory.items` filtered by `properties.equipped`. The Rust derives equipped from the equipment map. For a single equipped accessory these agree; verify the two-handed/dedup case matches (accessories are never two-handed, so dedup is moot for accessories — note it and keep it simple).

- [ ] **Step 4: Run + no_std** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/resolve.rs crates/wickedways-core/src/world/mod.rs
git commit -m "feat(core): effective_stat (base + equipped-accessory modifiers) (sub-plan 3a)"
```

---

## Task 5: ViewModel widening

**Files:**
- Modify: `crates/wickedways-core/src/world/view.rs`, `crates/wickedways-core/src/stats.rs` (bindings)
- Test: in `view.rs`

**Interfaces — Produces:** `ScopeEntity { id, name, aliases: Vec<String>, kind: String, health: Option<i64>, image: Option<Value>, equippable: Option<bool>, usable: Option<bool>, has_lore: Option<bool>, droppable: Option<bool> }` (camelCase; all `Option` skip-if-none except id/name/aliases/kind). `LootView { id, description, opened, contents: Vec<ScopeEntity> }`. `Inventory { items: Vec<ScopeEntity>, keys: Vec<ScopeEntity>, equipped_names: Vec<String>, slots: i64 }`. The ViewModel grows: `occupants: Vec<ScopeEntity>` (was `ThinOccupant`, now with `health`), `+ loot: Vec<LootView>`, `+ inventory: Inventory`, `+ scope: Vec<ScopeEntity>`; `ThinStatus` gains `health: i64, sanity: i64`. New signature: `World::view(&self, cat: &Catalog, opened_loot: &BTreeSet<String>) -> Result<ViewModel, ProceduralViolation>` (rename/replace `view_thin`; keep the struct name or rename `ThinViewModel`→`ViewModel` — pick one and update `replay_commands`).

**Reference:** `packages/play-runtime/src/viewmodel.ts:60-167` — but build only the 3a fields (NO `defeated`, NO `exits`/`lockedDoors` — those land in 4/6). `aliasesFor(behaviorKey, name, aliases)` = unique list of lowercased `name` + the alias-table entries.

- [ ] **Step 1: Write failing tests** (hand-built `World` + `Catalog`):
  - an inventory item ScopeEntity has `kind:"item"`, `equippable`/`usable` from descriptor properties, `hasLore = lore.is_some()`, `droppable = properties.droppable != Some(false)`, `aliases` = lowercased name + table entries (deduped);
  - a key ScopeEntity (`kind:"item"`) is not equippable/usable, `droppable:false`;
  - `loot[0]` has `description`, `opened` reflecting the `opened_loot` set, and `contents` resolved;
  - `inventory.equipped_names` lists the names of items in the equipment map; `slots` from `inventory.slots`;
  - `occupants[i].health` = `effective_stat(occupant, Health, cat)`;
  - `status.health`/`status.sanity` = `effective_stat(active, Health/Sanity, cat)`;
  - `scope` = occupants ++ loot-contents ++ inventory items ++ keys ++ loot-container entities (`kind:"loot"`), in that order (match `viewmodel.ts`).

- [ ] **Step 2: Run, verify fail** — `cargo test -p wickedways-core view`. Expected: FAIL.

- [ ] **Step 3: Implement** the widened `view`. Build item ScopeEntities by resolving inventory/loot item ids via the catalog; occupants reuse the sub-plan-2 logic + `health`; `scope` is the concatenation `viewmodel.ts` builds (occupants, loot contents, inventory items, keys, loot containers). The loot-container scope entity uses `kind:"loot"` with the container's description as `name` and the fixed aliases `["chest","box","drawer","container"]` (match `viewmodel.ts:lootScope`). Update `world/mod.rs`/`stats.rs` exports; replace `ThinOccupant` with `ScopeEntity`.

> Match `viewmodel.ts` ordering and the `aliasesFor` semantics exactly — `scope` order and alias contents are byte-compared by Task 8. Keep `loot[].contents` AND the flattened loot-contents-in-scope both present (the TS builds both).

- [ ] **Step 4: Run + no_std + bindings** — `cargo test -p wickedways-core` ; `cargo build -p wickedways-core --no-default-features` ; `pnpm run bindings:gen && pnpm run bindings:check`. Expected: PASS + green (new `ScopeEntity`/`LootView`/`Inventory` bindings; `ThinOccupant` removed).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/world/view.rs crates/wickedways-core/src/world/mod.rs crates/wickedways-core/src/stats.rs generated/
git commit -m "feat(core): widen ViewModel — item display, loot, inventory, scope, health/sanity (sub-plan 3a)"
```

---

## Task 6: WASM wiring (catalog-aware projection)

**Files:**
- Modify: `crates/wickedways-wasm/src/lib.rs`
- Test: a Rust integration assertion (and the WASM build)

**Interfaces — Produces:** `view_model(snapshot_json: &str, catalog_json: &str, aliases_json: &str, opened_loot_json: &str) -> Result<String, JsValue>` returning the widened ViewModel JSON (static projection). `replay_commands` gains `catalog_json: &str, aliases_json: &str` params and threads them into the per-step `view(...)` call (the per-step key stays `"viewThin"` OR rename to `"view"` — pick one; Task 7 regenerates the turn-movement golden to match).

- [ ] **Step 1:** Build a `Catalog` from `catalog_json` + `aliases_json` (the harness emits a single `{items, aliases}` object — accept either one combined `catalog_json` carrying both, or two args; pick the shape Task 7 emits and keep them consistent). Parse `opened_loot_json` as `Vec<String>` → `BTreeSet`. Call `world.view(&cat, &opened)`.

- [ ] **Step 2: Implement** both entrypoints, reusing the existing `JsValue` error pattern. `replay_commands` constructs the `Catalog` once and passes it to each per-step `view`.

- [ ] **Step 3: Build + test** — `pnpm run wasm:build` ; `cargo test -p wickedways-core`. Expected: WASM compiles, tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-wasm/src/lib.rs
git commit -m "feat(wasm): catalog-aware view_model entrypoint + replay_commands catalog params (sub-plan 3a)"
```

---

## Task 7: TS harness — catalog export + bespoke item campaign + goldens

**Files:**
- Create: `conformance/fixtures/items-projection.gen.test.ts`
- Create (committed): `conformance/fixtures/items-projection.{start.snapshot,catalog,aliases,golden}.json`
- Modify: `conformance/fixtures/turn-movement.gen.test.ts` (widen its view helper + pass catalog/aliases), `conformance/fixtures/vitest.config.ts`, `package.json` (`fixtures:gen`)
- Regenerated: `conformance/fixtures/turn-movement.golden.json`

**Interfaces — Produces:** a `catalog.json` (`{ items: { behaviorKey: descriptor }, aliases: { behaviorKey: [..] } }`) exported by instantiating each registry item factory and serializing its descriptor to the **Rust `ItemDescriptor` shape**; a bespoke item campaign (weapon, equipped accessory, usable consumable, key, loot container with contents); and the golden `{ snapshot, view }` (the widened ViewModel via a TS helper matching the Rust `ViewModel` shape).

- [ ] **Step 1: Write the catalog exporter** — for the campaign's registry, instantiate `registry.item(key)()` for each item key, read the live item's descriptor fields, and emit the catalog entry in the Rust `ItemDescriptor` JSON shape (camelCase; `type`/`slot` lowercase; inert `recipe`/`teaches`/`immunities`/`grantsImmunity` emitted as the TS values). Emit `aliases` from the campaign's `ALIASES`. Read `src/lib/inventory.ts` to map live-item getters → descriptor fields.

- [ ] **Step 2: Build the bespoke item campaign** — inline `authorTemplate` (do NOT modify `packages/seed`): rooms + behavior-free exits + 2 PCs; give a PC an inventory with a weapon + an **equipped** accessory (in the equipment map) + a usable consumable + a key; place a loot container with an item. Fixed `rng`/`now`; `maxRounds`.

- [ ] **Step 3: Emit the golden** — write `items-projection.start.snapshot.json`, `items-projection.catalog.json`, `items-projection.aliases.json` (or one combined catalog), and `items-projection.golden.json` = `{ snapshot, view }` where `view` is the widened ViewModel built by a TS helper EXACTLY matching the Rust `ViewModel` field shape (room, occupants[+health], loot, inventory, scope, status[+health/sanity], outcome, finished). Self-validate: throw if the catalog is empty or the view's inventory has no items.

- [ ] **Step 4: Widen the turn-movement generator** — update `turn-movement.gen.test.ts`'s `viewThin` helper to the widened shape (item fields empty for that campaign; occupants gain `health`), pass an empty catalog/aliases, and regenerate `turn-movement.golden.json`.

- [ ] **Step 5: Generate + restore + verify isolation** — `pnpm run fixtures:gen`; then `git checkout -- conformance/fixtures/seed.snapshot.json conformance/fixtures/hollow-house.snapshot.json` (restore the clobbered sub-plan-1 fixtures); confirm `git status` shows only the items-projection files + turn-movement.golden.json + the two generators changed. Run `pnpm run test:conformance` twice; goldens unchanged between runs.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/items-projection.* conformance/fixtures/turn-movement.gen.test.ts conformance/fixtures/turn-movement.golden.json conformance/fixtures/vitest.config.ts package.json
git commit -m "test(conformance): catalog exporter + bespoke item campaign golden; widen turn-movement view (sub-plan 3a)"
```

---

## Task 8: Differential projection-parity gate

**Files:**
- Create: `conformance/items-projection.test.ts`
- Modify: `conformance/turn-movement.test.ts` (pass catalog/aliases to `replay_commands`), `package.json` (checks alias if needed)
- Reference: `conformance/world-roundtrip.test.ts` + `conformance/turn-movement.test.ts` (WASM load + canonical compare patterns).

**Interfaces — Consumes:** WASM `view_model` (Task 6), the committed items-projection fixtures (Task 7), `canonicalize` from `canonical-json.ts`.

- [ ] **Step 1: Write the projection test** — load `items-projection.start.snapshot.json` + `catalog` + `aliases`; call `wasm.view_model(snapshot, catalog, aliases, "[]")`; `canonicalize`-compare the parsed result against `golden.view`. Assert the inventory items, loot contents, scope, occupant `health`, and `status.health/sanity` all match.

- [ ] **Step 2: Update the turn-movement test** — pass the (empty) catalog/aliases to `replay_commands` and compare against the regenerated golden (the view now carries the widened, mostly-empty item fields + occupant health).

- [ ] **Step 3: Run** — `pnpm run wasm:build && pnpm run test:conformance`. Expected: PASS (items-projection + turn-movement + the 3 prior suites).

- [ ] **Step 4: If a real divergence appears** (a field mismatch, wrong alias order, wrong scope order, wrong `effectiveStat`), diagnose precisely — that is a real fidelity bug in an earlier 3a task; fix it (note loudly) or set BLOCKED with the exact field + Rust-vs-golden values. Do NOT loosen the comparator or edit the golden. The `i64`→`bigint` issue is NOT a wire-level failure (serde emits plain numbers) — if a number diverges, it is a real value bug, not the binding issue.

- [ ] **Step 5: Full gate** — run `pnpm run checks:phase2` end-to-end (rename to `checks:phase3` as an honest alias if desired). Expected: all green (no_std build + `cargo test --workspace` + bindings drift + all conformance suites).

- [ ] **Step 6: Commit**

```bash
git add conformance/items-projection.test.ts conformance/turn-movement.test.ts package.json
git commit -m "test(conformance): item projection-parity differential gate (sub-plan 3a)"
```

---

## Self-review notes (author)

- **Spec coverage:** catalog primitives (T1), ItemDescriptor+Catalog (T2), resolution (T3), effectiveStat (T4), ViewModel widening (T5), WASM catalog plumbing (T6), catalog exporter + bespoke item campaign + golden (T7), projection-parity gate (T8). Item actions, durability decrement, `defeated`/KO, exits/lockedDoors, code-behavior op-registry, crafting are explicit non-goals (later sub-plans) — not in any task.
- **Type consistency:** `ItemType`/`SlotKind`/`ItemProperties`/`Presentation` (T1) → `ItemDescriptor`/`Catalog` (T2) → `ResolvedItem` (T3) → `effective_stat` (T4) → `ScopeEntity`/`LootView`/`Inventory`/widened `ViewModel` (T5) → WASM (T6) → goldens (T7) → gate (T8). The catalog JSON shape (T2) must equal the exporter's output (T7) — reconciled in T2's note and T7 Step 1.
- **Carried notes honored:** integer-typed (no `f64`); `i64`→`bigint` left as the deferred decision (T8 Step 4 clarifies it is not a wire failure); inert-as-Value for `recipe`/`teaches`/`immunities`/`grants_immunity`; fixtures:gen footgun handled (T7 Step 5 restore); ViewModel widens (not a new shape) and regenerates the prior golden (T7 Step 4).
- **Risk watch:** the catalog exporter↔`ItemDescriptor` shape agreement (T2/T7) and the `scope`/`aliases` ordering (T5/T8) are the two places most likely to need a fix loop.
