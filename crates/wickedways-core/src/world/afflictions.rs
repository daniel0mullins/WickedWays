//! Typed affliction data model — mirrors `src/lib/character/afflictions.ts` + `src/lib/status.ts`.
//! Serialize shape is byte-identical to TS `AfflictionsSnapshot` / `Status`.
use alloc::{collections::BTreeMap, collections::BTreeSet, vec::Vec};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::dice::roll;
use crate::world::rng::Rng;
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

    /// Returns the current timed immunity turns remaining for `s` (0 if none).
    pub fn immunity_of(&self, s: Status) -> i64 {
        self.immunity.get(&s).copied().unwrap_or(0)
    }

    /// Grant timed immunity to each status in `statuses` for `turns` turns,
    /// refreshing to max if already higher. KO is never immunizable.
    /// Mirrors `afflictions.ts:182-192`.
    pub fn grant_immunity(&mut self, statuses: &[Status], turns: i64) {
        for &s in statuses {
            if s == Status::Ko { continue; }
            let cur = self.immunity.get(&s).copied().unwrap_or(0);
            self.immunity.insert(s, cur.max(turns));
            self.clear_episode(s);
        }
    }

    // -- lifecycle (mirrors afflictions.ts:75-152) --

    /// `passiveImmune.has(s) || (#immunity.get(s) ?? 0) > 0` (afflictions.ts:75-77).
    fn immune(&self, s: Status, passive: &BTreeSet<Status>) -> bool {
        passive.contains(&s) || self.immunity.get(&s).copied().unwrap_or(0) > 0
    }

    /// Drop a status out of its current episode entirely (afflictions.ts:80-84).
    fn clear_episode(&mut self, s: Status) {
        self.active.insert(s, false);
        self.shaken_off.retain(|x| *x != s);
        self.turns_active.insert(s, 0);
    }

    /// `below` = stat is past the affliction threshold this resolution (afflictions.ts:87-93).
    fn resolve(&mut self, s: Status, below: bool, passive: &BTreeSet<Status>) {
        if self.immune(s, passive) || !below {
            self.clear_episode(s);
            return;
        }
        let v = !self.shaken_off.contains(&s);
        self.active.insert(s, v);
    }

    /// Recomputes every flag from the current effective stats. Pure: no RNG, no timer
    /// mutation. `passive` is the set of equipment-conferred immunities.
    /// Mirrors `applyFromStats` (afflictions.ts:99-128).
    pub fn apply_from_stats(
        &mut self,
        health: i64,
        sanity: i64,
        energy: i64,
        passive: &BTreeSet<Status>,
    ) {
        if health <= 0 {
            self.active.insert(Status::Ko, true);
            for s in CLEARABLE {
                self.clear_episode(s);
            }
            return;
        }
        self.active.insert(Status::Ko, false);

        self.resolve(Status::Panic, sanity <= 0, passive);
        self.resolve(Status::Fear, sanity > 0 && sanity < 5, passive);

        // Confused keeps a (0, 1] hold band so it doesn't flicker near the boundary.
        if energy <= 0 {
            self.resolve(Status::Confused, true, passive);
        } else if energy > 1 {
            self.resolve(Status::Confused, false, passive);
        } else if self.immune(Status::Confused, passive) {
            // (0, 1] hold band + immunity hysteresis (afflictions.ts:119-127).
            self.clear_episode(Status::Confused);
        }
    }

    /// The per-turn time step: roll each active non-KO status for an early clear
    /// (chance rises with `turns_active`), reconcile, then consume one turn of each
    /// immunity timer. Mirrors `onTurnStart` (afflictions.ts:136-152).
    ///
    /// RNG draw order IS the contract: clear rolls happen `for s in CLEARABLE`
    /// (`[Panic, Fear, Confused]`), only for active clearables, each
    /// `roll(100, rng.next_f64())`. Then `apply_from_stats` (no rng). Then the
    /// immunity decrement (no rng).
    pub fn on_turn_start(
        &mut self,
        health: i64,
        sanity: i64,
        energy: i64,
        passive: &BTreeSet<Status>,
        config: &AfflictionConfig,
        rng: &mut Rng,
    ) {
        for s in CLEARABLE {
            if !self.active.get(&s).copied().unwrap_or(false) {
                continue;
            }
            let turns = self.turns_active.get(&s).copied().unwrap_or(0) + 1;
            self.turns_active.insert(s, turns);
            let odds = &config.clear[&s];
            let p = (odds.base + odds.increment * (turns - 1)).clamp(0, 100);
            if (roll(100, rng.next_f64()) as i64) <= p && !self.shaken_off.contains(&s) {
                self.shaken_off.push(s);
            }
        }

        self.apply_from_stats(health, sanity, energy, passive);

        let keys: Vec<Status> = self.immunity.keys().copied().collect();
        for s in keys {
            let remaining = self.immunity[&s];
            if remaining <= 1 {
                self.immunity.remove(&s);
            } else {
                self.immunity.insert(s, remaining - 1);
            }
        }
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

    // -- apply_from_stats threshold tests (mirror afflictions.ts:95-128) --

    use alloc::collections::BTreeSet;
    use crate::world::rng::Rng;

    #[test]
    fn ko_when_health_le_zero_clears_clearables() {
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        a.apply_from_stats(0, 0, 0, &BTreeSet::new());
        assert!(a.is_active(Status::Ko));
        assert!(!a.is_active(Status::Panic)); // cleared under KO
    }

    #[test]
    fn panic_when_sanity_le_zero_fear_in_band() {
        let mut a = Afflictions::default();
        a.apply_from_stats(5, 0, 5, &BTreeSet::new());
        assert!(a.is_active(Status::Panic));
        let mut b = Afflictions::default();
        b.apply_from_stats(5, 3, 5, &BTreeSet::new()); // 0<sanity<5 → Fear
        assert!(b.is_active(Status::Fear) && !b.is_active(Status::Panic));
    }

    #[test]
    fn confused_energy_bands_and_immunity_hysteresis() {
        let mut a = Afflictions::default();
        a.apply_from_stats(5, 5, 0, &BTreeSet::new()); // energy<=0 → Confused
        assert!(a.is_active(Status::Confused));
        a.apply_from_stats(5, 5, 2, &BTreeSet::new()); // energy>1 → clear
        assert!(!a.is_active(Status::Confused));
    }

    #[test]
    fn confused_hold_band_clears_only_when_immune() {
        // energy in (0,1] with no immunity: Confused left as-is (stays active).
        let mut a = Afflictions::default();
        a.apply_from_stats(5, 5, 0, &BTreeSet::new()); // becomes Confused
        assert!(a.is_active(Status::Confused));
        a.apply_from_stats(5, 5, 1, &BTreeSet::new()); // hold band, no immunity → unchanged
        assert!(a.is_active(Status::Confused));
        // Now with a passive immunity → clears the episode even in the hold band.
        let immune: BTreeSet<Status> = [Status::Confused].into_iter().collect();
        a.apply_from_stats(5, 5, 1, &immune);
        assert!(!a.is_active(Status::Confused));
    }

    #[test]
    fn passive_immunity_clears_episode() {
        let mut a = Afflictions::default();
        let immune: BTreeSet<Status> = [Status::Panic].into_iter().collect();
        a.apply_from_stats(5, 0, 5, &immune); // sanity<=0 but immune → no Panic
        assert!(!a.is_active(Status::Panic));
    }

    // -- on_turn_start roll-order + immunity tests (mirror afflictions.ts:130-152) --

    #[test]
    fn on_turn_start_rolls_active_clearables_in_order_and_ticks_turns() {
        // Panic + Fear active, Confused inactive (energy=5 keeps it off).
        // The roll loop runs over active clearables ONLY, in CLEARABLE order
        // [Panic, Fear, Confused], each consuming exactly one draw. Both Panic
        // and Fear tick their turns_active counter (incremented before the roll);
        // Confused is inactive so it takes no draw and its counter stays 0.
        //
        // Stats are chosen so neither Panic nor Fear leaves its threshold band
        // during apply_from_stats — otherwise clear_episode would reset the
        // counter (mirroring the TS oracle). No single sanity keeps BOTH in band
        // (Panic needs sanity<=0, Fear needs 0<sanity<5), so we prove the
        // in-order draw count via the rng state instead (see the assert below),
        // and prove the tick with a case where the roll does NOT shake the
        // status off. Seed 1: draw1=0.627→roll 63 (>20, Panic not shaken),
        // draw2=0.0027→roll 1 (<=40, Fear shaken). With sanity=0 both are below
        // Panic's band; Fear leaves its band and is cleared → Fear counter 0.
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        a.set_active(Status::Fear, true);
        let cfg = default_affliction_config();
        let mut rng = Rng::seeded(1);
        a.on_turn_start(10, 0, 5, &BTreeSet::new(), &cfg, &mut rng);
        // Exactly two draws consumed, in order (Panic then Fear); Confused none.
        let mut expect = Rng::seeded(1);
        expect.next_f64();
        expect.next_f64();
        assert_eq!(rng, expect);
        // Panic stayed in band (sanity<=0) and was not shaken → counter ticked to 1.
        assert_eq!(a.turns_active.get(&Status::Panic).copied().unwrap_or(0), 1);
        assert!(a.is_active(Status::Panic));
        // Fear left its band (sanity==0, not 0<sanity<5) → episode cleared, counter 0.
        assert_eq!(a.turns_active.get(&Status::Fear).copied().unwrap_or(0), 0);
        assert!(!a.is_active(Status::Fear));
        // Confused was inactive → no draw, counter stays 0.
        assert_eq!(a.turns_active.get(&Status::Confused).copied().unwrap_or(0), 0);
    }

    #[test]
    fn on_turn_start_consumes_exactly_one_draw_per_active_clearable() {
        // With one active clearable, exactly one draw is consumed: the rng after
        // on_turn_start must equal the rng after a single manual next_f64().
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        let cfg = default_affliction_config();
        let mut rng_a = Rng::seeded(7);
        a.on_turn_start(10, 0, 5, &BTreeSet::new(), &cfg, &mut rng_a);
        let mut rng_b = Rng::seeded(7);
        rng_b.next_f64(); // exactly one draw
        assert_eq!(rng_a, rng_b);
    }

    #[test]
    fn on_turn_start_decrements_immunity_after_reconcile() {
        let mut a = Afflictions::default();
        a.immunity.insert(Status::Panic, 2); // grant_immunity lands in Task 4
        let cfg = default_affliction_config();
        let mut rng = Rng::seeded(1);
        a.on_turn_start(10, 0, 5, &BTreeSet::new(), &cfg, &mut rng);
        assert_eq!(a.immunity.get(&Status::Panic).copied().unwrap_or(0), 1); // 2 → 1
    }

    #[test]
    fn on_turn_start_immunity_at_one_is_removed() {
        let mut a = Afflictions::default();
        a.immunity.insert(Status::Fear, 1);
        let cfg = default_affliction_config();
        let mut rng = Rng::seeded(1);
        a.on_turn_start(10, 5, 5, &BTreeSet::new(), &cfg, &mut rng);
        assert!(!a.immunity.contains_key(&Status::Fear)); // 1 → removed
    }

    // -- grant_immunity tests (mirrors afflictions.ts:182-192) --

    #[test]
    fn grant_immunity_refreshes_to_max_and_resets_episode() {
        let mut a = Afflictions::default();
        a.set_active(Status::Panic, true);
        a.grant_immunity(&[Status::Panic], 3);
        assert_eq!(a.immunity_of(Status::Panic), 3);
        assert!(!a.is_active(Status::Panic)); // episode reset
        a.grant_immunity(&[Status::Panic], 1);
        assert_eq!(a.immunity_of(Status::Panic), 3); // max(3,1)
    }

    #[test]
    fn grant_immunity_ignores_ko() {
        let mut a = Afflictions::default();
        a.grant_immunity(&[Status::Ko], 5);
        assert_eq!(a.immunity_of(Status::Ko), 0);
    }
}
