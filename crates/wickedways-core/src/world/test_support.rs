//! Test helpers for constructing minimal valid `World` instances.
//! Extended by later tasks (Task 4+) as needed.
use alloc::{collections::BTreeMap, string::String, vec, vec::Vec};
use serde_json::Value;

use crate::presentation::CampaignOutcome;
use crate::world::ids::{CharacterId, ExitId, RoomId};
use crate::world::snapshot::{
    CampaignCoreSnapshot, CharacterKind, CharacterSnapshot, ExitSnapshot, InventorySnapshot,
    RoomSnapshot, SceneSnapshot, Stats,
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

/// Build a minimal `World` with:
/// - A player character "pc"/"Heir" in room "start"/"Start".
/// - A behavior-free exit "north" from "start" → room "next"/"Next"
///   (id "exit-north"). The reverse "south" exit on "next" → "start"
///   is NOT added (not required by the movement tests; the endpoint logic
///   handles either ordering).
/// - `next_dark` controls `dark` on the "next" room.
///
/// Exposes `make_north_exit_keyed` to mark the exit as behavior-keyed.
pub fn world_two_rooms(next_dark: bool) -> World {
    let pc_id = CharacterId("pc".into());
    let start_id = RoomId("start".into());
    let next_id = RoomId("next".into());
    let exit_id = ExitId("exit-north".into());

    // Character: player "Heir" in room "start"
    let pc = CharacterSnapshot {
        kind: CharacterKind::Player,
        id: pc_id.clone(),
        name: "Heir".into(),
        stats: Stats { energy: 5, sanity: 5, health: 5 },
        actions_per_round: 3,
        actions_this_round: 0,
        current_room_id: Some(start_id.clone()),
        inventory: InventorySnapshot { slots: 6, item_ids: vec![], key_ids: vec![] },
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

    // Exit: behavior-free, start[0] -> next[1]
    let exit = ExitSnapshot {
        id: exit_id.clone(),
        endpoint_ids: [start_id.clone(), next_id.clone()],
        behavior_key: None,
        name: None,
        state: Value::Object(serde_json::Map::new()),
    };

    // Room "start": not dark, has the north exit, pc is occupant
    let mut start_exits = BTreeMap::new();
    start_exits.insert("north".into(), exit_id.clone());
    let start_room = RoomSnapshot {
        id: start_id.clone(),
        name: "Start".into(),
        description: String::new(),
        exits: start_exits,
        dark: false,
        spawn_modifier: 0,
        occupant_ids: vec![pc_id.clone()],
        loot_ids: vec![],
        material_cache_ids: vec![],
        light_source_ids: vec![],
        scenes: Vec::<SceneSnapshot>::new(),
    };

    // Room "next": dark = next_dark, has the south exit back
    let mut next_exits = BTreeMap::new();
    next_exits.insert("south".into(), exit_id.clone());
    let next_room = RoomSnapshot {
        id: next_id.clone(),
        name: "Next".into(),
        description: String::new(),
        exits: next_exits,
        dark: next_dark,
        spawn_modifier: 0,
        occupant_ids: vec![],
        loot_ids: vec![],
        material_cache_ids: vec![],
        light_source_ids: vec![],
        scenes: Vec::<SceneSnapshot>::new(),
    };

    let campaign = CampaignCoreSnapshot {
        id: "test-campaign".into(),
        title: "Test".into(),
        max_rounds: 20,
        round: 0,
        started: true,
        outcome: CampaignOutcome::Ongoing,
        outcome_reason: None,
        win_conditions: Value::Array(vec![]),
        lose_conditions: Value::Array(vec![]),
        timeout_narration: None,
        ended_narration: None,
        active_character_index: 0,
        party_ids: vec![pc_id.clone()],
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

    let mut characters = BTreeMap::new();
    characters.insert(pc_id, pc);

    let mut rooms = BTreeMap::new();
    rooms.insert(start_id, start_room);
    rooms.insert(next_id, next_room);

    let mut exits = BTreeMap::new();
    exits.insert(exit_id, exit);

    World {
        characters,
        rooms,
        items: BTreeMap::new(),
        loot: BTreeMap::new(),
        material_caches: BTreeMap::new(),
        exits,
        campaign,
        codex: Value::Array(vec![]),
    }
}

impl World {
    /// Mark the north exit (id "exit-north") as behavior-keyed.
    /// Used in movement tests to verify that keyed exits return `Err`.
    pub fn make_north_exit_keyed(&mut self, key: &str) {
        let exit_id = ExitId("exit-north".into());
        if let Some(exit) = self.exits.get_mut(&exit_id) {
            exit.behavior_key = Some(key.into());
        }
    }
}
