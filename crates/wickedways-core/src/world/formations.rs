//! Encounter formations: a native `FormationBehavior` trait resolved by
//! `behavior_key` (mirrors `mechanic_op`/`exit_behavior`/`scene_behavior`), plus
//! `World::maybe_spawn` (the port of TS `EncounterTable.maybeSpawn`). Behavior is
//! compiled-in; only the encounter table's `visited`/`formations`/`baseChance`
//! serialize.
use alloc::string::ToString;
use alloc::vec::Vec;

use crate::error::ProceduralViolation;
use crate::presentation::PresentationCue;
use crate::world::descriptor::Catalog;
use crate::world::ids::{CharacterId, RoomId};
use crate::world::mechanics::CampaignView;
use crate::world::snapshot::CharacterSnapshot;
use crate::world::World;

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

    /// Test-only helper: insert a minimal live (non-KO) Mob character `name` (id ==
    /// name) into `room`, and push its id into that room's `occupant_ids`. Mirrors
    /// `seat_mob` in `movement.rs`'s test module — used by `maybe_spawn` spawn-gate
    /// tests to seat a live non-party occupant that should suppress a spawn.
    #[cfg(test)]
    pub fn seat_test_mob(w: &mut crate::world::World, name: &str, room: &str) {
        use alloc::collections::BTreeMap;
        use crate::world::afflictions::Afflictions;
        use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};
        let id = CharacterId(name.into());
        let room_id = RoomId(room.into());
        let snap = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: id.clone(),
            name: name.into(),
            stats: Stats { health: 4.0, sanity: 0.0, energy: 3.0 },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(room_id.clone()),
            inventory: InventorySnapshot { slots: 0, item_ids: alloc::vec![], key_ids: alloc::vec![] },
            equipment: BTreeMap::new(),
            history: alloc::vec![],
            archetype_immunities: alloc::vec![],
            afflictions: Afflictions::default(),
            archetype_id: None,
            origin: None,
            base_escape_chance: None,
            material_drops: None,
            light_averse: None,
            natural_attack: None,
            npc_behavior_key: None,
        };
        w.characters.insert(id.clone(), snap);
        if let Some(r) = w.rooms.get_mut(&room_id) {
            if !r.occupant_ids.contains(&id) {
                r.occupant_ids.push(id);
            }
        }
    }
}

impl World {
    /// Port of TS `EncounterTable.maybeSpawn` (`encounter-table.ts:82-102`). Marks
    /// the room visited (once), then — if unvisited, no active non-party occupant,
    /// formations present, and the threshold roll passes — selects one weighted
    /// formation, builds its mobs, and places each (origin "campaign", inserted into
    /// `characters` + `occupant_ids`, room enter-scenes fired SILENTLY). Emits no
    /// cues. Returns the spawned ids.
    pub fn maybe_spawn(
        &mut self,
        room: &RoomId,
        cat: &Catalog,
    ) -> Result<Vec<CharacterId>, ProceduralViolation> {
        // 1-2. first-visit-only; mark visited unconditionally.
        let already = self
            .campaign
            .encounter_table
            .get("visited")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().any(|v| v.as_str() == Some(&room.0)))
            .unwrap_or(false);
        if already {
            return Ok(Vec::new());
        }
        if let Some(arr) = self.campaign.encounter_table.get_mut("visited").and_then(|v| v.as_array_mut()) {
            arr.push(serde_json::Value::String(room.0.clone()));
        }

        // 3. suppressed if any active (non-KO) non-party occupant present.
        let party: alloc::collections::BTreeSet<CharacterId> =
            self.campaign.party_ids.iter().cloned().collect();
        let occupants: Vec<CharacterId> =
            self.rooms.get(room).map(|r| r.occupant_ids.clone()).unwrap_or_default();
        if occupants.iter().any(|o| !party.contains(o) && !self.is_ko(o)) {
            return Ok(Vec::new());
        }

