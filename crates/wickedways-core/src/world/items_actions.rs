//! Equipment item actions: `equip` and `unequip` on `World`.
//! Mirrors `character.ts` `:685-747` (equip) and `:756-773` (unequip).
//!
//! Both operations are **free** — no budget tick, no history entry.
//!
//! Visibility-flip note: we compute `is_lit` before/after and emit a
//! `{ kind: "visibility", room, lit }` cue if it changes. In sub-plan 3b
//! `is_lit = !dark || !light_source_ids.is_empty()` (sub-plan 3a definition)
//! does NOT yet depend on occupant-carried or equipped light, so equipping a
//! light-emitting item will NOT flip `is_lit` here.
//! TODO(sub-plan 4): widen `is_lit` to include equipped/carried light sources,
//! at which point the before/after check here will begin emitting cues when a
//! light item is equipped/unequipped.

use alloc::string::ToString;
use alloc::vec::Vec;

use crate::error::ProceduralViolation;
use crate::presentation::{EntityRef, PresentationCue};
use crate::world::descriptor::{Catalog, ItemType};
use crate::world::equipment::{slot_kind_of, DEFAULT_EQUIPMENT_SLOTS, LEFT_HAND, RIGHT_HAND};
use crate::world::ids::{CharacterId, ItemId};
use crate::world::resolve::resolve_item;
use crate::world::World;

