# Rust Engine Phase 1 — Sub-plan 1: World Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the id-keyed `World` data model in `wickedways-core` — branded ids, entity structs mirroring the TS serialization snapshot types, serde, and a single-pass `from_snapshot`/`to_snapshot` — and prove it round-trips real campaign snapshots byte-faithfully against the TS engine.

**Architecture:** Entity-reference fields, ids, and simple scalars are typed precisely so the `World` can key entities by branded id (`BTreeMap<Id, Entity>`) and relate them. Genuinely inert nested sub-structures (archetypes, codex, policies, action history, narration, mechanic state) are typed as `serde_json::Value` — they round-trip faithfully and get real types in the later sub-plan that first uses them (YAGNI). No behavior, mutation, turn loop, cues, or `ViewModel` — structure and load only.

**Tech Stack:** Rust (edition 2021), `serde` 1 + `serde_json` 1, `serde-wasm-bindgen` 0.6, `proptest` 1; TypeScript `vitest` 4 conformance harness loading the WASM build via `createRequire`.

## Global Constraints

- **Invariant 1 — one source of truth.** The authoritative field list for every entity struct is the existing TS `src/lib/serialization/types.ts` (`CampaignSnapshot` and its members). Mirror it; do not invent fields.
- **Invariant 3 — determinism + exact equality.** `World` stores are `BTreeMap`/`BTreeSet` (deterministic order). The conformance gate asserts **canonical-JSON equality** (deep object-key sort + the 7 top-level entity arrays sorted by `id`), never approximate.
- **Invariant 5 — no_std-friendly core.** New code lives in `wickedways-core`. `serde`/`serde_json` are pulled with no_std-compatible features where used in core; the ts-rs/std split from Phase 0 is preserved. `serde_json` in core uses `default-features = false, features = ["alloc"]`.
- **JSON byte-compatibility (the conformance mechanism).** During Phase 1 the Rust serde representation MUST match the existing TS snapshot JSON. **Every struct carries `#[serde(rename_all = "camelCase")]`; every `Option` field carries `#[serde(default, skip_serializing_if = "Option::is_none")]`** (TS omits absent optionals — Rust must too, never emit `null` for them).
- **Order fidelity.** Within-entity id lists (e.g. `partyIds`, `inventory.itemIds`, `occupantIds`, `contentIds`) are stored as **order-preserving `Vec<Id>`** this sub-plan (set-semantics/`BTreeSet` arrive with mutation in sub-plan 2). Only the 7 **top-level** entity arrays are reordered (id-sorted) on emit, and the gate canonicalizes the TS side to match.
- **`SCHEMA_VERSION = 6`** (from `serialization/types.ts`).
- **Branded ids are `String` newtypes**, serde-`transparent` (serialize as a bare string), to preserve the existing string-id format.
- Edition `2021`; package manager `pnpm@9.15.6`. `source "$HOME/.cargo/env"` if cargo isn't on PATH.

## Translation rules (TS snapshot → Rust)

Apply uniformly:

| TS | Rust |
|---|---|
| `id: string` on an entity, and `...Id: string` references | branded newtype (`CharacterId(String)`, …), `#[serde(transparent)]` |
| `...Ids: string[]` / ordered arrays | `Vec<BrandedId>` (order preserved) |
| `Record<Direction, string>` (exits), `Record<EquipmentSlot, string>` (equipment) | `BTreeMap<String, BrandedId>` (key is the slot/dir string; Direction/slot enums deferred to sub-plan 2/3) |
| discriminated union `{ kind: "item" } \| { kind: "key" }` | `#[serde(tag = "kind", rename_all = "camelCase")]` enum |
| field-discriminator `kind: "player"\|"mob"\|"npc"` on one interface | a `kind: CharacterKind` field; `CharacterKind` enum `#[serde(rename_all = "lowercase")]` |
| optional `field?: T` | `#[serde(default, skip_serializing_if = "Option::is_none")] field: Option<T>` |
| `Stats` `{ energy, sanity, health }` numbers | typed `Stats { energy: i64, sanity: i64, health: i64 }` |
| numbers that are counts/levels (`durability`, `modifier`, `round`, `slots`, …) | `i64` |
| **inert nested structures** (`ActionHistoryEntry[]`, `Archetype[]`, `CodexEntry[]`, `ChatPolicy`, `AvPolicy`, `MobOrigin`, `OutcomeNarration`, `AfflictionsSnapshot`, `actionSounds`, `encounterTable`, `MaterialMap`, mechanic `state`, `naturalAttack`, `archetypeImmunities`, `winConditions`/`loseConditions`, `scenes`) | `serde_json::Value` (faithful passthrough; real types when first used in a later sub-plan) |

