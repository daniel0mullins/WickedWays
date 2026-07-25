//! Keyed-exit behaviors: a native `ExitBehavior` trait resolved by `behavior_key`
//! (mirrors `mechanic_op`). Behavior is compiled-in; only the exit's `state`
//! serializes. Pinned byte-exact by the conformance goldens: the `Exit` / `ExitBehavior` contract.
use alloc::string::String;
use serde_json::Value;

use crate::world::mechanics::CharacterView;

/// A first-party exit behavior. `state` is the exit's serialized `Value`.
pub trait ExitBehavior: Sync {
    /// `canPass` — all preconditions pass (read-only).
    fn can_pass(&self, actor: &CharacterView, state: &Value) -> bool;
    /// `runScript` — run on a successful pass; may mutate `state`; returns a
    /// one-time narration line (`string | void`).
    fn run_script(&self, _actor: &CharacterView, _state: &mut Value) -> Option<String> {
        None
    }
    fn pass_message(&self) -> Option<&str> {
        None
    }
    fn fail_message(&self) -> Option<&str> {
        None
    }
}

/// Resolve a first-party exit behavior by key. `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the `go` call site).
pub fn exit_behavior(key: &str) -> Option<&'static dyn ExitBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:keyed-door" {
        return Some(&conformance::KEYED_DOOR);
    }
    let _ = key;
    None
}

/// The resolved exit behavior for a key: a compiled-in native behavior, or a
/// scripted behavior interpreted from `catalog.behaviors`. The exit counterpart
/// of `ResolvedMechanicOp`.
pub enum ResolvedExitBehavior<'a> {
    Native(&'static dyn ExitBehavior),
    Scripted(crate::script::ops::ScriptedExit<'a>),
}

impl ResolvedExitBehavior<'_> {
    pub fn as_behavior(&self) -> &dyn ExitBehavior {
        match self {
            ResolvedExitBehavior::Native(b) => *b,
            ResolvedExitBehavior::Scripted(s) => s,
        }
    }
}

/// Resolve an exit behavior key: the native registry FIRST (so a
/// `conformance:keyed-door` key always hits native), then `catalog.behaviors`
/// (Exit family only). `None` for an unregistered key.
pub fn resolve_exit_behavior<'a>(
    key: &str,
    cat: &'a crate::world::descriptor::Catalog,
) -> Option<ResolvedExitBehavior<'a>> {
    if let Some(b) = exit_behavior(key) {
        return Some(ResolvedExitBehavior::Native(b));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Exit { script }) => Some(
            ResolvedExitBehavior::Scripted(crate::script::ops::ScriptedExit { script }),
        ),
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
        state
            .get("unlocked")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            || has_key
    }
    /// Returns the narration (and mutates `state.unlocked = true`) iff the door was
    /// locked and the actor holds the key; otherwise `None`.
    pub fn door_run_script(state: &mut Value, has_key: bool) -> Option<String> {
        let unlocked = state
            .get("unlocked")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
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
        fn pass_message(&self) -> Option<&str> {
            Some("You pass through.")
        }
        fn fail_message(&self) -> Option<&str> {
            Some("The door is locked.")
        }
    }
}

/// A test-only Catalog carrying a scripted brass-keyed door under `key`,
/// reproducing the HH `doorBehavior("brass", "study door", ...)` shape. Hoisted
/// to the file (outside the `tests` module) so `movement.rs`'s scripted-exit
/// test reuses one copy.
#[cfg(test)]
pub(crate) fn tests_catalog_with_door(key: &str) -> crate::world::descriptor::Catalog {
    serde_json::from_value(serde_json::json!({
        "items": {}, "aliases": {},
        "behaviors": { key: { "family": "exit", "script": {
            "canPass": { "kind": "bin", "op": "or",
                "left": { "kind": "stateGet", "field": "unlocked", "default": false },
                "right": { "kind": "hasKey", "of": { "kind": "actor" }, "keyCode": "brass" } },
            "runScript": [ { "kind": "when",
                "cond": { "kind": "not", "expr":
                    { "kind": "stateGet", "field": "unlocked", "default": false } },
                "then": [
                    { "kind": "setState", "field": "unlocked",
                      "value": { "kind": "lit", "value": true } },
                    { "kind": "pass", "value": { "kind": "lit", "value": "The door unlocks." } }
                ] } ],
            "failMessage": "The study door won't budge — it's locked."
        } } }
    }))
    .unwrap()
}

