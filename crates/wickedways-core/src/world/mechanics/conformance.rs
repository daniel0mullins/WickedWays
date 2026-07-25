//! A first-party conformance mechanic used by the differential gate. Mirrored
//! byte-for-byte by a TS closure under key "conformance:dread". Gated so it does
//! not ship in the default build.
use alloc::vec;
use alloc::vec::Vec;
use serde_json::{json, Value};

use crate::presentation::MechanicCue;
use crate::stats::StatType;
use crate::world::ids::CharacterId;
use crate::world::mechanics::{
    ActionCtx, DamageView, Effect, HookCtx, MechanicOp, TransformResult, TurnCtx,
};

pub struct Dread;
pub static DREAD: Dread = Dread;

fn cue(text: &str) -> Effect {
    Effect::Cue {
        cue: MechanicCue {
            text: Some(text.into()),
            sound: None,
        },
    }
}

/// The `modify_damage` threshold, extracted as a free function so it is
/// unit-testable directly without constructing a `HookCtx`.
fn cap(amount: f64) -> TransformResult {
    if amount > 3.0 {
        TransformResult::Final(3.0)
    } else {
        TransformResult::Value(amount)
    }
}

/// Effects for the `conformance:dread` "brace" custom action: a cue plus a small
/// sanity heal on the bracing actor (a party member, so the party-only effect-target
/// check passes). Extracted as a free fn for direct unit testing.
fn brace_effects(actor: &CharacterId) -> Vec<Effect> {
    vec![
        cue("You brace against the dread."),
        Effect::AdjustStat {
            target: actor.clone(),
            stat: StatType::Sanity,
            delta: 1.0,
        },
    ]
}

impl MechanicOp for Dread {
    fn init_state(&self, _config: &Value) -> Value {
        json!({ "ticks": 0 })
    }
    fn on_round_start(&self, _cx: &mut HookCtx<'_>) -> Vec<Effect> {
        vec![cue("Dread stirs.")]
    }
    fn on_turn_start(&self, _cx: &mut TurnCtx<'_>) -> Vec<Effect> {
        vec![cue("The dread watches.")]
    }
    fn on_turn_end(&self, _cx: &mut TurnCtx<'_>) -> Vec<Effect> {
        vec![cue("The dread recedes.")]
    }
    fn on_action(&self, _cx: &mut ActionCtx<'_>) -> Vec<Effect> {
        vec![cue("The dread notices.")]
    }
    fn on_round_end(&self, cx: &mut HookCtx<'_>) -> Vec<Effect> {
        // Mutate persisted state: ticks += 1.
        let ticks = cx
            .state
            .get("ticks")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            + 1;
        cx.state["ticks"] = json!(ticks);
        // Target the first party member (fixtures use a single-PC party).
        let Some(target) = cx.view.party.first().map(|c| c.id.clone()) else {
            return vec![cue("Dread deepens.")];
        };
        vec![
            Effect::AdjustStat {
                target,
                stat: StatType::Sanity,
                delta: -1.0,
            },
            cue("Dread deepens."),
        ]
    }
    fn modify_damage(&self, d: &DamageView, _cx: &mut HookCtx<'_>) -> TransformResult {
        cap(d.amount)
    }
    fn run_action(&self, action_key: &str, cx: &mut ActionCtx<'_>) -> Option<Vec<Effect>> {
        match action_key {
            "brace" => Some(brace_effects(&cx.actor.id)),
            _ => None,
        }
    }
}

/// Test-only op that emits `n` cues from `on_round_end`, where `n` comes from its
/// state (`{"n": <count>}`). Used solely to unit-test the dispatch 64-effect cap
/// (`MAX_EFFECTS_PER_EVENT`) without depending on `Dread`'s fixed effect counts.
/// Registered under key "test:effect-count" in `mechanic_op` (`mod.rs`), gated
/// `#[cfg(test)]` alongside this struct so it never reaches a non-test build
/// (including `cargo build --features conformance`).
#[cfg(test)]
pub struct EffectCount;
#[cfg(test)]
pub static EFFECT_COUNT: EffectCount = EffectCount;

#[cfg(test)]
impl MechanicOp for EffectCount {
    fn init_state(&self, _config: &Value) -> Value {
        json!({ "n": 0 })
    }
    fn on_round_end(&self, cx: &mut HookCtx<'_>) -> Vec<Effect> {
        let n = cx
            .state
            .get("n")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            .max(0);
        (0..n).map(|_| cue("x")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dread_init_state_is_zeroed_ticks() {
        assert_eq!(DREAD.init_state(&json!(null)), json!({ "ticks": 0 }));
    }

    #[test]
    fn cap_passes_through_at_and_below_threshold() {
        assert_eq!(cap(3.0), TransformResult::Value(3.0));
        assert_eq!(cap(2.0), TransformResult::Value(2.0));
    }

    #[test]
    fn cap_finalizes_above_threshold() {
        assert_eq!(cap(3.5), TransformResult::Final(3.0));
        assert_eq!(cap(9.0), TransformResult::Final(3.0));
    }

    #[test]
    fn brace_effects_heal_actor_sanity_with_cue() {
        use crate::world::ids::CharacterId;
        let fx = brace_effects(&CharacterId("pc".into()));
        assert_eq!(fx.len(), 2);
        assert!(
            matches!(&fx[0], Effect::Cue { cue } if cue.text.as_deref() == Some("You brace against the dread."))
        );
        assert!(matches!(&fx[1],
            Effect::AdjustStat { target, stat: StatType::Sanity, delta }
            if target == &CharacterId("pc".into()) && *delta == 1.0));
    }
}
