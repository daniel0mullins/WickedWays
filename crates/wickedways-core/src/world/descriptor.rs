//! Item descriptor primitives — the data half of an item's identity, sourced
//! from the campaign's registry (the catalog), not the per-instance snapshot.
//! JSON byte-compatible with +.
use crate::stats::StatType;
use alloc::{collections::BTreeMap, string::String, vec::Vec};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Consumable,
    Armor,
    Weapon,
    Throwable,
    Accessory,
    Key,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotKind {
    Hand,
    Finger,
    Wrist,
    Head,
    Torso,
    Legs,
    Feet,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub equippable: bool,
    pub equipped: bool,
    pub destroyable: bool,
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub droppable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<crate::presentation::AssetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<crate::presentation::AssetRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDescriptor {
    pub name: String,
    pub r#type: ItemType,
    pub stat: StatType,
    pub modifier: i64,
    pub properties: ItemProperties,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<SlotKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub two_handed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emits_light: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_durability: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lore: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Presentation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consume_on_use: Option<bool>,
    // inert until 3b/4/5 — typed when their subsystem lands:
    pub recipe: serde_json::Value,
    pub teaches: serde_json::Value,
    pub immunities: serde_json::Value,
    pub grants_immunity: serde_json::Value,
}

/// Campaign-authored crafting recipe metadata, carried in the catalog so the
/// assembler can reconstruct the genesis recipe codex (the `outputName`/`materials`
/// otherwise live only in the registry's `create` closure). Keyed by recipe key
/// in the catalog's `recipes` map.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeMeta {
    pub id: String,
    pub output_name: String,
    pub materials: BTreeMap<String, i64>,
    /// Catalog item key the recipe instantiates when crafted. The serialized codex
    /// otherwise carries only display + cost (the `create()` factory doesn't
    /// serialize), so `craft` needs this to build the output `ItemSnapshot` from the
    /// catalog. Optional + `skip_serializing_if` so recipe-free catalogs stay
    /// byte-stable; a materials recipe without it can be priced but not crafted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_item_key: Option<String>,
}

