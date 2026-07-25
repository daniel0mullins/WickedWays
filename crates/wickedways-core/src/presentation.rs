//! Presentation cues — the engine emits intent; the surface owns presentation.
//! JSON byte-compatible with the cue format the conformance goldens pin.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Opaque campaign-supplied asset reference (sound/image). Passthrough — the
/// engine never inspects it. The seed campaign defines no sounds.
pub type AssetRef = serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct EntityRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct StatusField {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct MechanicCue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub sound: Option<AssetRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct OutcomeNarration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub sound: Option<AssetRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "kebab-case")]
pub enum CampaignOutcome {
    Ongoing,
    Won,
    Lost,
    TimedOut,
    Ended,
}

/// The action-cue discriminant. Each variant corresponds 1:1 to an
/// `ActionHistoryEntry` variant — derive it via `From<&ActionHistoryEntry>`
/// rather than naming both in parallel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Attack,
    Move,
    PickUp,
    Drop,
    Escape,
    TakeDamage,
    Fumble,
    MechanicAction,
}

impl From<&crate::world::history::ActionHistoryEntry> for ActionKind {
    fn from(entry: &crate::world::history::ActionHistoryEntry) -> Self {
        use crate::world::history::ActionHistoryEntry as E;
        match entry {
            E::Attack { .. } => ActionKind::Attack,
            E::Move { .. } => ActionKind::Move,
            E::PickUp { .. } => ActionKind::PickUp,
            E::Drop { .. } => ActionKind::Drop,
            E::Escape { .. } => ActionKind::Escape,
            E::TakeDamage { .. } => ActionKind::TakeDamage,
            E::Fumble { .. } => ActionKind::Fumble,
            E::MechanicAction { .. } => ActionKind::MechanicAction,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresentationCue {
    Action {
        action: ActionKind,
        actor: EntityRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(type = "unknown"))]
        sound: Option<AssetRef>,
    },
    Encounter {
        mob: EntityRef,
        room: EntityRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(type = "unknown"))]
        sound: Option<AssetRef>,
    },
    Visibility {
        room: EntityRef,
        lit: bool,
    },
    Resolution {
        outcome: CampaignOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        narration: Option<OutcomeNarration>,
    },
    Mechanic {
        cue: MechanicCue,
    },
    Status {
        fields: Vec<StatusField>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    fn json(c: &PresentationCue) -> serde_json::Value {
        serde_json::to_value(c).unwrap()
    }

    #[test]
    fn action_cue_move_serializes_camelcase_tagged() {
        let c = PresentationCue::Action {
            action: ActionKind::Move,
            actor: EntityRef {
                id: "c1".to_string(),
                name: "Heir".to_string(),
            },
            sound: None,
        };
        assert_eq!(
            json(&c),
            serde_json::json!({ "kind": "action", "action": "move",
                "actor": { "id": "c1", "name": "Heir" } })
        );
    }

    #[test]
    fn visibility_cue_serializes() {
        let c = PresentationCue::Visibility {
            room: EntityRef {
                id: "r1".to_string(),
                name: "Cellar".to_string(),
            },
            lit: false,
        };
        assert_eq!(
            json(&c),
            serde_json::json!({
            "kind": "visibility", "room": { "id": "r1", "name": "Cellar" }, "lit": false })
        );
    }

    #[test]
    fn mechanic_cue_serializes_with_text_only() {
        let c = PresentationCue::Mechanic {
            cue: MechanicCue {
                text: Some("You can't go that way.".to_string()),
                sound: None,
            },
        };
        assert_eq!(
            json(&c),
            serde_json::json!({
            "kind": "mechanic", "cue": { "text": "You can't go that way." } })
        );
    }

    #[test]
    fn resolution_cue_serializes_timeout() {
        let c = PresentationCue::Resolution {
            outcome: CampaignOutcome::TimedOut,
            reason: None,
            narration: None,
        };
        assert_eq!(
            json(&c),
            serde_json::json!({ "kind": "resolution", "outcome": "timed-out" })
        );
    }

    #[test]
    fn campaign_outcome_serializes_kebab() {
        assert_eq!(
            serde_json::to_value(CampaignOutcome::TimedOut).unwrap(),
            serde_json::json!("timed-out")
        );
        assert_eq!(
            serde_json::to_value(CampaignOutcome::Ongoing).unwrap(),
            serde_json::json!("ongoing")
        );
    }

    #[test]
    fn cue_roundtrips() {
        let c = PresentationCue::Resolution {
            outcome: CampaignOutcome::Won,
            reason: Some("reach-attic".to_string()),
            narration: None,
        };
        let s = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<PresentationCue>(&s).unwrap(), c);
    }
}
