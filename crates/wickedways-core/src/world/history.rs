//! Typed action history — JSON byte-compatible with.
use crate::stats::StatType;
use crate::world::ids::{CharacterId, ItemId, RoomId};
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoomRef {
    pub id: RoomId,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetRef {
    pub id: CharacterId,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemRef {
    pub id: ItemId,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionHistoryEntry {
    Attack {
        round: i64,
        target: TargetRef,
    },
    Move {
        round: i64,
        room: RoomRef,
    },
    PickUp {
        round: i64,
        items: Vec<ItemRef>,
    },
    Drop {
        round: i64,
        items: Vec<ItemRef>,
    },
    Escape {
        round: i64,
        success: bool,
    },
    TakeDamage {
        round: i64,
        amount: f64,
        stat: StatType,
    },
    Fumble {
        round: i64,
        action: String,
    },
    MechanicAction {
        round: i64,
        mechanic: String,
        action: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::ids::RoomId;
    use alloc::string::ToString;

    #[test]
    fn move_entry_serializes() {
        let e = ActionHistoryEntry::Move {
            round: 0,
            room: RoomRef {
                id: RoomId("r1".to_string()),
                name: "Next".to_string(),
            },
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({
            "kind": "move", "round": 0, "room": { "id": "r1", "name": "Next" } })
        );
    }

    #[test]
    fn move_entry_roundtrips() {
        let e = ActionHistoryEntry::Move {
            round: 3,
            room: RoomRef {
                id: RoomId("r2".to_string()),
                name: "Start".to_string(),
            },
        };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(serde_json::from_str::<ActionHistoryEntry>(&s).unwrap(), e);
    }

    #[test]
    fn attack_entry_roundtrips() {
        let e = ActionHistoryEntry::Attack {
            round: 1,
            target: TargetRef {
                id: CharacterId("c1".to_string()),
                name: "Goblin".to_string(),
            },
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: ActionHistoryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back, e);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "attack");
        assert_eq!(v["target"]["id"], "c1");
    }

    #[test]
    fn pick_up_entry_roundtrips() {
        let e = ActionHistoryEntry::PickUp {
            round: 2,
            items: alloc::vec![ItemRef {
                id: ItemId("i1".to_string()),
                name: "Sword".to_string()
            },],
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: ActionHistoryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back, e);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "pickUp");
    }

    #[test]
    fn drop_entry_roundtrips() {
        let e = ActionHistoryEntry::Drop {
            round: 2,
            items: alloc::vec![ItemRef {
                id: ItemId("i2".to_string()),
                name: "Shield".to_string()
            },],
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "drop");
    }

    #[test]
    fn escape_entry_roundtrips() {
        let e = ActionHistoryEntry::Escape {
            round: 4,
            success: true,
        };
        let s = serde_json::to_string(&e).unwrap();
        let back: ActionHistoryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back, e);
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "escape");
        assert_eq!(v["success"], true);
    }

    #[test]
    fn take_damage_entry_roundtrips() {
        use crate::stats::StatType;
        let e = ActionHistoryEntry::TakeDamage {
            round: 1,
            amount: 3.0,
            stat: StatType::Health,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "takeDamage");
        assert_eq!(v["amount"], 3.0);
        assert_eq!(v["stat"], "health");
        let s = serde_json::to_string(&e).unwrap();
        let back: ActionHistoryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn fumble_entry_roundtrips() {
        let e = ActionHistoryEntry::Fumble {
            round: 5,
            action: "attack".to_string(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "fumble");
        assert_eq!(v["action"], "attack");
    }

    #[test]
    fn mechanic_action_entry_roundtrips() {
        let e = ActionHistoryEntry::MechanicAction {
            round: 6,
            mechanic: "dread".to_string(),
            action: "invoke".to_string(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "mechanicAction");
        assert_eq!(v["mechanic"], "dread");
        assert_eq!(v["action"], "invoke");
        let s = serde_json::to_string(&e).unwrap();
        let back: ActionHistoryEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn empty_history_vec_roundtrips() {
        let v: Vec<ActionHistoryEntry> = alloc::vec![];
        let s = serde_json::to_string(&v).unwrap();
        assert_eq!(s, "[]");
        let back: Vec<ActionHistoryEntry> = serde_json::from_str(&s).unwrap();
        assert_eq!(back, v);
    }
}
