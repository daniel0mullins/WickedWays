//! Phase 2a: the ported `GameSession.execute` orchestration.
//!
//! `run_mob_reactions` — solo-GM turn driver, faithful port of
//! `packages/play-runtime/src/session.ts:148-177`.
//! (`ExecuteResult` + `World::submit` land in the next slice of this file.)
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::snapshot::CharacterKind;
use crate::world::World;

/// A single mob-on-player strike, surfaced for typed combat feedback.
/// Mirrors the TS `MobAttack` (`session.ts:22`); `amount` is an effective-stat
/// delta (f64 per sub-plan 4b's stat model).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobAttack {
    pub name: String,
    pub stat: StatType,
    pub amount: f64,
}

impl World {
    /// Each live (non-KO) mob in the active player's current room attacks the
    /// player (the "aggro while sharing its room" rule). Returns the typed damage
    /// each dealt, derived from the player's effective-stat deltas. A mob that
    /// can't act (afflicted → `ProceduralViolation` from `attack`) simply doesn't
    /// strike; a downed player is not piled on.
    ///
    /// Faithful port of `session.ts` `runMobReactions` (:148-177):
    /// - no current room or active player KO → empty
    /// - snapshot of the occupant id list, in room order (TS `[...room.occupants]`)
    /// - skip the active character, non-`Mob`s, KO'd mobs
    /// - per stat in [Health, Sanity, Energy] order: `before - after > 0` → push
    /// - break once the player is KO
    pub fn run_mob_reactions(
        &mut self,
        active: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Vec<MobAttack> {
        const STATS: [StatType; 3] = [StatType::Health, StatType::Sanity, StatType::Energy];
        let mut attacks: Vec<MobAttack> = Vec::new();

        let Some(room_id) = self
            .characters
            .get(active)
            .and_then(|c| c.current_room_id.clone())
        else {
            return attacks;
        };
        if self.is_ko(active) {
            return attacks;
        }

        let occupant_ids: Vec<CharacterId> = self
            .rooms
            .get(&room_id)
            .map(|r| r.occupant_ids.clone())
            .unwrap_or_default();

        for occ in occupant_ids {
            if &occ == active {
                continue;
            }
            let is_mob = self
                .characters
                .get(&occ)
                .map(|c| c.kind == CharacterKind::Mob)
                .unwrap_or(false);
            if !is_mob || self.is_ko(&occ) {
                continue;
            }

            let before: [f64; 3] = STATS.map(|s| self.effective_stat(active, s, cat));
            // A blocked (afflicted) mob's ProceduralViolation is swallowed —
            // the mob simply doesn't strike (session.ts:165-168). All core
            // errors are ProceduralViolation, so every Err is the "skip" arm.
            if self.attack(&occ, active, cat, cues).is_err() {
                continue;
            }
            let after: [f64; 3] = STATS.map(|s| self.effective_stat(active, s, cat));

            let name = self
                .characters
                .get(&occ)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            for (i, stat) in STATS.iter().enumerate() {
                let dealt = before[i] - after[i];
                if dealt > 0.0 {
                    attacks.push(MobAttack {
                        name: name.clone(),
                        stat: *stat,
                        amount: dealt,
                    });
                }
            }
            if self.is_ko(active) {
                break; // don't pile on a downed player
            }
        }
        attacks
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::collections::BTreeMap;
    use alloc::string::String;
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::formations::conformance::seat_test_mob;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::snapshot::RoomSnapshot;
    use crate::world::test_support::world_with_party;
    use crate::world::World;

    fn cid(s: &str) -> CharacterId {
        CharacterId(s.into())
    }
    fn rid(s: &str) -> RoomId {
        RoomId(s.into())
    }

    /// A PC (energy 5 / sanity 7 / health 10, 2 actions/round) placed alone in
    /// "room1" (lit). Stats are set explicitly here — `world_with_party` seeds a
    /// flat 5/5/5, so the mitigation math below (mitigator = effective sanity 7)
    /// needs sanity 7 / health 10 established on the fixture.
    fn world_with_pc_in_room() -> World {
        let mut w = world_with_party(&["pc"], 10);
        let pc = cid("pc");
        {
            let c = w.characters.get_mut(&pc).unwrap();
            c.current_room_id = Some(rid("room1"));
            c.stats.energy = 5.0;
            c.stats.sanity = 7.0;
            c.stats.health = 10.0;
        }
        w.rooms.insert(
            rid("room1"),
            RoomSnapshot {
                id: rid("room1"),
                name: "Test Room".into(),
                description: String::new(),
                exits: BTreeMap::new(),
                dark: false,
                spawn_modifier: 0,
                occupant_ids: alloc::vec![pc],
                loot_ids: alloc::vec![],
                material_cache_ids: alloc::vec![],
                light_source_ids: alloc::vec![],
                scenes: alloc::vec![],
            },
        );
        w
    }

    #[test]
    fn live_mob_strikes_and_reports_typed_health_delta() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1"); // natural attack default {health, 1}
        let mut cues = Vec::new();
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut cues);
        // strength 1, armor 0, mitigator = effective sanity 7 → (10-7)*0.2 = 0.6 dealt
        assert_eq!(attacks.len(), 1);
        assert_eq!(attacks[0].name, "wraith");
        assert_eq!(attacks[0].stat, StatType::Health);
        assert!((attacks[0].amount - 0.6).abs() < 1e-9, "amount = {}", attacks[0].amount);
        // The strike actually landed on the PC.
        let health = w.effective_stat(&cid("pc"), StatType::Health, &Catalog::default());
        assert!((health - 9.4).abs() < 1e-9);
        // Cues from the attack path were emitted (takeDamage + attack action cues).
        assert!(!cues.is_empty());
    }

