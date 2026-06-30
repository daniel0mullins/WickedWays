//! Item descriptor primitives — the data half of an item's identity, sourced
//! from the campaign's registry (the catalog), not the per-instance snapshot.
//! JSON byte-compatible with `src/lib/inventory.ts` + `src/lib/equipment.ts`.
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
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
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ItemProperties {
    pub equippable: bool,
    pub equipped: bool,
    pub destroyable: bool,
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub droppable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub image: Option<crate::presentation::AssetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional, type = "unknown"))]
    pub sound: Option<crate::presentation::AssetRef>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
