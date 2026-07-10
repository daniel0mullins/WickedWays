# Rust Campaign Assembler (G1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `src/lib/authoring/assembler.ts` to a new Rust crate so that Rust reproduces every committed pre-begin genesis golden byte-for-byte from `description.json + catalog.json`.

**Architecture:** A new leaf crate `crates/wickedways-assemble` depends on `wickedways-core`. It exposes one function, `assemble(desc, catalog, party) -> Result<CampaignSnapshot, AssembleError>`. A validate-all pass collects every problem before constructing anything; a construct pass builds the world with content-derived ids; a seating pass installs the party. A ~30-line TypeScript emitter adds the one missing artifact (`description.json`) to the existing fixture generator, and a pure `cargo test` diffs Rust's output against the committed goldens using `serde_json::Value` equality.

**Tech Stack:** Rust 2021, `serde` / `serde_json`, `ts-rs` (feature-gated), existing `wickedways-core` snapshot + catalog types. TypeScript side: `vitest` fixture generators only.

**Spec:** `docs/superpowers/specs/2026-07-09-rust-campaign-assembler-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential conformance gate is the authority.** NEVER edit a golden, and never edit `conformance/canonical-json.ts`, to force a pass. Regenerating a golden by running the real generator is legitimate; hand-editing one is forbidden.
- **Byte-parity with the committed goldens is the acceptance criterion.** Not "close", not "semantically equal".
- **Valid oracles are only the 16 pre-begin goldens** (14 single-PC `*.genesis.json`, plus the 2 pristine `hollow-house.snapshot.json` and `seed.snapshot.json`), plus the one new two-PC fixture built in Task 8. The 31 `started: true` snapshots are NOT oracles and must never be used as such.
- **Ids are derived, never generated. The crate must not depend on `rand` or `uuid`.**
- **Every collection reaching serialization uses `BTreeMap` / `BTreeSet`, never `HashMap` / `HashSet`.** `HashMap` iteration order breaks byte-parity nondeterministically — passing locally, failing in CI, or the reverse.
- **Never `panic!`, `unwrap()`, or `expect()` on author data.** `assemble` consumes untrusted input (this is the modding trust boundary). Returning `Result` is mandatory. `unwrap()` is permitted only in tests.
- **Room names, and all conformance-fixture prompts, triggers, and descriptions, must be ASCII.** JavaScript's `Array.prototype.sort()` compares UTF-16 code units; Rust's `str: Ord` compares UTF-8 bytes. They agree on ASCII and diverge above the BMP, so a non-ASCII room name would mint a different `exit:` id in each language.
- **Do not build any of G2** — no TOML, no expression parser, no CLI ergonomics, no runtime modding. `assemble()`'s signature must not need to change when G2 lands.
- **Out of scope entirely:** multiplayer, the sync layer, Dioxus, deleting any TypeScript, presentation images.
- Work on branch `design/rust-campaign-assembler`. Never commit to `main`.

### Id derivation rules (verbatim from the TS assembler)

| entity | id | TS site |
| --- | --- | --- |
| campaign | `campaign:{title}` | `assembler.ts:199` |
| room | `room:{name}` | `:248` |
| mob | `mob:{name}` | `:233` |
| npc | `npc:{name}` | `:287` |
| cache | `cache:{name}` | `:214` |
| loot box | `loot:{name}` | `:220` |
| exit | `exit:{a}\|{b}` — the two **author-supplied room names** (`e.from`, `e.to`), sorted | `:332` |
| scene | `scene:{room}:{key}:{phase ?? "enter"}` | `:345` |
| loot content item | `loot:{name}:item#{i}` | `:223` |
| mob drop item | `mob:{name}:drop#{i}` | `:236` |
| room light item | `room:{name}:light#{i}` | `:251` |
| npc held item | `npc:{name}:item#{i}` | `:295` |
| player | `player:{name}` — **minted outside `assemble()`** in `oracle-session.ts:80` | — |

Note the item infix differs by holder: `item#`, `drop#`, `light#`. `i` is the index in the source key array, so repeated keys get distinct indices.

### Defaults (verbatim from the TS)

| field | default | site |
| --- | --- | --- |
| `opts.maxRounds` | `100` | `assembler.ts:186` |
| `opts.baseEncounterChance` | `20` | `campaign.ts:376` |
| `MobDef.inventorySlots` | `2` | `assembler.ts:237` |
| `MobDef.actionsPerRound` | `2` | `:238` |
| `RoomDef.spawnModifier` | `1` | `:260` |
| `RoomDef.dark` | `false` | `:261` |
| `LootDef.description` | `l.name` | `:226` |
| `SceneDef.phase` | `"enter"` | `:345` |
| `SceneDef.initialState` | `{}` | `:343` |
| `FormationDef.weight` | `1` | `:305` |
| `ChatPolicy` | `DEFAULT_CHAT_POLICY` (all `true`, `backfillWindow: 200`) | `src/lib/chat-policy.ts` |
| `AvPolicy` | `{ enabled: true, video: true, maxParticipants: 6 }` | `src/lib/av-policy.ts:6` |

---

## File Structure

**Create:**
- `crates/wickedways-assemble/Cargo.toml` — crate manifest; deps `wickedways-core`, `serde`, `serde_json`; optional `ts-rs`.
- `crates/wickedways-assemble/src/lib.rs` — public surface: `assemble`, `Seat`, re-exports. Nothing else.
- `crates/wickedways-assemble/src/description.rs` — `CampaignDescription` + the nine `*Def` structs. Serde + `ts(export)`. Pure data, no logic.
- `crates/wickedways-assemble/src/error.rs` — `AssembleError`, `Problem`, `Display` impls carrying the exact TS message strings.
- `crates/wickedways-assemble/src/validate.rs` — the validate-all pass. Returns `Vec<Problem>`.
- `crates/wickedways-assemble/src/ids.rs` — every id-derivation helper, in one place, unit-tested. The single source of truth for the table above.
- `crates/wickedways-assemble/src/construct.rs` — the construct pass: description + catalog → `CampaignSnapshot`.
- `crates/wickedways-assemble/src/seat.rs` — party seating (`gmId`, `partyIds`, placing PCs in `startRoom`).
- `crates/wickedways-assemble/tests/goldens.rs` — the conformance gate over the fixture corpus.
- `crates/wickedways-assemble/tests/negative.rs` — one test per `Problem` variant, ported from `assembler.test.ts`.
- `conformance/fixtures/two-pc.gen.test.ts` — generator for the new pre-begin two-PC fixture.
- `conformance/fixtures/two-pc-session.ts` — a pre-begin multi-PC oracle harness (`OracleSession` is single-PC).

**Modify:**
- `Cargo.toml` (workspace) — add the crate to `members`.
- `conformance/fixtures/facade-gen.ts` — thread the builder through and emit `<name>.description.json`.
- `conformance/fixtures/generate-snapshots.test.ts` — also emit `hollow-house.description.json` and `seed.description.json`.
- `conformance/fixtures/vitest.config.ts` — register `two-pc.gen.test.ts` in `include`.
- `package.json` — no new script; the gate rides `cargo test --workspace`.
- `.github/workflows/checks.yml` — add `cargo test -p wickedways-assemble` (it needs no wasm-pack).
- `README.md` — document the assembler and the artifact triple.

Splitting `ids.rs` out of `construct.rs` is deliberate: the id rules are the load-bearing assumption of the entire gate, and they deserve their own unit tests independent of construction.

---

## Task 1: Scaffold the crate and the `CampaignDescription` type

**Files:**
- Create: `crates/wickedways-assemble/Cargo.toml`
- Create: `crates/wickedways-assemble/src/lib.rs`
- Create: `crates/wickedways-assemble/src/description.rs`
- Modify: `Cargo.toml` (workspace `members`)

**Interfaces:**
- Consumes: nothing.
- Produces: `wickedways_assemble::description::{CampaignDescription, CampaignOpts, ArchetypeDef, RoomDef, ExitDef, MobDef, LootDef, CacheDef, NpcDef, FormationDef, SceneDef, MaterialsEntry, ConditionEntry, MechanicEntry}` — all `Serialize + Deserialize + Clone + Debug + PartialEq`.

- [ ] **Step 1: Write the failing test**

