use serde::{Deserialize, Serialize};

/// The three core character stats. Wire values are exactly
/// `"energy" | "sanity" | "health"`, as pinned by the conformance goldens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatType {
    Energy,
    Sanity,
    Health,
}

impl StatType {
    /// The stat that mitigates incoming damage against this one, forming the
    /// cycle energy←health←sanity←energy.
    pub const fn mitigator(self) -> StatType {
        match self {
            StatType::Energy => StatType::Health,
            StatType::Health => StatType::Sanity,
            StatType::Sanity => StatType::Energy,
        }
    }

    /// The wire name of this stat — identical to its serde serialization
    /// (pinned by the `wire_names_match_serde` test below).
    pub const fn as_str(self) -> &'static str {
        match self {
            StatType::Energy => "energy",
            StatType::Sanity => "sanity",
            StatType::Health => "health",
        }
    }
}

impl core::fmt::Display for StatType {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod stat_type_tests {
    use super::StatType;

    /// `as_str` and serde must agree — `as_str` exists so hot paths can skip
    /// serialization, not so the names can drift.
    #[test]
    fn wire_names_match_serde() {
        for stat in [StatType::Energy, StatType::Sanity, StatType::Health] {
            let json = serde_json::to_string(&stat).unwrap();
            assert_eq!(json, alloc::format!("\"{}\"", stat.as_str()));
        }
    }
}