    #[test]
    fn ko_mob_does_not_strike() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn ko_active_player_is_not_piled_on_at_entry() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("pc")).unwrap().afflictions.set_active(Status::Ko, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
    }

    #[test]
    fn blocked_mob_violation_is_swallowed() {
        // Panic blocks non-move actions (gate.rs:53) — the mob's attack throws,
        // runMobReactions catches ProceduralViolation and skips (session.ts:165-168).
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "wraith", "room1");
        w.characters.get_mut(&cid("wraith")).unwrap().afflictions.set_active(Status::Panic, true);
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty());
        // PC untouched.
        assert_eq!(w.characters[&cid("pc")].stats.health, 10.0);
    }

    #[test]
    fn player_ko_mid_loop_stops_further_strikes() {
        let mut w = world_with_pc_in_room();
        seat_test_mob(&mut w, "mob-a", "room1");
        seat_test_mob(&mut w, "mob-b", "room1");
        // sanity 0 → mitigation multiplier 2.0 → each strike deals 2.0 health.
        // health 1 → first strike floors to 0 and latches KO → mob-b must not act.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = 1.0;
            c.stats.sanity = 0.0;
        }
        let attacks = w.run_mob_reactions(&cid("pc"), &Catalog::default(), &mut Vec::new());
        assert_eq!(attacks.len(), 1, "second mob must not pile on");
        assert_eq!(attacks[0].name, "mob-a");
        assert!(w.is_ko(&cid("pc")));
    }

    #[test]
    fn non_mob_occupant_is_skipped() {
        let mut w = world_with_party(&["pc", "ally"], 10);
        let pc = cid("pc");
        for id in ["pc", "ally"] {
            w.characters.get_mut(&cid(id)).unwrap().current_room_id = Some(rid("room1"));
        }
        w.rooms.insert(
            rid("room1"),
            RoomSnapshot {
                id: rid("room1"),
                name: "Test Room".into(),
                description: String::new(),
                exits: BTreeMap::new(),
                dark: false,
                spawn_modifier: 0,
                occupant_ids: alloc::vec![pc.clone(), cid("ally")],
                loot_ids: alloc::vec![],
                material_cache_ids: alloc::vec![],
                light_source_ids: alloc::vec![],
                scenes: alloc::vec![],
            },
        );
        let attacks = w.run_mob_reactions(&pc, &Catalog::default(), &mut Vec::new());
        assert!(attacks.is_empty()); // ally is kind=player, not Mob
    }
}
