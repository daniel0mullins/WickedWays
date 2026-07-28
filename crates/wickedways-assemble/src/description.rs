//! Plain-data authoring schema for a campaign description. There is no rng field:
//! the seed reaches the engine through `Authority::new` instead.
//!
//! Rust owns this schema; TypeScript conforms. `pnpm run bindings:check` fails on drift.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use wickedways_core::world::snapshot::Stats;

/// Stats with every field optional.
pub type PartialStats = BTreeMap<String, f64>;
/// Item-component type -> quantity.
pub type MaterialMap = BTreeMap<String, i64>;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_narration: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub av: Option<Value>,
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