impl World {
    /// Equip `item` on `actor`. Free — no budget tick, no history.
    ///
    /// Logic mirrors `character.ts:685-747` exactly:
    /// 1. Item must be in `inventory.item_ids` (else `ProceduralViolation`).
    /// 2. `resolved.properties.equippable` must be true (else throw).
    /// 3. `resolved.slot` must be `Some` (else throw).
    /// 4. If already equipped, unequip first (suppresses intermediate visibility cue).
    /// 5. Two-handed weapon: clear both hands, set both; emit one net visibility cue.
    /// 6. Else: pick first free eligible slot in canonical order, else displace
    ///    `eligible[0]`; auto-swap if occupied; emit one net visibility cue.
    pub fn equip(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // --- snapshot the actor's current room for visibility flip ---
        let actor_room = self.characters.get(actor).and_then(|c| c.current_room_id.clone());
        let was_lit = actor_room.as_ref().map(|r| self.is_lit(r)).unwrap_or(true);

        // 1. Item must be in actor's inventory.item_ids
        {
            let ch = self.characters.get(actor).ok_or_else(|| {
                ProceduralViolation("Actor not found.".into())
            })?;
            if !ch.inventory.item_ids.contains(item) {
                return Err(ProceduralViolation(
                    "Cannot equip an item the character is not holding.".into(),
                ));
            }
        }

        // Resolve the item to check equippability and slot
        let item_snap = self.items.get(item).ok_or_else(|| {
            ProceduralViolation("Item snapshot not found.".into())
        })?;
        let resolved = resolve_item(item_snap, cat)?;

        // 2. Must be equippable
        if !resolved.properties.equippable {
            return Err(ProceduralViolation("Item is not equippable.".into()));
        }

        // 3. Must have a slot kind
        let item_slot_kind = resolved.slot.ok_or_else(|| {
            ProceduralViolation("Item has no equipment slot.".into())
        })?;

        // Determine two-handed from descriptor (two_handed is not in ResolvedItem; read from catalog)
        let is_two_handed = {
            let snap = self.items.get(item).unwrap(); // safe: checked above
            if let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = snap {
                cat.items.get(behavior_key).and_then(|d| d.two_handed).unwrap_or(false)
            } else {
                false
            }
        };

        // 4. If already equipped, unequip first (suppress intermediate visibility cue)
        let already_equipped = {
            let ch = self.characters.get(actor).unwrap();
            ch.equipment.values().any(|v| v == item)
        };
        if already_equipped {
            self.unequip_inner(actor, item)?;
        }

        // 5. Two-handed weapon: clear both hands, set both
        if resolved.r#type == ItemType::Weapon && is_two_handed {
            // Collect current occupants of left/right hand (may be different items)
            let left_occ = self.characters.get(actor).and_then(|c| c.equipment.get(LEFT_HAND).cloned());
            let right_occ = self.characters.get(actor).and_then(|c| c.equipment.get(RIGHT_HAND).cloned());

            // Unequip each hand's occupant (suppress intermediate cues)
            if let Some(occ) = left_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }
            if let Some(occ) = right_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }

            // Set both hands to this item
            let ch = self.characters.get_mut(actor).unwrap();
            ch.equipment.insert(LEFT_HAND.into(), item.clone());
            ch.equipment.insert(RIGHT_HAND.into(), item.clone());
        } else {
            // 6. Normal slot assignment
            // eligible = DEFAULT_EQUIPMENT_SLOTS filtered by matching slot kind
            let eligible: Vec<&str> = DEFAULT_EQUIPMENT_SLOTS
                .iter()
                .copied()
                .filter(|s| slot_kind_of(s) == Some(item_slot_kind))
                .collect();

            if eligible.is_empty() {
                return Err(ProceduralViolation("Character has no slot for this item.".into()));
            }

            // First free eligible slot in canonical order, else displace eligible[0]
            let chosen_slot: &str = {
                let ch = self.characters.get(actor).unwrap();
                eligible.iter().find(|&&s| !ch.equipment.contains_key(s)).copied()
                    .unwrap_or(eligible[0])
            };
            let chosen_slot = chosen_slot.to_string(); // own the string before mutable borrow

            // Auto-swap: if chosen slot has a different occupant, unequip it first
            let current_occ = self.characters.get(actor)
                .and_then(|c| c.equipment.get(chosen_slot.as_str()).cloned());
            if let Some(occ) = current_occ {
                if &occ != item {
                    self.unequip_inner(actor, &occ)?;
                }
            }

            // Set the slot
            let ch = self.characters.get_mut(actor).unwrap();
            ch.equipment.insert(chosen_slot, item.clone());
        }

        // Emit one net visibility cue if lit state changed
        if let Some(ref room_id) = actor_room {
            let now_lit = self.is_lit(room_id);
            if now_lit != was_lit {
                let room_name = self.rooms.get(room_id).map(|r| r.name.clone()).unwrap_or_default();
                cues.push(PresentationCue::Visibility {
                    room: EntityRef { id: room_id.0.clone(), name: room_name },
                    lit: now_lit,
                });
            }
        }

        Ok(())
    }

    /// Unequip `item` from `actor`. Free — no budget tick, no history.
    ///
    /// Removes the item from every slot it occupies (a two-handed item occupies two).
    /// Mirrors `character.ts:756-773`.
    pub fn unequip(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
        _cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        let actor_room = self.characters.get(actor).and_then(|c| c.current_room_id.clone());
        let was_lit = actor_room.as_ref().map(|r| self.is_lit(r)).unwrap_or(true);

        // Validate: item held AND equipped (mirrors character.ts:756-773 — no catalog lookup)
        {
            let ch = self.characters.get(actor).ok_or_else(|| {
                ProceduralViolation("Actor not found.".into())
            })?;
            if !ch.inventory.item_ids.contains(item) {
                return Err(ProceduralViolation(
                    "Cannot unequip an item the character is not holding.".into(),
                ));
            }
            if !ch.equipment.values().any(|v| v == item) {
                return Err(ProceduralViolation("Item is not equipped.".into()));
            }
        }

        self.unequip_inner(actor, item)?;

        // Emit visibility cue if lit state changed
        if let Some(ref room_id) = actor_room {
            let now_lit = self.is_lit(room_id);
            if now_lit != was_lit {
                let room_name = self.rooms.get(room_id).map(|r| r.name.clone()).unwrap_or_default();
                cues.push(PresentationCue::Visibility {
                    room: EntityRef { id: room_id.0.clone(), name: room_name },
                    lit: now_lit,
                });
            }
        }

        Ok(())
    }

    /// Internal unequip: removes `item` from every slot it occupies. No validation,
    /// no cue emission — callers wrap this with validation and emit one net cue.
    pub(super) fn unequip_inner(
        &mut self,
        actor: &CharacterId,
        item: &ItemId,
    ) -> Result<(), ProceduralViolation> {
        let ch = self.characters.get_mut(actor).ok_or_else(|| {
            ProceduralViolation("Actor not found.".into())
        })?;
        // Remove from every slot that holds this item (two-handed spans two slots).
        ch.equipment.retain(|_, v| v != item);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::descriptor::{Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind};
    use crate::world::ids::ItemId;
    use crate::world::snapshot::{
        CharacterKind, CharacterSnapshot, InventorySnapshot, ItemSnapshot, Stats,
    };
    use crate::world::test_support::world_with_party;
    use alloc::collections::BTreeMap;
    use alloc::string::ToString;
    use serde_json::json;

    // ── helpers ────────────────────────────────────────────────────────────────

    fn iid(s: &str) -> ItemId { serde_json::from_value(json!(s)).unwrap() }
    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    fn weapon_desc(slot: SlotKind, two_handed: Option<bool>) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Weapon".into(),
            r#type: ItemType::Weapon,
            stat: crate::stats::StatType::Health,
            modifier: 2,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: true,
                usable: false,
                droppable: None,
            },
            slot: Some(slot),
            two_handed,
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

    fn accessory_desc(slot: SlotKind) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Ring".into(),
            r#type: ItemType::Accessory,
            stat: crate::stats::StatType::Energy,
            modifier: 1,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: Some(slot),
            two_handed: None,
            emits_light: None,
            max_durability: None,
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

    fn non_equippable_desc() -> ItemDescriptor {
        ItemDescriptor {
            name: "Gold Coin".into(),
            r#type: ItemType::Consumable,
            stat: crate::stats::StatType::Health,
            modifier: 0,
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
            consume_on_use: None,
            recipe: json!({}),
            teaches: json!(null),
            immunities: json!([]),
            grants_immunity: json!(null),
        }
    }

    /// Build a world with one player character and given items in their inventory.
    fn world_with_items(items: &[(&str, &str)], cat: &Catalog) -> (World, CharacterId) {
        let mut world = world_with_party(&["pc"], 10);
        let char_id = cid("pc");

        for (item_id_str, behavior_key) in items {
            let id = iid(item_id_str);
            world.items.insert(
                id.clone(),
                ItemSnapshot::Item {
                    id: id.clone(),
                    behavior_key: behavior_key.to_string(),
                    durability: Some(5),
                    modifier: 0,
                },
            );
            world.characters.get_mut(&char_id).unwrap()
                .inventory.item_ids.push(id);
        }

        // Also insert catalog-only items that have no snapshot (edge case detection)
        let _ = cat; // catalog is owned by caller
        (world, char_id)
    }

    fn simple_cat_with(key: &str, desc: ItemDescriptor) -> Catalog {
        let mut items = BTreeMap::new();
        items.insert(key.to_string(), desc);
        Catalog { items, aliases: BTreeMap::new() }
    }

    // ── tests ──────────────────────────────────────────────────────────────────

    #[test]
    fn equip_weapon_lands_in_hand_slot_and_is_free() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // First eligible hand slot in canonical DEFAULT_EQUIPMENT_SLOTS order is leftHand
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&item),
            "sword should land in leftHand (first eligible in canonical order); equipment = {:?}", ch.equipment
        );

        // Free: no budget tick, no history
        assert_eq!(ch.actions_this_round, 0, "equip should not tick budget");
        assert!(ch.history.is_empty(), "equip should not add history");

        // No visibility cue (room is not dark)
        assert!(cues.is_empty(), "no visibility cue for lit room");
    }

    #[test]
    fn equip_second_finger_ring_uses_second_eligible_slot() {
        let cat = simple_cat_with("items/ring", accessory_desc(SlotKind::Finger));
        let (mut world, char_id) = world_with_items(
            &[("ring-1", "items/ring"), ("ring-2", "items/ring")],
            &cat,
        );

        let ring1 = iid("ring-1");
        let ring2 = iid("ring-2");
        let mut cues = Vec::new();

        // Equip first ring
        world.equip(&char_id, &ring1, &cat, &mut cues).unwrap();
        // Equip second ring
        world.equip(&char_id, &ring2, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // Canonical DEFAULT_EQUIPMENT_SLOTS finger order: leftIndexFinger before leftRingFinger
        assert_eq!(
            ch.equipment.get("leftIndexFinger"),
            Some(&ring1),
            "first ring should land in leftIndexFinger (canonical order); equipment = {:?}", ch.equipment
        );
        assert_eq!(
            ch.equipment.get("leftRingFinger"),
            Some(&ring2),
            "second ring should land in leftRingFinger (canonical order); equipment = {:?}", ch.equipment
        );
    }

    #[test]
    fn equip_non_equippable_item_returns_err() {
        let cat = simple_cat_with("items/coin", non_equippable_desc());
        let (mut world, char_id) = world_with_items(&[("coin-1", "items/coin")], &cat);

        let item = iid("coin-1");
        let mut cues = Vec::new();
        let result = world.equip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "non-equippable item should return Err");
    }

    #[test]
    fn equip_unheld_item_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[], &cat);

        // Item exists in world but NOT in character's inventory
        let item = iid("sword-ghost");
        world.items.insert(
            item.clone(),
            ItemSnapshot::Item {
                id: item.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.equip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unheld item should return Err");
    }

    #[test]
    fn two_handed_weapon_occupies_both_hands() {
        let cat = simple_cat_with("items/greatsword", weapon_desc(SlotKind::Hand, Some(true)));
        let (mut world, char_id) = world_with_items(&[("gs-1", "items/greatsword")], &cat);

        let item = iid("gs-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        let left = ch.equipment.get("leftHand");
        let right = ch.equipment.get("rightHand");
        assert_eq!(left, Some(&item), "two-handed should be in leftHand");
        assert_eq!(right, Some(&item), "two-handed should be in rightHand");
    }

    #[test]
    fn auto_swap_displaces_same_slot_occupant_and_occupant_stays_in_inventory() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(
            &[("sword-1", "items/sword"), ("sword-2", "items/sword")],
            &cat,
        );

        let sword1 = iid("sword-1");
        let sword2 = iid("sword-2");
        let mut cues = Vec::new();

        // Fill both hand slots
        world.equip(&char_id, &sword1, &cat, &mut cues).unwrap();
        world.equip(&char_id, &sword2, &cat, &mut cues).unwrap();

        // Now equip a third sword to force displacement
        let sword3 = iid("sword-3");
        world.items.insert(
            sword3.clone(),
            ItemSnapshot::Item {
                id: sword3.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );
        world.characters.get_mut(&char_id).unwrap().inventory.item_ids.push(sword3.clone());

        world.equip(&char_id, &sword3, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        // sword3 displaces eligible[0] = leftHand (canonical DEFAULT_EQUIPMENT_SLOTS order)
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&sword3),
            "sword3 should be in leftHand (eligible[0]); equipment = {:?}", ch.equipment
        );
        // sword1 was in leftHand (first equipped), so it is the evicted item
        assert!(
            ch.inventory.item_ids.contains(&sword1),
            "sword1 (evicted from leftHand) should still be in inventory"
        );
    }

    #[test]
    fn unequip_removes_item_from_slot() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();

        // Equip then unequip
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();
        world.unequip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        let still_equipped = ch.equipment.values().any(|v| v == &item);
        assert!(!still_equipped, "item should not be in equipment after unequip");

        // Item still in inventory
        assert!(ch.inventory.item_ids.contains(&item), "item should stay in inventory");

        // Still free
        assert_eq!(ch.actions_this_round, 0);
        assert!(ch.history.is_empty());
    }

    #[test]
    fn unequip_two_handed_frees_both_hands() {
        let cat = simple_cat_with("items/greatsword", weapon_desc(SlotKind::Hand, Some(true)));
        let (mut world, char_id) = world_with_items(&[("gs-1", "items/greatsword")], &cat);

        let item = iid("gs-1");
        let mut cues = Vec::new();

        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        // Verify both hands occupied
        {
            let ch = &world.characters[&char_id];
            assert_eq!(ch.equipment.get("leftHand"), Some(&item));
            assert_eq!(ch.equipment.get("rightHand"), Some(&item));
        }

        world.unequip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        assert!(ch.equipment.get("leftHand").is_none(), "leftHand should be free");
        assert!(ch.equipment.get("rightHand").is_none(), "rightHand should be free");
    }

    #[test]
    fn unequip_not_held_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[], &cat);

        let item = iid("sword-ghost");
        world.items.insert(
            item.clone(),
            ItemSnapshot::Item {
                id: item.clone(),
                behavior_key: "items/sword".into(),
                durability: Some(5),
                modifier: 0,
            },
        );

        let mut cues = Vec::new();
        let result = world.unequip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unequip of unheld item should return Err");
    }

    #[test]
    fn unequip_not_equipped_returns_err() {
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        // Item is in inventory but NOT equipped
        let mut cues = Vec::new();
        let result = world.unequip(&char_id, &item, &cat, &mut cues);
        assert!(result.is_err(), "unequip of non-equipped item should return Err");
    }

    #[test]
    fn equip_canonical_slot_order_lefthand_before_righthand() {
        // First hand-slot item should go to leftHand (canonical order: leftHand before rightHand)
        let cat = simple_cat_with("items/sword", weapon_desc(SlotKind::Hand, None));
        let (mut world, char_id) = world_with_items(&[("sword-1", "items/sword")], &cat);

        let item = iid("sword-1");
        let mut cues = Vec::new();
        world.equip(&char_id, &item, &cat, &mut cues).unwrap();

        let ch = &world.characters[&char_id];
        assert_eq!(
            ch.equipment.get("leftHand"),
            Some(&item),
            "first hand item should go to leftHand per canonical DEFAULT_EQUIPMENT_SLOTS order"
        );
    }
}