/// A Wicked Ways card face — the display half of a card's identity. The card's
/// key doubles as its behavior key (native registry first, then a
/// `BehaviorScript::Card` in `catalog.behaviors`), mirroring how an item's
/// `behavior_key` doubles as its descriptor key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDescriptor {
    pub name: String,
    /// Rules/flavor text shown on the card face.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Behavior-specific tuning read by the card op (e.g. `{"rounds": 2}` for
    /// `wicked:lights-out`). Omitted when null.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub config: serde_json::Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Catalog {
    pub items: BTreeMap<String, ItemDescriptor>,
    pub aliases: BTreeMap<String, Vec<String>>,
    /// Campaign-authored scripted behaviors, keyed by behavior key
    /// (mechanic key / exit behaviorKey / victory condition key). Always emitted
    /// (even when empty), byte-faithful to the `catalogFromRegistry` oracle,
    /// which always writes this key; `default` keeps older keyless fixtures
    /// deserializable.
    #[serde(default)]
    pub behaviors: BTreeMap<String, crate::script::ast::BehaviorScript>,
    /// Campaign-authored formation descriptors, keyed by encounter `behaviorKey`.
    /// Always emitted (even when empty) to match the TS oracle; `default` keeps
    /// older keyless fixtures deserializable.
    #[serde(default)]
    pub formations: BTreeMap<String, crate::world::formation_descriptor::FormationDescriptor>,
    /// Campaign-authored crafting recipe metadata, keyed by recipe key. Always
    /// emitted (even when empty) to match the TS oracle; `default` keeps older
    /// keyless fixtures deserializable.
    #[serde(default)]
    pub recipes: BTreeMap<String, RecipeMeta>,
    /// Wicked Ways card faces, keyed by card key (which doubles as the card's
    /// behavior key). Unlike the oracle-pinned maps above, this post-oracle
    /// field is OMITTED when empty so the committed catalog fixtures stay
    /// byte-stable.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cards: BTreeMap<String, CardDescriptor>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_descriptor_roundtrips_with_inert_value_fields() {
        let json = serde_json::json!({
            "name": "Iron Poker", "type": "weapon", "stat": "health", "modifier": 5,
            "properties": { "equippable": true, "equipped": false, "destroyable": true, "usable": false },
            "slot": "hand", "maxDurability": 8,
            "recipe": { "metal": 1 }, "teaches": null, "immunities": [], "grantsImmunity": null
        });
        let d: ItemDescriptor = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(d.name, "Iron Poker");
        assert_eq!(d.r#type, ItemType::Weapon);
        assert_eq!(d.max_durability, Some(8));
        assert_eq!(d.recipe, serde_json::json!({ "metal": 1 })); // inert passthrough
        assert_eq!(serde_json::to_value(&d).unwrap(), json); // byte round-trip
    }

    #[test]
    fn catalog_loads_and_resolves_key() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": { "items/poker": { "name": "Iron Poker", "type": "weapon", "stat": "health",
                "modifier": 5, "properties": {"equippable":true,"equipped":false,"destroyable":true,"usable":false},
                "recipe": {}, "teaches": null, "immunities": [], "grantsImmunity": null } },
            "aliases": { "items/poker": ["poker", "iron"] }
        })).unwrap();
        assert_eq!(cat.items.get("items/poker").unwrap().name, "Iron Poker");
        assert_eq!(
            cat.aliases.get("items/poker").unwrap(),
            &vec!["poker".to_string(), "iron".to_string()]
        );
    }

    #[test]
    fn catalog_without_behaviors_still_parses_and_roundtrips_empty() {
        // Every committed fixture catalog lacks "behaviors" — must stay loadable.
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {}
        }))
        .unwrap();
        assert!(cat.behaviors.is_empty());
        // empty behaviors are still emitted as {} on serialize, byte-faithful to
        // the `catalogFromRegistry` oracle (which always writes the key).
        let out = serde_json::to_value(&cat).unwrap();
        assert_eq!(out.get("behaviors"), Some(&serde_json::json!({})));
    }

    #[test]
    fn catalog_parses_a_mechanic_behavior() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "dread": { "family": "mechanic", "script": {
                "init": {},
                "hooks": { "onTurnStart": [
                    { "kind": "guard", "cond": { "kind": "not", "expr":
                        { "kind": "hasEquipped", "of": { "kind": "actor" }, "itemKey": "lantern" } } },
                    { "kind": "emit", "effect": { "kind": "adjustStat",
                        "target": { "kind": "actor" }, "stat": "sanity",
                        "delta": { "kind": "lit", "value": -1.0 } } }
                ] }
            } } }
        })).unwrap();
        assert!(matches!(
            cat.behaviors.get("dread"),
            Some(crate::script::ast::BehaviorScript::Mechanic { .. })
        ));
    }

    #[test]
    fn catalog_without_formations_still_parses_and_roundtrips_empty() {
        // Every committed fixture catalog lacks "formations" — must stay loadable.
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {}
        }))
        .unwrap();
        assert!(cat.formations.is_empty());
        // empty formations are still emitted as {} on serialize, byte-faithful to
        // the `catalogFromRegistry` oracle (which always writes the key).
        let out = serde_json::to_value(&cat).unwrap();
        assert_eq!(out.get("formations"), Some(&serde_json::json!({})));
    }

    #[test]
    fn catalog_parses_a_formation() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "formations": { "rats": { "mobs": [ {
                "name": "Rat",
                "stats": { "energy": 3, "sanity": 0, "health": 4 },
                "naturalAttack": { "stat": "health", "power": 1 },
                "baseEscapeChance": 50,
                "actionsPerRound": 1
            } ] } }
        }))
        .unwrap();
        let f = cat.formations.get("rats").unwrap();
        assert_eq!(f.mobs.len(), 1);
        assert_eq!(f.mobs[0].name, "Rat");
        // round-trips: the parsed catalog re-serializes with its formation intact
        let back: Catalog = serde_json::from_value(serde_json::to_value(&cat).unwrap()).unwrap();
        assert_eq!(back, cat);
    }

    #[test]
    fn catalog_without_recipes_still_parses_and_roundtrips_empty() {
        // Every committed fixture catalog (before this change) lacks "recipes".
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {}
        }))
        .unwrap();
        assert!(cat.recipes.is_empty());
        // empty recipes are still emitted as {} on serialize, byte-faithful to
        // the `catalogFromRegistry` oracle (which always writes the key).
        let out = serde_json::to_value(&cat).unwrap();
        assert_eq!(out.get("recipes"), Some(&serde_json::json!({})));
    }

    #[test]
    fn catalog_parses_a_recipe() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "recipes": { "widget": {
                "id": "widget", "outputName": "Widget", "materials": { "metal": 2 }
            } }
        }))
        .unwrap();
        let r = cat.recipes.get("widget").unwrap();
        assert_eq!(r.id, "widget");
        assert_eq!(r.output_name, "Widget");
        assert_eq!(r.materials.get("metal"), Some(&2));
        // round-trips: the parsed catalog re-serializes with its recipe intact
        let back: Catalog = serde_json::from_value(serde_json::to_value(&cat).unwrap()).unwrap();
        assert_eq!(back, cat);
    }

    #[test]
    fn catalog_without_cards_parses_and_omits_the_key() {
        // Every committed fixture catalog lacks "cards" — must stay loadable,
        // and (unlike the oracle-pinned maps) an empty cards map is OMITTED on
        // serialize so those fixtures stay byte-stable.
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {}
        }))
        .unwrap();
        assert!(cat.cards.is_empty());
        let out = serde_json::to_value(&cat).unwrap();
        assert_eq!(out.get("cards"), None);
    }

    #[test]
    fn catalog_parses_a_card() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "cards": { "wicked:lights-out": {
                "name": "Lights Out",
                "text": "Every flame gutters and dies.",
                "config": { "rounds": 2 }
            } }
        }))
        .unwrap();
        let c = cat.cards.get("wicked:lights-out").unwrap();
        assert_eq!(c.name, "Lights Out");
        assert_eq!(c.config["rounds"], 2);
        let back: Catalog = serde_json::from_value(serde_json::to_value(&cat).unwrap()).unwrap();
        assert_eq!(back, cat);
    }

    // existing tests below

    #[test]
    fn item_type_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(ItemType::Accessory).unwrap(),
            serde_json::json!("accessory")
        );
        assert_eq!(
            serde_json::to_value(ItemType::Weapon).unwrap(),
            serde_json::json!("weapon")
        );
    }

    #[test]
    fn slot_kind_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(SlotKind::Hand).unwrap(),
            serde_json::json!("hand")
        );
    }

    #[test]
    fn item_properties_omits_absent_droppable() {
        let p = ItemProperties {
            equippable: true,
            equipped: false,
            destroyable: true,
            usable: false,
            droppable: None,
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({ "equippable": true, "equipped": false, "destroyable": true, "usable": false })
        );
    }

    #[test]
    fn item_properties_emits_present_droppable_false() {
        let p = ItemProperties {
            equippable: false,
            equipped: false,
            destroyable: false,
            usable: false,
            droppable: Some(false),
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap()["droppable"],
            serde_json::json!(false)
        );
    }
}
