//! Victory-condition behaviors: a native `VictoryConditionBehavior` trait
//! resolved by `behavior_key` (mirrors `exit_behavior` / `scene_behavior`).
//! Behavior is compiled-in; only `{ key, narration? }` serialize. Byte-exact
//! port of the TS `VictoryCondition.test` predicate (resolved from the registry
//! by key at round-end).
use crate::world::mechanics::CampaignView;

/// A first-party victory condition. Reads the campaign projection and returns
/// whether the condition holds this round (TS `VictoryCondition.test`).
pub trait VictoryConditionBehavior: Sync {
    fn test(&self, campaign: &CampaignView) -> bool;
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
}
