//! Typed affliction data model — mirrors `src/lib/character/afflictions.ts` + `src/lib/status.ts`.
//! Serialize shape is byte-identical to TS `AfflictionsSnapshot` / `Status`.
use alloc::{collections::BTreeMap, vec::Vec};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
#[cfg(feature = "ts")]
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

/// Adverse conditions a character can be afflicted with.
/// Serde: `"ko"`, `"panic"`, `"confused"`, `"fear"` — matches TS `Status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Confused,
    Fear,
    Ko,
    Panic,
}

/// The three non-KO statuses that self-clear and can be immunized.
pub const CLEARABLE: [Status; 3] = [Status::Panic, Status::Fear, Status::Confused];

// ---------------------------------------------------------------------------
// AfflictionConfig
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct ClearOdds {
    pub base: i64,
    pub increment: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AfflictionConfig {
    pub clear: BTreeMap<Status, ClearOdds>,
    pub confused_fail_chance: i64,
}

pub fn default_affliction_config() -> AfflictionConfig {
    let mut clear = BTreeMap::new();
    clear.insert(Status::Fear, ClearOdds { base: 40, increment: 30 });
    clear.insert(Status::Panic, ClearOdds { base: 20, increment: 20 });
    clear.insert(Status::Confused, ClearOdds { base: 15, increment: 15 });
    AfflictionConfig { clear, confused_fail_chance: 50 }
}

// ---------------------------------------------------------------------------
// Afflictions struct
// ---------------------------------------------------------------------------

/// Owns a character's status state, serialized as `AfflictionsSnapshot`.
/// The `active` field emits **only true entries** on serialize.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Afflictions {
    active: BTreeMap<Status, bool>,
    pub turns_active: BTreeMap<Status, i64>,
    pub shaken_off: Vec<Status>,
    pub immunity: BTreeMap<Status, i64>,
}

impl Afflictions {
    pub fn set_active(&mut self, s: Status, on: bool) {
        self.active.insert(s, on);
    }

    pub fn is_active(&self, s: Status) -> bool {
        self.active.get(&s).copied().unwrap_or(false)
    }

    pub fn list(&self) -> Vec<Status> {
        self.active.iter().filter(|(_, &on)| on).map(|(&s, _)| s).collect()
    }
}

// ---------------------------------------------------------------------------
// Custom Serialize: `active` emits only-true entries; camelCase keys.
// ---------------------------------------------------------------------------

impl Serialize for Afflictions {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        // Only emit entries where the value is true.
        let active_true: BTreeMap<Status, bool> =
            self.active.iter().filter(|(_, &on)| on).map(|(&k, &v)| (k, v)).collect();
        let mut st = s.serialize_struct("Afflictions", 4)?;
        st.serialize_field("active", &active_true)?;
        st.serialize_field("turnsActive", &self.turns_active)?;
        st.serialize_field("shakenOff", &self.shaken_off)?;
        st.serialize_field("immunity", &self.immunity)?;
        st.end()
    }
}

// ---------------------------------------------------------------------------
// Custom Deserialize via a wire struct (camelCase).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AfflictionsWire {
    #[serde(default)]
    active: BTreeMap<Status, bool>,
    #[serde(default)]
    turns_active: BTreeMap<Status, i64>,
    #[serde(default)]
    shaken_off: Vec<Status>,
    #[serde(default)]
    immunity: BTreeMap<Status, i64>,
}

impl<'de> Deserialize<'de> for Afflictions {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let w = AfflictionsWire::deserialize(d)?;
        Ok(Afflictions {
            active: w.active,
            turns_active: w.turns_active,
            shaken_off: w.shaken_off,
            immunity: w.immunity,
        })
    }
}

// ---------------------------------------------------------------------------
// ts-rs: manual TS impl for Afflictions (hand serialize prevents derive).
// The emitted shape mirrors TS `AfflictionsSnapshot`:
//   { active: Partial<Record<Status,boolean>>, turnsActive: Partial<Record<Status,number>>,
//     shakenOff: Status[], immunity: Partial<Record<Status,number>> }
// ---------------------------------------------------------------------------

#[cfg(feature = "ts")]
impl TS for Afflictions {
    type WithoutGenerics = Self;

    fn decl() -> String {
        alloc::format!(
            "type Afflictions = {{ active: Partial<Record<{status}, boolean>>; turnsActive: Partial<Record<{status}, number>>; shakenOff: {status}[]; immunity: Partial<Record<{status}, number>>; }};",
            status = <Status as TS>::name(),
        )
    }

    fn decl_concrete() -> String {
        Self::decl()
    }

    fn name() -> String {
        alloc::string::String::from("Afflictions")
    }

    fn inline() -> String {
        alloc::format!(
            "{{ active: Partial<Record<{status}, boolean>>; turnsActive: Partial<Record<{status}, number>>; shakenOff: {status}[]; immunity: Partial<Record<{status}, number>>; }}",
            status = <Status as TS>::name(),
        )
    }

    fn inline_flattened() -> String {
        Self::inline()
    }

    fn output_path() -> Option<&'static std::path::Path> {
        Some(std::path::Path::new("Afflictions.ts"))
    }

    fn dependencies() -> Vec<ts_rs::Dependency> {
        vec![ts_rs::Dependency::from_ty::<Status>().unwrap()]
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normal_character_serializes_empty_shape() {
        let a = Afflictions::default();
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            json!({ "active": {}, "turnsActive": {}, "shakenOff": [], "immunity": {} })
        );
    }

    #[test]
    fn active_serializes_only_true_entries_lowercase() {
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        a.set_active(Status::Fear, false); // must NOT appear
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["active"], json!({ "panic": true }));
    }

    #[test]
    fn round_trips_through_snapshot_shape() {
        let src = json!({
            "active": { "confused": true },
            "turnsActive": { "confused": 2 },
            "shakenOff": ["fear"],
            "immunity": { "panic": 3 }
        });
        let a: Afflictions = serde_json::from_value(src.clone()).unwrap();
        assert_eq!(serde_json::to_value(&a).unwrap(), src);
    }

    #[test]
    fn default_affliction_config_has_expected_values() {
        let cfg = default_affliction_config();
        assert_eq!(cfg.clear[&Status::Fear].base, 40);
        assert_eq!(cfg.clear[&Status::Panic].base, 20);
        assert_eq!(cfg.clear[&Status::Confused].base, 15);
        assert_eq!(cfg.confused_fail_chance, 50);
    }

    #[test]
    fn clearable_constant_has_three_non_ko_statuses() {
        assert_eq!(CLEARABLE.len(), 3);
        assert!(!CLEARABLE.contains(&Status::Ko));
    }
}