`i64` is correct for these counts (all integers in practice; `serde_json` round-trips integers exactly). `MaterialMap` is inert here → `Value`.

## File Structure

**Created (all under `crates/wickedways-core/src/`):**
- `world/mod.rs` — `World`, `CampaignState`, `from_snapshot`/`to_snapshot`, module wiring.
- `world/ids.rs` — the 6 branded id newtypes.
- `world/snapshot.rs` — `CampaignSnapshot` + all entity/sub snapshot structs (the serde wire types).
- Test: `conformance/world-roundtrip.test.ts` + `conformance/fixtures/*.snapshot.json` (TS-generated) + a TS fixture-generator script.

**Modified:**
- `crates/wickedways-core/src/lib.rs` — `pub mod world;` + re-exports.
- `crates/wickedways-core/Cargo.toml` — add `serde_json` (core, `default-features=false, features=["alloc"]`); `proptest` dev-dep already present.
- `crates/wickedways-wasm/src/lib.rs` — `roundtrip_snapshot` export.
- `crates/wickedways-wasm/Cargo.toml` — `serde_json` already present (Phase 0).
- `package.json` — extend the conformance/gate scripts for the new suite + fixture generation.

---

### Task 1: Branded ids + module scaffold

**Files:**
- Create: `crates/wickedways-core/src/world/ids.rs`, `crates/wickedways-core/src/world/mod.rs`
- Modify: `crates/wickedways-core/src/lib.rs`, `crates/wickedways-core/Cargo.toml`

**Interfaces:**
- Produces: `CharacterId`, `RoomId`, `ItemId`, `LootId`, `MaterialCacheId`, `ExitId` — each `pub struct X(pub String)`, `#[serde(transparent)]`, deriving `Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize`.

- [ ] **Step 1: Add `serde_json` to the core crate**

In `crates/wickedways-core/Cargo.toml` `[dependencies]`, add:
```toml
serde_json = { version = "1", default-features = false, features = ["alloc"] }
```

- [ ] **Step 2: Write the failing test (id serde is transparent)**

Create `crates/wickedways-core/src/world/ids.rs`:
```rust
//! Branded entity-id newtypes. Serialize as a bare string (transparent) to
//! preserve the existing string-id snapshot format.
use serde::{Deserialize, Serialize};

macro_rules! branded_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
    };
}

branded_id!(CharacterId);
branded_id!(RoomId);
branded_id!(ItemId);
branded_id!(LootId);
branded_id!(MaterialCacheId);
branded_id!(ExitId);

#[cfg(test)]
mod tests {
    use super::CharacterId;

    #[test]
    fn id_serializes_as_bare_string() {
        let id = CharacterId("abc-123".into());
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"abc-123\"");
        let back: CharacterId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }
}
```

- [ ] **Step 3: Wire the module**

Create `crates/wickedways-core/src/world/mod.rs`:
```rust
//! The id-keyed runtime world model (Phase 1).
pub mod ids;
pub mod snapshot; // created in Task 2

pub use ids::{CharacterId, ExitId, ItemId, LootId, MaterialCacheId, RoomId};
```
For Task 1 only, comment out `pub mod snapshot;` and its re-use until Task 2 creates it (so the crate compiles). In `crates/wickedways-core/src/lib.rs` add `pub mod world;`.

- [ ] **Step 4: Run the test**

Run: `cargo test -p wickedways-core world::ids`
Expected: PASS (`id_serializes_as_bare_string`). `cargo build --workspace` and `cargo build -p wickedways-core --no-default-features` both succeed.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core
git commit -m "feat(core): branded entity ids + world module scaffold (phase 1 world task 1)"
```

---

### Task 2: Leaf snapshot structs (item, key, loot, material cache, exit, scene)

**Files:**
- Create/extend: `crates/wickedways-core/src/world/snapshot.rs`
- Modify: `crates/wickedways-core/src/world/mod.rs` (enable `pub mod snapshot;`)

**Interfaces:**
- Produces: `ItemSnapshot` (tagged enum), `LootSnapshot`, `MaterialCacheSnapshot`, `ExitSnapshot`, `SceneSnapshot`.

- [ ] **Step 1: Write the structs**

Create `crates/wickedways-core/src/world/snapshot.rs` (mirrors `src/lib/serialization/types.ts`):
```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::ids::*;

