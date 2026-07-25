//! Scene behaviors: a native `SceneBehavior` trait resolved by `behavior_key`
//! (mirrors `exit_behavior`). Behavior is compiled-in; only the scene's `state`
//! serializes. Byte-exact port of the TS `Scene` / `SceneBehavior` contract,
//! extended (6c-2) so a scene script emits mechanic cues.
use alloc::vec::Vec;
use serde_json::Value;

use crate::presentation::MechanicCue;
use crate::world::descriptor::Catalog;
use crate::world::mechanics::RoomView;

/// A first-party scene behavior. `state` is the scene's serialized `Value`.
pub trait SceneBehavior: Sync {
    /// TS `preconditions.every` — read-only over the room view + scene state.
    fn can_play(&self, room: &RoomView, state: &Value) -> bool;
    /// TS `script` — runs on a matched phase + passing preconditions; may mutate
    /// its own `state`; returns the mechanic cues to emit (empty = none).
    fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue>;
}

/// Resolve a first-party scene behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the fire site).
pub fn scene_behavior(key: &str) -> Option<&'static dyn SceneBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:visit-counter" {
        return Some(&conformance::VISIT_COUNTER);
    }
    let _ = key;
    None
}

/// The outcome of resolving a scene `behavior_key`: a compiled-in native scene
/// behavior, or a data-driven `SceneScript` from the catalog (`BehaviorScript::Scene`).
pub enum ResolvedScene<'a> {
    Native(&'static dyn SceneBehavior),
    Scripted(&'a crate::script::ast::SceneScript),
}

/// Resolve a scene `key`: native first (a first-party `SceneBehavior`), then a
/// catalog `BehaviorScript::Scene`. `None` if neither knows the key (surfaced as a
/// `ProceduralViolation` at the fire site). Mirrors `resolve_formation`; a catalog
/// key of a NON-scene family resolves to `None` (it is not a scene).
pub fn resolve_scene<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedScene<'a>> {
    if let Some(op) = scene_behavior(key) {
        return Some(ResolvedScene::Native(op));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Scene { script }) => {
            Some(ResolvedScene::Scripted(script))
        }
        _ => None,
    }
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use serde_json::json;

    // Behavior-logic-free helpers (testable without a `RoomView`).

    /// Fires while `state.count < 3` AND the room is occupied.
    pub fn visit_can_play(state: &Value, occupied: bool) -> bool {
        let count = state
            .get("count")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        count < 3 && occupied
    }

    /// Increments `state.count` and returns one cue naming the room + new count.
    pub fn visit_run_script(room_name: &str, state: &mut Value) -> Vec<MechanicCue> {
        let count = state
            .get("count")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            + 1;
        state["count"] = json!(count);
        alloc::vec![MechanicCue {
            text: Some(alloc::format!("The {room_name} stirs (visit {count}).")),
            sound: None,
        }]
    }

    pub struct VisitCounter;
    pub static VISIT_COUNTER: VisitCounter = VisitCounter;

    impl SceneBehavior for VisitCounter {
        fn can_play(&self, room: &RoomView, state: &Value) -> bool {
            visit_can_play(state, !room.occupants.is_empty())
        }
        fn run_script(&self, room: &RoomView, state: &mut Value) -> Vec<MechanicCue> {
            visit_run_script(&room.name, state)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_resolves_visit_counter_and_rejects_unknown() {
        assert!(scene_behavior("conformance:visit-counter").is_some());
        assert!(scene_behavior("nope").is_none());
    }

    #[test]
    fn can_play_gates_on_count_and_occupancy() {
        assert!(conformance::visit_can_play(&json!({ "count": 0 }), true));
        assert!(conformance::visit_can_play(&json!({}), true)); // missing count → 0
        assert!(!conformance::visit_can_play(&json!({ "count": 3 }), true)); // capped
        assert!(!conformance::visit_can_play(&json!({ "count": 0 }), false)); // empty room
    }

    #[test]
    fn run_script_increments_and_emits_named_cue() {
        let mut s = json!({ "count": 1 });
        let cues = conformance::visit_run_script("Crypt", &mut s);
        assert_eq!(s["count"], json!(2));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text.as_deref(), Some("The Crypt stirs (visit 2)."));
    }
}
