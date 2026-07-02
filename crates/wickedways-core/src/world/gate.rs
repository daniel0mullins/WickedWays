//! Affliction action gating — mirrors `afflictions.ts` `gate(isMove)` (:158-175)
//! and `character.ts` `attemptAction` (:421-434) + `recordAction` (:515-538).
//!
//! Three verdicts:
//! - **Block** — a hard block (KO, Panic-on-non-move, Fear-on-move). The mutator
//!   throws `ProceduralViolation(reason)`; NO history/cue/budget side-effects.
//! - **Fizzle** — an active Confused status rolled a failure. The mutator records a
//!   `{kind:"fumble", action, round}` history entry AND emits an `{kind:"action",
//!   action:"fumble", actor, sound}` cue UNCONDITIONALLY, ticks the budget ONLY IF
//!   the method is budgeted, then skips the action body (returns its early-ok).
//! - **Allow** — the action proceeds normally.
//!
//! RNG: the only rng draw during an action is the Confused fizzle roll
//! (`roll(100, rng.next_f64())`), and only when Confused is active.
use alloc::string::String;
use alloc::vec::Vec;

use crate::dice::roll;
use crate::presentation::{ActionKind, EntityRef, PresentationCue};
use crate::world::afflictions::{default_affliction_config, Status};
use crate::world::descriptor::Catalog;
use crate::world::history::ActionHistoryEntry;
use crate::world::ids::CharacterId;
use crate::world::World;

/// The verdict from gating an attempted action against active afflictions.
/// Mirrors TS `GateVerdict` (`{ kind: "allow" } | { kind: "fizzle" } | { kind: "block", reason }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateVerdict {
    Allow,
    Fizzle,
    Block(String),
}

impl World {
    /// Verdict for an attempted action by `actor`. Hard blocks (KO, Panic-on-non-move,
    /// Fear-on-move) come first; an active Confused then rolls a fizzle. Draws the rng
    /// ONLY in the Confused branch. Mirrors `afflictions.ts:158-175`.
    pub fn gate(&mut self, actor: &CharacterId, is_move: bool) -> GateVerdict {
        let (ko, panic, fear, confused) = match self.characters.get(actor) {
            Some(c) => (
                c.afflictions.is_active(Status::Ko),
                c.afflictions.is_active(Status::Panic),
                c.afflictions.is_active(Status::Fear),
                c.afflictions.is_active(Status::Confused),
            ),
            None => return GateVerdict::Allow,
        };
        if ko {
            return GateVerdict::Block("Cannot act while KO'd.".into());
        }
        if panic && !is_move {
            return GateVerdict::Block("Panicked: can only move.".into());
        }
        if fear && is_move {
            return GateVerdict::Block("Too afraid to move.".into());
        }
        if confused {
            let cfg = default_affliction_config();
            if (roll(100, self.rng.next_f64()) as i64) <= cfg.confused_fail_chance {
                return GateVerdict::Fizzle;
            }
        }
        GateVerdict::Allow
    }

