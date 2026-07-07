use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::descriptor::Catalog;
use crate::world::direction::Direction;
use crate::world::ids::{CharacterId, ItemId};
use crate::world::World;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    StartTurn,
    EndTurn,
    Go { dir: Direction },
    NextPlayer,
    EndCampaign,
    #[serde(rename_all = "camelCase")]
    Take { target_id: String },
    #[serde(rename_all = "camelCase")]
    Drop { target_id: String },
    #[serde(rename_all = "camelCase")]
    Open { target_id: String },
    #[serde(rename_all = "camelCase")]
    Equip { target_id: String },
    #[serde(rename_all = "camelCase")]
    Unequip { target_id: String },
    #[serde(rename_all = "camelCase")]
    Use { target_id: String },
    #[serde(rename_all = "camelCase")]
    Read { target_id: String },
    #[serde(rename_all = "camelCase")]
    Attack { target_id: String },
    #[serde(rename_all = "camelCase")]
    MechanicAction { mechanic_key: String, action_key: String },
}

pub fn apply_command(
    world: &mut World,
    cmd: Command,
    cat: &Catalog,
    opened: &mut BTreeSet<String>,
    cues: &mut Vec<PresentationCue>,
) -> Result<(), ProceduralViolation> {
    let actor = world.active_character_id()?;
    match cmd {
        Command::StartTurn => world.start_turn(&actor, cat, cues),
        Command::EndTurn => world.end_turn(&actor, cat, cues),
        Command::Go { dir } => world.go(&actor, dir, cat, cues),
        Command::NextPlayer => world.next_player(cat, cues),
        Command::EndCampaign => world.end_campaign(cues),
        Command::Take { target_id } => {
            if let Some(loot_id) = world.take(&actor, &ItemId(target_id), cat, cues)? {
                opened.insert(loot_id.0);
            }
            Ok(())
        }
        Command::Drop { target_id } => {
            world.drop_item(&actor, &ItemId(target_id), cat, cues)
        }
        Command::Use { target_id } => {
            world.use_item(&actor, &ItemId(target_id), cat, cues)
        }
        Command::Read { target_id } => {
            world.read_item(&actor, &ItemId(target_id), cat, cues)
        }
        Command::Equip { target_id } => {
            world.equip(&actor, &ItemId(target_id), cat, cues)
        }
        Command::Unequip { target_id } => {
            world.unequip(&actor, &ItemId(target_id), cat, cues)
        }
        Command::Open { target_id } => {
            opened.insert(target_id);
            Ok(())
        }
        Command::Attack { target_id } => {
            world.attack(&actor, &CharacterId(target_id), cat, cues)
        }
        Command::MechanicAction { mechanic_key, action_key } =>
            world.use_mechanic_action(&actor, &mechanic_key, &action_key, cat, cues),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeMap;
    use crate::world::descriptor::{
        Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind,
    };
    use crate::world::direction::Direction;
    use crate::world::ids::{CharacterId, LootId, RoomId};
    use crate::world::snapshot::{ItemSnapshot, LootSnapshot, RoomSnapshot};
    use crate::world::test_support::world_two_rooms;
    use crate::stats::StatType;
    use serde_json::json;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn iid(s: &str) -> ItemId { ItemId(s.into()) }
    fn lid(s: &str) -> LootId { LootId(s.into()) }
    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    fn weapon_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Sword".into(),
            r#type: ItemType::Weapon,
            stat: StatType::Health,
            modifier: 3,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None,
            },
            slot: Some(SlotKind::Hand),
            two_handed: None,
            emits_light: None,
            max_durability: Some(5),
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    fn consumable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Herb".into(),
            r#type: ItemType::Consumable,
            stat: StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: true,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: None,
            consume_on_use: Some(true),
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    fn simple_cat(key: &str, desc: ItemDescriptor) -> Catalog {
        let mut items = BTreeMap::new();
        items.insert(key.to_string(), desc);
        Catalog { items, aliases: BTreeMap::new(), behaviors: Default::default(), formations: Default::default() }
    }

    /// Build a world with a player in "room1", a loot container "loot-1" holding
    /// "item-1", and the loot in the room.
    fn world_with_loot_in_room() -> World {
        use crate::world::test_support::world_with_party;
        let mut world = world_with_party(&["pc"], 10);
        let pc_id = CharacterId("pc".into());

        // Place player in room1
        world.characters.get_mut(&pc_id).unwrap().current_room_id = Some(rid("room1"));

        // Add item to world.items
        let item_id = iid("item-1");
        world.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "items/herb".into(),
                durability: None,
                modifier: 0,
            },
        );

        // Add loot container
        let loot_id = lid("loot-1");
        world.loot.insert(loot_id.clone(), LootSnapshot {
            id: loot_id.clone(),
            description: "A sack".into(),
            capacity: 5,
            content_ids: alloc::vec![item_id],
        });

        // Add room with loot
        world.rooms.insert(rid("room1"), RoomSnapshot {
            id: rid("room1"),
            name: "Test Room".into(),
            description: alloc::string::String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone()],
            loot_ids: alloc::vec![loot_id],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        });

        world
    }

    /// Build a world with a player in "room1" holding "sword-1" in inventory.
    fn world_with_sword_in_inventory() -> World {
        use crate::world::test_support::world_with_party;
        let mut world = world_with_party(&["pc"], 10);
        let pc_id = CharacterId("pc".into());

        world.characters.get_mut(&pc_id).unwrap().current_room_id = Some(rid("room1"));

        let item_id = iid("sword-1");
        world.items.insert(
            item_id.clone(),
            ItemSnapshot::Item {
                id: item_id.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );
        world.characters.get_mut(&pc_id).unwrap().inventory.item_ids.push(item_id);

        // Add an empty room
        world.rooms.insert(rid("room1"), RoomSnapshot {
            id: rid("room1"),
            name: "Test Room".into(),
            description: alloc::string::String::new(),
            exits: BTreeMap::new(),
            dark: false,
            spawn_modifier: 0,
            occupant_ids: alloc::vec![pc_id.clone()],
            loot_ids: alloc::vec![],
            material_cache_ids: alloc::vec![],
            light_source_ids: alloc::vec![],
            scenes: alloc::vec![],
        });

        world
    }

    // ── deserialization tests ─────────────────────────────────────────────────

    #[test]
    fn take_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "take", "targetId": "i1" })
        ).unwrap();
        assert!(matches!(c, Command::Take { target_id } if target_id == "i1"));
    }

    #[test]
    fn equip_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "equip", "targetId": "i2" })
        ).unwrap();
        assert!(matches!(c, Command::Equip { target_id } if target_id == "i2"));
    }

    #[test]
    fn drop_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "drop", "targetId": "item-x" })
        ).unwrap();
        assert!(matches!(c, Command::Drop { target_id } if target_id == "item-x"));
    }

    #[test]
    fn open_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "open", "targetId": "loot-42" })
        ).unwrap();
        assert!(matches!(c, Command::Open { target_id } if target_id == "loot-42"));
    }

    #[test]
    fn unequip_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "unequip", "targetId": "sword-7" })
        ).unwrap();
        assert!(matches!(c, Command::Unequip { target_id } if target_id == "sword-7"));
    }

    #[test]
    fn use_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "use", "targetId": "herb-3" })
        ).unwrap();
        assert!(matches!(c, Command::Use { target_id } if target_id == "herb-3"));
    }

    #[test]
    fn read_command_deserializes() {
        let c: Command = serde_json::from_value(serde_json::json!({
            "kind": "read", "targetId": "item-note"
        })).unwrap();
        assert!(matches!(c, Command::Read { target_id } if target_id == "item-note"));
    }

    #[test]
    fn end_campaign_deserializes_from_json() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "endCampaign" })
        ).unwrap();
        assert!(matches!(c, Command::EndCampaign));
    }

    // ── existing tests (updated to new signature) ─────────────────────────────

    #[test]
    fn apply_go_dispatches_to_active_character() {
        let mut w = world_two_rooms(false);
        let mut cues = Vec::new();
        let mut opened = BTreeSet::new();
        apply_command(&mut w, Command::Go { dir: Direction::North }, &Catalog::default(), &mut opened, &mut cues).unwrap();
        assert_eq!(cues.len(), 1); // action move cue
    }

    #[test]
    fn command_json_tag_shape() {
        let c: Command = serde_json::from_value(
            serde_json::json!({ "kind": "go", "dir": "north" })).unwrap();
        assert!(matches!(c, Command::Go { dir: Direction::North }));
        assert!(matches!(
            serde_json::from_value::<Command>(serde_json::json!({ "kind": "nextPlayer" })).unwrap(),
            Command::NextPlayer));
    }

    // ── new dispatch tests ────────────────────────────────────────────────────

    #[test]
    fn open_command_adds_to_opened_set_no_world_mutation() {
        let mut world = world_with_loot_in_room();
        let mut cues = Vec::new();
        let mut opened: BTreeSet<String> = BTreeSet::new();

        // Before: room still has loot-1
        assert_eq!(world.loot.len(), 1);

        apply_command(
            &mut world,
            Command::Open { target_id: "loot-1".into() },
            &Catalog::default(),
            &mut opened,
            &mut cues,
        ).unwrap();

        // opened set gained the loot id
        assert!(opened.contains("loot-1"), "open should insert target_id into opened");
        // No world mutation — loot container still has its item
        assert_eq!(world.loot[&lid("loot-1")].content_ids.len(), 1);
        // No cue emitted
        assert!(cues.is_empty(), "open should emit no cue");
    }

    #[test]
    fn take_command_moves_item_to_inventory_and_auto_opens_loot_container() {
        let cat = simple_cat("items/herb", consumable_desc());
        let mut world = world_with_loot_in_room();
        let mut cues = Vec::new();
        let mut opened: BTreeSet<String> = BTreeSet::new();

        apply_command(
            &mut world,
            Command::Take { target_id: "item-1".into() },
            &cat,
            &mut opened,
            &mut cues,
        ).unwrap();

        let pc_id = CharacterId("pc".into());
        let ch = &world.characters[&pc_id];

        // Item moved to inventory
        assert!(ch.inventory.item_ids.contains(&iid("item-1")), "item-1 should be in inventory");
        // Item removed from loot
        assert!(!world.loot[&lid("loot-1")].content_ids.contains(&iid("item-1")));
        // Loot container id auto-added to opened
        assert!(opened.contains("loot-1"), "take should auto-add loot container to opened");
    }

    #[test]
    fn equip_command_equips_held_item() {
        let cat = simple_cat("items/sword", weapon_desc());
        let mut world = world_with_sword_in_inventory();
        let mut cues = Vec::new();
        let mut opened: BTreeSet<String> = BTreeSet::new();

        apply_command(
            &mut world,
            Command::Equip { target_id: "sword-1".into() },
            &cat,
            &mut opened,
            &mut cues,
        ).unwrap();

        let pc_id = CharacterId("pc".into());
        let ch = &world.characters[&pc_id];
        // Sword should be in some equipment slot
        assert!(
            ch.equipment.values().any(|id| id == &iid("sword-1")),
            "sword-1 should be in equipment after equip command; equipment = {:?}", ch.equipment
        );
    }
}
