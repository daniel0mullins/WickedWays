//! Plain-data authoring schema for a campaign description. There is no rng field:
//! the seed reaches the engine through `Authority::new` instead.
//!
//! Rust owns this schema; TypeScript conforms. `pnpm run bindings:check` fails on drift.
//!
//! A one-time serde primer for the attribute pattern repeated on every struct
//! below (the derives are the Rust analog of a TS interface plus its JSON codec):
//!   * `rename_all = "camelCase"` — fields are `snake_case` in Rust but
//!     camelCase on the wire (`start_room` <-> `"startRoom"`).
//!   * `Option<T>` — an optional field, like `field?: T`.
//!   * `#[serde(default)]` — a missing JSON key parses as the type's default
//!     instead of erroring (JS destructuring-with-default).
//!   * `skip_serializing_if = ...` — omit the key entirely when empty/absent,
//!     the way `JSON.stringify` drops `undefined`; this keeps committed
//!     fixtures byte-stable.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use wickedways_core::world::snapshot::Stats;

/// Stats with every field optional.
pub type PartialStats = BTreeMap<String, f64>;
/// Item-component type -> quantity.
pub type MaterialMap = BTreeMap<String, i64>;

// ---------------------------------------------------------------------------
// The root document
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// The Villain declaration. Absent (and omitted on serialize) for a
    /// villain-less campaign, so committed description fixtures stay byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub villain: Option<VillainDef>,
    /// Procedural map generation. When present, `exits` stays empty and the
    /// engine wires the room graph at `begin_campaign` (randomized spanning
    /// tree over `World.rng`). Absent (and omitted on serialize) for
    /// hand-wired campaigns, so committed fixtures stay byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_gen: Option<MapGenDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub av: Option<Value>,
}

// ---------------------------------------------------------------------------
// Building blocks, in the order the root lists them
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_encounter_chance: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchetypeDef {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_stats: Option<PartialStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_slots: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub immunities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDef {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_modifier: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lights: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitDef {
    pub from: String,
    pub direction: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub one_way: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobDef {
    pub name: String,
    pub stats: Stats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_slots: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions_per_round: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drops: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_escape_chance: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_drops: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_averse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_attack: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LootDef {
    pub name: String,
    pub room: String,
    pub items: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDef {
    pub name: String,
    pub room: String,
    pub materials: MaterialMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcDef {
    pub name: String,
    pub stats: Stats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormationDef {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneDef {
    pub room: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialsEntry {
    pub source: String,
    pub map: MaterialMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narration: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicEntry {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

/// The Villain declaration: which character plays against the heroes, and the
/// authored deck of Wicked Ways card keys (draw order fixed by the engine's
/// seeded shuffle at `begin_campaign`, not here).
///
/// `character` is either the name of a declared mob/npc (resolved mob-first),
/// or the sentinel `"@gm"` — resolved at seating to the GM's seat, for the
/// multiplayer "the GM plays the Villain" table.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VillainDef {
    pub character: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deck: Vec<String>,
}

/// Procedural map-generation config (mirrors the engine's `MapGenSnapshot`,
/// but references rooms by their author NAMES — id derivation happens in
/// `construct`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapGenDef {
    /// Loop edges beyond the spanning tree: an absolute count, or a fraction
    /// of `n - 1` when strictly between 0 and 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_connections: Option<f64>,
    /// Room pairs pinned as neighbors in every layout; each may carry an
    /// authored door (behavior/name/state), like a hand-wired exit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<RequiredExitDef>,
    /// Per-room exit cap (clamped to `2..=8` at build time; default 8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_exits_per_room: Option<i64>,
    /// Room NAMES reachable only through `required` passages (a locked crypt's
    /// keyed door stays its sole entrance in every layout).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sealed: Vec<String>,
}

/// One pinned passage of a [`MapGenDef`]: `from`/`to` are room names; the
/// door fields mirror `ExitDef` (the generator assigns the compass direction).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredExitDef {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The description must round-trip through the exact JSON shape the committed
    /// description fixtures carry (camelCase, `opts` nested, no `rng`).
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
