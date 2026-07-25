//! Data-driven formation descriptors: a serializable mob template + a named
//! group of them. Interpreted by `resolve_formation`/`maybe_spawn` (both engines
//! build byte-identical snapshots). See the roving-Rats spec.
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::stats::StatType;
use crate::world::afflictions::Afflictions;
use crate::world::ids::CharacterId;
use crate::world::snapshot::{CharacterKind, CharacterSnapshot, InventorySnapshot, Stats};

/// `materialDrops` default — JSON `{}`, not `null` (`Value::default()` is `Null`).
/// A data-built mob must emit `materialDrops: {}` to match the native mob shape.
fn empty_object() -> Value {
    serde_json::json!({})
}

/// A mob's innate attack (the `naturalAttack` field on a mob snapshot). Always
/// present on a spawned mob; the native default is `{stat:"health",power:1}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct NaturalAttack {
    pub stat: StatType,
    pub power: f64,
}

/// A serializable mob template. Reuses the snapshot `Stats` so stat byte-parity
/// with a native-built mob is automatic. The field set is chosen to reproduce the
/// exact `CharacterSnapshot` a native formation emits (see `build_wraith`),
/// including the always-emit mob fields (`baseEscapeChance`, `materialDrops`,
/// `lightAverse`, `naturalAttack`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct MobSpec {
    pub name: String,
    pub stats: Stats,
    pub natural_attack: NaturalAttack,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drops: Vec<String>,
    pub base_escape_chance: i64,
    #[serde(default)]
    pub light_averse: bool,
    /// Material drops for this mob. Defaults to (and serializes as) JSON `{}`.
    /// `unknown` in TS.
    #[serde(default = "empty_object")]
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub material_drops: Value,
    pub actions_per_round: i64,
}

/// A named formation: the mobs it spawns. Keyed by encounter `behaviorKey` in
/// `Catalog.formations`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct FormationDescriptor {
    pub mobs: Vec<MobSpec>,
}

impl FormationDescriptor {
    /// Build the mobs to spawn (rng-free, deterministic ids). `maybe_spawn` sets
    /// each mob's `current_room_id` + `origin="campaign"` afterward.
    ///
    /// The emitted `CharacterSnapshot` field set is identical to the native
    /// `build_wraith` (`formations.rs`), so a data-built mob is byte-faithful to a
    /// native-built one. Deterministic id scheme: `campaign-mob:{name.lowercase}`
    /// for the first mob, `…#{index+1}` for index ≥ 1 (a pair → `campaign-mob:rat`,
    /// `campaign-mob:rat#2`); the TS side mirrors this scheme.
    ///
    /// NOTE: `MobSpec.drops` is intentionally NOT seeded here. Realizing descriptor
    /// drops requires an `ItemSnapshot` in `World.items` (resolved from the item
    /// catalog) plus an id in `inventory.item_ids`; `build`'s `Vec<CharacterSnapshot>`
    /// return type (and its lack of `Catalog` access) cannot supply that world state.
    /// The drops are seeded by `World::maybe_spawn`'s descriptor arm (Task 2b), which
    /// owns `&mut World` + `&Catalog`, right after this `build` runs.
    pub fn build(&self) -> Vec<CharacterSnapshot> {
        self.mobs
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let base = alloc::format!("campaign-mob:{}", m.name.to_lowercase());
                let id = if i == 0 {
                    base
                } else {
                    alloc::format!("{base}#{}", i + 1)
                };
                CharacterSnapshot {
                    kind: CharacterKind::Mob,
                    id: CharacterId(id),
                    name: m.name.clone(),
                    stats: m.stats.clone(),
                    actions_per_round: m.actions_per_round,
                    actions_this_round: 0,
                    current_room_id: None,
                    inventory: InventorySnapshot {
                        slots: 0,
                        item_ids: Vec::new(),
                        key_ids: Vec::new(),
                    },
                    equipment: BTreeMap::new(),
                    history: Vec::new(),
                    archetype_immunities: Vec::new(),
                    afflictions: Afflictions::default(),
                    archetype_id: None,
                    origin: None,
                    base_escape_chance: Some(m.base_escape_chance),
                    material_drops: Some(m.material_drops.clone()),
                    light_averse: Some(m.light_averse),
                    natural_attack: Some(serde_json::json!({
                        "stat": m.natural_attack.stat, "power": m.natural_attack.power
                    })),
                    npc_behavior_key: None,
                    npc_state: serde_json::Value::Null,
                    visible: true,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mob() -> serde_json::Value {
        serde_json::json!({
            "name": "Rat",
            "stats": { "energy": 3, "sanity": 0, "health": 4 },
            "naturalAttack": { "stat": "health", "power": 1 },
            "baseEscapeChance": 50,
            "actionsPerRound": 1
        })
    }

    #[test]
    fn mob_spec_defaults_material_drops_to_empty_object() {
        let m: MobSpec = serde_json::from_value(sample_mob()).unwrap();
        assert_eq!(m.material_drops, serde_json::json!({}));
        assert!(!m.light_averse);
        assert!(m.drops.is_empty());
        // materialDrops always serializes as {} (never null), lightAverse always emits.
        let out = serde_json::to_value(&m).unwrap();
        assert_eq!(out["materialDrops"], serde_json::json!({}));
        assert_eq!(out["lightAverse"], serde_json::json!(false));
        // empty drops omitted
        assert!(out.get("drops").is_none());
    }

    #[test]
    fn mob_spec_roundtrips_full() {
        let json = serde_json::json!({
            "name": "Rat",
            "stats": { "energy": 3.0, "sanity": 0.0, "health": 4.0 },
            "naturalAttack": { "stat": "health", "power": 2.0 },
            "drops": ["items/tail"],
            "baseEscapeChance": 60,
            "lightAverse": true,
            "materialDrops": { "bone": 1 },
            "actionsPerRound": 2
        });
        let m: MobSpec = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(m.name, "Rat");
        assert_eq!(m.stats.health, 4.0);
        assert_eq!(m.natural_attack.power, 2.0);
        assert_eq!(serde_json::to_value(&m).unwrap(), json);
    }

    #[test]
    fn formation_descriptor_roundtrips() {
        let json = serde_json::json!({
            "mobs": [ {
                "name": "Rat",
                "stats": { "energy": 3.0, "sanity": 0.0, "health": 4.0 },
                "naturalAttack": { "stat": "health", "power": 1.0 },
                "baseEscapeChance": 50,
                "lightAverse": false,
                "materialDrops": {},
                "actionsPerRound": 1
            } ]
        });
        let f: FormationDescriptor = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(f.mobs.len(), 1);
        assert_eq!(serde_json::to_value(&f).unwrap(), json);
    }
}
