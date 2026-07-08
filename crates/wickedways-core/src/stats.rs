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
        use crate::world::descriptor::{ItemType, SlotKind, ItemProperties, Presentation, ItemDescriptor, Catalog};
        ItemType::export_all().expect("export ItemType");
        SlotKind::export_all().expect("export SlotKind");
        ItemProperties::export_all().expect("export ItemProperties");
        Presentation::export_all().expect("export Presentation");
        // Task 2 (sub-plan 3a): descriptor-data catalog
        ItemDescriptor::export_all().expect("export ItemDescriptor");
        Catalog::export_all().expect("export Catalog");
        // Data-driven formations: MobSpec / NaturalAttack / FormationDescriptor (+ Stats)
        use crate::world::formation_descriptor::{FormationDescriptor, MobSpec, NaturalAttack};
        use crate::world::snapshot::Stats;
        Stats::export_all().expect("export Stats");
        NaturalAttack::export_all().expect("export NaturalAttack");
        MobSpec::export_all().expect("export MobSpec");
        FormationDescriptor::export_all().expect("export FormationDescriptor");
        // Task 5 (sub-plan 3a): widened ViewModel
        use crate::world::view::{ThinRoom, ScopeEntity, LootView, Inventory, StatusView, ViewModel};
        ThinRoom::export_all().expect("export ThinRoom");
        ScopeEntity::export_all().expect("export ScopeEntity");
        LootView::export_all().expect("export LootView");
        Inventory::export_all().expect("export Inventory");
        StatusView::export_all().expect("export StatusView");
        ViewModel::export_all().expect("export ViewModel");
        use crate::world::view::{ExitView, LockedDoorView};
        ExitView::export_all().expect("export ExitView");
        LockedDoorView::export_all().expect("export LockedDoorView");
        // Task 2 (sub-plan 4a): typed afflictions + Status
        use crate::world::afflictions::{Status, Afflictions};
        Status::export_all().expect("export Status");
        Afflictions::export_all().expect("export Afflictions");
        // Phase 2a: the Authority boundary types
        use crate::world::intent::Intent;
        use crate::world::submit::{ExecuteResult, MobAttack};
        Intent::export_all().expect("export Intent");
        MobAttack::export_all().expect("export MobAttack");
        ExecuteResult::export_all().expect("export ExecuteResult");
        // Scripted-ops DSL AST (scripted-ops plan, Task 10)
        use crate::script::ast::{
            BehaviorScript, BinOp, DamageBody, DialogueEntry, DialogueMatch, EffectTemplate,
            Expr, ExitScript, FieldTemplate, ItemScript, MechanicHooks, MechanicScript,
            NpcScript, Stmt, VictoryScript,
        };
        use crate::script::value::Value as ScriptValue;
        ScriptValue::export_all().expect("export ScriptValue");
        BinOp::export_all().expect("export BinOp");
        Expr::export_all().expect("export Expr");
        Stmt::export_all().expect("export Stmt");
        EffectTemplate::export_all().expect("export EffectTemplate");
        FieldTemplate::export_all().expect("export FieldTemplate");
        DamageBody::export_all().expect("export DamageBody");
        MechanicHooks::export_all().expect("export MechanicHooks");
        MechanicScript::export_all().expect("export MechanicScript");
        ExitScript::export_all().expect("export ExitScript");
        VictoryScript::export_all().expect("export VictoryScript");
        ItemScript::export_all().expect("export ItemScript");
        DialogueMatch::export_all().expect("export DialogueMatch");
        DialogueEntry::export_all().expect("export DialogueEntry");
        NpcScript::export_all().expect("export NpcScript");
        BehaviorScript::export_all().expect("export BehaviorScript");
    }
}
