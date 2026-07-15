//! Campaign-lifecycle actions issued by the GM (Phase 2c, sub-project A2).
//!
//! Ports the GM/lifecycle commands beyond begin/end/nextPlayer. First up: `transferGM`
//! (`Campaign.transfer`) — hand the GM role to another character. Additional lifecycle actions
//! (`leaveCampaign`, …) join this module as they land.

use alloc::format;

use crate::error::ProceduralViolation;
use crate::world::ids::CharacterId;
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
}
