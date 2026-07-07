//! Data-driven formation descriptors: a serializable mob template + a named
//! group of them. Interpreted by `resolve_formation`/`maybe_spawn` (both engines
//! build byte-identical snapshots). See the roving-Rats spec.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::stats::StatType;
use crate::world::snapshot::Stats;

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
