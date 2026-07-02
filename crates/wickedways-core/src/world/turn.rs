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
        // Mirror TS `#floorAndSnapshot` (character.ts:308-317): persistently clamp
        // base stats to max(0, x) BEFORE computing effective stats.  This ensures
        // a negative base (e.g. from future damage) never bleeds into effective
        // values or affliction thresholds.
        if let Some(c) = self.characters.get_mut(actor) {
            c.stats.health = c.stats.health.max(0.0);
            c.stats.sanity = c.stats.sanity.max(0.0);
            c.stats.energy = c.stats.energy.max(0.0);
        }
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

    /// End `actor`'s turn. Mirrors TS `Character.endTurn` (character.ts:1066-1070):
    /// `events.onTurnEnd()` (sub-plan 6), `#reconcile()`, `DISPATCH_TURN("end")`
    /// (sub-plan 6). Only the reconcile lands in sub-plan 5 — it floors base stats,
    /// re-applies affliction flags from effective stats, and latches KO on the
    /// rising edge. RNG-free.
    pub fn end_turn(&mut self, actor: &CharacterId, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        // character events (events.onTurnEnd): no-op until sub-plan 6.
        self.reconcile(actor, cat, cues);
        // mechanic DISPATCH_TURN("end"): no-op until sub-plan 6.
    }

    /// Single seam mirroring the budget half of TS `Character.recordAction`
    /// (character.ts:530-537): when `budgeted`, increment `actions_this_round`
    /// (DISPATCH_ACTION/onAction is deferred to sub-plan 6); then — regardless of
    /// `budgeted`, matching TS where the cap check sits OUTSIDE the budgeted block —
    /// auto-end the turn (which reconciles the actor) when the budget is exhausted.
    /// Call at the TAIL of each action, AFTER its cue is pushed.
    pub(crate) fn record_action(
        &mut self,
        actor: &CharacterId,
        budgeted: bool,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        if budgeted {
            if let Some(c) = self.characters.get_mut(actor) {
                c.actions_this_round += 1;
            }
            // DISPATCH_ACTION (mechanic onAction): no-op until sub-plan 6.
        }
        let at_cap = self
            .characters
            .get(actor)
            .map(|c| c.actions_this_round == c.actions_per_round)
            .unwrap_or(false);
        if at_cap {
            self.end_turn(actor, cat, cues);
        }
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
            c.stats.sanity = 0.0;
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
            c.stats.health = 0.0;
            c.afflictions.set_active(Status::Fear, true);
        }
        w.start_turn(&cid("pc"), &Catalog::default());
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert!(ch.afflictions.is_active(Status::Ko));
        assert!(!ch.afflictions.is_active(Status::Fear));
    }

    // Regression: mirrors #floorAndSnapshot (character.ts:308-317).
    // Base stats must be persistently clamped to max(0, x) BEFORE computing
    // effective stats — so a negative base doesn't bleed into affliction thresholds.
    #[test]
    fn start_turn_floors_negative_base_stats_persistently() {
        use crate::world::descriptor::{
            Catalog, ItemDescriptor, ItemProperties, ItemType, SlotKind,
        };
        use crate::world::afflictions::Status;
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        use crate::stats::StatType;
        use alloc::collections::BTreeMap;
        use serde_json::json;

        // ── case 1: plain negative base sanity, no bonus ──────────────────────
        // base sanity = -3  → after floor: 0  → no Fear (0 is not > 0 && < 5)
        let mut w1 = world_with_party(&["pc"], 10);
        if let Some(c) = w1.characters.get_mut(&cid("pc")) {
            c.stats.sanity = -3.0;
        }
        w1.start_turn(&cid("pc"), &Catalog::default());
        let ch1 = w1.characters.get(&cid("pc")).unwrap();
        // (a) base floored to 0 in the snapshot
        assert_eq!(ch1.stats.sanity, 0.0,
            "base sanity should be floored to 0 (was -3)");
        // (b) no Fear — effective sanity is 0, not in (0, 5)
        assert!(!ch1.afflictions.is_active(Status::Fear),
            "sanity==0 should NOT trigger Fear (threshold is 0 < sanity < 5)");

        // ── case 2: negative base sanity + accessory +5 ───────────────────────
        // TS oracle: max(0,-3)=0, effective=0+5=5 → NOT Fear (5 < 5 is false)
        // Rust bug:  -3+5=2 → Fear (2 > 0 && 2 < 5 is true)  ← this must not happen
        let mut w2 = world_with_party(&["pc"], 10);
        let ring_id = ItemId("ring-san".into());

        // Catalog: accessory +5 sanity
        let mut items = BTreeMap::new();
        items.insert(
            "items/ring-san".to_string(),
            ItemDescriptor {
                name: "Sanity Ring".to_string(),
                r#type: ItemType::Accessory,
                stat: StatType::Sanity,
                modifier: 5,
                properties: ItemProperties {
                    equippable: true,
                    equipped: false,
                    destroyable: false,
                    usable: false,
                    droppable: None,
                },
                slot: Some(SlotKind::Finger),
                two_handed: None,
                emits_light: None,
                max_durability: None,
                lore: None,
                presentation: None,
                key_code: None,
                consume_on_use: None,
                recipe: json!({}),
                teaches: json!(null),
                immunities: json!([]),
                grants_immunity: json!(null),
            },
        );
        let cat2 = Catalog { items, aliases: BTreeMap::new() };

        // Insert item into world and equip it
        w2.items.insert(
            ring_id.clone(),
            ItemSnapshot::Item {
                id: ring_id.clone(),
                behavior_key: "items/ring-san".to_string(),
                durability: None,
                modifier: 5,
            },
        );
        if let Some(c) = w2.characters.get_mut(&cid("pc")) {
            c.stats.sanity = -3.0;
            c.equipment.insert("finger".to_string(), ring_id);
        }

        w2.start_turn(&cid("pc"), &cat2);
        let ch2 = w2.characters.get(&cid("pc")).unwrap();
        // (a) base floored to 0 in the snapshot
        assert_eq!(ch2.stats.sanity, 0.0,
            "base sanity should be floored to 0 before accessory bonus");
        // (b) effective sanity = floor(base) + bonus = 0 + 5 = 5 → NO Fear
        assert!(!ch2.afflictions.is_active(Status::Fear),
            "effective sanity 5 (=0+5) should NOT trigger Fear (5<5 is false)");
    }

    #[test]
    fn end_turn_runs_reconcile_floors_and_latches_ko() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        // Drive base health negative WITHOUT start_turn's floor, so we can prove
        // end_turn's reconcile floors it and latches KO.
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.stats.health = -3.0;
        }
        w.end_turn(&cid("pc"), &Catalog::default(), &mut cues);
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.stats.health, 0.0, "end_turn reconcile floors base health");
        assert!(ch.afflictions.is_active(Status::Ko), "end_turn reconcile latches KO");
    }

    #[test]
    fn record_action_auto_ends_turn_at_cap() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 1; // one below cap
            c.stats.health = -3.0;    // reconcile will floor this iff it runs
        }
        w.record_action(&cid("pc"), true, &Catalog::default(), &mut cues); // 1 -> 2 == cap
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 2);
        assert_eq!(ch.stats.health, 0.0, "cap reached -> end_turn -> reconcile floored base");
        assert!(ch.afflictions.is_active(Status::Ko));
    }

    #[test]
    fn record_action_below_cap_does_not_end_turn() {
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 0;
            c.stats.health = -3.0; // stays negative iff reconcile does NOT run
        }
        w.record_action(&cid("pc"), true, &Catalog::default(), &mut cues); // 0 -> 1 < cap
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 1);
        assert_eq!(ch.stats.health, -3.0, "below cap: no reconcile, base untouched");
    }

    // Fix 2 (final-review, sub-plan 5): TS `recordAction`'s cap check
    // (character.ts:530-537) sits OUTSIDE the `budgeted` block, so it must fire
    // even for a FREE call (budgeted = false) — e.g. a free fumble routed through
    // `attemptAction`. This proves a free call at-cap still triggers `end_turn`
    // (reconcile), and crucially does NOT increment `actions_this_round`.
    #[test]
    fn record_action_free_call_at_cap_still_ends_turn_but_does_not_increment() {
        use crate::world::afflictions::Status;
        use crate::world::descriptor::Catalog;
        let mut w = world_with_party(&["pc"], 10); // actions_per_round = 2
        let mut cues = Vec::new();
        if let Some(c) = w.characters.get_mut(&cid("pc")) {
            c.actions_this_round = 2; // already at cap
            c.stats.health = -3.0;    // reconcile will floor this iff end_turn runs
        }
        w.record_action(&cid("pc"), false, &Catalog::default(), &mut cues); // free call
        let ch = w.characters.get(&cid("pc")).unwrap();
        assert_eq!(ch.actions_this_round, 2, "free call must not increment the budget");
        assert_eq!(ch.stats.health, 0.0, "free call at cap -> end_turn -> reconcile floored base");
        assert!(ch.afflictions.is_active(Status::Ko), "free call at cap -> end_turn latches KO");
    }
}
