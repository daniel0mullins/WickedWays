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
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, ItemId};

pub use view::{CampaignView, CharacterView, DamageView, RoomView};

/// Per-mechanic-per-event effect cap (`MAX_EFFECTS_PER_EVENT`).
pub const MAX_EFFECTS_PER_EVENT: usize = 64;

/// Every `Status` variant — the target of a `GrantImmunity` effect (`ALL_STATUSES`).
pub const ALL_STATUSES: [Status; 4] = [Status::Confused, Status::Fear, Status::Ko, Status::Panic];

/// The closed effect union a mechanic hook may return (`Effect`). `amount`/`delta`
/// are `f64` to match `number` and the f64 stat model.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Damage {
        target: CharacterId,
        amount: f64,
    },
    Heal {
        target: CharacterId,
        amount: f64,
    },
    /// `stat` is Sanity or Energy only (TS restricts AdjustStat to non-Health).
    AdjustStat {
        target: CharacterId,
        stat: StatType,
        delta: f64,
    },
    GrantImmunity {
        target: CharacterId,
        turns: f64,
    },
    Cue {
        cue: MechanicCue,
    },
    Status {
        fields: Vec<StatusField>,
    },
    /// Hand item id `item` from `from`'s inventory to `to`'s. Routes by the source
    /// list (a key stays a key, a non-key stays an item); `World.items` is never
    /// touched — the `ItemSnapshot` persists and reachability follows the new
    /// holder. Not party-restricted (an NPC — non-party — may hand over a key).
    GiveItem {
        from: CharacterId,
        to: CharacterId,
        item: ItemId,
    },
    /// Flip `target`'s `visible` flag (reversibly). An NPC that "disappears" flips
    /// this to `false`. Not party-restricted; a missing target is a no-op.
    SetVisible {
        target: CharacterId,
        visible: bool,
    },
}

/// Result of `modify_damage` (`number | { value; final: true }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransformResult {
    Value(f64),
    Final(f64),
}

/// Contexts passed to hooks. Views are owned (built once before dispatch); `state`
/// and `rng` are live mutable borrows of disjoint `World` fields.
///
/// Two simultaneous `&mut` into one `World` is legal only because the dispatch
/// site carves them out field-by-field (a "split borrow") — the compiler proves
/// they can never alias. The `<'a>` lifetime ties the context to that borrow:
/// a `HookCtx` cannot be stored past the dispatch call that built it.
pub struct HookCtx<'a> {
    pub state: &'a mut Value,
    pub view: &'a CampaignView,
    pub rng: &'a mut crate::world::rng::Rng,
}

impl HookCtx<'_> {
    /// Integer in `[1, n]` from the campaign rng (`roll(n)`).
    pub fn roll(&mut self, n: i64) -> i64 {
        let unit = self.rng.next_f64();
        i64::from(crate::dice::roll(n as u32, unit))
    }
}

pub struct TurnCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
}

pub struct ActionCtx<'a> {
    pub base: HookCtx<'a>,
    pub actor: CharacterView,
    /// A projection of the action detail (`ActionCtx.action`).
    pub action: ActionView,
}

/// Read-only projection of the action being recorded (`ActionDetail`).
#[derive(Clone, Debug, PartialEq)]
pub struct ActionView {
    pub kind: String,
    /// Move payload — the "move" action kind carries `{id, name}` for the room
    /// entered. `None` for every other action kind.
    pub room: Option<crate::world::history::RoomRef>,
}

impl ActionView {
    /// A room-less action view (every non-move action).
    pub fn of(kind: &str) -> ActionView {
        ActionView {
            kind: kind.into(),
            room: None,
        }
    }
}

/// A first-party mechanic op. Stateless behavior; state lives in the snapshot and
/// is handed in via `HookCtx.state`. Mirrors the `Mechanic` interface.
pub trait MechanicOp: Sync {
    /// Authoring-time state seed (`initialState`). NEVER called on hydrate.
    fn init_state(&self, config: &Value) -> Value;
    fn on_round_start(&self, _cx: &mut HookCtx<'_>) -> Vec<Effect> {
        Vec::new()
    }
    fn on_round_end(&self, _cx: &mut HookCtx<'_>) -> Vec<Effect> {
        Vec::new()
    }
    fn on_turn_start(&self, _cx: &mut TurnCtx<'_>) -> Vec<Effect> {
        Vec::new()
    }
    fn on_turn_end(&self, _cx: &mut TurnCtx<'_>) -> Vec<Effect> {
        Vec::new()
    }
    fn on_action(&self, _cx: &mut ActionCtx<'_>) -> Vec<Effect> {
        Vec::new()
    }
    fn modify_damage(&self, d: &DamageView, _cx: &mut HookCtx<'_>) -> TransformResult {
        TransformResult::Value(d.amount)
    }
    /// Run a named custom action (`CustomAction.run`). `None` = this op has no
    /// action under `action_key` (→ a `ProceduralViolation` at the invoke site,
    /// mirroring TS's "has no action" throw). `cost` is v1-inert (every action costs 1).
    fn run_action(&self, _action_key: &str, _cx: &mut ActionCtx<'_>) -> Option<Vec<Effect>> {
        None
    }
}

/// Resolve a first-party op by key. The compiled-in registry; the snapshot's
/// `mechanics[].key` selects entries. Returns `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` by `validate_mechanics`).
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

/// A key resolved to an op: a compiled-in native, or an interpreter bound to a
/// catalog-borrowed AST (no per-fire-point clone — spec risk note).
pub enum ResolvedMechanicOp<'a> {
    Native(&'static dyn MechanicOp),
    Scripted(crate::script::ops::ScriptedMechanic<'a>),
}

impl ResolvedMechanicOp<'_> {
    pub fn as_op(&self) -> &dyn MechanicOp {
        match self {
            ResolvedMechanicOp::Native(op) => *op,
            ResolvedMechanicOp::Scripted(s) => s,
        }
    }
}

/// Native registry first; on `None`, look the key up in `catalog.behaviors`
/// (Mechanic family only). `None` when both miss.
pub fn resolve_mechanic_op<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedMechanicOp<'a>> {
    if let Some(op) = mechanic_op(key) {
        return Some(ResolvedMechanicOp::Native(op));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Mechanic { script }) => Some(
            ResolvedMechanicOp::Scripted(crate::script::ops::ScriptedMechanic { script }),
        ),
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
        assert_eq!(
            op.init_state(&serde_json::json!(null)),
            serde_json::json!({"ticks": 0})
        );
    }
}