        // 4. no formations → no spawn.
        let formations: Vec<(alloc::string::String, i64)> = self
            .campaign
            .encounter_table
            .get("formations")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| {
                        let k = f.get("behaviorKey")?.as_str()?.to_string();
                        let w = f.get("weight")?.as_i64()?;
                        Some((k, w))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if formations.is_empty() {
            return Ok(Vec::new());
        }

        // 5. threshold roll (1 rng draw). threshold = clamp(baseChance * spawnModifier, 0, 100).
        let base = self.campaign.encounter_table.get("baseChance").and_then(|v| v.as_i64()).unwrap_or(0);
        let spawn_mod = self.rooms.get(room).map(|r| r.spawn_modifier).unwrap_or(1);
        let threshold = (base * spawn_mod).clamp(0, 100);
        let r = crate::dice::roll(100, self.rng.next_f64()) as i64;
        if r > threshold {
            return Ok(Vec::new());
        }

        // 6. weighted select (2nd rng draw).
        let total: i64 = formations.iter().map(|(_, w)| *w).sum();
        let mut pick = crate::dice::roll(total as u32, self.rng.next_f64()) as i64;
        let mut chosen: Option<&str> = None;
        for (k, w) in &formations {
            pick -= *w;
            if pick <= 0 {
                chosen = Some(k);
                break;
            }
        }
        let key = chosen.unwrap_or(&formations[formations.len() - 1].0);
        let behavior = formation(key)
            .ok_or_else(|| ProceduralViolation(alloc::format!("Formation '{key}' is not registered.")))?;

        // 7. build.
        let view = self.build_campaign_view(cat);
        let mobs = behavior.build(&view);

        // 8. place each: origin "campaign", room set, insert, occupant push, silent enter-scenes.
        let mut spawned = Vec::new();
        for mut mob in mobs {
            mob.origin = Some(serde_json::json!("campaign"));
            mob.current_room_id = Some(room.clone());
            let id = mob.id.clone();
            self.characters.insert(id.clone(), mob);
            if let Some(r) = self.rooms.get_mut(room) {
                if !r.occupant_ids.contains(&id) {
                    r.occupant_ids.push(id.clone());
                }
            }
            // Silent [PLACE] enter-scene firing: cues discarded.
            let mut discard: Vec<PresentationCue> = Vec::new();
            self.fire_scenes(room, "enter", cat, &mut discard)?;
            spawned.push(id);
        }
        Ok(spawned)
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

#[cfg(test)]
mod spawn_tests {
    use super::*;
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, RoomId};
    use crate::world::test_support::world_two_rooms;

    fn rid(s: &str) -> RoomId { RoomId(s.into()) }

    /// Put a single `conformance:wraith` formation (weight 1) and a baseChance into
    /// the encounter table, and clear `visited`.
    fn arm_encounter_table(w: &mut crate::world::World, base_chance: i64) {
        w.campaign.encounter_table = serde_json::json!({
            "baseChance": base_chance,
            "visited": [],
            "formations": [ { "behaviorKey": "conformance:wraith", "weight": 1 } ]
        });
    }

    #[test]
    fn spawns_wraith_when_threshold_guarantees_and_marks_visited() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100); // threshold = clamp(100*spawn_mod,0,100) = 100 → always
        // ensure spawn_modifier is 1 on "next"
        if let Some(r) = w.rooms.get_mut(&rid("next")) { r.spawn_modifier = 1; }
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert_eq!(spawned, alloc::vec![CharacterId("campaign-mob:wraith".into())]);
        // inserted into characters with origin "campaign" and room "next"
        let m = &w.characters[&CharacterId("campaign-mob:wraith".into())];
        assert_eq!(m.origin, Some(serde_json::json!("campaign")));
        assert_eq!(m.current_room_id, Some(rid("next")));
        // present in the room occupants
        assert!(w.rooms[&rid("next")].occupant_ids.contains(&CharacterId("campaign-mob:wraith".into())));
        // visited marked
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap()
            .iter().any(|v| v == "next"));
    }

    #[test]
    fn no_spawn_when_already_visited_but_still_returns_empty() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100);
        if let Some(arr) = w.campaign.encounter_table["visited"].as_array_mut() {
            arr.push(serde_json::json!("next"));
        }
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(!w.characters.contains_key(&CharacterId("campaign-mob:wraith".into())));
    }

    #[test]
    fn no_spawn_when_active_non_party_occupant_present_but_marks_visited() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 100);
        // seat a live mob in "next"
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.occupant_ids.push(CharacterId("resident".into()));
        }
        // (insert a minimal live mob "resident" so is_ko(false); reuse seat helper pattern)
        crate::world::formations::conformance::seat_test_mob(&mut w, "resident", "next");
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap().iter().any(|v| v == "next"));
    }

    #[test]
    fn no_spawn_when_no_formations_but_marks_visited() {
        let mut w = world_two_rooms(false);
        w.campaign.encounter_table = serde_json::json!({ "baseChance": 100, "visited": [], "formations": [] });
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(w.campaign.encounter_table["visited"].as_array().unwrap().iter().any(|v| v == "next"));
    }

    #[test]
    fn roll_miss_does_not_spawn() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 0); // threshold 0 → roll(100) always > 0 → never spawn
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(!w.characters.contains_key(&CharacterId("campaign-mob:wraith".into())));
    }
}
