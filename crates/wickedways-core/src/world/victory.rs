//! Victory-condition behaviors: a native `VictoryConditionBehavior` trait
//! resolved by `behavior_key` (mirrors `exit_behavior` / `scene_behavior`).
//! Behavior is compiled-in; only `{ key, narration? }` serialize. Byte-exact
//! port of the `VictoryCondition.test` predicate (resolved from the registry
//! by key at round-end).
use crate::world::descriptor::Catalog;
use crate::world::mechanics::CampaignView;

/// A first-party victory condition. Reads the campaign projection and returns
/// whether the condition holds this round (`VictoryCondition.test`).
pub trait VictoryConditionBehavior: Sync {
    fn test(&self, campaign: &CampaignView) -> bool;
}

/// A resolved victory condition: either a compiled-in native behavior, or a
/// campaign-authored scripted `test` predicate. Scripted victory (plan deviation
/// note 2) is NOT a `VictoryConditionBehavior` — the trait's `test(&CampaignView)`
/// cannot carry the `World` the lazy `character.room` resolver needs — so the
/// `resolve_outcome` seam calls `ScriptedVictory::test` directly for this arm.
pub enum ResolvedVictory<'a> {
    Native(&'static dyn VictoryConditionBehavior),
    Scripted(&'a crate::script::ast::VictoryScript),
}

/// Resolve a victory condition by key: native registry FIRST, then
/// `catalog.behaviors` (Victory family only). `None` for an unregistered key
/// (surfaced as a `ProceduralViolation` at the round-end evaluation site).
pub fn resolve_victory<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedVictory<'a>> {
    if let Some(b) = victory_behavior(key) {
        return Some(ResolvedVictory::Native(b));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Victory { script }) => {
            Some(ResolvedVictory::Scripted(script))
        }
        _ => None,
    }
}

/// Resolve a first-party victory condition by key. `None` for an unregistered
/// key (surfaced as a `ProceduralViolation` at the round-end evaluation site).
pub fn victory_behavior(key: &str) -> Option<&'static dyn VictoryConditionBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:round-reached" {
        return Some(&conformance::ROUND_REACHED);
    }
    let _ = key;
    None
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;

    /// The round at (or after) which `conformance:round-reached` fires.
    pub const THRESHOLD: i64 = 2;

    /// Threshold-logic free helper (testable without a `CampaignView`).
    pub fn round_reached(round: i64) -> bool {
        round >= THRESHOLD
    }

    pub struct RoundReached;
    pub static ROUND_REACHED: RoundReached = RoundReached;

    impl VictoryConditionBehavior for RoundReached {
        fn test(&self, campaign: &CampaignView) -> bool {
            round_reached(campaign.round)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_round_reached_and_rejects_unknown() {
        assert!(victory_behavior("conformance:round-reached").is_some());
        assert!(victory_behavior("nope").is_none());
    }

    #[test]
    fn round_reached_fires_at_or_after_threshold() {
        assert!(!conformance::round_reached(0));
        assert!(!conformance::round_reached(1));
        assert!(conformance::round_reached(2));
        assert!(conformance::round_reached(3));
    }

    #[test]
    fn resolve_victory_native_first_then_scripted() {
        let cat: crate::world::descriptor::Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "sanity-zero": { "family": "victory", "script": {
                "test": { "kind": "some", "list": { "kind": "party" },
                    "pred": { "kind": "bin", "op": "lte",
                        "left": { "kind": "get", "of": { "kind": "element" }, "field": "sanity" },
                        "right": { "kind": "lit", "value": 0.0 } } } } } }
        }))
        .unwrap();
        assert!(matches!(
            resolve_victory("conformance:round-reached", &cat),
            Some(ResolvedVictory::Native(_))
        ));
        assert!(matches!(
            resolve_victory("sanity-zero", &cat),
            Some(ResolvedVictory::Scripted(_))
        ));
        assert!(resolve_victory("nope", &cat).is_none());
    }
}
