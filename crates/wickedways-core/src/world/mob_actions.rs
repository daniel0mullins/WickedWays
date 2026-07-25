//! Mob-issued actions (Phase 2c, sub-project A2). First: `mobEscape` (`Mob.escape`).

use alloc::vec::Vec;

use crate::dice::roll;
use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::gate::GateVerdict;
use crate::world::history::ActionHistoryEntry;
use crate::world::ids::{CharacterId, RoomId};
use crate::world::World;

impl World {
    /// A mob attempts to flee its room. Mirrors `Mob.escape` (`src/lib/character/mob.ts`):
    /// affliction-gated (Confused → fumble, no-op); the escape threshold is
    /// `clamp(baseEscapeChance + effectiveStat(Health), 0, 100)`; a `roll(100)` under the threshold
    /// with at least one exit is a success, which draws a second roll to pick an exit and relocates
    /// the mob through it; either way an `escape` history entry records the outcome.
    ///
    /// The two rng draws (threshold roll, then exit pick on success) are ordered exactly as the TS
    /// so a seeded replay lands on the identical result.
    pub fn mob_escape(
        &mut self,
        mob: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        // 0. Affliction gate (not budgeted). Fizzle → fumble, no-op (TS returns early).
        match self.gate(mob, false) {
            GateVerdict::Block(r) => return Err(ProceduralViolation(r)),
            GateVerdict::Fizzle => {
                self.record_fumble(mob, "escape", false, cat, cues)?;
                return Ok(());
            }
            GateVerdict::Allow => {}
        }

        // 1. Current room + its exits (in the room's stored order).
        let room_id = self
            .characters
            .get(mob)
            .and_then(|c| c.current_room_id.clone());
        let exit_ids: Vec<_> = room_id
            .as_ref()
            .and_then(|rid| self.rooms.get(rid))
            .map(|r| r.exits.values().cloned().collect())
            .unwrap_or_default();

        // 2. Threshold and the (always-drawn) escape roll.
        let base = self
            .characters
            .get(mob)
            .and_then(|c| c.base_escape_chance)
            .unwrap_or(0) as f64;
        let effective_health = self.effective_stat(mob, StatType::Health, cat);
        let threshold = (base + effective_health).clamp(0.0, 100.0);
        let rolled = f64::from(roll(100, self.rng.next_f64())) <= threshold;
        let success = rolled && !exit_ids.is_empty();

        // 3. On success, pick an exit (second draw) and relocate through it.
        if success {
            let idx = (roll(exit_ids.len() as u32, self.rng.next_f64()) - 1) as usize;
            let destination = room_id.as_ref().and_then(|rid| {
                self.exits
                    .get(&exit_ids[idx])
                    .map(|e| other_side(&e.endpoint_ids, rid))
            });
            if let Some(dest) = destination {
                self.move_to(mob, dest, cat, cues)?;
            }
        }

        // 4. Record the outcome (mirrors `recordAction(escape, { kind: "escape", success })`).
        let round = self.campaign.round;
        if let Some(c) = self.characters.get_mut(mob) {
            c.history
                .push(ActionHistoryEntry::Escape { round, success });
        }
        Ok(())
    }
}

/// The endpoint of a two-sided exit that is NOT `from`.
fn other_side(endpoints: &[RoomId; 2], from: &RoomId) -> RoomId {
    if &endpoints[0] == from {
        endpoints[1].clone()
    } else {
        endpoints[0].clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::rng::Rng;
    use crate::world::test_support::world_two_rooms;

    /// Turn the lone pc in `world_two_rooms` into an escaping mob in "start" (which has a north exit
    /// to "next"), with a chosen base-escape chance.
    fn escaping_mob(base_escape_chance: i64) -> (World, CharacterId) {
        let mut w = world_two_rooms(false);
        let mob = CharacterId("pc".into());
        {
            let c = w.characters.get_mut(&mob).unwrap();
            c.kind = crate::world::snapshot::CharacterKind::Mob;
            c.base_escape_chance = Some(base_escape_chance);
        }
        (w, mob)
    }

    #[test]
    fn a_certain_escape_relocates_through_the_exit_and_records_success() {
        let (mut w, mob) = escaping_mob(100); // threshold clamps to 100 → always rolls under
        w.rng = Rng::seeded(1);
        let mut cues = Vec::new();
        w.mob_escape(&mob, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(
            w.characters[&mob].current_room_id,
            Some(RoomId("next".into())),
            "moved through exit"
        );
        assert!(matches!(
            w.characters[&mob].history.last(),
            Some(ActionHistoryEntry::Escape { success: true, .. })
        ));
    }

    #[test]
    fn a_failed_escape_stays_put_and_records_failure() {
        // base 0 + low effective health → tiny threshold; seed 1's first draw (~0.63) rolls high.
        let (mut w, mob) = escaping_mob(0);
        w.rng = Rng::seeded(1);
        let mut cues = Vec::new();
        w.mob_escape(&mob, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(
            w.characters[&mob].current_room_id,
            Some(RoomId("start".into())),
            "did not move"
        );
        assert!(matches!(
            w.characters[&mob].history.last(),
            Some(ActionHistoryEntry::Escape { success: false, .. })
        ));
    }
}
