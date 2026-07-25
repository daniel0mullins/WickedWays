//! Item resolution: snapshot + catalog → effective item identity.
//!
//! Mirrors `hydrateItem` (inventory.ts:723-734), `[HYDRATE]` (inventory.ts:443-448),
//! and `isBroken` (inventory.ts:403-405).
//! Also provides `World::effective_stat`, mirroring `character.ts:903-913`.
use alloc::{collections::BTreeSet, format, string::String};

use crate::{
    error::ProceduralViolation,
    stats::StatType,
    world::{
        descriptor::{Catalog, ItemProperties, ItemType, Presentation, SlotKind},
        ids::CharacterId,
        snapshot::ItemSnapshot,
        World,
    },
};

/// Internal projection of a fully-resolved item: descriptor fields merged with
/// per-instance snapshot state.  Not serialized — used only inside the engine core.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedItem {
    pub id: String,
    pub name: String,
    pub r#type: ItemType,
    pub stat: StatType,
    pub modifier: i64,
    pub properties: ItemProperties,
    pub slot: Option<SlotKind>,
    pub durability: Option<i64>,
    pub max_durability: Option<i64>,
    pub is_broken: bool,
    pub lore: Option<String>,
    pub presentation: Option<Presentation>,
    pub key_code: Option<String>,
}

/// Resolve a snapshot against the campaign catalog into a `ResolvedItem`.
///
/// # Errors
/// Returns `ProceduralViolation` if an `ItemSnapshot::Item`'s `behavior_key` is not
/// present in the catalog — mirroring the TS registry's "No item registered for key '…'"
/// fail-fast guard.
pub fn resolve_item(
    snap: &ItemSnapshot,
    cat: &Catalog,
) -> Result<ResolvedItem, ProceduralViolation> {
    match snap {
        ItemSnapshot::Item {
            id,
            behavior_key,
            durability,
            modifier,
        } => {
            let desc = cat.items.get(behavior_key).ok_or_else(|| {
                ProceduralViolation(format!("No item registered for key '{behavior_key}'"))
            })?;

            // is_broken mirrors TS `get isBroken()`: maxDurability present AND durability === 0
            let is_broken = desc.max_durability.is_some() && *durability == Some(0);

            Ok(ResolvedItem {
                id: id.0.clone(),
                name: desc.name.clone(),
                r#type: desc.r#type,
                stat: desc.stat,
                // Per-instance modifier wins over the descriptor's default (mirrors [HYDRATE])
                modifier: *modifier,
                properties: desc.properties.clone(),
                slot: desc.slot,
                durability: *durability,
                max_durability: desc.max_durability,
                is_broken,
                lore: desc.lore.clone(),
                presentation: desc.presentation.clone(),
                key_code: None,
            })
        }

        ItemSnapshot::Key {
            id, name, key_code, ..
        } => {
            // Keys don't live in the catalog; all identity is in the snapshot.
            // `stat` defaults to Health — mirrors TS `createKey` which uses StatType.Health.
            // NOTE: TS `createKey` sets `properties` with no `droppable` field (undefined),
            // so `droppable` must be `None` here — NOT `Some(false)`.  `None != Some(false)`
            // evaluates to `true` in the view projection, matching the TS oracle result of
            // `undefined !== false` = true (keys ARE droppable unless explicitly marked).
            Ok(ResolvedItem {
                id: id.0.clone(),
                name: name.clone(),
                r#type: ItemType::Key,
                stat: StatType::Health,
                modifier: 0,
                properties: ItemProperties {
                    equippable: false,
                    equipped: false,
                    destroyable: false,
                    usable: false,
                    droppable: None,
                },
                slot: None,
                durability: None,
                max_durability: None,
                is_broken: false,
                lore: None,
                presentation: None,
                key_code: Some(key_code.clone()),
            })
        }
    }
}