Create `crates/wickedways-assemble/src/description.rs` with only this test module at the bottom (the structs come in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The description must round-trip through the exact JSON shape the TS
    /// `CampaignTemplateDescription` produces (camelCase, `opts` nested, no `rng`).
    #[test]
    fn deserializes_a_minimal_description() {
        let json = r#"{
            "title": "T",
            "opts": {},
            "archetypes": [],
            "rooms": [{ "name": "start", "description": "entry" }],
            "startRoom": "start",
            "exits": [], "mobs": [], "loot": [], "caches": [], "npcs": [],
            "formations": [], "scenes": [], "recipes": [], "materials": [],
            "winConditions": [], "loseConditions": [], "mechanics": []
        }"#;
        let d: CampaignDescription = serde_json::from_str(json).expect("parse");
        assert_eq!(d.title, "T");
        assert_eq!(d.start_room.as_deref(), Some("start"));
        assert_eq!(d.rooms.len(), 1);
        assert_eq!(d.rooms[0].name, "start");
        assert_eq!(d.opts.max_rounds, None);
    }

    #[test]
    fn optional_room_fields_default() {
        let json = r#"{ "name": "start", "description": "entry" }"#;
        let r: RoomDef = serde_json::from_str(json).expect("parse");
        assert_eq!(r.dark, None);
        assert_eq!(r.spawn_modifier, None);
        assert!(r.lights.is_empty());
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-assemble`
Expected: FAIL — `error: no matching package named 'wickedways-assemble'` (the crate does not exist yet).

- [ ] **Step 3: Create the crate manifest and register it in the workspace**

`crates/wickedways-assemble/Cargo.toml`:

```toml
[package]
name = "wickedways-assemble"
version = "0.0.1"
edition = "2021"

[features]
default = []
# Mirrors wickedways-core: emits TS bindings via ts-rs under `cargo test --features ts`.
ts = ["dep:ts-rs", "wickedways-core/ts"]

[dependencies]
wickedways-core = { path = "../wickedways-core", features = ["std"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ts-rs = { version = "10", optional = true, features = ["no-serde-warnings"] }

# NOTE: `rand` and `uuid` are deliberately absent. Ids are derived, never generated.
# Adding either is a spec violation.
```

Modify the workspace `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/wickedways-core", "crates/wickedways-wasm", "crates/wickedways-assemble"]
```

- [ ] **Step 4: Write `description.rs`**

Put this ABOVE the test module you already created. Field-for-field mirror of `src/lib/authoring/description.ts:11-158`, minus `opts.rng` (a function, unserializable).

```rust
//! Plain-data mirror of the TypeScript `CampaignTemplateDescription`
//! (`src/lib/authoring/description.ts:118`), minus `opts.rng` — a closure, and the
//! seed reaches the engine through `Authority::new` instead.
//!
//! Rust owns this schema; TypeScript conforms. `pnpm run bindings:check` fails on drift.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(feature = "ts")]
use ts_rs::TS;

use wickedways_core::world::snapshot::Stats;

/// `Partial<Stats>` on the TS side — every field optional.
pub type PartialStats = BTreeMap<String, f64>;
/// `Partial<Record<ItemComponentType, number>>` — `src/lib/inventory.ts:49`.
pub type MaterialMap = BTreeMap<String, i64>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct CampaignOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub max_rounds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub base_encounter_chance: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ArchetypeDef {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub base_stats: Option<PartialStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub inventory_slots: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub immunities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct RoomDef {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub dark: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub spawn_modifier: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lights: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExitDef {
    pub from: String,
    pub direction: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub initial_state: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub one_way: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobDef {
    pub name: String,
    pub stats: Stats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub inventory_slots: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub actions_per_round: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drops: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub base_escape_chance: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub material_drops: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub light_averse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub natural_attack: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LootDef {
    pub name: String,
    pub room: String,
    pub items: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct CacheDef {
    pub name: String,
    pub room: String,
    pub materials: MaterialMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct NpcDef {
    pub name: String,
    pub stats: Stats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub room: Option<String>,
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct FormationDef {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub weight: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SceneDef {
    pub room: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub initial_state: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MaterialsEntry {
    pub source: String,
    pub map: MaterialMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ConditionEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub narration: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MechanicEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub config: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct CampaignDescription {
    pub title: String,
    #[serde(default)]
    pub opts: CampaignOpts,
    #[serde(default)]
    pub archetypes: Vec<ArchetypeDef>,
    #[serde(default)]
    pub rooms: Vec<RoomDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub start_room: Option<String>,
    #[serde(default)]
    pub exits: Vec<ExitDef>,
    #[serde(default)]
    pub mobs: Vec<MobDef>,
    #[serde(default)]
    pub loot: Vec<LootDef>,
    #[serde(default)]
    pub caches: Vec<CacheDef>,
    #[serde(default)]
    pub npcs: Vec<NpcDef>,
    #[serde(default)]
    pub formations: Vec<FormationDef>,
    #[serde(default)]
    pub scenes: Vec<SceneDef>,
    #[serde(default)]
    pub recipes: Vec<String>,
    #[serde(default)]
    pub materials: Vec<MaterialsEntry>,
    #[serde(default)]
    pub win_conditions: Vec<ConditionEntry>,
    #[serde(default)]
    pub lose_conditions: Vec<ConditionEntry>,
    #[serde(default)]
    pub mechanics: Vec<MechanicEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub timeout_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub ended_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub chat: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub av: Option<Value>,
}
```

Create `crates/wickedways-assemble/src/lib.rs`:

```rust
//! Campaign assembler: `description + catalog + party -> CampaignSnapshot`.
//!
//! A faithful port of `src/lib/authoring/assembler.ts`. The differential conformance
//! gate against the committed genesis goldens is the authority for correctness.
//!
//! This crate must never depend on `rand` or `uuid`: all ids are derived from content.

pub mod description;

pub use description::CampaignDescription;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p wickedways-assemble`
Expected: PASS — `test description::tests::deserializes_a_minimal_description ... ok` and `optional_room_fields_default ... ok`.

- [ ] **Step 6: Verify the whole workspace still builds and the crate has no forbidden deps**

Run: `cargo build --workspace && ! cargo tree -p wickedways-assemble | grep -qE '^\s*[|`-]*\s*(rand|uuid) ' && echo "NO rand/uuid ✓"`
Expected: builds, then prints `NO rand/uuid ✓`.

- [ ] **Step 7: Generate the TS binding and check it in**

Run: `cd crates/wickedways-assemble && TS_RS_EXPORT_DIR=../../generated/bindings cargo test --features ts export_bindings && cd ../..`
Expected: writes `generated/bindings/CampaignDescription.ts` and one file per `*Def` struct.

Then run: `git status --short generated/bindings`
Expected: new untracked `.ts` files listed.

> ts-rs emits one `export_bindings_<struct>` test per `ts(export)` type. `cargo test --features ts export_bindings` runs them all by name prefix.

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-assemble Cargo.toml generated/bindings
git commit -m "feat(assemble): scaffold crate and CampaignDescription schema

Rust owns the description schema; TypeScript conforms via generated bindings.
No rand/uuid dependency: ids are derived from content, never generated."
```

---

## Task 2: Id derivation helpers

**Files:**
- Create: `crates/wickedways-assemble/src/ids.rs`
- Modify: `crates/wickedways-assemble/src/lib.rs` (add `pub(crate) mod ids;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ids::{campaign_id, room_id, mob_id, npc_id, cache_id, loot_id, exit_id, scene_id, loot_item_id, mob_drop_id, room_light_id, npc_item_id, player_id}` — all `fn(...) -> String`.

This is the load-bearing assumption of the entire gate, so it gets its own module and its own tests.

- [ ] **Step 1: Write the failing test**

Create `crates/wickedways-assemble/src/ids.rs` containing ONLY this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_entity_ids() {
        assert_eq!(campaign_id("Crypt"), "campaign:Crypt");
        assert_eq!(room_id("start"), "room:start");
        assert_eq!(mob_id("goblin"), "mob:goblin");
        assert_eq!(npc_id("Keeper"), "npc:Keeper");
        assert_eq!(cache_id("vein"), "cache:vein");
        assert_eq!(loot_id("chest"), "loot:chest");
        assert_eq!(player_id("Ada"), "player:Ada");
    }

    /// `exit:${[from, to].sort().join("|")}` over AUTHOR ROOM NAMES, not room ids.
    /// assembler.test.ts:100 asserts exactly "exit:next|start" for start->next.
    #[test]
    fn exit_id_sorts_author_room_names() {
        assert_eq!(exit_id("start", "next"), "exit:next|start");
        assert_eq!(exit_id("next", "start"), "exit:next|start");
        // hollow-house: `Foyer --south--> Cellar` serializes as exit:Cellar|Foyer
        assert_eq!(exit_id("Foyer", "Cellar"), "exit:Cellar|Foyer");
        // ...while `Foyer --north--> Hall` serializes as exit:Foyer|Hall
        assert_eq!(exit_id("Foyer", "Hall"), "exit:Foyer|Hall");
    }

    #[test]
    fn scene_id_defaults_phase_to_enter() {
        assert_eq!(scene_id("start", "intro", None), "scene:start:intro:enter");
        assert_eq!(scene_id("start", "intro", Some("exit")), "scene:start:intro:exit");
    }

    /// The infix differs by holder: item# / drop# / light#. Four rules, not one.
    #[test]
    fn item_ids_are_positional_and_holder_specific() {
        assert_eq!(loot_item_id("chest", 0), "loot:chest:item#0");
        assert_eq!(loot_item_id("chest", 1), "loot:chest:item#1");
        assert_eq!(mob_drop_id("goblin", 0), "mob:goblin:drop#0");
        assert_eq!(room_light_id("next", 0), "room:next:light#0");
        assert_eq!(npc_item_id("Keeper", 0), "npc:Keeper:item#0");
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-assemble ids::`
Expected: FAIL — `cannot find function 'campaign_id' in this scope` (and siblings).

- [ ] **Step 3: Write the implementation**

Put this ABOVE the test module in `ids.rs`:

```rust
//! Content-derived id minting. The single source of truth for every id shape.
//!
//! Ported verbatim from `src/lib/authoring/assembler.ts`. These rules are the
//! load-bearing assumption of the conformance gate: get one wrong and the byte
//! diff fires. No randomness, no uuids — an id is a pure function of content.

pub fn campaign_id(title: &str) -> String { format!("campaign:{title}") }
pub fn room_id(name: &str) -> String { format!("room:{name}") }
pub fn mob_id(name: &str) -> String { format!("mob:{name}") }
pub fn npc_id(name: &str) -> String { format!("npc:{name}") }
pub fn cache_id(name: &str) -> String { format!("cache:{name}") }
pub fn loot_id(name: &str) -> String { format!("loot:{name}") }

/// `player:{name}` — minted OUTSIDE the TS assembler (`oracle-session.ts:80`),
/// folded in here because this crate's `assemble` also seats the party.
pub fn player_id(name: &str) -> String { format!("player:{name}") }

/// `exit:${[from, to].sort().join("|")}` (assembler.ts:332) over the two
/// AUTHOR-SUPPLIED ROOM NAMES — not room ids, and not `from|to` order.
///
/// JS `Array.prototype.sort()` compares UTF-16 code units; `str: Ord` compares UTF-8
/// bytes. They agree on ASCII and diverge above the BMP, which is why room names are
/// constrained to ASCII (see the plan's Global Constraints).
pub fn exit_id(from: &str, to: &str) -> String {
    let (a, b) = if from <= to { (from, to) } else { (to, from) };
    format!("exit:{a}|{b}")
}

/// `scene:{room}:{key}:{phase ?? "enter"}` (assembler.ts:345).
pub fn scene_id(room: &str, key: &str, phase: Option<&str>) -> String {
    format!("scene:{room}:{key}:{}", phase.unwrap_or("enter"))
}

pub fn loot_item_id(loot_name: &str, i: usize) -> String { format!("loot:{loot_name}:item#{i}") }
pub fn mob_drop_id(mob_name: &str, i: usize) -> String { format!("mob:{mob_name}:drop#{i}") }
pub fn room_light_id(room_name: &str, i: usize) -> String { format!("room:{room_name}:light#{i}") }
pub fn npc_item_id(npc_name: &str, i: usize) -> String { format!("npc:{npc_name}:item#{i}") }
```

Add to `lib.rs`:

```rust
pub(crate) mod ids;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p wickedways-assemble ids::`
Expected: PASS — 4 tests ok.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-assemble/src/ids.rs crates/wickedways-assemble/src/lib.rs
git commit -m "feat(assemble): content-derived id minting

Four distinct item-id rules (item#/drop#/light#), and exit ids sort the author
room names, not from|to. These rules are what the conformance gate rests on."
```

---

## Task 3: `AssembleError` / `Problem` and the validate-all pass

**Files:**
- Create: `crates/wickedways-assemble/src/error.rs`
- Create: `crates/wickedways-assemble/src/validate.rs`
- Create: `crates/wickedways-assemble/tests/negative.rs`
- Modify: `crates/wickedways-assemble/src/lib.rs`

**Interfaces:**
- Consumes: `description::CampaignDescription`; `wickedways_core::world::descriptor::Catalog`.
- Produces:
  - `error::{AssembleError, Problem}`; `AssembleError { pub problems: Vec<Problem> }`; `impl std::fmt::Display for Problem`; `impl std::error::Error for AssembleError`.
  - `validate::validate(desc: &CampaignDescription, catalog: &Catalog) -> Vec<Problem>` — returns ALL problems; empty means valid.

The TS collects into `problems: string[]` and throws one `AuthoringError` only if non-empty (`assembler.ts:39-48, :168`). Fail-fast is a spec violation: `assembler.test.ts` has a case feeding three simultaneous faults and asserting `problems.length >= 3`.

**Registry lookups become catalog lookups.** `catalog.items` is a `BTreeMap<String, ItemDescriptor>`. `catalog.behaviors` is a `BTreeMap<String, BehaviorScript>`; the `family` tag distinguishes `mechanic` / `npc` / `scene` / `exit` / `condition`. `catalog.formations` is a `BTreeMap<String, FormationDescriptor>`. Recipes have no catalog home, so `UnregisteredRecipe` is checked against `catalog.behaviors` keyed by recipe key — **verify against a golden that carries recipes (`seed.snapshot.json` has `knownRecipes`) and adjust the lookup to whatever the catalog actually exposes.**

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-assemble/tests/negative.rs`:

```rust
//! One test per `Problem` variant, ported from `src/lib/authoring/assembler.test.ts`.
//! The gate proves parity on campaigns that WORK; these prove the validation paths.

use serde_json::json;
use wickedways_assemble::{assemble, description::CampaignDescription, error::Problem, Seat};
use wickedways_core::world::descriptor::Catalog;

fn desc_from(v: serde_json::Value) -> CampaignDescription {
    serde_json::from_value(v).expect("test description must parse")
}

fn base() -> serde_json::Value {
    json!({
        "title": "T", "opts": {},
        "archetypes": [], "rooms": [{ "name": "start", "description": "entry" }],
        "startRoom": "start",
        "exits": [], "mobs": [], "loot": [], "caches": [], "npcs": [],
        "formations": [], "scenes": [], "recipes": [], "materials": [],
        "winConditions": [], "loseConditions": [], "mechanics": []
    })
}

fn problems(v: serde_json::Value) -> Vec<Problem> {
    match assemble(&desc_from(v), &Catalog::default(), &[]) {
        Err(e) => e.problems,
        Ok(_) => vec![],
    }
}

#[test]
fn duplicate_room_name() {
    let mut v = base();
    v["rooms"] = json!([
        { "name": "start", "description": "a" },
        { "name": "start", "description": "b" }
    ]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::DuplicateName { kind: "room", name } if name == "start")));
}

#[test]
fn undefined_start_room() {
    let mut v = base();
    v["startRoom"] = json!("ghost");
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UndefinedRoom { ctx, room } if ctx == "startRoom" && room == "ghost")));
}

#[test]
fn exit_references_undefined_room() {
    let mut v = base();
    v["exits"] = json!([{ "from": "start", "direction": "north", "to": "nowhere" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UndefinedRoom { room, .. } if room == "nowhere")));
}

/// assembler.test.ts "collects ALL validation problems into one AuthoringError":
/// three simultaneous faults must all appear. Fail-fast would return only one.
#[test]
fn collects_all_problems_not_just_the_first() {
    let mut v = base();
    v["rooms"] = json!([
        { "name": "start", "description": "a" },
        { "name": "start", "description": "b" }
    ]);
    v["startRoom"] = json!("ghost");
    v["exits"] = json!([{ "from": "start", "direction": "north", "to": "nowhere" }]);
    assert!(problems(v).len() >= 3, "expected >= 3 problems, got fewer (fail-fast bug)");
}

#[test]
fn unregistered_item_key_on_loot() {
    let mut v = base();
    v["loot"] = json!([{ "name": "chest", "room": "start", "items": ["missing-item"] }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredItem { key, .. } if key == "missing-item")));
}

#[test]
fn unregistered_npc_behavior_key() {
    let mut v = base();
    v["npcs"] = json!([{ "name": "Keeper", "stats": { "health": 1.0, "sanity": 1.0, "energy": 1.0 },
                         "room": "start", "behavior": "missing" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredNpc { key, .. } if key == "missing")));
}

#[test]
fn npc_references_undefined_room() {
    let mut v = base();
    v["npcs"] = json!([{ "name": "Keeper", "stats": { "health": 1.0, "sanity": 1.0, "energy": 1.0 },
                         "room": "nowhere", "behavior": "sage" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UndefinedRoom { room, .. } if room == "nowhere")));
}

#[test]
fn unregistered_scene_key() {
    let mut v = base();
    v["scenes"] = json!([{ "room": "start", "key": "missing" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredScene { key } if key == "missing")));
}

#[test]
fn unregistered_formation_key() {
    let mut v = base();
    v["formations"] = json!([{ "key": "missing" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredFormation { key } if key == "missing")));
}

#[test]
fn unregistered_exit_behavior_key() {
    let mut v = base();
    v["rooms"] = json!([{ "name": "start", "description": "a" }, { "name": "next", "description": "b" }]);
    v["exits"] = json!([{ "from": "start", "direction": "north", "to": "next", "behaviorKey": "missing" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredExit { key, .. } if key == "missing")));
}

#[test]
fn duplicate_and_unregistered_mechanics() {
    let mut v = base();
    v["mechanics"] = json!([{ "key": "doom" }, { "key": "doom" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::DuplicateMechanic { key } if key == "doom")));
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredMechanic { key } if key == "doom")));
}

/// Conditions live in the catalog under `family: "victory"` (verified against the
/// hollow-house keys reached-attic-with-journal / sanity-zero / party-down).
#[test]
fn unregistered_condition_keys() {
    let mut v = base();
    v["winConditions"] = json!([{ "key": "missing-win" }]);
    v["loseConditions"] = json!([{ "key": "missing-lose" }]);
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredCondition { ctx, key } if ctx == "winWhen" && key == "missing-win")));
    assert!(ps.iter().any(|p| matches!(p, Problem::UnregisteredCondition { ctx, key } if ctx == "loseWhen" && key == "missing-lose")));
}

// NOTE: there is no `unregistered_recipe_key` test. The catalog has no recipe registry,
// so the check has no Rust counterpart in G1. See "Deliberate divergences".

#[test]
fn chat_backfill_window_below_one() {
    let mut v = base();
    v["chat"] = json!({ "enabled": true, "whisper": true, "edit": true, "reactions": true,
                        "readReceipts": true, "typing": true, "backfillWindow": 0 });
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::ChatBackfillWindow { got: 0 })));
}

