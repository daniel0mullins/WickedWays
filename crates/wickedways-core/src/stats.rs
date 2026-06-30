use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// The three core character stats. Serde values match the TS `StatType`
/// string union exactly (`"energy" | "sanity" | "health"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum StatType {
    Energy,
    Sanity,
    Health,
}

impl StatType {
    /// The stat that mitigates incoming damage against this one, forming the
    /// cycle energy←health←sanity←energy (mirror of TS `MitigatorStatType`).
    pub const fn mitigator(self) -> StatType {
        match self {
            StatType::Energy => StatType::Health,
            StatType::Health => StatType::Sanity,
            StatType::Sanity => StatType::Energy,
        }
    }
}

#[cfg(all(test, feature = "ts"))]
mod ts_export {
    use super::StatType;
    use crate::damage::DamageInput;
    use ts_rs::TS;

    #[test]
    fn export_typescript_bindings() {
        StatType::export_all().expect("export StatType bindings");
        DamageInput::export_all().expect("export DamageInput");
    }
}