/// Resolve an NPC dialogue behavior key to its `NpcScript`. There is no native
/// NPC concept (unlike mechanics/exits/victory/formations), so resolution is
/// catalog-only: it looks up `catalog.behaviors[key]` and matches the `Npc`
/// family. Returns `None` if the key is absent or bound to a non-NPC behavior —
/// mirroring the native-first-then-catalog `resolve_*` family (here the native
/// arm is simply empty). Borrows only `cat`, so callers can hold the returned
/// `&NpcScript` while separately taking a `&mut` on the NPC's snapshot state.
pub fn resolve_npc<'a>(key: &str, cat: &'a Catalog) -> Option<&'a crate::script::ast::NpcScript> {
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Npc { script }) => Some(script),
        _ => None,
    }
}

impl World {
    /// Mirrors `character.ts:903-913` (`effectiveStat`):
    /// returns `base_stat + Σ modifier` for each **equipped** accessory whose
    /// `stat` matches the requested `stat`.
    ///
    /// Equipped-ness is derived from `CharacterSnapshot.equipment` (the slot map),
    /// not from `properties.equipped` (which is not serialized).
    ///
    /// Item ids that appear in multiple slots (two-handed weapons) are counted
    /// once via de-duplication — accessories are never two-handed but we mirror
    /// the TS invariant for safety.
    ///
    /// Returns `0` if the character id is not found.
    /// Silently skips equipped item ids whose `ItemSnapshot` is absent in
    /// `World.items` or whose catalog lookup fails — the non-panicking choice.
    pub fn effective_stat(&self, character: &CharacterId, stat: StatType, cat: &Catalog) -> f64 {
        let Some(ch) = self.characters.get(character) else {
            return 0.0;
        };

        let base = match stat {
            StatType::Energy => ch.stats.energy,
            StatType::Sanity => ch.stats.sanity,
            StatType::Health => ch.stats.health,
        };

        // De-duplicate: a two-handed item occupies two slot-map entries.
        let equipped_ids: BTreeSet<&crate::world::ids::ItemId> = ch.equipment.values().collect();

        let bonus: i64 = equipped_ids
            .into_iter()
            .filter_map(|item_id| self.items.get(item_id))
            .filter_map(|snap| resolve_item(snap, cat).ok())
            .filter(|resolved| resolved.r#type == ItemType::Accessory && resolved.stat == stat)
            .map(|resolved| resolved.modifier)
            .sum();

        base + bonus as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        stats::StatType,
        world::{
            descriptor::{Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind},
            ids::ItemId,
            snapshot::ItemSnapshot,
        },
    };
    use alloc::{collections::BTreeMap, string::ToString};
    use serde_json::json;

    fn poker_descriptor() -> ItemDescriptor {
        ItemDescriptor {
            name: "Iron Poker".to_string(),
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
            max_durability: Some(8),
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

    fn catalog_with_poker() -> Catalog {
        let mut items = BTreeMap::new();
        items.insert("items/poker".to_string(), poker_descriptor());
        Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        }
    }

    fn item_id(s: &str) -> ItemId {
        serde_json::from_value(json!(s)).unwrap()
    }

    // ── ItemSnapshot::Item resolution ────────────────────────────────────────

    #[test]
    fn item_merges_descriptor_fields() {
        let snap = ItemSnapshot::Item {
            id: item_id("itm-1"),
            behavior_key: "items/poker".to_string(),
            durability: Some(5),
            modifier: 7,
        };
        let cat = catalog_with_poker();
        let resolved = resolve_item(&snap, &cat).unwrap();

        assert_eq!(resolved.id, "itm-1");
        assert_eq!(resolved.name, "Iron Poker");
        assert_eq!(resolved.r#type, ItemType::Weapon);
        assert_eq!(resolved.stat, StatType::Health);
        assert_eq!(resolved.slot, Some(SlotKind::Hand));
        assert_eq!(resolved.max_durability, Some(8));
        assert_eq!(resolved.durability, Some(5));
        assert!(!resolved.is_broken);
    }

    #[test]
    fn item_snapshot_modifier_overrides_descriptor() {
        // Descriptor has modifier 3, snapshot has modifier 7 — snapshot wins.
        let snap = ItemSnapshot::Item {
            id: item_id("itm-2"),
            behavior_key: "items/poker".to_string(),
            durability: Some(4),
            modifier: 7,
        };
        let resolved = resolve_item(&snap, &catalog_with_poker()).unwrap();
        assert_eq!(resolved.modifier, 7);
    }

    #[test]
    fn is_broken_true_when_max_durability_present_and_durability_zero() {
        let snap = ItemSnapshot::Item {
            id: item_id("itm-3"),
            behavior_key: "items/poker".to_string(),
            durability: Some(0),
            modifier: 5,
        };
        let resolved = resolve_item(&snap, &catalog_with_poker()).unwrap();
        assert_eq!(resolved.durability, Some(0));
        assert_eq!(resolved.max_durability, Some(8));
        assert!(
            resolved.is_broken,
            "should be broken when durability=0 and max_durability is set"
        );
    }

    #[test]
    fn is_broken_false_when_durability_nonzero() {
        let snap = ItemSnapshot::Item {
            id: item_id("itm-4"),
            behavior_key: "items/poker".to_string(),
            durability: Some(8),
            modifier: 5,
        };
        let resolved = resolve_item(&snap, &catalog_with_poker()).unwrap();
        assert!(!resolved.is_broken);
    }

    #[test]
    fn is_broken_false_when_no_max_durability() {
        // An item with no max_durability is indestructible — never broken.
        let mut items = BTreeMap::new();
        items.insert(
            "items/coin".to_string(),
            ItemDescriptor {
                name: "Gold Coin".to_string(),
                r#type: ItemType::Consumable,
                stat: StatType::Health,
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
            },
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        };

        let snap = ItemSnapshot::Item {
            id: item_id("itm-5"),
            behavior_key: "items/coin".to_string(),
            durability: Some(0), // would be broken IF max_durability was set
            modifier: 0,
        };
        let resolved = resolve_item(&snap, &cat).unwrap();
        assert!(!resolved.is_broken, "no max_durability ⇒ never broken");
    }

    #[test]
    fn unknown_behavior_key_returns_procedural_violation() {
        let snap = ItemSnapshot::Item {
            id: item_id("itm-6"),
            behavior_key: "items/does-not-exist".to_string(),
            durability: None,
            modifier: 0,
        };
        let cat = catalog_with_poker();
        let err = resolve_item(&snap, &cat).unwrap_err();
        assert!(
            err.0.contains("items/does-not-exist"),
            "error message should mention the missing key, got: {}",
            err.0
        );
    }

    // ── ItemSnapshot::Key resolution ─────────────────────────────────────────

    #[test]
    fn key_resolves_from_snapshot_only() {
        let snap = ItemSnapshot::Key {
            id: item_id("key-1"),
            name: "Brass Key".to_string(),
            key_code: "door-east".to_string(),
            consume_on_use: true,
        };
        // Catalog is empty — keys must not need it
        let cat = Catalog::default();
        let resolved = resolve_item(&snap, &cat).unwrap();

        assert_eq!(resolved.id, "key-1");
        assert_eq!(resolved.name, "Brass Key");
        assert_eq!(resolved.r#type, ItemType::Key);
        assert_eq!(resolved.key_code.as_deref(), Some("door-east"));
        assert_eq!(resolved.modifier, 0);
        assert!(resolved.slot.is_none());
        assert!(resolved.durability.is_none());
        assert!(resolved.max_durability.is_none());
        assert!(!resolved.is_broken);
    }

    #[test]
    fn key_properties_are_all_false() {
        let snap = ItemSnapshot::Key {
            id: item_id("key-2"),
            name: "Skeleton Key".to_string(),
            key_code: "any".to_string(),
            consume_on_use: false,
        };
        let resolved = resolve_item(&snap, &Catalog::default()).unwrap();
        let p = &resolved.properties;
        assert!(!p.equippable);
        assert!(!p.equipped);
        assert!(!p.destroyable);
        assert!(!p.usable);
        // Keys have no explicit droppable flag in TS (createKey omits it → undefined).
        // None here mirrors that: None != Some(false) → true in the view projection.
        assert_eq!(p.droppable, None);
    }

    #[test]
    fn key_has_no_lore_or_presentation() {
        let snap = ItemSnapshot::Key {
            id: item_id("key-3"),
            name: "Rusty Key".to_string(),
            key_code: "cage".to_string(),
            consume_on_use: false,
        };
        let resolved = resolve_item(&snap, &Catalog::default()).unwrap();
        assert!(resolved.lore.is_none());
        assert!(resolved.presentation.is_none());
    }

    // ── effective_stat ───────────────────────────────────────────────────────

    use crate::world::{
        ids::CharacterId,
        snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats},
        World,
    };
    use serde_json::Value;

    /// Build a minimal descriptor for an accessory or weapon.
    fn accessory_descriptor(stat: StatType, modifier: i64) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Ring".to_string(),
            r#type: ItemType::Accessory,
            stat,
            modifier,
            properties: ItemProperties {
                equippable: true,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: Some(SlotKind::Finger),
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

    fn weapon_descriptor(stat: StatType, modifier: i64) -> ItemDescriptor {
        ItemDescriptor {
            name: "Test Sword".to_string(),
            r#type: ItemType::Weapon,
            stat,
            modifier,
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

    /// Build a minimal World with one player character, no items.
    fn minimal_world(char_id: &str, stats: Stats) -> World {
        let cid = CharacterId(char_id.to_string());
        let snap = CharacterSnapshot {
            kind: CharacterKind::Player,
            id: cid.clone(),
            name: char_id.to_string(),
            stats,
            actions_per_round: 2,
            actions_this_round: 0,
            current_room_id: None,
            inventory: InventorySnapshot {
                slots: 6,
                item_ids: alloc::vec![],
                key_ids: alloc::vec![],
            },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: alloc::vec![],
            afflictions: crate::world::afflictions::Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
            npc_state: serde_json::Value::Null,
            visible: true,
        };
        let mut characters = BTreeMap::new();
        characters.insert(cid, snap);
        World {
            characters,
            rooms: BTreeMap::new(),
            items: BTreeMap::new(),
            loot: BTreeMap::new(),
            material_caches: BTreeMap::new(),
            exits: BTreeMap::new(),
            campaign: crate::world::snapshot::CampaignCoreSnapshot {
                id: "t".to_string(),
                title: "T".to_string(),
                max_rounds: 10,
                round: 0,
                started: true,
                outcome: crate::presentation::CampaignOutcome::Ongoing,
                outcome_reason: None,
                win_conditions: alloc::vec::Vec::new(),
                lose_conditions: alloc::vec::Vec::new(),
                timeout_narration: None,
                ended_narration: None,
                active_character_index: 0,
                party_ids: alloc::vec![],
                acted_this_round: alloc::vec![],
                gm_id: None,
                materials: serde_json::json!({}),
                claims: alloc::vec![],
                encountered: alloc::vec![],
                known_recipes: alloc::vec![],
                archetypes: Value::Array(alloc::vec![]),
                action_sounds: serde_json::json!({}),
                encounter_table: serde_json::json!({"baseChance":0,"visited":[],"formations":[]}),
                chat_policy: serde_json::json!({}),
                av_policy: serde_json::json!({}),
                mechanics: alloc::vec![],
            },
            codex: Value::Array(alloc::vec![]),
            rng: crate::world::rng::Rng::seeded(0),
        }
    }

    #[test]
    fn effective_stat_base_only_no_equipment() {
        let world = minimal_world(
            "c1",
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0,
            },
        );
        let cid = CharacterId("c1".to_string());
        let cat = Catalog::default();
        // No equipment → returns base stat
        assert_eq!(world.effective_stat(&cid, StatType::Energy, &cat), 5.0);
        assert_eq!(world.effective_stat(&cid, StatType::Sanity, &cat), 7.0);
        assert_eq!(world.effective_stat(&cid, StatType::Health, &cat), 10.0);
    }

    #[test]
    fn effective_stat_equipped_accessory_matching_stat_adds_modifier() {
        let mut world = minimal_world(
            "c1",
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0,
            },
        );
        let cid = CharacterId("c1".to_string());
        let ring_id = item_id("ring-1");

        // Catalog: ring that boosts energy by 3
        let mut items = BTreeMap::new();
        items.insert(
            "items/ring".to_string(),
            accessory_descriptor(StatType::Energy, 3),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        };

        // Item in World.items
        world.items.insert(
            ring_id.clone(),
            ItemSnapshot::Item {
                id: ring_id.clone(),
                behavior_key: "items/ring".to_string(),
                durability: None,
                modifier: 3,
            },
        );

        // Put ring in character's equipment map
        let ch = world.characters.get_mut(&cid).unwrap();
        ch.equipment.insert("finger".to_string(), ring_id);

        assert_eq!(world.effective_stat(&cid, StatType::Energy, &cat), 8.0); // 5 + 3
        assert_eq!(world.effective_stat(&cid, StatType::Sanity, &cat), 7.0); // unaffected
    }

    #[test]
    fn effective_stat_equipped_weapon_does_not_contribute() {
        let mut world = minimal_world(
            "c1",
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0,
            },
        );
        let cid = CharacterId("c1".to_string());
        let sword_id = item_id("sword-1");

        // Catalog: weapon targeting energy
        let mut items = BTreeMap::new();
        items.insert(
            "items/sword".to_string(),
            weapon_descriptor(StatType::Energy, 4),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        };

        world.items.insert(
            sword_id.clone(),
            ItemSnapshot::Item {
                id: sword_id.clone(),
                behavior_key: "items/sword".to_string(),
                durability: Some(5),
                modifier: 4,
            },
        );
        let ch = world.characters.get_mut(&cid).unwrap();
        ch.equipment.insert("hand".to_string(), sword_id);

        // Weapon is not an accessory — does NOT contribute
        assert_eq!(world.effective_stat(&cid, StatType::Energy, &cat), 5.0);
    }

    #[test]
    fn effective_stat_accessory_in_inventory_but_not_equipped_does_not_contribute() {
        let mut world = minimal_world(
            "c1",
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0,
            },
        );
        let cid = CharacterId("c1".to_string());
        let ring_id = item_id("ring-2");

        let mut items = BTreeMap::new();
        items.insert(
            "items/ring".to_string(),
            accessory_descriptor(StatType::Energy, 3),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        };

        // Item exists in World.items (in inventory) but NOT in equipment map
        world.items.insert(
            ring_id.clone(),
            ItemSnapshot::Item {
                id: ring_id.clone(),
                behavior_key: "items/ring".to_string(),
                durability: None,
                modifier: 3,
            },
        );
        let ch = world.characters.get_mut(&cid).unwrap();
        ch.inventory.item_ids.push(ring_id); // in inventory, not equipped

        // Should NOT contribute — equipment map is empty
        assert_eq!(world.effective_stat(&cid, StatType::Energy, &cat), 5.0);
    }

    #[test]
    fn effective_stat_accessory_with_different_stat_does_not_contribute() {
        let mut world = minimal_world(
            "c1",
            Stats {
                energy: 5.0,
                sanity: 7.0,
                health: 10.0,
            },
        );
        let cid = CharacterId("c1".to_string());
        let ring_id = item_id("ring-3");

        // Accessory boosts SANITY, not ENERGY
        let mut items = BTreeMap::new();
        items.insert(
            "items/ring-san".to_string(),
            accessory_descriptor(StatType::Sanity, 2),
        );
        let cat = Catalog {
            items,
            aliases: BTreeMap::new(),
            behaviors: Default::default(),
            formations: Default::default(),
            recipes: Default::default(),
        };

        world.items.insert(
            ring_id.clone(),
            ItemSnapshot::Item {
                id: ring_id.clone(),
                behavior_key: "items/ring-san".to_string(),
                durability: None,
                modifier: 2,
            },
        );
        let ch = world.characters.get_mut(&cid).unwrap();
        ch.equipment.insert("finger".to_string(), ring_id);

        // Equipped but different stat — does NOT add to energy
        assert_eq!(world.effective_stat(&cid, StatType::Energy, &cat), 5.0);
        // But does add to sanity
        assert_eq!(world.effective_stat(&cid, StatType::Sanity, &cat), 9.0); // 7 + 2
    }
}
