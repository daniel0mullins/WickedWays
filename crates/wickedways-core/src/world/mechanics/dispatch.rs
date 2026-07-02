//! Mechanic dispatch (collect-then-apply) + effect application. Byte-exact port of
//! `dispatch.ts` (`runReducers`, `runDamageTransformers`) and `apply.ts` (`applyEffect`).
use alloc::format;
use alloc::vec::Vec;

use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::stats::StatType;
use crate::world::descriptor::Catalog;
use crate::world::ids::CharacterId;
use crate::world::mechanics::{
    mechanic_op, ActionView, DamageView, Effect, HookCtx, TransformResult, ALL_STATUSES,
    MAX_EFFECTS_PER_EVENT,
};
use crate::world::World;

/// Which round hook to run.
#[derive(Clone, Copy)]
pub enum RoundPhase { Start, End }
/// Which turn hook to run.
#[derive(Clone, Copy)]
pub enum TurnPhase { Start, End }

impl World {
    /// TS `[ADJUST_STAT]` (character.ts:359-362): `stats[stat] = max(0, stats[stat]+delta)`
    /// then reconcile. The sole mechanic-facing stat mutator.
    pub fn adjust_stat(
        &mut self,
        actor: &CharacterId,
        stat: StatType,
        delta: f64,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) {
        if let Some(c) = self.characters.get_mut(actor) {
            let cur = match stat {
                StatType::Health => &mut c.stats.health,
                StatType::Sanity => &mut c.stats.sanity,
                StatType::Energy => &mut c.stats.energy,
            };
            *cur = (*cur + delta).max(0.0);
        }
        self.reconcile(actor, cat, cues);
    }

    /// Route one effect to state (TS `applyEffect`). Damage/Heal/AdjustStat reconcile
    /// (via `adjust_stat`); GrantImmunity/Cue/Status do not.
    pub fn apply_effect(&mut self, e: Effect, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        match e {
            Effect::Damage { target, amount } => {
                self.adjust_stat(&target, StatType::Health, -amount.max(0.0), cat, cues)
            }
            Effect::Heal { target, amount } => {
                self.adjust_stat(&target, StatType::Health, amount.max(0.0), cat, cues)
            }
            Effect::AdjustStat { target, stat, delta } => {
                self.adjust_stat(&target, stat, delta, cat, cues)
            }
            Effect::GrantImmunity { target, turns } => {
                // TS `Math.max(0, Math.trunc(turns))`; `as i64` truncates toward
                // zero, so after the 0-floor the cast IS the trunc (core-only —
                // `f64::trunc` needs std).
                let t = turns.max(0.0) as i64;
                if let Some(c) = self.characters.get_mut(&target) {
                    c.afflictions.grant_immunity(&ALL_STATUSES, t);
                }
            }
            Effect::Cue { cue } => cues.push(PresentationCue::Mechanic { cue }),
            Effect::Status { fields } => cues.push(PresentationCue::Status { fields }),
        }
    }

    /// Apply a queued effect batch in order (collect-then-apply tail).
    fn apply_all(&mut self, effects: Vec<Effect>, cat: &Catalog, cues: &mut Vec<PresentationCue>) {
        for e in effects {
            self.apply_effect(e, cat, cues);
        }
    }