#[test]
fn av_max_participants_below_one() {
    let mut v = base();
    v["av"] = json!({ "enabled": true, "video": true, "maxParticipants": 0 });
    let ps = problems(v);
    assert!(ps.iter().any(|p| matches!(p, Problem::AvMaxParticipants { got: 0 })));
}

/// The modding trust boundary: malformed author data must never panic.
#[test]
fn never_panics_on_hostile_input() {
    let v = json!({ "title": "T", "opts": {},
        "rooms": [{ "name": "start", "description": "a" }],
        "startRoom": "nope",
        "exits": [{ "from": "x", "direction": "sideways", "to": "y" }],
        "mobs": [], "loot": [], "caches": [], "npcs": [], "archetypes": [],
        "formations": [], "scenes": [], "recipes": [], "materials": [],
        "winConditions": [], "loseConditions": [], "mechanics": [] });
    let _ = assemble(&desc_from(v), &Catalog::default(), &[]); // must return Err, not panic
}
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p wickedways-assemble --test negative`
Expected: FAIL to compile — `cannot find function 'assemble'`, `unresolved import wickedways_assemble::error`.

- [ ] **Step 3: Write `error.rs`**

```rust
//! Aggregated authoring errors. Mirrors `AuthoringError` (`src/lib/authoring/errors.ts`):
//! the validate pass collects EVERY problem and reports them together.
//!
//! `assemble` consumes untrusted author data. Nothing here may panic.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    DuplicateName { kind: &'static str, name: String },
    UndefinedRoom { ctx: String, room: String },
    UnregisteredItem { ctx: String, key: String },
    // NOTE: no `UnregisteredRecipe` in G1 — the catalog carries no recipe registry.
    // See "Deliberate divergences".
    UnregisteredCondition { ctx: String, key: String },
    UnregisteredScene { key: String },
    UnregisteredExit { from: String, to: String, key: String },
    UnregisteredFormation { key: String },
    UnregisteredNpc { npc: String, key: String },
    DuplicateMechanic { key: String },
    UnregisteredMechanic { key: String },
    ChatBackfillWindow { got: i64 },
    AvMaxParticipants { got: i64 },
}

