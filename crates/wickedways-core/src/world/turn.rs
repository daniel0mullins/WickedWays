use alloc::collections::BTreeSet;
use alloc::format;
use alloc::vec::Vec;
use crate::error::ProceduralViolation;
use crate::presentation::{CampaignOutcome, PresentationCue};
use crate::stats::StatType;
use crate::world::afflictions::{default_affliction_config, Status};
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::resolve::resolve_item;
use crate::world::World;

impl World {
    pub fn active_character_id(&self) -> Result<CharacterId, ProceduralViolation> {
        let i = self.campaign.active_character_index as usize;
        self.campaign.party_ids.get(i).cloned()
            .ok_or_else(|| ProceduralViolation(format!("no active character at index {i}")))
    }

    pub fn begin_campaign(&mut self, _cues: &mut Vec<PresentationCue>) {
        self.campaign.started = true;
        // onRoundStart mechanic dispatch is a no-op until sub-plan 6 (empty registry).
    }

    /// Statuses immunized by equipped, non-broken gear or the selected archetype.
    /// Mirrors `character.ts:#passiveImmunities` (character.ts:320-328): for each
    /// equipped item, skip if broken or lacking immunities, else union its
    /// `immunities`; then union the character's `archetype_immunities`.
    ///
    /// Equipped-ness is derived from `CharacterSnapshot.equipment` (the slot map),
    /// matching `effective_stat`. `immunities` is an inert `Value` on the catalog
    /// descriptor (not on `ResolvedItem`), so it is read via `cat.items`.
    pub fn passive_immune(&self, actor: &CharacterId, cat: &Catalog) -> BTreeSet<Status> {
        let mut set: BTreeSet<Status> = BTreeSet::new();
        if let Some(ch) = self.characters.get(actor) {
            // De-duplicate: a two-handed item occupies two slot-map entries.
            let equipped_ids: BTreeSet<&crate::world::ids::ItemId> =
                ch.equipment.values().collect();
            for item_id in equipped_ids {
                let Some(snap) = self.items.get(item_id) else { continue };
                let Ok(resolved) = resolve_item(snap, cat) else { continue };
                if resolved.is_broken {
                    continue;
                }
                // Only catalog-backed items carry immunities; keys never do.
                let crate::world::snapshot::ItemSnapshot::Item { behavior_key, .. } = snap else {
                    continue;
                };
                let Some(desc) = cat.items.get(behavior_key) else { continue };
                if let Ok(list) =
                    serde_json::from_value::<Vec<Status>>(desc.immunities.clone())
                {
                    for s in list {
                        set.insert(s);
                    }
                }
            }
            for s in &ch.archetype_immunities {
                set.insert(*s);
            }
        }
        set
    }

    pub fn start_turn(&mut self, actor: &CharacterId, cat: &Catalog) {
        // Effective stats + passive immunities computed first (immutable borrows).
        let health = self.effective_stat(actor, StatType::Health, cat);
        let sanity = self.effective_stat(actor, StatType::Sanity, cat);
        let energy = self.effective_stat(actor, StatType::Energy, cat);
        let passive = self.passive_immune(actor, cat);
        let config = default_affliction_config();
        // Disjoint mutable borrows of self.rng and self.characters (different
        // fields of self, borrowed directly to satisfy the borrow checker).
        let rng = &mut self.rng;
        if let Some(c) = self.characters.get_mut(actor) {
            c.actions_this_round = 0;
            c.afflictions
                .on_turn_start(health, sanity, energy, &passive, &config, rng);
        }
        // character events + DISPATCH_TURN("start"): no-ops until sub-plan 6.
    }

    pub fn end_turn(&mut self, _actor: &CharacterId) {
        // character events + reconcile + mechanic turn-end: no-ops this sub-plan.
    }

    pub fn next_player(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        let active = self.active_character_id()?;
        if !self.campaign.acted_this_round.contains(&active) {
            self.campaign.acted_this_round.push(active);
        }
        let next = self.campaign.active_character_index + 1;
        if next as usize == self.campaign.party_ids.len() {
            self.campaign.active_character_index = 0;
            self.end_round(cues)?;
        } else {
            self.campaign.active_character_index = next;
        }
        Ok(())
    }

