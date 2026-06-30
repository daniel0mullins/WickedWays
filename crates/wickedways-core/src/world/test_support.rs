//! Test helpers for constructing minimal valid `World` instances.
//! Extended by later tasks (Task 4+) as needed.
use alloc::{collections::BTreeMap, string::String, vec, vec::Vec};
use serde_json::Value;

use crate::presentation::CampaignOutcome;
use crate::world::ids::CharacterId;
use crate::world::snapshot::{
    CampaignCoreSnapshot, CharacterKind, CharacterSnapshot, InventorySnapshot, Stats,
};
use crate::world::World;

/// Build a minimal started `World` with the given party ids, each backed by a
/// minimal player `CharacterSnapshot` in no room. Fields: `started = true`,
/// `round = 0`, `outcome = Ongoing`, `active_character_index = 0`,
/// `acted_this_round = []`, `max_rounds = max_rounds`.
pub fn world_with_party(ids: &[&str], max_rounds: i64) -> World {
    let party_ids: Vec<CharacterId> = ids.iter().map(|s| CharacterId(String::from(*s))).collect();

    let characters: BTreeMap<CharacterId, CharacterSnapshot> = party_ids
        .iter()
        .map(|id| {
            let snap = CharacterSnapshot {
                kind: CharacterKind::Player,
                id: id.clone(),
                name: id.0.clone(),
                stats: Stats { energy: 5, sanity: 5, health: 5 },
                actions_per_round: 2,
                actions_this_round: 0,
                current_room_id: None,
                inventory: InventorySnapshot {
                    slots: 6,
                    item_ids: vec![],
                    key_ids: vec![],
                },
                equipment: BTreeMap::new(),
                history: vec![],
                archetype_immunities: Value::Array(vec![]),
                afflictions: serde_json::json!({
                    "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {}
                }),
                archetype_id: None,
                origin: None,
                base_escape_chance: None,
                material_drops: None,
                light_averse: None,
                natural_attack: None,
                npc_behavior_key: None,
            };
            (id.clone(), snap)
        })
        .collect();

    let campaign = CampaignCoreSnapshot {
        id: String::from("test-campaign"),
        title: String::from("Test Campaign"),
        max_rounds,
        round: 0,
        started: true,
        outcome: CampaignOutcome::Ongoing,
        outcome_reason: None,
        win_conditions: Value::Array(vec![]),
        lose_conditions: Value::Array(vec![]),
        timeout_narration: None,
        ended_narration: None,
        active_character_index: 0,
        party_ids,
        acted_this_round: vec![],
        gm_id: None,
        materials: serde_json::json!({}),
        claims: vec![],
        encountered: vec![],
        known_recipes: vec![],
        archetypes: Value::Array(vec![]),
        action_sounds: serde_json::json!({}),
        encounter_table: serde_json::json!({
            "baseChance": 0, "visited": [], "formations": []
        }),
        chat_policy: serde_json::json!({}),
        av_policy: serde_json::json!({}),
        mechanics: vec![],
    };

    World {
        characters,
        rooms: BTreeMap::new(),
        items: BTreeMap::new(),
        loot: BTreeMap::new(),
        material_caches: BTreeMap::new(),
        exits: BTreeMap::new(),
        campaign,
        codex: Value::Array(vec![]),
    }
}