impl fmt::Display for Problem {
    /// Message strings are copied verbatim from `assembler.ts` so the CLI reads the
    /// same as the TS authoring errors did. They are NOT byte-compared by the gate.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::DuplicateName { kind, name } => write!(f, "Duplicate {kind} name '{name}'."),
            Problem::UndefinedRoom { ctx, room } => write!(f, "{ctx} references undefined room '{room}'."),
            Problem::UnregisteredItem { ctx, key } => write!(f, "{ctx} references unregistered item key '{key}'."),
            Problem::UnregisteredCondition { ctx, key } => write!(f, "{ctx} references unregistered condition key '{key}'."),
            Problem::UnregisteredScene { key } => write!(f, "scene references unregistered scene key '{key}'."),
            Problem::UnregisteredExit { from, to, key } => write!(f, "exit from '{from}' to '{to}' references unregistered exit key '{key}'."),
            Problem::UnregisteredFormation { key } => write!(f, "formation references unregistered formation key '{key}'."),
            Problem::UnregisteredNpc { npc, key } => write!(f, "npc '{npc}' references unregistered npc key '{key}'."),
            Problem::DuplicateMechanic { key } => write!(f, "useMechanic key '{key}' is duplicated."),
            Problem::UnregisteredMechanic { key } => write!(f, "useMechanic references unregistered mechanic key '{key}'."),
            Problem::ChatBackfillWindow { got } => write!(f, "chat.backfillWindow must be >= 1 (got {got})."),
            Problem::AvMaxParticipants { got } => write!(f, "av.maxParticipants must be >= 1 (got {got})."),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssembleError {
    pub problems: Vec<Problem>,
}

impl fmt::Display for AssembleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "campaign failed to assemble ({} problems):", self.problems.len())?;
        for p in &self.problems {
            writeln!(f, "  - {p}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AssembleError {}
```

- [ ] **Step 4: Write `validate.rs`**

Order matches `assembler.ts:51-166` exactly. Reference the TS for each block.

```rust
//! The validate-all pass (`assembler.ts:38-168`). Collects EVERY problem; never
//! short-circuits. Registry lookups become catalog lookups.

use std::collections::BTreeSet;

use wickedways_core::world::descriptor::Catalog;

use crate::description::CampaignDescription;
use crate::error::Problem;

/// Does `catalog.behaviors` hold `key` with the given `family` tag?
fn has_behavior(catalog: &Catalog, key: &str, family: &str) -> bool {
    catalog
        .behaviors
        .get(key)
        .is_some_and(|b| behavior_family(b) == family)
}

/// `BehaviorScript` is an externally-tagged union with a `family` field.
/// Serializing to `Value` and reading the tag keeps this independent of the AST's
/// internal Rust shape.
fn behavior_family(b: &wickedways_core::script::ast::BehaviorScript) -> String {
    serde_json::to_value(b)
        .ok()
        .and_then(|v| v.get("family").and_then(|f| f.as_str().map(str::to_owned)))
        .unwrap_or_default()
}

pub fn validate(desc: &CampaignDescription, catalog: &Catalog) -> Vec<Problem> {
    let mut problems = Vec::new();

    // ---- duplicate names (assembler.ts:42-55) ----
    let mut dup = |kind: &'static str, names: Vec<&str>, problems: &mut Vec<Problem>| {
        let mut seen = BTreeSet::new();
        for n in names {
            if !seen.insert(n) {
                problems.push(Problem::DuplicateName { kind, name: n.to_owned() });
            }
        }
    };
    dup("room", desc.rooms.iter().map(|r| r.name.as_str()).collect(), &mut problems);
    dup("mob", desc.mobs.iter().map(|m| m.name.as_str()).collect(), &mut problems);
    dup("loot", desc.loot.iter().map(|l| l.name.as_str()).collect(), &mut problems);
    dup("cache", desc.caches.iter().map(|c| c.name.as_str()).collect(), &mut problems);
    dup("npc", desc.npcs.iter().map(|n| n.name.as_str()).collect(), &mut problems);

    let room_names: BTreeSet<&str> = desc.rooms.iter().map(|r| r.name.as_str()).collect();
    let mut require_room = |ctx: String, name: &str, problems: &mut Vec<Problem>| {
        if !room_names.contains(name) {
            problems.push(Problem::UndefinedRoom { ctx, room: name.to_owned() });
        }
    };

    // ---- room references (assembler.ts:63-72) ----
    if let Some(sr) = &desc.start_room {
        require_room("startRoom".into(), sr, &mut problems);
    }
    for e in &desc.exits {
        require_room("exit.from".into(), &e.from, &mut problems);
        require_room("exit.to".into(), &e.to, &mut problems);
    }
    for m in &desc.mobs {
        if let Some(r) = &m.room { require_room(format!("mob '{}'", m.name), r, &mut problems); }
    }
    for l in &desc.loot { require_room(format!("loot '{}'", l.name), &l.room, &mut problems); }
    for c in &desc.caches { require_room(format!("cache '{}'", c.name), &c.room, &mut problems); }
    for n in &desc.npcs {
        if let Some(r) = &n.room { require_room(format!("npc '{}'", n.name), r, &mut problems); }
    }
    for s in &desc.scenes { require_room(format!("scene '{}'", s.key), &s.room, &mut problems); }

    // ---- item keys (assembler.ts:75-93) ----
    let mut require_item = |ctx: String, k: &str, problems: &mut Vec<Problem>| {
        if !catalog.items.contains_key(k) {
            problems.push(Problem::UnregisteredItem { ctx, key: k.to_owned() });
        }
    };
    for m in &desc.mobs {
        for k in &m.drops { require_item(format!("mob '{}' drop", m.name), k, &mut problems); }
    }
    for l in &desc.loot {
        for k in &l.items { require_item(format!("loot '{}' item", l.name), k, &mut problems); }
    }
    for r in &desc.rooms {
        for k in &r.lights { require_item(format!("room '{}' light", r.name), k, &mut problems); }
    }
    for n in &desc.npcs {
        for k in &n.holds { require_item(format!("npc '{}' holds", n.name), k, &mut problems); }
    }

    // ---- recipes (assembler.ts:95-101) ----
    // DELIBERATE DIVERGENCE: the catalog carries no recipe registry (its keys are only
    // items/aliases/behaviors/formations), so the TS `registry.recipe(k)` existence check
    // has no Rust counterpart. Genesis is unaffected: `knownRecipes` is populated straight
    // from `desc.recipes`. See "Deliberate divergences" at the end of this plan.

    // ---- conditions (assembler.ts:103-111) ----
    // Conditions are the "victory" behavior family, NOT "condition". Verified: the
    // hollow-house win/lose keys (reached-attic-with-journal, sanity-zero, party-down)
    // are all `family: "victory"` in the catalog.
    for (ctx, list) in [("winWhen", &desc.win_conditions), ("loseWhen", &desc.lose_conditions)] {
        for c in list {
            if !has_behavior(catalog, &c.key, "victory") {
                problems.push(Problem::UnregisteredCondition { ctx: ctx.into(), key: c.key.clone() });
            }
        }
    }

    // ---- scenes (assembler.ts:113-119) ----
    for s in &desc.scenes {
        if !has_behavior(catalog, &s.key, "scene") {
            problems.push(Problem::UnregisteredScene { key: s.key.clone() });
        }
    }

    // ---- keyed exits (assembler.ts:121-129) ----
    for e in &desc.exits {
        if let Some(k) = &e.behavior_key {
            if !has_behavior(catalog, k, "exit") {
                problems.push(Problem::UnregisteredExit {
                    from: e.from.clone(), to: e.to.clone(), key: k.clone(),
                });
            }
        }
    }

    // ---- formations (assembler.ts:131-137) ----
    for f in &desc.formations {
        if !catalog.formations.contains_key(&f.key) {
            problems.push(Problem::UnregisteredFormation { key: f.key.clone() });
        }
    }

    // ---- npc behaviors (assembler.ts:139-145) ----
    for n in &desc.npcs {
        if !has_behavior(catalog, &n.behavior, "npc") {
            problems.push(Problem::UnregisteredNpc { npc: n.name.clone(), key: n.behavior.clone() });
        }
    }

    // ---- mechanics: duplicate THEN unregistered (assembler.ts:147-158) ----
    let mut seen_mech: BTreeSet<&str> = BTreeSet::new();
    for m in &desc.mechanics {
        if !seen_mech.insert(m.key.as_str()) {
            problems.push(Problem::DuplicateMechanic { key: m.key.clone() });
        }
        if !has_behavior(catalog, &m.key, "mechanic") {
            problems.push(Problem::UnregisteredMechanic { key: m.key.clone() });
        }
    }

    // ---- policy bounds (assembler.ts:160-166) ----
    if let Some(w) = desc.chat.as_ref().and_then(|c| c.get("backfillWindow")).and_then(|v| v.as_i64()) {
        if w < 1 { problems.push(Problem::ChatBackfillWindow { got: w }); }
    }
    if let Some(n) = desc.av.as_ref().and_then(|a| a.get("maxParticipants")).and_then(|v| v.as_i64()) {
        if n < 1 { problems.push(Problem::AvMaxParticipants { got: n }); }
    }

    problems
}
```

- [ ] **Step 5: Add a temporary `assemble` that only validates**

In `lib.rs` — the construct pass arrives in Task 5:

```rust
pub mod description;
pub mod error;
pub(crate) mod ids;
pub(crate) mod validate;

pub use description::CampaignDescription;
pub use error::{AssembleError, Problem};

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::CampaignSnapshot;

/// One player seat. `archetype` mirrors `CharacterSnapshot::archetype_id`
/// (`snapshot.rs:130`) — there is no `ArchetypeId` newtype in the core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seat {
    pub name: String,
    pub archetype: Option<String>,
}

