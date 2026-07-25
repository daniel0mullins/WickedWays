//! The surface-facing `Intent` boundary type.
//!
//! Mirrors 1:1 — the parser-produced
//! player intents. Distinct from `Command` (`world/command.rs`), which
//! additionally carries internal lifecycle ops (startTurn/endTurn/nextPlayer/
//! endCampaign/mechanicAction) and has no `wait`/`talk`; `Command` stays the
//! internal/multiplayer representation.
use alloc::string::String;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::world::direction::Direction;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Intent {
    Move {
        dir: Direction,
    },
    #[serde(rename_all = "camelCase")]
    Take {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Drop {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Open {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Attack {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Equip {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Unequip {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Use {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Harvest {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Craft {
        recipe_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Repair {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Destroy {
        target_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Talk {
        npc_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        prompt: Option<String>,
    },
    Wait,
}

/// Port of `isTimeAdvancing`: move/take/drop/use/attack/wait
/// advance the turn; open/equip/unequip/talk are free. `talk` is a free
/// interaction (dialogue spends no round) — a co-located NPC just answers.
pub fn is_time_advancing(intent: &Intent) -> bool {
    matches!(
        intent,
        Intent::Move { .. }
            | Intent::Take { .. }
            | Intent::Drop { .. }
            | Intent::Use { .. }
            | Intent::Attack { .. }
            | Intent::Wait
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intent_json_wire_shapes_are_stable() {
        // Byte-for-byte field names — the surface/engine wire contract.
        let cases = [
            json!({ "kind": "move", "dir": "north" }),
            json!({ "kind": "take", "targetId": "i1" }),
            json!({ "kind": "drop", "targetId": "i1" }),
            json!({ "kind": "open", "targetId": "l1" }),
            json!({ "kind": "attack", "targetId": "m1" }),
            json!({ "kind": "equip", "targetId": "i1" }),
            json!({ "kind": "unequip", "targetId": "i1" }),
            json!({ "kind": "use", "targetId": "i1" }),
            json!({ "kind": "talk", "npcId": "n1", "prompt": "hello" }),
            json!({ "kind": "talk", "npcId": "n1" }),
            json!({ "kind": "wait" }),
        ];
        for case in cases {
            let parsed: Intent = serde_json::from_value(case.clone()).unwrap();
            // Round-trip: serialization emits the same JSON (prompt omitted when None).
            assert_eq!(serde_json::to_value(&parsed).unwrap(), case);
        }
    }

    #[test]
    fn talk_prompt_is_optional_and_omitted_when_absent() {
        let t: Intent = serde_json::from_value(json!({ "kind": "talk", "npcId": "n1" })).unwrap();
        assert!(matches!(&t, Intent::Talk { npc_id, prompt: None } if npc_id == "n1"));
    }

    #[test]
    fn time_advancing_set_matches_intent_ts() {
        // intent.ts — TIME_ADVANCING = {move, take, drop, use, attack, wait}
        // (talk is a FREE interaction and must not appear here).
        let advancing = [
            Intent::Move {
                dir: crate::world::direction::Direction::North,
            },
            Intent::Take {
                target_id: "x".into(),
            },
            Intent::Drop {
                target_id: "x".into(),
            },
            Intent::Use {
                target_id: "x".into(),
            },
            Intent::Attack {
                target_id: "x".into(),
            },
            Intent::Wait,
        ];
        for i in advancing {
            assert!(is_time_advancing(&i), "{i:?} must advance time");
        }
        let free = [
            Intent::Open {
                target_id: "x".into(),
            },
            Intent::Equip {
                target_id: "x".into(),
            },
            Intent::Unequip {
                target_id: "x".into(),
            },
            Intent::Talk {
                npc_id: "x".into(),
                prompt: None,
            },
        ];
        for i in free {
            assert!(!is_time_advancing(&i), "{i:?} must be free");
        }
    }

    #[test]
    fn talk_is_not_time_advancing() {
        // Talk is a free interaction — dialogue spends no round.
        assert!(!is_time_advancing(&Intent::Talk {
            npc_id: "n1".into(),
            prompt: None
        }));
        assert!(!is_time_advancing(&Intent::Talk {
            npc_id: "n1".into(),
            prompt: Some("hello".into()),
        }));
    }
}