    pub fn end_round(&mut self, cues: &mut Vec<PresentationCue>) -> Result<(), ProceduralViolation> {
        self.assert_running()?;
        let all_acted = self.campaign.party_ids.iter()
            .all(|id| self.campaign.acted_this_round.contains(id));
        if !all_acted {
            return Err(ProceduralViolation(
                "Attempted to end round before all characters have acted".into()));
        }
        // onRoundEnd dispatch: no-op (sub-plan 6).
        self.campaign.round += 1;
        self.campaign.acted_this_round.clear();
        // Minimal resolver: timeout only. Win/lose -> sub-plan 7.
        if self.campaign.round >= self.campaign.max_rounds {
            self.finish(CampaignOutcome::TimedOut, None, cues);
            return Ok(());
        }
        // onRoundStart dispatch: no-op (sub-plan 6).
        Ok(())
    }

    fn finish(&mut self, outcome: CampaignOutcome, reason: Option<alloc::string::String>,
              cues: &mut Vec<PresentationCue>) {
        self.campaign.outcome = outcome;
        self.campaign.outcome_reason = reason.clone();
        cues.push(PresentationCue::Resolution { outcome, reason, narration: None });
    }

    fn assert_running(&self) -> Result<(), ProceduralViolation> {
        if !self.campaign.started || self.campaign.outcome != CampaignOutcome::Ongoing {
            return Err(ProceduralViolation("campaign is not running".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::{CampaignOutcome, PresentationCue};
    use crate::world::ids::CharacterId;
    // test-utils helper that builds a minimal started World with `party` ids,
    // `max_rounds`, round 0, outcome Ongoing, and a character per id.
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    #[test]
    fn next_player_single_member_wraps_and_advances_round() {
        let mut w = world_with_party(&["pc"], /*max_rounds*/ 10);
        let mut cues = Vec::new();
        w.next_player(&mut cues).unwrap();
        assert_eq!(w.campaign.round, 1);
        assert!(w.campaign.acted_this_round.is_empty()); // reset after end_round
        assert!(cues.is_empty()); // still ongoing, no resolution cue
    }

    #[test]
    fn end_round_before_all_acted_is_a_violation() {
        let mut w = world_with_party(&["a", "b"], 10);
        let mut cues = Vec::new();
        // only `a` acted
        w.campaign.acted_this_round = vec![cid("a")];
        assert!(w.end_round(&mut cues).is_err());
    }

    #[test]
    fn timeout_at_max_rounds_finishes_and_emits_resolution() {
        let mut w = world_with_party(&["pc"], 1);
        let mut cues = Vec::new();
        w.next_player(&mut cues).unwrap(); // round 0 -> 1 == max_rounds -> timed-out
        assert_eq!(w.campaign.outcome, CampaignOutcome::TimedOut);
        assert_eq!(cues, vec![PresentationCue::Resolution {
            outcome: CampaignOutcome::TimedOut, reason: None, narration: None }]);
    }

    #[test]
    fn start_turn_resets_action_budget() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10);
        if let Some(c) = w.characters.get_mut(&cid("pc")) { c.actions_this_round = 2; }
        w.start_turn(&cid("pc"), &Catalog::default());
        assert_eq!(w.characters.get(&cid("pc")).unwrap().actions_this_round, 0);
    }

    #[test]
    fn start_turn_runs_affliction_tick_and_ticks_active_status() {
        use crate::world::descriptor::Catalog;
        use crate::world::afflictions::Status;
        // Healthy party member (energy 5 / sanity 7 / health 10 from world_with_party),
        // but drive sanity to 0 so Panic is below-threshold: seed Panic active and
        // confirm on_turn_start ticks its counter (no manual increment in turn.rs).
        let mut w = world_with_party(&["pc"], 10);
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.sanity = 0;
            c.afflictions.set_active(Status::Panic, true);
        }
        w.start_turn(&cid("pc"), &Catalog::default());
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.afflictions.turns_active.get(&Status::Panic).copied().unwrap_or(0), 1);
        assert!(ch.afflictions.is_active(Status::Panic)); // still below threshold
    }

    #[test]
    fn start_turn_ko_when_health_le_zero_clears_clearables() {
        use crate::world::descriptor::Catalog;
        use crate::world::afflictions::Status;
        let mut w = world_with_party(&["pc"], 10);
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = 0;
            c.afflictions.set_active(Status::Fear, true);
        }
        w.start_turn(&cid("pc"), &Catalog::default());
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert!(ch.afflictions.is_active(Status::Ko));
        assert!(!ch.afflictions.is_active(Status::Fear));
    }
}
