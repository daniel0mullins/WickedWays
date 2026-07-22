//! Campaign-lifecycle actions issued by the GM (Phase 2c, sub-project A2).
//!
//! Ports the GM/lifecycle commands beyond begin/end/nextPlayer. First up: `transferGM`
//! (`Campaign.transfer`) — hand the GM role to another character. Additional lifecycle actions
//! (`leaveCampaign`, …) join this module as they land.

use alloc::format;

use crate::error::ProceduralViolation;
use crate::world::ids::CharacterId;
use crate::world::snapshot::{CharacterKind, CharacterSnapshot};
use crate::world::World;

impl World {
    /// Hands the GM role to `target`. Mirrors `Campaign.transfer` (the sync `transferGM` command):
    /// asserts the campaign is running, then records the new GM.
    ///
    /// # Errors
    /// [`ProceduralViolation`] if the campaign has not begun, has already finished, or `target` is
    /// not a known character.
    pub fn transfer_gm(&mut self, target: &CharacterId) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        if !self.characters.contains_key(target) {
            return Err(ProceduralViolation(format!("Unknown character id '{}'.", target.0)));
        }
        self.campaign.gm_id = Some(target.clone());
        Ok(())
    }

    /// Removes `target` from the party. Mirrors `Campaign.leaveCampaign` (the sync `leaveCampaign`
    /// command): asserts the campaign is running, refuses to drop the GM, removes the character from
    /// `party_ids`, and keeps `active_character_index` pointing at the same turn position (shift it
    /// down when an earlier member leaves; wrap to 0 if it now dangles past the shrunk party). The
    /// character snapshot itself is left in place — as in the TS, a departed player is still a room
    /// occupant, so it stays reachable and serialized until moved.
    ///
    /// # Errors
    /// [`ProceduralViolation`] if the campaign is not running, `target` is unknown, or `target` is
    /// the GM.
    pub fn leave_campaign(&mut self, target: &CharacterId) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        if !self.characters.contains_key(target) {
            return Err(ProceduralViolation(format!("Unknown character id '{}'.", target.0)));
        }
        if self.campaign.gm_id.as_ref() == Some(target) {
            return Err(ProceduralViolation(
                "GM cannot leave the campaign, transfer the campaign first".into(),
            ));
        }

        let index = self.campaign.party_ids.iter().position(|id| id == target);
        self.campaign.party_ids.retain(|id| id != target);

        if let Some(index) = index {
            let index = index as i64;
            if index < self.campaign.active_character_index {
                self.campaign.active_character_index -= 1;
            } else if self.campaign.active_character_index >= self.campaign.party_ids.len() as i64 {
                self.campaign.active_character_index = 0;
            }
        }
        Ok(())
    }

    /// Adds a self-service joining player to the campaign. Mirrors the TS `resolver.ts` `joinCampaign`
    /// case + `PlayerCharacter.joinCampaign`: only players may join, a duplicate id is rejected (it
    /// would let a joiner shadow or hijack an existing seat), and the character is inserted and
    /// appended to the party. The created character propagates to every replica through the sync
    /// delta, which already diffs the characters map (`sync::delta`) — no extra wiring, no poll.
    ///
    /// The joining snapshot carries its own identity, spawn room (`current_room_id`), and starting
    /// stats; a following `select_archetype` (pre-begin) applies an archetype's statline on top.
    ///
    /// # Errors
    /// [`ProceduralViolation`] if `character` is not a player, or its id already exists in the campaign.
    pub fn join_campaign(&mut self, character: CharacterSnapshot) -> Result<(), ProceduralViolation> {
        if character.kind != CharacterKind::Player {
            return Err(ProceduralViolation(
                "Only player characters can join a campaign.".into(),
            ));
        }
        if self.characters.contains_key(&character.id) {
            return Err(ProceduralViolation(format!(
                "Character id '{}' already exists in this campaign.",
                character.id.0
            )));
        }
        let id = character.id.clone();
        self.characters.insert(id.clone(), character);
        // `PlayerCharacter.joinCampaign`: append to the party, ignoring a repeated join.
        if !self.campaign.party_ids.contains(&id) {
            self.campaign.party_ids.push(id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::CampaignOutcome;
    use crate::world::test_support::world_with_party;

    fn started_with_gm() -> World {
        let mut w = world_with_party(&["a", "b"], 10);
        w.campaign.started = true;
        w.campaign.gm_id = Some(CharacterId("a".into()));
        w
    }

    #[test]
    fn transfers_the_gm_to_another_character() {
        let mut w = started_with_gm();
        w.transfer_gm(&CharacterId("b".into())).unwrap();
        assert_eq!(w.campaign.gm_id, Some(CharacterId("b".into())));
    }

    #[test]
    fn rejects_an_unknown_target() {
        let mut w = started_with_gm();
        assert!(w.transfer_gm(&CharacterId("ghost".into())).is_err());
        assert_eq!(w.campaign.gm_id, Some(CharacterId("a".into())), "gm unchanged on failure");
    }

    #[test]
    fn rejects_before_start_and_after_finish() {
        let mut w = started_with_gm();
        w.campaign.started = false;
        assert!(w.transfer_gm(&CharacterId("b".into())).is_err());

        let mut w = started_with_gm();
        w.campaign.outcome = CampaignOutcome::Won;
        assert!(w.transfer_gm(&CharacterId("b".into())).is_err());
    }

    #[test]
    fn join_adds_a_player_to_the_characters_and_party() {
        let mut w = world_with_party(&["a"], 10);
        let mut newbie = w.characters.get(&CharacterId("a".into())).unwrap().clone();
        newbie.id = CharacterId("b".into());
        newbie.name = "Ben".into();
        w.join_campaign(newbie).unwrap();
        assert!(w.characters.contains_key(&CharacterId("b".into())), "joined character is in the world");
        assert!(w.campaign.party_ids.contains(&CharacterId("b".into())), "joined character is in the party");
    }

    #[test]
    fn join_is_idempotent_on_the_party_but_rejects_a_duplicate_id() {
        // A duplicate character id is refused (it would let a joiner shadow an existing seat), and
        // nothing about the existing seat changes.
        let mut w = world_with_party(&["a"], 10);
        let dup = w.characters.get(&CharacterId("a".into())).unwrap().clone();
        assert!(w.join_campaign(dup).is_err());
        assert_eq!(w.campaign.party_ids, alloc::vec![CharacterId("a".into())], "party unchanged on a rejected join");
    }

    #[test]
    fn join_rejects_a_non_player() {
        let mut w = world_with_party(&["a"], 10);
        let mut mob = w.characters.get(&CharacterId("a".into())).unwrap().clone();
        mob.id = CharacterId("m".into());
        mob.kind = CharacterKind::Mob;
        assert!(w.join_campaign(mob).is_err(), "only players may join");
        assert!(!w.characters.contains_key(&CharacterId("m".into())), "a rejected join inserts nothing");
    }

    #[test]
    fn leave_removes_from_party_and_keeps_the_active_position() {
        // Party [a, b, c], active index 2 (c). b (index 1, earlier than active) leaves ⇒ active
        // shifts down to 1 so it still points at c.
        let mut w = world_with_party(&["a", "b", "c"], 10);
        w.campaign.started = true;
        w.campaign.gm_id = Some(CharacterId("a".into()));
        w.campaign.active_character_index = 2;
        w.leave_campaign(&CharacterId("b".into())).unwrap();
        assert_eq!(w.campaign.party_ids, alloc::vec![CharacterId("a".into()), CharacterId("c".into())]);
        assert_eq!(w.campaign.active_character_index, 1, "active still points at c");
    }

    #[test]
    fn leave_wraps_the_active_index_when_it_dangles() {
        // Party [a, b], active index 1 (b). b leaves ⇒ active (1) now past the shrunk party (len 1),
        // wraps to 0.
        let mut w = world_with_party(&["a", "b"], 10);
        w.campaign.started = true;
        w.campaign.gm_id = Some(CharacterId("a".into()));
        w.campaign.active_character_index = 1;
        w.leave_campaign(&CharacterId("b".into())).unwrap();
        assert_eq!(w.campaign.party_ids, alloc::vec![CharacterId("a".into())]);
        assert_eq!(w.campaign.active_character_index, 0, "active wrapped to 0");
    }

    #[test]
    fn the_gm_cannot_leave() {
        let mut w = started_with_gm(); // gm = a
        assert!(w.leave_campaign(&CharacterId("a".into())).is_err());
        assert!(w.campaign.party_ids.contains(&CharacterId("a".into())), "gm stays in the party");
    }

    #[test]
    fn leave_rejects_an_unknown_target() {
        let mut w = started_with_gm();
        assert!(w.leave_campaign(&CharacterId("ghost".into())).is_err());
    }
}