/// TS `ItemSnapshot` — a discriminated union on `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemSnapshot {
    #[serde(rename_all = "camelCase")]
    Item {
        id: ItemId,
        behavior_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        durability: Option<i64>,
        modifier: i64,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        id: ItemId,
        name: String,
        key_code: String,
        consume_on_use: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootSnapshot {
    pub id: LootId,
    pub description: String,
    pub capacity: i64,
    pub content_ids: Vec<ItemId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCacheSnapshot {
    pub id: MaterialCacheId,
    /// Inert here (MaterialMap) — faithful passthrough.
    pub contents: Value,
    pub depleted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSnapshot {
    pub id: String,
    pub behavior_key: String,
    pub phase: String, // "enter" | "exit" — string this sub-plan
    pub state: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitSnapshot {
    pub id: ExitId,
    pub endpoint_ids: [RoomId; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub state: Value,
}
```
Enable `pub mod snapshot;` in `world/mod.rs`.

- [ ] **Step 2: Write the failing round-trip tests**

Append to `snapshot.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(json: &str) {
        let v: T = serde_json::from_str(json).unwrap();
        let out = serde_json::to_value(&v).unwrap();
        let expected: Value = serde_json::from_str(json).unwrap();
        assert_eq!(out, expected, "round-trip changed the JSON");
    }

    #[test]
    fn item_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(r#"{"kind":"item","id":"i1","behaviorKey":"lantern","modifier":0}"#);
        roundtrip::<ItemSnapshot>(r#"{"kind":"item","id":"i2","behaviorKey":"sword","durability":3,"modifier":2}"#);
    }

    #[test]
    fn key_variant_roundtrips() {
        roundtrip::<ItemSnapshot>(r#"{"kind":"key","id":"k1","name":"Brass Key","keyCode":"crypt","consumeOnUse":true}"#);
    }

    #[test]
    fn exit_roundtrips_with_and_without_optionals() {
        roundtrip::<ExitSnapshot>(r#"{"id":"e1","endpointIds":["r1","r2"],"state":{}}"#);
        roundtrip::<ExitSnapshot>(r#"{"id":"e2","endpointIds":["r1","r3"],"behaviorKey":"locked","name":"oak door","state":{"locked":true}}"#);
    }
}
```
Note: `serde_json::to_value` then comparing `Value`s makes the assertion order-insensitive on object keys (a `Value` compares structurally), so these tests verify field/shape fidelity and the `skip_serializing_if` behavior (the no-optional `exit` must not gain a `behaviorKey:null`).

- [ ] **Step 3: Run the tests**

Run: `cargo test -p wickedways-core world::snapshot`
Expected: FAIL first if written before the structs; PASS after. Verify the optional-omission case passes (proves `skip_serializing_if`).

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core
git commit -m "feat(core): item/loot/cache/exit/scene snapshot structs (phase 1 world task 2)"
```

---

### Task 3: Room + Character snapshot structs

**Files:**
- Extend: `crates/wickedways-core/src/world/snapshot.rs`

**Interfaces:**
- Produces: `RoomSnapshot`, `CharacterSnapshot`, `CharacterKind`, `Stats`, `InventorySnapshot`.

- [ ] **Step 1: Write the structs**

Append to `snapshot.rs` (mirrors `RoomSnapshot`/`CharacterSnapshot`; inert sub-structures are `Value`):
```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub energy: i64,
    pub sanity: i64,
    pub health: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub id: RoomId,
    pub name: String,
    pub description: String,
    /// Direction -> exitId. Direction enum deferred to sub-plan 2; key is the string.
    pub exits: std::collections::BTreeMap<String, ExitId>,
    pub dark: bool,
    pub spawn_modifier: i64,
    pub occupant_ids: Vec<CharacterId>,
    pub loot_ids: Vec<LootId>,
    pub material_cache_ids: Vec<MaterialCacheId>,
    pub light_source_ids: Vec<ItemId>,
    pub scenes: Vec<SceneSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterKind {
    Player,
    Mob,
    Npc,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySnapshot {
    pub slots: i64,
    pub item_ids: Vec<ItemId>,
    pub key_ids: Vec<ItemId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSnapshot {
    pub kind: CharacterKind,
    pub id: CharacterId,
    pub name: String,
    pub stats: Stats,
    pub actions_per_round: i64,
    pub actions_this_round: i64,
    pub current_room_id: Option<RoomId>, // present but nullable in TS — keep as null, not omitted
    pub inventory: InventorySnapshot,
    /// EquipmentSlot -> itemId.
    pub equipment: std::collections::BTreeMap<String, ItemId>,
    /// Inert here (ActionHistoryEntry[]) — passthrough.
    pub history: Value,
    /// Inert here (Status[]) — passthrough.
    pub archetype_immunities: Value,
    /// Inert here (AfflictionsSnapshot) — passthrough.
    pub afflictions: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archetype_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_escape_chance: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_drops: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_averse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_attack: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npc_behavior_key: Option<String>,
}
```
Note `current_room_id` is `Option<RoomId>` but is **always present** in TS (`string | null`), so it is NOT `skip_serializing_if` — it must serialize as `null` when absent. (Contrast with the truly-optional `archetypeId?` etc., which are omitted.)

- [ ] **Step 2: Write the failing round-trip tests**

Append to the `tests` module in `snapshot.rs`:
```rust
#[test]
fn player_character_roundtrips() {
    roundtrip::<CharacterSnapshot>(r#"{
        "kind":"player","id":"c1","name":"Heir",
        "stats":{"energy":5,"sanity":7,"health":10},
        "actionsPerRound":2,"actionsThisRound":0,"currentRoomId":"r1",
        "inventory":{"slots":6,"itemIds":["i1"],"keyIds":[]},
        "equipment":{"hand":"i1"},
        "history":[],"archetypeImmunities":[],
        "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
        "archetypeId":"survivor"
    }"#);
}

#[test]
fn mob_character_roundtrips_with_null_room_and_omitted_player_fields() {
    roundtrip::<CharacterSnapshot>(r#"{
        "kind":"mob","id":"m1","name":"Wraith",
        "stats":{"energy":3,"sanity":0,"health":4},
        "actionsPerRound":1,"actionsThisRound":0,"currentRoomId":null,
        "inventory":{"slots":0,"itemIds":[],"keyIds":[]},
        "equipment":{},
        "history":[],"archetypeImmunities":[],
        "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}},
        "origin":{"some":"data"},"lightAverse":true,"naturalAttack":{"stat":"sanity","power":2}
    }"#);
}

#[test]
fn room_roundtrips() {
    roundtrip::<RoomSnapshot>(r#"{
        "id":"r1","name":"Foyer","description":"Dusty.",
        "exits":{"north":"e1"},"dark":false,"spawnModifier":0,
        "occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],"scenes":[]
    }"#);
}
```

- [ ] **Step 3: Run the tests**

Run: `cargo test -p wickedways-core world::snapshot`
Expected: PASS (incl. the mob case proving `currentRoomId:null` is kept while `archetypeId` is omitted).

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core
git commit -m "feat(core): room + character snapshot structs (phase 1 world task 3)"
```

---

### Task 4: Campaign core + top-level `CampaignSnapshot`

**Files:**
- Extend: `crates/wickedways-core/src/world/snapshot.rs`

**Interfaces:**
- Produces: `CampaignCoreSnapshot`, `MechanicSnapshot`, `CampaignSnapshot`, `SCHEMA_VERSION`.

- [ ] **Step 1: Write the structs**

Append to `snapshot.rs` (mirrors `CampaignCoreSnapshot`/`CampaignSnapshot`; the many inert config fields are `Value`):
```rust
pub const SCHEMA_VERSION: i64 = 6;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicSnapshot {
    pub key: String,
    pub state: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignCoreSnapshot {
    pub id: String,
    pub title: String,
    pub max_rounds: i64,
    pub round: i64,
    pub started: bool,
    pub outcome: String, // CampaignOutcome string enum
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_reason: Option<String>,
    /// Inert here — { key, narration? }[]; passthrough.
    pub win_conditions: Value,
    pub lose_conditions: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_narration: Option<Value>,
    pub active_character_index: i64,
    pub party_ids: Vec<CharacterId>,
    pub acted_this_round: Vec<CharacterId>,
    pub gm_id: Option<CharacterId>, // present but nullable -> keep null
    pub materials: Value,           // MaterialMap, inert
    pub claims: Vec<String>,
    pub encountered: Vec<String>,
    pub known_recipes: Vec<String>,
    pub archetypes: Value, // Archetype[], inert
    pub action_sounds: Value,
    pub encounter_table: Value,
    pub chat_policy: Value,
    pub av_policy: Value,
    pub mechanics: Vec<MechanicSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignSnapshot {
    pub schema_version: i64,
    pub campaign: CampaignCoreSnapshot,
    pub rooms: Vec<RoomSnapshot>,
    pub exits: Vec<ExitSnapshot>,
    pub characters: Vec<CharacterSnapshot>,
    pub items: Vec<ItemSnapshot>,
    pub loot: Vec<LootSnapshot>,
    pub material_caches: Vec<MaterialCacheSnapshot>,
    pub codex: Value, // CodexEntry[], inert
}
```
Note `gm_id` is `Option<CharacterId>` always-present-nullable (not skipped). `party_ids`/`acted_this_round` are `Vec<CharacterId>` (order preserved — `activeCharacterIndex` indexes `partyIds`).

- [ ] **Step 2: Write the failing round-trip test (minimal full snapshot)**

Append to the `tests` module:
```rust
#[test]
fn full_campaign_snapshot_roundtrips() {
    let json = r#"{
      "schemaVersion":6,
      "campaign":{
        "id":"camp1","title":"Hollow House","maxRounds":20,"round":0,"started":false,
        "outcome":"ongoing","winConditions":[],"loseConditions":[],
        "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,
        "materials":{},"claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],
        "actionSounds":{},"encounterTable":{"baseChance":0,"visited":[],"formations":[]},
        "chatPolicy":{},"avPolicy":{},"mechanics":[{"key":"dread","state":{}}]
      },
      "rooms":[{"id":"r1","name":"Foyer","description":"Dusty.","exits":{},"dark":false,
        "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],
        "lightSourceIds":[],"scenes":[]}],
      "exits":[],
      "characters":[{"kind":"player","id":"c1","name":"Heir",
        "stats":{"energy":5,"sanity":7,"health":10},"actionsPerRound":2,"actionsThisRound":0,
        "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
        "history":[],"archetypeImmunities":[],
        "afflictions":{"active":{},"turnsActive":{},"shakenOff":[],"immunity":{}}}],
      "items":[],"loot":[],"materialCaches":[],"codex":[]
    }"#;
    roundtrip::<CampaignSnapshot>(json);
}
```

- [ ] **Step 3: Run the test**

Run: `cargo test -p wickedways-core world::snapshot::tests::full_campaign_snapshot_roundtrips`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core
git commit -m "feat(core): campaign-core + top-level CampaignSnapshot (phase 1 world task 4)"
```

---

### Task 5: `World` + single-pass `from_snapshot`/`to_snapshot`

**Files:**
- Extend: `crates/wickedways-core/src/world/mod.rs`

**Interfaces:**
- Consumes: all `snapshot` structs.
- Produces: `World { characters: BTreeMap<CharacterId, CharacterSnapshot>, rooms: BTreeMap<RoomId, RoomSnapshot>, items: BTreeMap<ItemId, ItemSnapshot>, loot: BTreeMap<LootId, LootSnapshot>, material_caches: BTreeMap<MaterialCacheId, MaterialCacheSnapshot>, exits: BTreeMap<ExitId, ExitSnapshot>, campaign: CampaignCoreSnapshot, codex: Value }`; `World::from_snapshot(CampaignSnapshot) -> World`; `World::to_snapshot(&self) -> CampaignSnapshot`.

Note: this sub-plan stores the snapshot structs directly in the id-keyed `World` (the id-based snapshot fields ARE the runtime reference fields). Later sub-plans introduce runtime-only state by extending these structs or wrapping them; the key/store shape is what matters now.

- [ ] **Step 1: Write the `World` + conversions**

Append to `world/mod.rs`:
```rust
use std::collections::BTreeMap;
use serde_json::Value;
use snapshot::*;

#[derive(Clone, Debug, PartialEq)]
pub struct World {
    pub characters: BTreeMap<CharacterId, CharacterSnapshot>,
    pub rooms: BTreeMap<RoomId, RoomSnapshot>,
    pub items: BTreeMap<ItemId, ItemSnapshot>,
    pub loot: BTreeMap<LootId, LootSnapshot>,
    pub material_caches: BTreeMap<MaterialCacheId, MaterialCacheSnapshot>,
    pub exits: BTreeMap<ExitId, ExitSnapshot>,
    pub campaign: CampaignCoreSnapshot,
    pub codex: Value,
}

fn item_id(i: &ItemSnapshot) -> ItemId {
    match i { ItemSnapshot::Item { id, .. } | ItemSnapshot::Key { id, .. } => id.clone() }
}

impl World {
    /// Single pass: fold each entity array into its id-keyed store. No two-pass
    /// hydration — references are ids, so there is nothing to re-wire.
    pub fn from_snapshot(s: CampaignSnapshot) -> World {
        World {
            characters: s.characters.into_iter().map(|c| (c.id.clone(), c)).collect(),
            rooms: s.rooms.into_iter().map(|r| (r.id.clone(), r)).collect(),
            items: s.items.into_iter().map(|i| (item_id(&i), i)).collect(),
            loot: s.loot.into_iter().map(|l| (l.id.clone(), l)).collect(),
            material_caches: s.material_caches.into_iter().map(|m| (m.id.clone(), m)).collect(),
            exits: s.exits.into_iter().map(|e| (e.id.clone(), e)).collect(),
            campaign: s.campaign,
            codex: s.codex,
        }
    }

    /// Emit each store as an array in id-sorted order (BTreeMap iterates sorted).
    /// The conformance gate canonicalizes the TS side to the same ordering.
    pub fn to_snapshot(&self) -> CampaignSnapshot {
        CampaignSnapshot {
            schema_version: SCHEMA_VERSION,
            campaign: self.campaign.clone(),
            rooms: self.rooms.values().cloned().collect(),
            exits: self.exits.values().cloned().collect(),
            characters: self.characters.values().cloned().collect(),
            items: self.items.values().cloned().collect(),
            loot: self.loot.values().cloned().collect(),
            material_caches: self.material_caches.values().cloned().collect(),
            codex: self.codex.clone(),
        }
    }
}
```

- [ ] **Step 2: Write the failing tests (round-trip identity + proptest)**

Append to `world/mod.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> &'static str {
        // reuse the Task 4 minimal full snapshot
        r#"{ "schemaVersion":6, "campaign":{ "id":"camp1","title":"HH","maxRounds":20,"round":0,
        "started":false,"outcome":"ongoing","winConditions":[],"loseConditions":[],
        "activeCharacterIndex":0,"partyIds":["c1"],"actedThisRound":[],"gmId":null,"materials":{},
        "claims":[],"encountered":[],"knownRecipes":[],"archetypes":[],"actionSounds":{},
        "encounterTable":{"baseChance":0,"visited":[],"formations":[]},"chatPolicy":{},"avPolicy":{},
        "mechanics":[]}, "rooms":[{"id":"r1","name":"F","description":"d","exits":{},"dark":false,
        "spawnModifier":0,"occupantIds":["c1"],"lootIds":[],"materialCacheIds":[],"lightSourceIds":[],
        "scenes":[]}], "exits":[], "characters":[{"kind":"player","id":"c1","name":"H",
        "stats":{"energy":5,"sanity":7,"health":10},"actionsPerRound":2,"actionsThisRound":0,
        "currentRoomId":"r1","inventory":{"slots":6,"itemIds":[],"keyIds":[]},"equipment":{},
        "history":[],"archetypeImmunities":[],"afflictions":{"active":{},"turnsActive":{},
        "shakenOff":[],"immunity":{}}}], "items":[],"loot":[],"materialCaches":[],"codex":[] }"#
    }

    #[test]
    fn world_roundtrip_is_value_identical() {
        let snap: CampaignSnapshot = serde_json::from_str(sample_json()).unwrap();
        let back = World::from_snapshot(snap.clone()).to_snapshot();
        // Compare as serde_json::Value (object-key-order-insensitive); arrays already single-element.
        assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&snap).unwrap());
    }

    #[test]
    fn from_then_to_preserves_entity_counts() {
        let snap: CampaignSnapshot = serde_json::from_str(sample_json()).unwrap();
        let w = World::from_snapshot(snap);
        assert_eq!(w.characters.len(), 1);
        assert_eq!(w.rooms.len(), 1);
        assert_eq!(w.to_snapshot().characters.len(), 1);
    }
}
```

- [ ] **Step 3: Run the tests**

Run: `cargo test -p wickedways-core world`
Expected: PASS. `cargo build -p wickedways-core --no-default-features` still succeeds.

- [ ] **Step 4: Commit**

```bash
git add crates/wickedways-core
git commit -m "feat(core): id-keyed World + single-pass from/to_snapshot (phase 1 world task 5)"
```

---

### Task 6: Conformance — real-campaign round-trip vs the TS engine

**Files:**
- Modify: `crates/wickedways-wasm/src/lib.rs`
- Create: `conformance/fixtures/generate-snapshots.ts` (TS fixture generator), `conformance/fixtures/*.snapshot.json` (generated output, committed), `conformance/canonical-json.ts` (comparator), `conformance/world-roundtrip.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `World::from_snapshot`/`to_snapshot`.
- Produces: WASM `roundtrip_snapshot(json: string): string`; `canonicalize(value): unknown` helper.

- [ ] **Step 1: Export the round-trip from WASM**

Append to `crates/wickedways-wasm/src/lib.rs`:
```rust
use wickedways_core::world::{snapshot::CampaignSnapshot, World};

/// Parse a CampaignSnapshot JSON, fold into the id-keyed World, and re-emit.
/// Used by the conformance harness to prove byte-faithful round-trip vs TS.
#[wasm_bindgen]
pub fn roundtrip_snapshot(json: &str) -> Result<String, JsValue> {
    let snap: CampaignSnapshot =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = World::from_snapshot(snap).to_snapshot();
    serde_json::to_string(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}
```
Ensure `wickedways-core` re-exports `world::{World, snapshot}` (add `pub use` in `lib.rs` if needed so the path resolves).

- [ ] **Step 2: Write the canonicalizer**

Create `conformance/canonical-json.ts`:
```ts
/** Canonical form for snapshot comparison: deep-sort object keys, and sort the
 *  7 top-level entity arrays by `id` (they are id-keyed sets; element order is
 *  not semantic). All other arrays keep their order (semantically ordered). */
const TOP_LEVEL_ENTITY_ARRAYS = new Set([
  "rooms", "exits", "characters", "items", "loot", "materialCaches",
]);

function sortKeys(value: unknown, keyHint?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => sortKeys(v));
    if (keyHint && TOP_LEVEL_ENTITY_ARRAYS.has(keyHint)) {
      return [...mapped].sort((a, b) => {
        const ai = (a as { id?: string }).id ?? "";
        const bi = (b as { id?: string }).id ?? "";
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k], k);
    }
    return out;
  }
  return value;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
```

- [ ] **Step 3: Write the fixture generator**

Create `conformance/fixtures/generate-snapshots.ts`. It builds each campaign at genesis and serializes via the engine's serializer, writing one JSON file per campaign. Use the existing serialize entry point (`serializeCampaign`) and the campaign assembly pattern from the serialization round-trip helpers (`src/lib/serialization/roundtrip.test-helpers.ts`) and the campaign manifests (`@wickedways/campaigns/hollow-house`, `@wickedways/seed`):
```ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
// Assemble each campaign at genesis. Mirror how the serialization round-trip
// helpers / integration tests build a campaign from its manifest builder+registry.
import { buildGenesisCampaign } from "./build-genesis"; // small local helper you write per the helpers file

const here = dirname(fileURLToPath(import.meta.url));
for (const slug of ["hollow-house", "seed"]) {
  const campaign = buildGenesisCampaign(slug);
  const snapshot = serializeCampaign(campaign);
  writeFileSync(join(here, `${slug}.snapshot.json`), JSON.stringify(snapshot, null, 2));
}
```
Write `conformance/fixtures/build-genesis.ts` by following the exact assembly used in `src/lib/serialization/roundtrip.test-helpers.ts` (it already constructs serializable campaigns). If the seed world is the simplest, start with it and add hollow-house once seed passes. Add a `fixtures:gen` script:
```json
"fixtures:gen": "tsx conformance/fixtures/generate-snapshots.ts"
```
(Use the repo's existing TS runner; if `tsx` isn't available, run via `vitest` as a one-off or `node --import tsx`. Confirm the runner before finalizing.)

- [ ] **Step 4: Write the failing conformance test**

Create `conformance/world-roundtrip.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonical } from "./canonical-json";

const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  roundtrip_snapshot: (json: string) => string;
};
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("World snapshot round-trip parity (Rust vs TS)", () => {
  for (const slug of ["seed", "hollow-house"]) {
    it(`round-trips the ${slug} genesis snapshot canonically`, () => {
      const input = readFileSync(join(fixturesDir, `${slug}.snapshot.json`), "utf8");
      const output = wasm.roundtrip_snapshot(input);
      expect(canonical(JSON.parse(output))).toBe(canonical(JSON.parse(input)));
    });
  }
});
```

- [ ] **Step 5: Generate fixtures, build wasm, run the gate**

Run:
```bash
pnpm run fixtures:gen
pnpm run wasm:build
vitest run --config conformance/vitest.config.ts conformance/world-roundtrip.test.ts
```
Expected: both fixtures round-trip to canonical equality. If a field diverges, the diff names the path — fix the corresponding struct (missing field, wrong rename, or an inert field that should be `Value`). Do NOT relax `canonical` to paper over a real field mismatch; only the documented set-ordering is canonicalized.

- [ ] **Step 6: Wire into the Phase 1 gate + commit fixtures**

Add a `checks:phase1` script chaining the Phase 0 gate plus the new suite:
```json
"checks:phase1": "cargo build -p wickedways-core --no-default-features && cargo test --workspace && pnpm run bindings:check && pnpm run test:conformance"
```
(`test:conformance` already runs all of `conformance/**`, including the new test, after `wasm:build`.) Commit the generator, comparator, test, and the committed `*.snapshot.json` fixtures:
```bash
git add conformance crates/wickedways-wasm package.json
git commit -m "test(conformance): world snapshot round-trip vs TS engine (phase 1 world task 6)"
```

---

## Self-Review

**Spec coverage (sub-plan 1 scope):**
- Stores + entity structs mirroring `serialization/types.ts` → Tasks 2–5. ✓
- Branded ids, `BTreeMap` stores → Tasks 1, 5. ✓
- serde save/snapshot format, camelCase + `skip_serializing_if` → translation rules + all struct tasks. ✓
- Single-pass `from_snapshot`/`to_snapshot` → Task 5 (explicitly no two-pass hydrate). ✓
- Snapshot round-trip conformance gate (canonical comparison, real fixtures) → Task 6. ✓
- `no_std` preserved → core builds checked in Tasks 1, 5; gate retains the no_std build. ✓
- **Out of scope, correctly absent:** ViewModel projection, mutations, cues, behavior — none appear. ✓

**Placeholder scan:** No "TBD"/"handle edge cases." Two judgment points are explicitly bounded, not vague: the inert-field set (enumerated in the translation rules) and the TS runner for fixtures (Task 6 Step 3 names the fallback). The fixture-assembly helper points at a concrete existing file (`roundtrip.test-helpers.ts`) to mirror. ✓

**Type consistency:** `World` field/store names and the `snapshot` struct/field names are used identically across Tasks 1–6; `roundtrip_snapshot` (Task 6) matches the `World::from_snapshot`/`to_snapshot` produced in Task 5; `CharacterKind`/tagged `ItemSnapshot` serde reprs match the TS discriminators. Optional vs always-present-nullable fields (`currentRoomId`/`gmId` kept as `null`; `archetypeId` etc. omitted) are called out where they occur. ✓

**One flagged risk for the implementer/reviewer:** Task 6's fixture assembly (`build-genesis.ts`) is the least-specified step because it depends on the existing campaign-assembly API; it is deliberately pointed at `roundtrip.test-helpers.ts` to copy. If that helper doesn't expose a genesis build cleanly, the implementer should report it rather than improvise a divergent assembly.