#[cfg(test)]
mod tests {
    use super::tests_catalog_with_door as cat_with_door;
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_resolves_keyed_door_and_rejects_unknown() {
        assert!(exit_behavior("conformance:keyed-door").is_some());
        assert!(exit_behavior("nope").is_none());
    }

    #[test]
    fn resolve_exit_behavior_native_first_then_scripted() {
        let cat = cat_with_door("study-door");
        assert!(matches!(
            resolve_exit_behavior("conformance:keyed-door", &cat),
            Some(ResolvedExitBehavior::Native(_))
        ));
        assert!(matches!(
            resolve_exit_behavior("study-door", &cat),
            Some(ResolvedExitBehavior::Scripted(_))
        ));
        assert!(resolve_exit_behavior("nope", &cat).is_none());
    }

    #[test]
    fn scripted_door_matches_the_hh_door_contract() {
        use crate::world::descriptor::Catalog;
        use crate::world::ids::{CharacterId, ItemId};
        use crate::world::snapshot::ItemSnapshot;
        use crate::world::test_support::world_with_party;
        let cat = cat_with_door("study-door");
        let Some(ResolvedExitBehavior::Scripted(door)) = resolve_exit_behavior("study-door", &cat)
        else {
            panic!("expected scripted")
        };
        let b: &dyn ExitBehavior = &door;

        // actor WITHOUT the brass key
        let mut w = world_with_party(&["pc"], 10);
        let no_key = w
            .character_view(&CharacterId("pc".into()), &Catalog::default())
            .unwrap();
        let mut state = json!({ "unlocked": false });
        assert!(!b.can_pass(&no_key, &state), "locked + keyless -> blocked");
        assert_eq!(
            b.fail_message(),
            Some("The study door won't budge — it's locked.")
        );
        assert_eq!(b.pass_message(), None);

        // actor WITH the brass key: passes, unlocks once, silent re-pass
        w.items.insert(
            ItemId("k1".into()),
            ItemSnapshot::Key {
                id: ItemId("k1".into()),
                name: "Brass Key".into(),
                key_code: "brass".into(),
                consume_on_use: false,
            },
        );
        w.characters
            .get_mut(&CharacterId("pc".into()))
            .unwrap()
            .inventory
            .key_ids
            .push(ItemId("k1".into()));
        let with_key = w
            .character_view(&CharacterId("pc".into()), &Catalog::default())
            .unwrap();
        assert!(b.can_pass(&with_key, &state));
        assert_eq!(
            b.run_script(&with_key, &mut state).as_deref(),
            Some("The door unlocks.")
        );
        assert_eq!(state["unlocked"], json!(true));
        assert_eq!(
            b.run_script(&with_key, &mut state),
            None,
            "already unlocked -> silent"
        );
        // and now even a keyless actor passes (state.unlocked)
        assert!(b.can_pass(&no_key, &state));
    }

    #[test]
    fn door_can_pass_when_unlocked_or_holding_key() {
        assert!(!conformance::door_can_pass(
            &json!({ "unlocked": false }),
            false
        ));
        assert!(conformance::door_can_pass(
            &json!({ "unlocked": false }),
            true
        )); // has key
        assert!(conformance::door_can_pass(
            &json!({ "unlocked": true }),
            false
        )); // already unlocked
    }

    #[test]
    fn door_run_script_unlocks_once_with_key() {
        let mut s = json!({ "unlocked": false });
        assert_eq!(
            conformance::door_run_script(&mut s, true).as_deref(),
            Some("The door unlocks.")
        );
        assert_eq!(s["unlocked"], json!(true));
        // already unlocked → no narration, no change
        assert_eq!(conformance::door_run_script(&mut s, true), None);
        // locked but no key → no narration, stays locked
        let mut locked = json!({ "unlocked": false });
        assert_eq!(conformance::door_run_script(&mut locked, false), None);
        assert_eq!(locked["unlocked"], json!(false));
    }
}