    /// Dispatch a round hook to every live mechanic (collect-then-apply, opt-in order,
    /// per-mechanic 64-cap). No-op when there are no mechanics (existing goldens unchanged).
    pub fn dispatch_round(
        &mut self,
        phase: RoundPhase,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let mut cx = HookCtx { state: &mut m.state, view: &view, rng: &mut *rng };
                let effects = match phase {
                    RoundPhase::Start => op.on_round_start(&mut cx),
                    RoundPhase::End => op.on_round_end(&mut cx),
                };
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Dispatch a turn hook (adds `actor` to the ctx). Same discipline as `dispatch_round`.
    pub fn dispatch_turn(
        &mut self,
        phase: TurnPhase,
        actor: &CharacterId,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let actor_view = view.party.iter().find(|c| &c.id == actor).cloned();
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                // actor_view is required by TurnCtx; if the actor isn't a party member
                // there is nothing to project — skip (mirrors TS where turn hooks always
                // have the acting PlayerCharacter).
                let Some(av) = actor_view.clone() else { continue };
                let base = HookCtx { state: &mut m.state, view: &view, rng: &mut *rng };
                let mut cx = crate::world::mechanics::TurnCtx { base, actor: av };
                let effects = match phase {
                    TurnPhase::Start => op.on_turn_start(&mut cx),
                    TurnPhase::End => op.on_turn_end(&mut cx),
                };
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Dispatch `on_action` for a budgeted action (TS `[DISPATCH_ACTION]`).
    pub fn dispatch_action(
        &mut self,
        actor: &CharacterId,
        action: ActionView,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if self.campaign.mechanics.is_empty() {
            return Ok(());
        }
        let view = self.build_campaign_view(cat);
        let actor_view = view.party.iter().find(|c| &c.id == actor).cloned();
        let mut queued: Vec<Effect> = Vec::new();
        {
            let rng = &mut self.rng;
            for m in self.campaign.mechanics.iter_mut() {
                let Some(op) = mechanic_op(&m.key) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let Some(av) = actor_view.clone() else { continue };
                let base = HookCtx { state: &mut m.state, view: &view, rng: &mut *rng };
                let mut cx = crate::world::mechanics::ActionCtx {
                    base, actor: av, action: action.clone(),
                };
                let effects = op.on_action(&mut cx);
                if effects.len() > MAX_EFFECTS_PER_EVENT {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' emitted too many effects.", m.key
                    )));
                }
                queued.extend(effects);
            }
        }
        self.apply_all(queued, cat, cues);
        Ok(())
    }

    /// Fold post-mitigation damage through each mechanic's `modify_damage`
    /// (TS `runDamageTransformers`). Clamp `>= 0` after each step; a `Final`
    /// result emits `"{key} fixed damage at {value}."` and short-circuits.
    pub fn run_damage_transformers(
        &mut self,
        dv: DamageView,
        cues: &mut Vec<PresentationCue>,
        cat: &Catalog,
    ) -> f64 {
        if self.campaign.mechanics.is_empty() {
            return dv.amount;
        }
        let view = self.build_campaign_view(cat);
        let mut value = dv.amount;
        let rng = &mut self.rng;
        for m in self.campaign.mechanics.iter_mut() {
            let Some(op) = mechanic_op(&m.key) else { continue };
            let stepped = DamageView { amount: value, ..dv.clone() };
            let mut cx = HookCtx { state: &mut m.state, view: &view, rng: &mut *rng };
            match op.modify_damage(&stepped, &mut cx) {
                TransformResult::Value(v) => value = v.max(0.0),
                TransformResult::Final(v) => {
                    let next = v.max(0.0);
                    cues.push(PresentationCue::Mechanic {
                        cue: crate::presentation::MechanicCue {
                            text: Some(format!("{} fixed damage at {}.", m.key, next)),
                            sound: None,
                        },
                    });
                    return next;
                }
            }
        }
        value
    }

    /// Fail-fast on an unregistered mechanic key (TS registry throw at hydrate).
    /// Call after building a `World` for replay.
    pub fn validate_mechanics(&self) -> Result<(), ProceduralViolation> {
        for m in &self.campaign.mechanics {
            if mechanic_op(&m.key).is_none() {
                return Err(ProceduralViolation(format!(
                    "Mechanic '{}' is not registered.", m.key
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use crate::presentation::{MechanicCue, PresentationCue};
    use crate::stats::StatType;
    use crate::world::afflictions::Status;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::mechanics::Effect;
    use crate::world::snapshot::MechanicSnapshot;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    // world_with_party gives every character uniform stats:
    // health 5.0 / sanity 5.0 / energy 5.0 (test_support.rs); the second
    // argument is max_rounds, not a stat.

    #[test]
    fn apply_damage_reduces_health_and_reconciles() {
        let mut w = world_with_party(&["pc"], 10); // health 5.0
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Damage { target: cid("pc"), amount: 3.0 },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 2.0);
    }

    #[test]
    fn apply_damage_floors_negative_amount_to_zero() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Damage { target: cid("pc"), amount: -5.0 }, // max(0,-5)=0
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 5.0);
    }

    #[test]
    fn apply_heal_floors_negative_amount_to_zero() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Heal { target: cid("pc"), amount: -4.0 }, // max(0,-4)=0
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 5.0);
        w.apply_effect(
            Effect::Heal { target: cid("pc"), amount: 2.5 },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.health, 7.5);
    }

    #[test]
    fn apply_adjust_stat_passes_delta_sign_and_floors_result() {
        let mut w = world_with_party(&["pc"], 10); // sanity 5.0
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::AdjustStat { target: cid("pc"), stat: StatType::Sanity, delta: -9.0 },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 0.0, "delta unclamped, result floored");
        // Sanity 0 → reconcile latches Panic (proves adjust_stat reconciled).
        assert!(w.characters[&cid("pc")].afflictions.is_active(Status::Panic));
    }

    #[test]
    fn apply_grant_immunity_sets_all_status_immunity_without_reconcile() {
        let mut w = world_with_party(&["pc"], 10);
        // Drive sanity to 0 WITHOUT reconciling, so Panic is not yet latched:
        // if GrantImmunity reconciled, Panic-band logic would run here.
        w.characters.get_mut(&cid("pc")).unwrap().stats.sanity = 0.0;
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::GrantImmunity { target: cid("pc"), turns: 2.9 }, // trunc -> 2
            &Catalog::default(), &mut cues,
        );
        let a = &w.characters[&cid("pc")].afflictions;
        assert_eq!(a.immunity_of(Status::Panic), 2);
        assert_eq!(a.immunity_of(Status::Fear), 2);
        assert_eq!(a.immunity_of(Status::Confused), 2);
        assert_eq!(a.immunity_of(Status::Ko), 0, "KO is never immunizable");
        assert!(!a.is_active(Status::Panic), "GrantImmunity must NOT reconcile");
        assert!(cues.is_empty());
    }

    #[test]
    fn apply_grant_immunity_negative_turns_floor_to_zero() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::GrantImmunity { target: cid("pc"), turns: -3.7 }, // max(0,trunc(-3.7))=0
            &Catalog::default(), &mut cues,
        );
        assert_eq!(w.characters[&cid("pc")].afflictions.immunity_of(Status::Panic), 0);
    }

    #[test]
    fn apply_cue_and_status_emit_and_do_not_change_stats() {
        let mut w = world_with_party(&["pc"], 10);
        let mut cues = Vec::new();
        w.apply_effect(
            Effect::Cue { cue: MechanicCue { text: Some("boo".into()), sound: None } },
            &Catalog::default(), &mut cues,
        );
        assert_eq!(cues.len(), 1);
        assert!(matches!(cues[0], PresentationCue::Mechanic { .. }));
        assert_eq!(w.characters[&cid("pc")].stats.health, 5.0);
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 5.0);
        assert_eq!(w.characters[&cid("pc")].stats.energy, 5.0);
    }

    // -- dispatch + validate --

    #[test]
    fn dispatch_round_no_mechanics_is_a_noop_and_draws_no_rng() {
        let mut w = world_with_party(&["pc"], 10);
        let rng_before = w.rng.clone();
        let mut cues = Vec::new();
        w.dispatch_round(RoundPhase::Start, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(w.rng, rng_before, "empty mechanics fast path must not touch rng");
        assert!(cues.is_empty());
    }

    #[test]
    fn dispatch_round_with_registered_dread_op_emits_cues_and_ticks_sanity() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({"ticks": 0}),
        });
        let mut cues = Vec::new();
        w.dispatch_round(RoundPhase::Start, &Catalog::default(), &mut cues).unwrap();
        w.dispatch_round(RoundPhase::End, &Catalog::default(), &mut cues).unwrap();
        // on_round_start: "Dread stirs."; on_round_end: AdjustStat(Sanity,-1) then
        // "Dread deepens." — health untouched, sanity ticks down, ticks persisted.
        assert_eq!(w.characters[&cid("pc")].stats.health, 5.0, "dread never touches health");
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 4.0, "on_round_end ticks Sanity -1");
        assert_eq!(cues.len(), 2, "\"Dread stirs.\" + \"Dread deepens.\"");
        assert_eq!(w.campaign.mechanics[0].state, serde_json::json!({"ticks": 1}));
    }

    #[test]
    fn dispatch_round_unregistered_key_is_a_procedural_violation() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "nope".into(),
            state: serde_json::json!({}),
        });
        let mut cues = Vec::new();
        let err = w.dispatch_round(RoundPhase::Start, &Catalog::default(), &mut cues).unwrap_err();
        assert!(err.0.contains("nope"));
    }

    #[test]
    fn dispatch_turn_and_action_with_registered_op_are_ok() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({"ticks": 0}),
        });
        let mut cues = Vec::new();
        w.dispatch_turn(TurnPhase::Start, &cid("pc"), &Catalog::default(), &mut cues).unwrap();
        w.dispatch_turn(TurnPhase::End, &cid("pc"), &Catalog::default(), &mut cues).unwrap();
        w.dispatch_action(
            &cid("pc"),
            crate::world::mechanics::ActionView { kind: "move".into() },
            &Catalog::default(),
            &mut cues,
        ).unwrap();
        // "The dread watches." + "The dread recedes." + "The dread notices."
        assert_eq!(cues.len(), 3);
    }

    #[test]
    fn run_damage_transformers_identity_with_no_mechanics_then_dread_caps_at_three() {
        let mut w = world_with_party(&["pc"], 10);
        let dv = crate::world::mechanics::DamageView {
            amount: 3.5,
            target: cid("pc"),
            stat: StatType::Health,
            source: None,
        };
        let mut cues = Vec::new();
        assert_eq!(w.run_damage_transformers(dv.clone(), &mut cues, &Catalog::default()), 3.5);
        // Dread's modify_damage: amount(3.5) > 3.0 -> Final(3.0), short-circuits
        // with a "{key} fixed damage at {value}." cue.
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({"ticks": 0}),
        });
        assert_eq!(w.run_damage_transformers(dv, &mut cues, &Catalog::default()), 3.0);
        assert_eq!(cues.len(), 1);
        assert!(matches!(cues[0], PresentationCue::Mechanic { .. }));
    }

    // -- MAX_EFFECTS_PER_EVENT (64) cap --

    #[test]
    fn dispatch_round_at_cap_of_64_effects_is_ok() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "test:effect-count".into(),
            state: serde_json::json!({"n": 64}),
        });
        let mut cues = Vec::new();
        w.dispatch_round(RoundPhase::End, &Catalog::default(), &mut cues).unwrap();
        assert_eq!(cues.len(), 64);
    }

    #[test]
    fn dispatch_round_over_cap_of_65_effects_is_a_procedural_violation() {
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "test:effect-count".into(),
            state: serde_json::json!({"n": 65}),
        });
        let mut cues = Vec::new();
        let err = w.dispatch_round(RoundPhase::End, &Catalog::default(), &mut cues).unwrap_err();
        assert!(err.0.contains("too many effects"));
    }

    #[test]
    fn validate_mechanics_rejects_unregistered_and_accepts_registered() {
        let mut w = world_with_party(&["pc"], 10);
        assert!(w.validate_mechanics().is_ok(), "no mechanics is valid");
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "conformance:dread".into(),
            state: serde_json::json!({}),
        });
        assert!(w.validate_mechanics().is_ok());
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "dread".into(), // TS seed key, NOT registered in Rust
            state: serde_json::json!({}),
        });
        let err = w.validate_mechanics().unwrap_err();
        assert!(err.0.contains("dread"));
    }
}
