//! Equipment slot constants and lookup helpers.
//! Mirrors.
//!
//! `EquipmentSlot` string constants: the named positions a character can equip items into.
//! `SLOT_KIND`: maps each named slot to its `SlotKind` category.
//! `DEFAULT_EQUIPMENT_SLOTS`: the canonical humanoid fill order.

use crate::world::descriptor::SlotKind;

// Named slot string constants — byte-identical to `EquipmentSlot` values.
pub const HEAD: &str = "head";
pub const TORSO: &str = "torso";
pub const LEGS: &str = "legs";
pub const FEET: &str = "feet";
pub const LEFT_WRIST: &str = "leftWrist";
pub const RIGHT_WRIST: &str = "rightWrist";
pub const LEFT_HAND: &str = "leftHand";
pub const RIGHT_HAND: &str = "rightHand";
pub const LEFT_INDEX_FINGER: &str = "leftIndexFinger";
pub const LEFT_RING_FINGER: &str = "leftRingFinger";
pub const RIGHT_INDEX_FINGER: &str = "rightIndexFinger";
pub const RIGHT_RING_FINGER: &str = "rightRingFinger";

/// The default humanoid slot set in canonical fill order.
/// Mirrors `DEFAULT_EQUIPMENT_SLOTS` exactly.
/// Used by `equip` to assign a free slot in order (first free wins, else displace [0]).
pub const DEFAULT_EQUIPMENT_SLOTS: [&str; 12] = [
    HEAD,
    TORSO,
    LEGS,
    FEET,
    LEFT_WRIST,
    RIGHT_WRIST,
    LEFT_HAND,
    RIGHT_HAND,
    LEFT_INDEX_FINGER,
    LEFT_RING_FINGER,
    RIGHT_INDEX_FINGER,
    RIGHT_RING_FINGER,
];

/// Map a named slot to its `SlotKind` category.
/// Mirrors `SLOT_KIND` record in.
pub fn slot_kind_of(slot: &str) -> Option<SlotKind> {
    match slot {
        HEAD => Some(SlotKind::Head),
        TORSO => Some(SlotKind::Torso),
        LEGS => Some(SlotKind::Legs),
        FEET => Some(SlotKind::Feet),
        LEFT_WRIST | RIGHT_WRIST => Some(SlotKind::Wrist),
        LEFT_HAND | RIGHT_HAND => Some(SlotKind::Hand),
        LEFT_INDEX_FINGER | LEFT_RING_FINGER | RIGHT_INDEX_FINGER | RIGHT_RING_FINGER => {
            Some(SlotKind::Finger)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::descriptor::SlotKind;

    #[test]
    fn default_equipment_slots_has_12_entries() {
        assert_eq!(DEFAULT_EQUIPMENT_SLOTS.len(), 12);
    }

    #[test]
    fn default_equipment_slots_canonical_order() {
        // Mirrors DEFAULT_EQUIPMENT_SLOTS exactly
        assert_eq!(
            DEFAULT_EQUIPMENT_SLOTS,
            [
                "head",
                "torso",
                "legs",
                "feet",
                "leftWrist",
                "rightWrist",
                "leftHand",
                "rightHand",
                "leftIndexFinger",
                "leftRingFinger",
                "rightIndexFinger",
                "rightRingFinger",
            ]
        );
    }

    #[test]
    fn slot_kind_of_maps_all_slots() {
        assert_eq!(slot_kind_of("head"), Some(SlotKind::Head));
        assert_eq!(slot_kind_of("torso"), Some(SlotKind::Torso));
        assert_eq!(slot_kind_of("legs"), Some(SlotKind::Legs));
        assert_eq!(slot_kind_of("feet"), Some(SlotKind::Feet));
        assert_eq!(slot_kind_of("leftWrist"), Some(SlotKind::Wrist));
        assert_eq!(slot_kind_of("rightWrist"), Some(SlotKind::Wrist));
        assert_eq!(slot_kind_of("leftHand"), Some(SlotKind::Hand));
        assert_eq!(slot_kind_of("rightHand"), Some(SlotKind::Hand));
        assert_eq!(slot_kind_of("leftIndexFinger"), Some(SlotKind::Finger));
        assert_eq!(slot_kind_of("leftRingFinger"), Some(SlotKind::Finger));
        assert_eq!(slot_kind_of("rightIndexFinger"), Some(SlotKind::Finger));
        assert_eq!(slot_kind_of("rightRingFinger"), Some(SlotKind::Finger));
    }

    #[test]
    fn slot_kind_of_unknown_returns_none() {
        assert_eq!(slot_kind_of("unknown"), None);
        assert_eq!(slot_kind_of(""), None);
        assert_eq!(slot_kind_of("Hand"), None); // case-sensitive
    }
}
