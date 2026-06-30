//! Thin ViewModel slice — room scalars, occupants (id/name/kind), status turn/maxTurns,
//! outcome, and finished. Deferred fields (exits, loot, inventory, scope, occupant
//! health/defeated/image) land in later sub-plans.
//!
//! Mirrors `packages/play-runtime/src/viewmodel.ts:60-167` (thin slice only).
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::error::ProceduralViolation;
use crate::presentation::CampaignOutcome;
use crate::world::World;

/// The room fields populated in the thin slice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinRoom {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_lit: bool,
}

/// An occupant (non-active character) in the thin slice.
/// `kind` is always the literal string `"occupant"`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinOccupant {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// Turn counters in the thin slice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinStatus {
    pub turn: i64,
    pub max_turns: i64,
}

/// The thin ViewModel — only the fields available in sub-plan 2.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ThinViewModel {
    pub room: ThinRoom,
    pub occupants: Vec<ThinOccupant>,
    pub status: ThinStatus,
    pub outcome: CampaignOutcome,
    pub finished: bool,
}

impl World {
    /// Build the thin ViewModel for the active character's current state.
    ///
    /// - Active character determined by `campaign.active_character_index` in `party_ids`.
    /// - `occupants` = room's `occupant_ids` minus the active character, each mapped to
    ///   `{ id, name, kind: "occupant" }`.
    /// - `status.turn` = `campaign.round`; `status.max_turns` = `campaign.max_rounds`.
    /// - `outcome` / `finished` mirror `campaign.outcome` and `outcome != Ongoing`.
    pub fn view_thin(&self) -> Result<ThinViewModel, ProceduralViolation> {
        let active_id = self.active_character_id()?;

        let room_id = self
            .characters
            .get(&active_id)
            .and_then(|c| c.current_room_id.clone())
            .ok_or_else(|| ProceduralViolation("active character has no current room".into()))?;

        let room_snap = self
            .rooms
            .get(&room_id)
            .ok_or_else(|| ProceduralViolation("current room not found in world".into()))?;

        let is_lit = self.is_lit(&room_id);

        let occupants: Vec<ThinOccupant> = room_snap
            .occupant_ids
            .iter()
            .filter(|id| *id != &active_id)
            .map(|id| {
                let name = self
                    .characters
                    .get(id)
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
                ThinOccupant { id: id.0.clone(), name, kind: "occupant".into() }
            })
            .collect();

        let outcome = self.campaign.outcome;
        let finished = outcome != CampaignOutcome::Ongoing;

        Ok(ThinViewModel {
            room: ThinRoom {
                id: room_id.0.clone(),
                name: room_snap.name.clone(),
                description: room_snap.description.clone(),
                is_lit,
            },
            occupants,
            status: ThinStatus {
                turn: self.campaign.round,
                max_turns: self.campaign.max_rounds,
            },
            outcome,
            finished,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::presentation::CampaignOutcome;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_two_rooms;

    #[test]
    fn view_thin_reports_room_status_and_outcome() {
        let w = world_two_rooms(false); // pc "Heir" in "start"="Start"
        let v = w.view_thin().unwrap();
        assert_eq!(v.room.name, "Start");
        assert!(v.room.is_lit);
        assert_eq!(v.status.turn, 0);
        assert_eq!(v.outcome, CampaignOutcome::Ongoing);
        assert!(!v.finished);
        assert!(v.occupants.is_empty()); // only the pc, filtered out
    }

    #[test]
    fn view_thin_room_id_and_description() {
        let w = world_two_rooms(false);
        let v = w.view_thin().unwrap();
        assert_eq!(v.room.id, "start");
        assert_eq!(v.status.max_turns, 20);
    }

    #[test]
    fn view_thin_finished_when_outcome_not_ongoing() {
        let mut w = world_two_rooms(false);
        w.campaign.outcome = CampaignOutcome::Won;
        let v = w.view_thin().unwrap();
        assert_eq!(v.outcome, CampaignOutcome::Won);
        assert!(v.finished);
    }

    #[test]
    fn view_thin_excludes_active_character_from_occupants() {
        let mut w = world_two_rooms(false);
        // Add a second character to the "start" room's occupant list
        let npc_id = CharacterId("npc1".into());
        use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats};
        use alloc::collections::BTreeMap;
        use serde_json::Value;
        let npc = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: npc_id.clone(),
            name: "Wraith".into(),
            stats: Stats { energy: 2, sanity: 0, health: 3 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(crate::world::ids::RoomId("start".into())),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: Value::Array(alloc::vec![]),
            afflictions: serde_json::json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} }),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        };
        w.characters.insert(npc_id.clone(), npc);
        if let Some(room) = w.rooms.get_mut(&crate::world::ids::RoomId("start".into())) {
            room.occupant_ids.push(npc_id.clone());
        }

        let v = w.view_thin().unwrap();
        assert_eq!(v.occupants.len(), 1);
        assert_eq!(v.occupants[0].id, "npc1");
        assert_eq!(v.occupants[0].name, "Wraith");
        assert_eq!(v.occupants[0].kind, "occupant");
    }

    #[test]
    fn view_thin_dark_room_is_not_lit() {
        let mut w = world_two_rooms(false);
        // Make the start room dark
        if let Some(room) = w.rooms.get_mut(&crate::world::ids::RoomId("start".into())) {
            room.dark = true;
        }
        let v = w.view_thin().unwrap();
        assert!(!v.room.is_lit);
    }
}
