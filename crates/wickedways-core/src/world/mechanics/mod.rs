//! The mechanics op-registry (roadmap A2): the `MechanicOp` trait, the closed
//! `Effect` enum, dispatch contexts, and the compiled-in first-party op registry.
//! Mechanics are DATA (`campaign.mechanics: {key, state}`) selecting stateless ops;
//! only `{key, state}` serializes — behavior is resolved by `mechanic_op(key)`.
pub mod dispatch;
pub mod view;

#[cfg(any(test, feature = "conformance"))]
pub mod conformance;

use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value;

use crate::presentation::{MechanicCue, StatusField};
use crate::stats::StatType;
use crate::world::afflictions::Status;
use crate::world::ids::CharacterId;

pub use view::{CampaignView, CharacterView, DamageView, RoomView};

/// Per-mechanic-per-event effect cap (TS `MAX_EFFECTS_PER_EVENT`).
pub const MAX_EFFECTS_PER_EVENT: usize = 64;

/// Every `Status` variant — the target of a `GrantImmunity` effect (TS `ALL_STATUSES`).
pub const ALL_STATUSES: [Status; 4] = [Status::Confused, Status::Fear, Status::Ko, Status::Panic];

/// The closed effect union a mechanic hook may return (TS `Effect`). `amount`/`delta`
/// are `f64` to match TS `number` and the f64 stat model.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Damage { target: CharacterId, amount: f64 },
    Heal { target: CharacterId, amount: f64 },
    /// `stat` is Sanity or Energy only (TS restricts AdjustStat to non-Health).
    AdjustStat { target: CharacterId, stat: StatType, delta: f64 },
    GrantImmunity { target: CharacterId, turns: f64 },
    Cue { cue: MechanicCue },
    Status { fields: Vec<StatusField> },
}

/// Result of `modify_damage` (TS `number | { value; final: true }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransformResult {
    Value(f64),
    Final(f64),
}

/// Contexts passed to hooks. Views are owned (built once before dispatch); `state`
/// and `rng` are live mutable borrows of disjoint `World` fields.
pub struct HookCtx<'a> {
    pub state: &'a mut Value,
    pub view: &'a CampaignView,
    pub rng: &'a mut crate::world::rng::Rng,
}

impl HookCtx<'_> {
    /// Integer in `[1, n]` from the campaign rng (TS `roll(n)`).
    pub fn roll(&mut self, n: i64) -> i64 {
        let unit = self.rng.next_f64();
        crate::dice::roll(n as u32, unit) as i64
    }
}

pub struct TurnCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
}

pub struct ActionCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
    /// A projection of the action detail (TS `ActionCtx.action`).
    pub action: ActionView,
}

/// Read-only projection of the action being recorded (TS `ActionDetail`).
#[derive(Clone, Debug, PartialEq)]
pub struct ActionView {
    pub kind: String,
}

/// A first-party mechanic op. Stateless behavior; state lives in the snapshot and
/// is handed in via `HookCtx.state`. Mirrors the TS `Mechanic` interface.
pub trait MechanicOp: Sync {
    /// Authoring-time state seed (TS `initialState`). NEVER called on hydrate.
    fn init_state(&self, config: &Value) -> Value;
    fn on_round_start(&self, _cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_round_end(&self, _cx: &mut HookCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_start(&self, _cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_turn_end(&self, _cx: &mut TurnCtx) -> Vec<Effect> { Vec::new() }
    fn on_action(&self, _cx: &mut ActionCtx) -> Vec<Effect> { Vec::new() }
    fn modify_damage(&self, d: &DamageView, _cx: &mut HookCtx) -> TransformResult {
        TransformResult::Value(d.amount)
    }
    /// Run a named custom action (TS `CustomAction.run`). `None` = this op has no
    /// action under `action_key` (→ a `ProceduralViolation` at the invoke site,
    /// mirroring TS's "has no action" throw). `cost` is v1-inert (every action costs 1).
    fn run_action(&self, _action_key: &str, _cx: &mut ActionCtx) -> Option<Vec<Effect>> { None }
}

/// Resolve a first-party op by key. The compiled-in registry; the snapshot's
/// `mechanics[].key` selects entries. Returns `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` by `validate_mechanics`, Task 3).
pub fn mechanic_op(key: &str) -> Option<&'static dyn MechanicOp> {
    match key {
        #[cfg(any(test, feature = "conformance"))]
        "conformance:dread" => Some(&conformance::DREAD),
        // Test-only op for the dispatch 64-effect-cap unit tests (dispatch.rs).
        #[cfg(test)]
        "test:effect-count" => Some(&conformance::EFFECT_COUNT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mechanic_op_resolves_conformance_key_and_rejects_unknown() {
        assert!(mechanic_op("conformance:dread").is_some());
        assert!(mechanic_op("nope").is_none());
    }

    #[test]
    fn conformance_op_init_state_is_zeroed_ticks() {
        let op = mechanic_op("conformance:dread").unwrap();
        assert_eq!(op.init_state(&serde_json::json!(null)), serde_json::json!({"ticks": 0}));
    }
}
