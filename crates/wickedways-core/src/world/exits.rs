//! Keyed-exit behaviors: a native `ExitBehavior` trait resolved by `behavior_key`
//! (mirrors `mechanic_op`). Behavior is compiled-in; only the exit's `state`
//! serializes. Byte-exact port of the TS `Exit` / `ExitBehavior` contract.
use alloc::string::String;
use serde_json::Value;

use crate::world::mechanics::CharacterView;

/// A first-party exit behavior. `state` is the exit's serialized `Value`.
pub trait ExitBehavior: Sync {
    /// TS `canPass` — all preconditions pass (read-only).
    fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool;
    /// TS `runScript` — run on a successful pass; may mutate `state`; returns a
    /// one-time narration line (TS `string | void`).
    fn run_script(&self, _actor: &CharacterView, _state: &mut Value) -> Option<String> { None }
    fn pass_message(&self) -> Option<&str> { None }
    fn fail_message(&self) -> Option<&str> { None }
}

/// Resolve a first-party exit behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the `go` call site).
pub fn exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior> {
    match key {
        #[cfg(any(test, feature = "conformance"))]
        "conformance:keyed-door" => Some(&conformance::KEYED_DOOR),
        _ => None,
    }
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use serde_json::json;

    /// The item behavior key that unlocks the conformance door.
    pub const DOOR_KEY: &str = "brass-key";

    /// Door-logic free helpers (testable without constructing a `CharacterView`).
    pub fn door_can_pass(state: &Value, has_key: bool) -> bool {
        state.get("unlocked").and_then(|v| v.as_bool()).unwrap_or(false) || has_key
    }
    /// Returns the narration (and mutates `state.unlocked = true`) iff the door was
    /// locked and the actor holds the key; otherwise `None`.
    pub fn door_run_script(state: &mut Value, has_key: bool) -> Option<String> {
        let unlocked = state.get("unlocked").and_then(|v| v.as_bool()).unwrap_or(false);
        if !unlocked && has_key {
            state["unlocked"] = json!(true);
            Some(String::from("The door unlocks."))
        } else {
            None
        }
    }

    pub struct KeyedDoor;
    pub static KEYED_DOOR: KeyedDoor = KeyedDoor;

    impl ExitBehavior for KeyedDoor {
        fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool {
            door_can_pass(state, actor.has_item(DOOR_KEY))
        }
        fn run_script(&self, actor: &CharacterView, state: &mut Value) -> Option<String> {
            door_run_script(state, actor.has_item(DOOR_KEY))
        }
        fn pass_message(&self) -> Option<&str> { Some("You pass through.") }
        fn fail_message(&self) -> Option<&str> { Some("The door is locked.") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_resolves_keyed_door_and_rejects_unknown() {
        assert!(exit_behavior("conformance:keyed-door").is_some());
        assert!(exit_behavior("nope").is_none());
    }

    #[test]
    fn door_can_pass_when_unlocked_or_holding_key() {
        assert!(!conformance::door_can_pass(&json!({ "unlocked": false }), false));
        assert!(conformance::door_can_pass(&json!({ "unlocked": false }), true)); // has key
        assert!(conformance::door_can_pass(&json!({ "unlocked": true }), false)); // already unlocked
    }

    #[test]
    fn door_run_script_unlocks_once_with_key() {
        let mut s = json!({ "unlocked": false });
        assert_eq!(conformance::door_run_script(&mut s, true).as_deref(), Some("The door unlocks."));
        assert_eq!(s["unlocked"], json!(true));
        // already unlocked → no narration, no change
        assert_eq!(conformance::door_run_script(&mut s, true), None);
        // locked but no key → no narration, stays locked
        let mut locked = json!({ "unlocked": false });
        assert_eq!(conformance::door_run_script(&mut locked, false), None);
        assert_eq!(locked["unlocked"], json!(false));
    }
}