/// `description + catalog + party -> CampaignSnapshot`.
///
/// `party` may be empty (pristine genesis), one seat (single-player), or many.
/// The FIRST seat becomes GM.
pub fn assemble(
    desc: &CampaignDescription,
    catalog: &Catalog,
    party: &[Seat],
) -> Result<CampaignSnapshot, AssembleError> {
    let problems = validate::validate(desc, catalog);
    if !problems.is_empty() {
        return Err(AssembleError { problems });
    }
    let _ = party;
    unimplemented!("construct pass lands in Task 5")
}
```

- [ ] **Step 6: Run the negative tests**

Run: `cargo test -p wickedways-assemble --test negative`
Expected: all tests PASS **except** `never_panics_on_hostile_input`, which will fail on the `unimplemented!()` if that description happens to validate clean. It does not — `startRoom: "nope"` and the two undefined exit rooms produce problems, so `assemble` returns `Err` before reaching `unimplemented!()`. All 15 tests PASS.

If any fail, fix `validate.rs` — never the test, and never by loosening a `matches!` pattern.

- [ ] **Step 7: Confirm the behavior families you validate against**

The `family` tags are load-bearing. Re-derive them rather than trusting this plan:

Run:
```bash
python3 -c "
import json,glob
from collections import Counter
c=Counter()
for f in glob.glob('conformance/fixtures/*.catalog.json'):
    for k,v in json.load(open(f)).get('behaviors',{}).items(): c[v.get('family')]+=1
print(dict(c))"
```
Expected: `{'mechanic': 11, 'exit': 9, 'item': 5, 'victory': 9, 'npc': 6, 'scene': 6}`.

Note what is **absent**: there is no `condition` family (it is `victory`) and no `recipe` family at all. If the printed families differ from the above, fix `validate.rs` to match reality — never the other way round.

- [ ] **Step 8: Commit**

```bash
git add crates/wickedways-assemble/src/error.rs crates/wickedways-assemble/src/validate.rs \
        crates/wickedways-assemble/src/lib.rs crates/wickedways-assemble/tests/negative.rs
git commit -m "feat(assemble): validate-all pass with aggregated problems

Collects EVERY problem before failing, matching assembler.ts:39-48 — a fail-fast
port would silently pass the 'collects ALL problems' oracle test. Never panics on
author data: this is the modding trust boundary."
```

---

## Task 4: Emit `description.json` from the TypeScript fixture generators

**Files:**
- Modify: `conformance/fixtures/facade-gen.ts`
- Modify: `conformance/fixtures/generate-snapshots.test.ts`

**Interfaces:**
- Consumes: nothing from earlier Rust tasks.
- Produces: `conformance/fixtures/<name>.description.json` for all 14 facade fixtures plus `hollow-house.description.json` and `seed.description.json`. Consumed by Task 6's gate.

This is the one new TypeScript file's worth of work. It is deleted in sub-project F.

- [ ] **Step 1: Read the two generators**

Run: `sed -n '40,70p' conformance/fixtures/facade-gen.ts && echo '---' && cat conformance/fixtures/generate-snapshots.test.ts`
Expected: `writeFacadeFixture` writes `<name>.genesis.json`, `<name>.catalog.json`, `<name>.golden.json`. `generate-snapshots.test.ts` writes the two `.snapshot.json` files from `.toSnapshot()`.

- [ ] **Step 2: Write the failing check**

There is no unit test here; the artifact's existence is the assertion. Run:

`ls conformance/fixtures/*.description.json 2>/dev/null | wc -l`
Expected: `0` — none exist yet.

- [ ] **Step 3: Thread the description through `writeFacadeFixture`**

`writeFacadeFixture` currently receives `oracle` and `catalog`. Add a `description` parameter and one `writeFileSync`. In `conformance/fixtures/facade-gen.ts`, beside the existing genesis write:

```ts
// The description is the assembler's INPUT artifact; genesis is its output. Emitting
// it here lets the Rust assembler be gated against the genesis golden beside it.
// Note `opts.rng` is a closure and is dropped — the seed reaches the engine via
// `Authority::new` instead.
writeFileSync(
  join(here, `${name}.description.json`),
  JSON.stringify(stripRng(description), null, 2) + "\n",
);
```

And add, near the top of the file:

```ts
/** `CampaignTemplateDescription.opts.rng` is a function; strip it before serializing. */
function stripRng(d: CampaignTemplateDescription): Omit<CampaignTemplateDescription, "opts"> & {
  opts: Omit<CampaignTemplateDescription["opts"], "rng">;
} {
  const { rng: _rng, ...opts } = d.opts;
  return { ...d, opts };
}
```

Update every `writeFacadeFixture(...)` call site to pass the builder's `description`. Find them with:

Run: `grep -rln "writeFacadeFixture" conformance/fixtures/`

- [ ] **Step 4: Emit descriptions AND catalogs for the two pristine snapshots**

`hollow-house.catalog.json` and `seed.catalog.json` **do not exist** — only the facade generator writes catalogs. Task 6's gate needs them, so emit both here.

In `conformance/fixtures/generate-snapshots.test.ts`, beside each `.snapshot.json` write:

```ts
writeFileSync(
  join(here, "hollow-house.description.json"),
  JSON.stringify(stripRng(hauntedHouseTemplate().description), null, 2) + "\n",
);
// The gate needs the catalog too: it is `assemble`'s second input.
writeFileSync(
  join(here, "hollow-house.catalog.json"),
  JSON.stringify(
    catalogFromRegistry(
      hauntedHouseTemplate().registry,
      /* aliases */ {},
      hollowHouseBehaviors(),
      hollowHouseFormations(),
    ),
    null,
    2,
  ) + "\n",
);
```

(and the same pair for `seed.description.json` / `seed.catalog.json` from `seedTemplate()`). Export `stripRng` from `./facade-gen.js` and import it here. Import `catalogFromRegistry` from `@wickedways/play-runtime`.

> Read how an existing `*.gen.test.ts` calls `catalogFromRegistry` and copy its argument list exactly — the behaviors/formations factories differ per campaign, and `seed` may pass `{}` for both.

- [ ] **Step 5: Regenerate and verify**

Run: `pnpm run fixtures:gen`
Expected: passes; writes the new files.

Run: `ls conformance/fixtures/*.description.json | wc -l`
Expected: `16`.

Run: `ls conformance/fixtures/hollow-house.catalog.json conformance/fixtures/seed.catalog.json`
Expected: both exist.

Run: `python3 -c "import json; d=json.load(open('conformance/fixtures/hollow-house.description.json')); assert 'rng' not in d['opts'], 'rng leaked'; print('rooms:', len(d['rooms']), '| exits:', len(d['exits']), '| opts:', d['opts'])"`
Expected: prints counts; no assertion error.

- [ ] **Step 6: Confirm no golden changed**

Run: `git status --short conformance/fixtures/ | grep -v '^??' || echo "NO existing golden modified ✓"`
Expected: `NO existing golden modified ✓`. The only changes are new untracked `.description.json` files.

**If any existing golden shows as modified, STOP.** Do not commit. The generator change altered an output it should not have.

- [ ] **Step 7: Confirm the generator is idempotent**

Run: `pnpm run fixtures:stable`
Expected: PASS (regenerates, then `git diff --exit-code -- conformance/fixtures` is clean for tracked files).

- [ ] **Step 8: Commit**

```bash
git add conformance/fixtures
git commit -m "feat(conformance): emit description.json beside each genesis golden

The description is the assembler's input artifact; genesis is its output. This
adds the one missing artifact so the Rust assembler can be gated against the
committed goldens. opts.rng is stripped: it is a closure, and the seed reaches
the engine through Authority::new."
```

---

## Task 5: The construct pass

**Files:**
- Create: `crates/wickedways-assemble/src/construct.rs`
- Modify: `crates/wickedways-assemble/src/lib.rs`

**Interfaces:**
- Consumes: `description::*`, `ids::*`, `wickedways_core::world::descriptor::Catalog`.
- Produces: `construct::construct(desc: &CampaignDescription, catalog: &Catalog) -> Result<CampaignSnapshot, AssembleError>` — a **player-less** snapshot (`party_ids: []`, `gm_id: None`). Seating is Task 7.

Construction order is `assembler.ts:170-359` and must be preserved: win/lose conditions → mechanics → campaign core → archetypes → caches → loot → mobs → rooms → mobs-into-rooms → npcs → formations → exits → scenes → recipes → materials.

Target types are in `crates/wickedways-core/src/world/snapshot.rs`. `SCHEMA_VERSION` is `6` (`snapshot.rs:181`).

**Mechanic state is NOT a closure.** `campaign.mechanics[i].state` is exactly `catalog.behaviors[key].script.init`, verified against the goldens (`dread → {}`, `storyteller → {"seen":{}}`). Clone it in `desc.mechanics` declared order.

- [ ] **Step 1: Write the failing test**

Append to `crates/wickedways-assemble/src/construct.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::description::CampaignDescription;
    use wickedways_core::world::descriptor::Catalog;

    fn minimal() -> CampaignDescription {
        serde_json::from_value(serde_json::json!({
            "title": "Crypt", "opts": {},
            "archetypes": [], "startRoom": "start",
            "rooms": [
                { "name": "start", "description": "entry" },
                { "name": "next",  "description": "onward" }
            ],
            "exits": [{ "from": "start", "direction": "north", "to": "next" }],
            "mobs": [], "loot": [], "caches": [], "npcs": [],
            "formations": [], "scenes": [], "recipes": [], "materials": [],
            "winConditions": [], "loseConditions": [], "mechanics": []
        })).expect("parse")
    }

    #[test]
    fn builds_a_player_less_not_begun_campaign() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        assert_eq!(snap.schema_version, 6);
        assert_eq!(snap.campaign.id, "campaign:Crypt");
        assert_eq!(snap.campaign.round, 0);
        assert!(!snap.campaign.started);
        assert!(snap.campaign.party_ids.is_empty());
        assert!(snap.campaign.gm_id.is_none());
        assert_eq!(snap.campaign.max_rounds, 100); // opts.maxRounds ?? 100
    }

    /// Branded ids are transparent tuple structs — `pub struct RoomId(pub String)`
    /// (`crates/wickedways-core/src/world/ids.rs`). Access the inner string with `.0`.
    #[test]
    fn mints_content_derived_ids() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        let rooms: Vec<&str> = snap.rooms.iter().map(|r| r.id.0.as_str()).collect();
        assert_eq!(rooms, vec!["room:start", "room:next"]);
        assert_eq!(snap.exits.len(), 1);
        assert_eq!(snap.exits[0].id.0, "exit:next|start"); // sorted author names
    }

    /// A single exit is one ExitSnapshot, wired into BOTH rooms' `exits` maps
    /// (unless `oneWay`). assembler.ts:313-315 dedups by unordered endpoint pair.
    #[test]
    fn a_two_way_exit_appears_once_and_links_both_rooms() {
        let snap = construct(&minimal(), &Catalog::default()).expect("construct");
        assert_eq!(snap.exits.len(), 1);
        let start = snap.rooms.iter().find(|r| r.id.0 == "room:start").expect("start");
        assert!(start.exits.values().any(|e| e.0 == "exit:next|start"));
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-assemble construct::`
Expected: FAIL — `cannot find function 'construct' in this scope`.

- [ ] **Step 3: Implement `construct.rs`**

Write the construct pass. Every collection that reaches serialization is a `BTreeMap`/`BTreeSet`; `Vec` order follows `desc` declaration order.

Structure the module as one function per entity group, each returning its snapshot vector, and a `construct` that composes them in the TS order:

```rust
//! The construct pass (`assembler.ts:170-359`). Order is load-bearing: mechanics run
//! in declared order (it is the reducer execution order), and `Vec` ordering in the
//! snapshot must match the TS emission order or the byte diff fires.
//!
//! No randomness. No `HashMap`. No panics.

use std::collections::BTreeMap;
use serde_json::{json, Value};

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::{
    CampaignCoreSnapshot, CampaignSnapshot, CharacterKind, CharacterSnapshot, ExitSnapshot,
    InventorySnapshot, ItemSnapshot, LootSnapshot, MaterialCacheSnapshot, MechanicSnapshot,
    RoomSnapshot, SceneSnapshot, VictoryConditionSnapshot, SCHEMA_VERSION,
};

use crate::description::CampaignDescription;
use crate::error::AssembleError;
use crate::ids;

pub fn construct(
    desc: &CampaignDescription,
    catalog: &Catalog,
) -> Result<CampaignSnapshot, AssembleError> {
    // 1. win/lose conditions (assembler.ts:171-180)
    let win = desc.win_conditions.iter().map(|c| VictoryConditionSnapshot {
        key: c.key.clone(),
        narration: c.narration.clone().and_then(|v| serde_json::from_value(v).ok()),
    }).collect();
    let lose = desc.lose_conditions.iter().map(|c| VictoryConditionSnapshot {
        key: c.key.clone(),
        narration: c.narration.clone().and_then(|v| serde_json::from_value(v).ok()),
    }).collect();

    // 2. mechanics, in declared order. State = catalog.behaviors[key].script.init.
    //    (TS calls registry.mechanic(key).initialState(config); the DSL carries it as data.)
    let mechanics = desc.mechanics.iter().map(|m| MechanicSnapshot {
        key: m.key.clone(),
        state: mechanic_init(catalog, &m.key),
    }).collect();

    // 3..17: archetypes, caches, loot, mobs, rooms, npcs, formations, exits, scenes,
    //        recipes, materials — see the per-group helpers below.
    //
    // Fill these in following assembler.ts:201-357 exactly. Each helper mints its ids
    // via `crate::ids` and pushes into the snapshot's Vec in declaration order.

    todo!("implement the per-group helpers below, then assemble the CampaignSnapshot")
}

/// `campaign.mechanics[i].state` == `catalog.behaviors[key].script.init`.
/// Verified against goldens: dread -> {}, storyteller -> {"seen":{}}.
fn mechanic_init(catalog: &Catalog, key: &str) -> Value {
    catalog
        .behaviors
        .get(key)
        .and_then(|b| serde_json::to_value(b).ok())
        .and_then(|v| v.get("script").and_then(|s| s.get("init")).cloned())
        .unwrap_or_else(|| json!({}))
}
```

> **This is the one task where the plan cannot hand you finished code.** The construct pass is ~200 lines mapping 17 ordered steps of `assembler.ts:170-359` onto the snapshot structs in `snapshot.rs:10-243`. Read both side by side. The byte-parity gate in Task 6 is your oracle: it will tell you precisely which field is wrong. Work group by group, running Task 6's gate against `seed.snapshot.json` (the simplest fixture) as you go.
>
> Field-level notes drawn from the two files:
> - `CampaignCoreSnapshot`: `round: 0`, `started: false`, `outcome: CampaignOutcome::Ongoing`, `active_character_index: 0`, `acted_this_round: []`, `claims: []`, `encountered: []`, `known_recipes: []`, `materials: {}`, `action_sounds: {}`, `codex: []` at genesis (verified in the goldens).
> - `encounter_table` is `{ "baseChance": opts.baseEncounterChance ?? 20, "visited": [], "formations": [{ "behaviorKey": f.key, "weight": f.weight ?? 1 }, ...] }` — verified against `hollow-house.snapshot.json`.
> - `chat_policy` / `av_policy` default to `DEFAULT_CHAT_POLICY` / `DEFAULT_AV_POLICY` when `desc.chat` / `desc.av` are absent (see the Defaults table).
> - `archetypes` is an inert `Value` array of `{ id, name, baseStats, inventorySlots, immunities }`.
> - `ItemSnapshot` is `#[serde(tag = "kind")]` with `Item` and `Key` variants. Which variant an item becomes is decided by its `ItemDescriptor` (`key_code`/`consume_on_use` present ⇒ `Key`).
> - `RoomSnapshot.exits` is `BTreeMap<String /*direction*/, ExitId>`.
> - `ExitSnapshot.endpoint_ids` is `[RoomId; 2]`; dedup two-way exits by the unordered endpoint pair (`assembler.ts:313-315`).
> - A `CharacterSnapshot` for a mob sets `kind: CharacterKind::Mob`; for an npc `CharacterKind::Npc` plus `npc_behavior_key`. `visible` defaults `true` and is `skip_serializing_if = "is_true"`, so it is normally absent from JSON.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cargo test -p wickedways-assemble construct::`
Expected: PASS — 3 tests ok.

