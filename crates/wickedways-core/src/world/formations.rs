//! Encounter formations: a native `FormationBehavior` trait resolved by
//! `behavior_key` (mirrors `mechanic_op`/`exit_behavior`/`scene_behavior`), plus
//! `World::maybe_spawn` (the port of TS `EncounterTable.maybeSpawn`). Behavior is
//! compiled-in; only the encounter table's `visited`/`formations`/`baseChance`
//! serialize.
use alloc::vec::Vec;

use crate::world::mechanics::CampaignView;
use crate::world::snapshot::CharacterSnapshot;

/// A first-party encounter formation. `build` returns the mobs to spawn; each MUST
/// carry a deterministic id (spawned ids are not auto-derived). v1 `build` is rng-free.
pub trait FormationBehavior: Sync {
    fn build(&self, view: &CampaignView) -> Vec<CharacterSnapshot>;
}

/// Resolve a first-party formation by key. `None` for an unregistered key (surfaced
/// as a `ProceduralViolation` at the spawn site).
pub fn formation(key: &str) -> Option<&'static dyn FormationBehavior> {
    #[cfg(any(test, feature = "conformance"))]
    if key == "conformance:wraith" {
        return Some(&conformance::WRAITH);
    }
    let _ = key;
    None
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use alloc::collections::BTreeMap;
    use crate::world::afflictions::Afflictions;
    use crate::world::ids::CharacterId;
    use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};

    /// The deterministic id of the spawned wraith (assigned in `build`, matched by
    /// the TS shadow). Spawned ids are not auto-derived.
    pub const WRAITH_ID: &str = "campaign-mob:wraith";

    /// Build the fixed conformance mob. `origin`/`current_room_id` are left `None`
    /// here — `World::maybe_spawn` sets `origin = "campaign"` and the room. Modeled
    /// on the mob shape the `mob-defeat` fixture round-trips.
    pub fn build_wraith() -> CharacterSnapshot {
        CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: CharacterId(WRAITH_ID.into()),
            name: "Wraith".into(),
            stats: Stats { health: 4.0, sanity: 0.0, energy: 3.0 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: None,
            inventory: InventorySnapshot { slots: 0, item_ids: Vec::new(), key_ids: Vec::new() },
            equipment: BTreeMap::new(),
            history: Vec::new(),
            archetype_immunities: Vec::new(),
            afflictions: Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        }
    }

    pub struct Wraith;
    pub static WRAITH: Wraith = Wraith;

    impl FormationBehavior for Wraith {
        fn build(&self, _view: &CampaignView) -> Vec<CharacterSnapshot> {
            alloc::vec![build_wraith()]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_wraith_and_rejects_unknown() {
        assert!(formation("conformance:wraith").is_some());
        assert!(formation("nope").is_none());
    }

    #[test]
    fn build_wraith_is_deterministic_mob() {
        let m = conformance::build_wraith();
        assert_eq!(m.id.0, "campaign-mob:wraith");
        assert_eq!(m.name, "Wraith");
        assert!(matches!(m.kind, crate::world::snapshot::CharacterKind::Mob));
        assert_eq!(m.origin, None); // maybe_spawn sets origin
        assert_eq!(m.current_room_id, None); // maybe_spawn sets the room
    }
}
