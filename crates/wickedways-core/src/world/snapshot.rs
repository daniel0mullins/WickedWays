//! Serde wire structs mirroring `src/lib/serialization/types.ts` —
//! the leaf snapshots that compose a full `CampaignSnapshot`.
use alloc::{collections::BTreeMap, string::String, vec::Vec};
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
    pub exits: BTreeMap<String, ExitId>,
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
    /// `string | null` in TS — always present in JSON, serialises as `null` when None.
    pub current_room_id: Option<RoomId>,
    pub inventory: InventorySnapshot,
    /// EquipmentSlot -> itemId.
    pub equipment: BTreeMap<String, ItemId>,
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
    /// TS `baseEscapeChance?: number` — typed f64 because TS `number` can be fractional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_escape_chance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_drops: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light_averse: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_attack: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npc_behavior_key: Option<String>,
}

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
}