- [ ] **Step 5: Wire `construct` into `assemble`**

In `lib.rs`, replace the `unimplemented!()`:

```rust
pub fn assemble(
    desc: &CampaignDescription,
    catalog: &Catalog,
    party: &[Seat],
) -> Result<CampaignSnapshot, AssembleError> {
    let problems = validate::validate(desc, catalog);
    if !problems.is_empty() {
        return Err(AssembleError { problems });
    }
    let mut snap = construct::construct(desc, catalog)?;
    seat::seat_party(&mut snap, desc, catalog, party)?;   // Task 6
    Ok(snap)
}
```

For now, stub `seat::seat_party` to return `Ok(())` when `party.is_empty()` and `unimplemented!()` otherwise; Task 6 replaces it.

- [ ] **Step 6: Run the full crate suite**

Run: `cargo test -p wickedways-assemble`
Expected: PASS. `never_panics_on_hostile_input` still passes (it errors out in validate).

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-assemble/src/construct.rs crates/wickedways-assemble/src/lib.rs
git commit -m "feat(assemble): construct pass

Builds a player-less pre-begin snapshot in assembler.ts's declaration order.
Mechanic state comes from catalog.behaviors[key].script.init -- the scripted-ops
DSL already carries as data what TS computed with initialState()."
```

---

## Task 6: The conformance gate over the pristine goldens

**Files:**
- Create: `crates/wickedways-assemble/tests/goldens.rs`

**Interfaces:**
- Consumes: `assemble`, `Seat`; the `*.description.json` / `*.catalog.json` / golden triples from Task 4.
- Produces: the gate. Later tasks extend its fixture list.

**`serde_json::Value` equality gives canonical comparison for free:** `Value::Object` is a map, so equality is key-order-insensitive; `Value::Array` equality is order-sensitive. Those are exactly `canonicalize()`'s semantics. We neither import nor re-implement `conformance/canonical-json.ts` — which is edit-forbidden.

This task gates only the two **pristine** fixtures (empty party). Seated fixtures land in Task 7.

- [ ] **Step 1: Write the failing test**

Create `crates/wickedways-assemble/tests/goldens.rs`:

```rust
//! The differential conformance gate. THE AUTHORITY.
//!
//! Never edit a golden to make this pass. If Rust and the golden disagree, Rust is
//! wrong until proven otherwise, and the fix goes in the assembler.
//!
//! Only PRE-BEGIN goldens are valid oracles: `started: false`. The 31 `started: true`
//! snapshots encode `Authority::begin_campaign`'s work, not the assembler's.

use std::path::{Path, PathBuf};
use serde_json::Value;
use wickedways_assemble::{assemble, description::CampaignDescription, Seat};
use wickedways_core::world::descriptor::Catalog;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> T {
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

/// Prints the first differing JSON pointer instead of dumping 200KB of diff.
fn assert_json_eq(got: &Value, want: &Value, fixture: &str) {
    if got == want { return; }
    let mut path = String::new();
    let (g, w) = first_diff(got, want, &mut path);
    panic!(
        "byte-parity FAILED for {fixture}\n  at: {path}\n  rust: {g}\n  golden: {w}",
    );
}

fn first_diff(a: &Value, b: &Value, path: &mut String) -> (String, String) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, xv) in x {
                match y.get(k) {
                    None => return (format!("<present: {xv}>"), "<absent>".into()),
                    Some(yv) if xv != yv => {
                        path.push('/');
                        path.push_str(k);
                        return first_diff(xv, yv, path);
                    }
                    _ => {}
                }
            }
            for k in y.keys() {
                if !x.contains_key(k) {
                    path.push('/');
                    path.push_str(k);
                    return ("<absent>".into(), format!("<present: {}>", y[k]));
                }
            }
            (a.to_string(), b.to_string())
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return (format!("<len {}>", x.len()), format!("<len {}>", y.len()));
            }
            for (i, (xv, yv)) in x.iter().zip(y).enumerate() {
                if xv != yv {
                    path.push_str(&format!("/{i}"));
                    return first_diff(xv, yv, path);
                }
            }
            (a.to_string(), b.to_string())
        }
        _ => (a.to_string(), b.to_string()),
    }
}

