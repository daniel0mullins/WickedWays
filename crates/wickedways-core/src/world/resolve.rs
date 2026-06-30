//! Item resolution: snapshot + catalog → effective item identity.
//!
//! Mirrors `hydrateItem` (inventory.ts:723-734), `[HYDRATE]` (inventory.ts:443-448),
//! and `isBroken` (inventory.ts:403-405).
use alloc::{format, string::String};

use crate::{
    error::ProceduralViolation,
    stats::StatType,
    world::{
        descriptor::{Catalog, ItemProperties, ItemType, Presentation, SlotKind},
        snapshot::ItemSnapshot,
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
pub fn resolve_item(snap: &ItemSnapshot, cat: &Catalog) -> Result<ResolvedItem, ProceduralViolation> {
    match snap {
        ItemSnapshot::Item { id, behavior_key, durability, modifier } => {
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

        ItemSnapshot::Key { id, name, key_code, .. } => {
            // Keys don't live in the catalog; all identity is in the snapshot.
            // `stat` defaults to Health — mirrors TS `createKey` which uses StatType.Health.
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
                    droppable: Some(false),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        world::{
            descriptor::{Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind},
            ids::ItemId,
            snapshot::ItemSnapshot,
        },
        stats::StatType,
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
        Catalog { items, aliases: BTreeMap::new() }
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
        assert!(resolved.is_broken, "should be broken when durability=0 and max_durability is set");
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
        items.insert("items/coin".to_string(), ItemDescriptor {
            name: "Gold Coin".to_string(),
            r#type: ItemType::Consumable,
            stat: StatType::Health,
            modifier: 0,
            properties: ItemProperties { equippable: false, equipped: false, destroyable: false, usable: true, droppable: None },
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
        });
        let cat = Catalog { items, aliases: BTreeMap::new() };

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
            "error message should mention the missing key, got: {}", err.0
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
        assert_eq!(p.droppable, Some(false));
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
}
