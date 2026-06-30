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
    use crate::presentation::{
        ActionKind, CampaignOutcome, EntityRef, MechanicCue, OutcomeNarration, PresentationCue,
        StatusField,
    };
    use crate::world::direction::Direction;
    use crate::world::history::{ActionHistoryEntry, ItemRef, RoomRef, TargetRef};
    use crate::world::ids::{CharacterId, ExitId, ItemId, LootId, MaterialCacheId, RoomId};
    use ts_rs::TS;

    #[test]
    fn export_typescript_bindings() {
        StatType::export_all().expect("export StatType bindings");
        DamageInput::export_all().expect("export DamageInput");
        EntityRef::export_all().expect("export EntityRef");
        StatusField::export_all().expect("export StatusField");
        MechanicCue::export_all().expect("export MechanicCue");
        OutcomeNarration::export_all().expect("export OutcomeNarration");
        CampaignOutcome::export_all().expect("export CampaignOutcome");
        ActionKind::export_all().expect("export ActionKind");
        PresentationCue::export_all().expect("export PresentationCue");
        // Task 2: typed action history
        ActionHistoryEntry::export_all().expect("export ActionHistoryEntry");
        RoomRef::export_all().expect("export RoomRef");
        TargetRef::export_all().expect("export TargetRef");
        ItemRef::export_all().expect("export ItemRef");
        // branded ids
        CharacterId::export_all().expect("export CharacterId");
        RoomId::export_all().expect("export RoomId");
        ItemId::export_all().expect("export ItemId");
        LootId::export_all().expect("export LootId");
        MaterialCacheId::export_all().expect("export MaterialCacheId");
        ExitId::export_all().expect("export ExitId");
        // Task 4: movement + direction
        Direction::export_all().expect("export Direction");
        // Task 1 (sub-plan 3a): item descriptor primitives
        use crate::world::descriptor::{ItemType, SlotKind, ItemProperties, Presentation};
        ItemType::export_all().expect("export ItemType");
        SlotKind::export_all().expect("export SlotKind");
        ItemProperties::export_all().expect("export ItemProperties");
        Presentation::export_all().expect("export Presentation");
        // Task 5: thin ViewModel slice
        use crate::world::view::{ThinRoom, ThinOccupant, ThinStatus, ThinViewModel};
        ThinRoom::export_all().expect("export ThinRoom");
        ThinOccupant::export_all().expect("export ThinOccupant");
        ThinStatus::export_all().expect("export ThinStatus");
        ThinViewModel::export_all().expect("export ThinViewModel");
    }
}