/// Assemble `<name>.description.json` + `<name>.catalog.json` with `party`,
/// and compare to `<golden>`.
fn gate(name: &str, golden: &str, catalog_name: Option<&str>, party: &[Seat]) {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join(format!("{name}.description.json")));
    let catalog: Catalog = catalog_name
        .map(|c| read_json::<Catalog>(&dir.join(format!("{c}.catalog.json"))))
        .unwrap_or_default();
    let want: Value = read_json(&dir.join(golden));
    let got = serde_json::to_value(assemble(&desc, &catalog, party).expect("assemble")).expect("to_value");
    assert_json_eq(&got, &want, golden);
}

#[test]
fn hollow_house_pristine() {
    gate("hollow-house", "hollow-house.snapshot.json", Some("hollow-house"), &[]);
}

#[test]
fn seed_pristine() {
    gate("seed", "seed.snapshot.json", Some("seed"), &[]);
}

/// Byte-parity depends on stable iteration order. A stray `HashMap` reaching
/// serialization would make this flap.
#[test]
fn assembly_is_deterministic() {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join("hollow-house.description.json"));
    let catalog: Catalog = read_json(&dir.join("hollow-house.catalog.json"));
    let a = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("a")).expect("va");
    let b = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("b")).expect("vb");
    assert_eq!(a, b, "assemble() is not deterministic");
}
```

> `hollow-house.catalog.json` and `seed.catalog.json` are produced by Task 4 Step 4. If they are missing, go back — this gate cannot load its inputs without them.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-assemble --test goldens`
Expected: FAIL — `byte-parity FAILED for hollow-house.snapshot.json`, naming the first differing JSON pointer.

- [ ] **Step 3: Iterate the construct pass to green**

Fix `construct.rs` until both pristine gates pass. Use the reported JSON pointer to find the wrong field. Read `assembler.ts` for that entity group and mirror it exactly.

**Do not touch the goldens.** Do not relax `assert_json_eq`. If you become convinced a golden is wrong, stop and escalate — a wrong golden is a finding about the TS oracle, not licence to edit it.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p wickedways-assemble --test goldens`
Expected: PASS — `hollow_house_pristine`, `seed_pristine`, `assembly_is_deterministic`.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(assemble): gate the pristine goldens byte-for-byte

serde_json::Value equality is key-order-insensitive for objects and order-sensitive
for arrays -- exactly canonicalize()'s semantics -- so canonical comparison comes
free from the stdlib and the edit-forbidden canonical-json.ts is never touched."
```

---

## Task 7: Party seating and the 14 single-PC genesis goldens

**Files:**
- Create: `crates/wickedways-assemble/src/seat.rs`
- Modify: `crates/wickedways-assemble/src/lib.rs`, `crates/wickedways-assemble/tests/goldens.rs`

**Interfaces:**
- Consumes: `construct`'s player-less `CampaignSnapshot`; `ids::player_id`.
- Produces: `seat::seat_party(snap: &mut CampaignSnapshot, desc, catalog, party: &[Seat]) -> Result<(), AssembleError>`.

**The oracle for seating is `conformance/fixtures/oracle-session.ts:79-98`, not `assembler.ts`** — the TS assembler returns a player-less campaign. Read those twenty lines before writing this.

Seating rules, read off the goldens:

| `party` | `gm_id` | `party_ids` | `active_character_index` |
| --- | --- | --- | --- |
| `[]` | `None` | `[]` | `0` |
| `[Ada]` | `Some("player:Ada")` | `["player:Ada"]` | `0` |
| `[Ada, Ben]` | `Some("player:Ada")` | `["player:Ada","player:Ben"]` | `0` |

The first seat becomes GM. Each PC is placed in `desc.start_room` **without firing enter-scenes** (`pc.move(room, /*fireScenes*/ false)`), so it appears in that room's `occupant_ids` and carries `current_room_id`.

- [ ] **Step 1: Write the failing test**

Add to `crates/wickedways-assemble/tests/goldens.rs`:

```rust
fn ada() -> Vec<Seat> { vec![Seat { name: "Ada".into(), archetype: None }] }

/// All 14 pre-begin `*.genesis.json` goldens carry exactly one PC, `player:Ada`.
/// Each has its own catalog emitted beside it by `writeFacadeFixture`.
#[test]
fn facade_genesis_goldens_single_pc() {
    for name in [
        "caretaker", "facade-afflicted-mob", "facade-free-vs-advancing", "facade-ko-piling",
        "facade-legality", "facade-lit-entry", "facade-loot", "facade-mob-combat",
        "facade-open-fail", "facade-talk", "facade-undo", "npc-dialogue",
        "npc-foundation", "scripted-scene",
    ] {
        gate(name, &format!("{name}.genesis.json"), Some(name), &ada());
    }
}
```

> Before writing this list, confirm it against reality:
> `ls conformance/fixtures/*.genesis.json | sed 's|.*/||; s|\.genesis\.json||'`
> and confirm the PC name with
> `python3 -c "import json; print([c['id'] for c in json.load(open('conformance/fixtures/caretaker.genesis.json'))['characters'] if c['id'].startswith('player:')])"`
> Use whatever those print. Do not assume `Ada` for every fixture; some facade generators may name the PC differently. If a fixture's PC differs, pass the right `Seat` for it.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-assemble --test goldens facade_genesis`
Expected: FAIL — panics at `unimplemented!()` in the `seat_party` stub.

- [ ] **Step 3: Read the seating oracle**

Run: `sed -n '75,100p' conformance/fixtures/oracle-session.ts`
Expected: shows `new PlayerCharacter(...)`, `pc.id = \`player:${opts.playerName}\``, `pc.joinCampaign()`, optional `selectArchetype`, `pc.move(startRoom, false)`, `campaign.gm = pc`, then `serializeCampaign(campaign)` captured as `genesis` BEFORE `beginCampaign()`.

- [ ] **Step 4: Implement `seat.rs`**

```rust
//! Party seating. Oracle: `conformance/fixtures/oracle-session.ts:79-98`.
//!
//! The TS `assemble()` returns a player-less campaign; the PC is constructed, given
//! `player:{name}`, joined, optionally given an archetype, and moved into `startRoom`
//! WITHOUT firing enter-scenes — those are `begin_campaign`'s job. `campaign.gm` is
//! set to the first player. Genesis is captured before `beginCampaign()`.

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::{
    CampaignSnapshot, CharacterKind, CharacterSnapshot, InventorySnapshot,
};

use crate::description::CampaignDescription;
use crate::error::AssembleError;
use crate::{ids, Seat};

pub fn seat_party(
    snap: &mut CampaignSnapshot,
    desc: &CampaignDescription,
    catalog: &Catalog,
    party: &[Seat],
) -> Result<(), AssembleError> {
    if party.is_empty() {
        return Ok(()); // pristine genesis: gm_id None, party_ids []
    }
    // Build one CharacterSnapshot per seat, in order; push into snap.characters,
    // snap.campaign.party_ids, and the start room's occupant_ids.
    // The FIRST seat becomes gm_id.
    //
    // Archetype application (base_stats, inventory_slots, archetype_immunities) mirrors
    // `PlayerCharacter.selectArchetype`; `archetype_id` is `Option<String>`.
    todo!("implement per oracle-session.ts:79-98; the goldens gate every field")
}
```

> As with Task 5, the gate is your oracle. Run it after each field you add; the reported JSON pointer names the next thing to fix.

- [ ] **Step 5: Run the whole gate**

Run: `cargo test -p wickedways-assemble --test goldens`
Expected: PASS — pristine ×2, `facade_genesis_goldens_single_pc` (14 fixtures), determinism.

- [ ] **Step 6: Run the full workspace suite**

Run: `cargo test --workspace`
Expected: PASS. No existing core/wasm test regresses.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-assemble/src/seat.rs crates/wickedways-assemble/src/lib.rs \
        crates/wickedways-assemble/tests/goldens.rs
git commit -m "feat(assemble): party seating; 16 pre-begin goldens now byte-parity