    /// Record a Confused fizzle: push a `{kind:"fumble", action, round}` history entry,
    /// emit an `{kind:"action", action:"fumble", actor, sound}` cue UNCONDITIONALLY, and
    /// tick the budget ONLY IF `budgeted`. Mirrors `character.ts` `recordAction` (:515-538)
    /// for the `{kind:"fumble"}` detail.
    pub fn record_fumble(
        &mut self,
        actor: &CharacterId,
        action: &str,
        budgeted: bool,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        let round = self.campaign.round;
        let actor_name = self
            .characters
            .get(actor)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        if let Some(c) = self.characters.get_mut(actor) {
            c.history.push(ActionHistoryEntry::Fumble {
                round,
                action: action.into(),
            });
        }
        cues.push(PresentationCue::Action {
            action: ActionKind::Fumble,
            actor: EntityRef { id: actor.0.clone(), name: actor_name },
            sound: None,
        });
        // Cap check runs UNCONDITIONALLY (matching TS `recordAction`, character.ts:
        // 530-537, where the cap check sits outside the budgeted block) — a free
        // fumble (`budgeted = false`) must still end the turn if already at cap.
        self.record_action(actor, budgeted, cat, cues);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::afflictions::Status;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    /// Build a world with one player and set a single active affliction on them.
    fn world_with_affliction(status: Status) -> (World, CharacterId) {
        let mut w = world_with_party(&["pc"], 10);
        let id = cid("pc");
        w.characters.get_mut(&id).unwrap().afflictions.set_active(status, true);
        (w, id)
    }

    #[test]
    fn gate_ko_blocks_everything() {
        let (mut w, actor) = world_with_affliction(Status::Ko);
        assert!(matches!(w.gate(&actor, false), GateVerdict::Block(_)));
        assert!(matches!(w.gate(&actor, true), GateVerdict::Block(_)));
    }

    #[test]
    fn gate_ko_block_message() {
        let (mut w, actor) = world_with_affliction(Status::Ko);
        match w.gate(&actor, false) {
            GateVerdict::Block(r) => assert_eq!(r, "Cannot act while KO'd."),
            other => panic!("expected Block, got {:?}", other),
        }
    }

    #[test]
    fn gate_panic_blocks_non_move_allows_move() {
        let (mut w, actor) = world_with_affliction(Status::Panic);
        match w.gate(&actor, false) {
            GateVerdict::Block(r) => assert_eq!(r, "Panicked: can only move."),
            other => panic!("expected Block, got {:?}", other),
        }
        assert_eq!(w.gate(&actor, true), GateVerdict::Allow);
    }

    #[test]
    fn gate_fear_blocks_move_allows_non_move() {
        let (mut w, actor) = world_with_affliction(Status::Fear);
        match w.gate(&actor, true) {
            GateVerdict::Block(r) => assert_eq!(r, "Too afraid to move."),
            other => panic!("expected Block, got {:?}", other),
        }
        assert_eq!(w.gate(&actor, false), GateVerdict::Allow);
    }

    #[test]
    fn gate_confused_fizzles_per_roll() {
        // confused_fail_chance = 50. roll(100, u) = floor(u*100)+1.
        // A draw producing roll <= 50 → Fizzle; a draw producing roll > 50 → Allow.
        // Seed the rng and inspect the first draw to pick the branch deterministically.
        let (mut w, actor) = world_with_affliction(Status::Confused);

        // Peek the first draw the gate will consume.
        let mut peek = w.rng.clone();
        let r = (roll(100, peek.next_f64()) as i64) <= default_affliction_config().confused_fail_chance;
        let verdict = w.gate(&actor, false);
        if r {
            assert_eq!(verdict, GateVerdict::Fizzle, "roll<=50 should fizzle");
        } else {
            assert_eq!(verdict, GateVerdict::Allow, "roll>50 should allow");
        }
    }

    #[test]
    fn gate_confused_draws_rng_only_when_confused() {
        // No affliction → gate does NOT draw the rng.
        let mut w = world_with_party(&["pc"], 10);
        let actor = cid("pc");
        let before = w.rng.clone();
        let _ = w.gate(&actor, false);
        assert_eq!(w.rng, before, "gate should not draw rng when no affliction active");

        // Confused → gate draws exactly one rng value.
        w.characters.get_mut(&actor).unwrap().afflictions.set_active(Status::Confused, true);
        let mut expect = w.rng.clone();
        expect.next_f64();
        let _ = w.gate(&actor, false);
        assert_eq!(w.rng, expect, "gate should draw exactly one rng value when Confused");
    }

    #[test]
    fn gate_no_affliction_allows() {
        let mut w = world_with_party(&["pc"], 10);
        let actor = cid("pc");
        assert_eq!(w.gate(&actor, false), GateVerdict::Allow);
        assert_eq!(w.gate(&actor, true), GateVerdict::Allow);
    }

    #[test]
    fn record_fumble_budgeted_ticks_and_records() {
        let mut w = world_with_party(&["pc"], 10);
        let actor = cid("pc");
        let mut cues = Vec::new();
        w.record_fumble(&actor, "takeFromLootBox", true, &Catalog::default(), &mut cues);

        let ch = &w.characters[&actor];
        assert_eq!(ch.actions_this_round, 1, "budgeted fumble ticks budget");
        assert_eq!(ch.history.len(), 1);
        match &ch.history[0] {
            ActionHistoryEntry::Fumble { round: 0, action } => {
                assert_eq!(action, "takeFromLootBox");
            }
            other => panic!("expected Fumble history, got {:?}", other),
        }
        assert_eq!(cues.len(), 1);
        match &cues[0] {
            PresentationCue::Action { action: ActionKind::Fumble, actor, sound: None } => {
                assert_eq!(actor.id, "pc");
            }
            other => panic!("expected Action(fumble) cue, got {:?}", other),
        }
    }

    #[test]
    fn record_fumble_free_records_but_does_not_tick() {
        let mut w = world_with_party(&["pc"], 10);
        let actor = cid("pc");
        let mut cues = Vec::new();
        w.record_fumble(&actor, "equip", false, &Catalog::default(), &mut cues);

        let ch = &w.characters[&actor];
        assert_eq!(ch.actions_this_round, 0, "free fumble does NOT tick budget");
        assert_eq!(ch.history.len(), 1, "free fumble still records a Fumble entry");
        assert_eq!(cues.len(), 1, "free fumble still emits a fumble cue");
    }
}