The seating oracle is oracle-session.ts:79-98, not assembler.ts -- the TS assembler
returns a player-less campaign. First seat becomes GM; PCs are placed in startRoom
without firing enter-scenes (that is begin_campaign's job)."
```

---

## Task 8: The pre-begin two-PC fixture

**Files:**
- Create: `conformance/fixtures/two-pc-session.ts`
- Create: `conformance/fixtures/two-pc.gen.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`

**Interfaces:**
- Consumes: `assemble`, `Seat`.
- Produces: `conformance/fixtures/two-pc.{description,catalog,genesis}.json`; gates `party.len() == 2`.

`OracleSession` is single-PC (`OracleArgs.playerName: string`). `startSession` (`orchestration.ts:73-92`) loops over players but calls `beginCampaign()` and exposes no pre-begin snapshot. So this needs a small pre-begin multi-PC harness.

**This generates a NEW golden by running the real TS engine. That is legitimate.** What is forbidden is hand-editing a golden to force a pass.

- [ ] **Step 1: Write the pre-begin two-PC harness**

Create `conformance/fixtures/two-pc-session.ts`, modelled on `oracle-session.ts:79-98` but seating two PCs:

```ts
/**
 * Pre-begin two-PC oracle. `OracleSession` seats exactly one PC and `startSession`
 * calls beginCampaign(), so neither can produce a pre-begin multi-PC genesis — and a
 * pre-begin golden is the only valid oracle for the assembler.
 *
 * Mirrors oracle-session.ts:79-98, twice, then captures genesis BEFORE beginCampaign().
 */
import { assemble } from "wickedways/lib/authoring/assembler";
import { PlayerCharacter } from "wickedways/lib/character/player-character";
import { serializeCampaign } from "wickedways/lib/serialization/serialize";
import type { TemplateBuilder } from "wickedways/lib/authoring/template-builder";

export function twoPcGenesis(builder: TemplateBuilder<string, string>, names: [string, string]) {
  const { campaign, rooms } = assemble(builder.description, builder.registry);
  const start = rooms.get(builder.description.startRoom!)!;
  const pcs = names.map((name) => {
    const pc = new PlayerCharacter({ campaign, name });
    pc.joinCampaign();
    pc.move(start, /* fireScenes */ false);
    return pc;
  });
  campaign.gm = pcs[0]!;                       // first seat is GM
  return structuredClone(serializeCampaign(campaign));  // pre-begin
}
```

> `pc.id` is assigned by `PlayerCharacter`'s constructor or by the caller in `oracle-session.ts:80`. Check which; if the caller assigns it, add `pc.id = \`player:${name}\`` here to match.

- [ ] **Step 2: Write the generator**

Create `conformance/fixtures/two-pc.gen.test.ts`, following the shape of an existing `*.gen.test.ts` (read one first: `sed -n '1,40p' conformance/fixtures/facade-loot.gen.test.ts`). It must:
- build a small ASCII-only template (two rooms, one exit, no npcs) via `TemplateBuilder`,
- write `two-pc.description.json` (via the exported `stripRng` from Task 4),
- write `two-pc.catalog.json` (via `catalogFromRegistry`),
- write `two-pc.genesis.json` from `twoPcGenesis(builder, ["Ada", "Ben"])`.

All three with `JSON.stringify(x, null, 2) + "\n"`, matching the existing writers.

- [ ] **Step 3: Register it and generate**

Add `"two-pc.gen.test.ts"` to the `include` array in `conformance/fixtures/vitest.config.ts`.

Run: `pnpm run fixtures:gen`
Expected: passes; writes the three `two-pc.*.json` files.

- [ ] **Step 4: Verify the new golden is pre-begin and two-PC**

Run:
```bash
python3 -c "
import json; d=json.load(open('conformance/fixtures/two-pc.genesis.json'))
c=d['campaign']
assert c['started'] is False, 'NOT pre-begin -- invalid oracle'
assert c['partyIds']==['player:Ada','player:Ben'], c['partyIds']
assert c['gmId']=='player:Ada', c['gmId']
print('pre-begin two-PC golden OK')"
```
Expected: `pre-begin two-PC golden OK`.

Run: `git status --short conformance/fixtures/ | grep -v '^??' || echo "NO existing golden modified ✓"`
Expected: `NO existing golden modified ✓`.

- [ ] **Step 5: Write the failing gate test**

Add to `crates/wickedways-assemble/tests/goldens.rs`:

```rust
/// The only pre-begin multi-PC oracle. `combat.start.snapshot.json` has two PCs but is
/// `started: true`, so `assemble()` cannot reproduce it.
#[test]
fn two_pc_genesis_golden() {
    let party = vec![
        Seat { name: "Ada".into(), archetype: None },
        Seat { name: "Ben".into(), archetype: None },
    ];
    gate("two-pc", "two-pc.genesis.json", Some("two-pc"), &party);
}
```

- [ ] **Step 6: Run it**

Run: `cargo test -p wickedways-assemble --test goldens two_pc`
Expected: PASS. If it fails, fix `seat.rs` — most likely `party_ids` ordering or the second PC's `occupant_ids` entry.

- [ ] **Step 7: Commit**

```bash
git add conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): pre-begin two-PC fixture gates party.len()==2

combat.start.snapshot.json has two PCs but is post-begin, so it cannot gate the
assembler. This generates a pre-begin equivalent through the real TS engine --
generation, not golden-editing."
```

---

## Task 9: CI wiring, hygiene audit, and documentation

**Files:**
- Modify: `.github/workflows/checks.yml`
- Modify: `README.md`
- Modify: `package.json` (add `checks:assemble` convenience script)

**Interfaces:**
- Consumes: everything above.
- Produces: the gate running in CI.

The assembler gate needs no wasm-pack, no browser, and no vitest — so it belongs in the **fast `checks` job**, unlike the WASM conformance gate.

- [ ] **Step 1: Audit for forbidden constructs**

Run:
```bash
cd crates/wickedways-assemble
! grep -rnE "\bHashMap\b|\bHashSet\b" src/ && echo "no HashMap/HashSet ✓"
! grep -rnE "\.unwrap\(\)|\.expect\(|panic!|todo!|unimplemented!" src/ && echo "no panics in src ✓"
! grep -rqE "^(rand|uuid)\b" Cargo.toml && echo "no rand/uuid ✓"
cd ../..
```
Expected: all three ✓ lines. `unwrap`/`expect` are permitted in `tests/` and `#[cfg(test)]` modules only, so restrict the grep to `src/` as written.

**If `todo!` or `unimplemented!` still appears in `src/`, the work is not done.** Go back to Task 5 or 7.

- [ ] **Step 2: Add the convenience script**

In `package.json` `scripts`, after `checks:phase3`:

```json
"checks:assemble": "cargo test -p wickedways-assemble && pnpm run bindings:check"
```

- [ ] **Step 3: Add the gate to CI**

In `.github/workflows/checks.yml`, after the Rust toolchain setup and before `pnpm run checks`:

```yaml
      # The assembler gate is pure Rust -- no wasm-pack, no browser -- so it runs in
      # the fast job. It diffs Rust's assembled genesis against the committed goldens.
      - run: cargo test -p wickedways-assemble
```

- [ ] **Step 4: Verify the full local gate**

Run: `cargo test --workspace && pnpm run bindings:check && pnpm run fixtures:stable`
Expected: all PASS. `bindings:check` proves `generated/bindings/CampaignDescription.ts` matches the Rust schema; `fixtures:stable` proves the generators are idempotent and no golden drifted.

- [ ] **Step 5: Document it in the README**

`README.md` is the authoritative architecture doc and the project convention is to update it before calling work done. Add a subsection near the Phase 2 cutover material (`README.md:1981-2030`), covering:
- the artifact triple `description.json + catalog.json → genesis.json`;
- that `wickedways-assemble` is the Rust port of `src/lib/authoring/assembler.ts`;
- the id-derivation table (copy it from this plan's Global Constraints);
- that the assembler is gated against the **pre-begin** goldens only, and why the 31 `started: true` snapshots are not oracles;
- that `assemble()` takes a party of 0..N and the first seat becomes GM;
- the ASCII room-name constraint and the JS-vs-Rust sort rationale;
- a forward pointer: G2 adds the TOML surface and CLI without changing `assemble()`'s signature.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/checks.yml package.json README.md
git commit -m "ci(assemble): run the assembler gate in the fast checks job

Pure cargo test -- no wasm-pack, no browser. Documents the artifact triple, the
id-derivation rules, and why only pre-begin goldens are valid oracles."
```

- [ ] **Step 7: Push and open a PR**

```bash
git push -u origin design/rust-campaign-assembler
gh pr create --base main --title "feat(assemble): Rust campaign assembler (G1)" --body "..."
```

The PR body should state: the assembler now reproduces all 17 pre-begin goldens byte-for-byte; TypeScript's role in `assemble` is reduced to a build-time `description.json` emitter; nothing is deleted yet (F does that); G2 slots in without changing `assemble()`'s signature.

---

## Deliberate divergences from the TypeScript assembler

Recorded so a reviewer doesn't mistake them for bugs, and so they don't get silently lost.

**1. No `UnregisteredRecipe` validation.** `assembler.ts:95-101` checks `registry.recipe(k)` resolves. The Rust catalog has no recipe registry — its keys are only `items`, `aliases`, `behaviors`, `formations`, and the behavior families are `mechanic | exit | item | victory | npc | scene`, with no `recipe` among them.

*Genesis bytes are unaffected*: `knownRecipes` is populated straight from `desc.recipes` (verified — `seed.snapshot.json` has `knownRecipes: ["widget"]`, and `seedTemplate` declares `.recipe("widget")`). So the gate still passes.

*What is lost*: a campaign naming a nonexistent recipe key assembles cleanly and produces a `knownRecipes` entry pointing at nothing. That is acceptable in G1, where campaigns come from the trusted TS toolchain. **It is not acceptable once G2 ships modding**, because `assemble` then consumes untrusted input. Closing it means adding `recipes` to `wickedways_core::world::descriptor::Catalog` (a `BTreeMap`, `skip_serializing_if = "BTreeMap::is_empty"`, so zero churn to existing catalog goldens) and emitting it from `catalogFromRegistry`. **Track this as a G2 prerequisite.**

**2. Validation message strings are not byte-compared.** The `Display` impls reproduce the TS strings, but nothing gates them. The gate compares genesis, not error text.

**3. `assemble()` seats the party; the TypeScript one does not.** `assembler.ts` returns a player-less campaign — its own test says so. Seating lives in `oracle-session.ts:79-98` and `orchestration.ts:75`. Folding it in is what lets `assemble` produce a genesis directly, and it is why `party: &[Seat]` exists.

---

## Notes for the implementer

**The gate is the authority.** When Rust and a golden disagree, Rust is wrong until proven otherwise. If you become convinced a golden is wrong, that is a finding about the TypeScript oracle — escalate it, don't edit the file.

**Two tasks intentionally end in `todo!()` in the plan** (the construct pass in Task 5 and seating in Task 7). Those are the two places where a plan cannot usefully pre-write ~200 lines mapping one language's object graph onto another's snapshot structs. Both have an exact oracle to read (`assembler.ts:170-359` and `oracle-session.ts:79-98`) and an exact acceptance test (the byte-parity gate, which names the first differing JSON pointer). Work field by field against the gate. Task 9 Step 1 fails the build if a `todo!()` survives.

**Three facts most likely to trip you up:**
1. Item ids use three different infixes — `item#`, `drop#`, `light#` — depending on the holder.
2. `exit:` ids sort the **author-supplied room names**, not room ids, and not `from|to` order.
3. `assemble()` in TypeScript produces a **player-less** campaign; seating lives in `oracle-session.ts`, and this crate folds it in.
