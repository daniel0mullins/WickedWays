//! Encounter formations: a native `FormationBehavior` trait resolved by
//! `behavior_key` (mirrors `mechanic_op`/`exit_behavior`/`scene_behavior`), plus
//! `World::maybe_spawn` (the port of `EncounterTable.maybeSpawn`). Behavior is
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

/// The outcome of resolving an encounter `behaviorKey`: a compiled-in native
/// formation, or a data-driven descriptor from the catalog.
pub enum ResolvedFormation<'a> {
    Native(&'static dyn FormationBehavior),
    Descriptor(&'a crate::world::formation_descriptor::FormationDescriptor),
}

/// Resolve a formation `key`: native first (a first-party `FormationBehavior`),
/// then a catalog `FormationDescriptor`. `None` if neither knows the key (surfaced
/// as a `ProceduralViolation` at the spawn site). Formations are NOT a
/// `BehaviorScript` family — descriptors live in `Catalog.formations`.
pub fn resolve_formation<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedFormation<'a>> {
    if let Some(op) = formation(key) {
        return Some(ResolvedFormation::Native(op));
    }
    cat.formations.get(key).map(ResolvedFormation::Descriptor)
}

#[cfg(any(test, feature = "conformance"))]
pub mod conformance {
    use super::*;
    use crate::world::afflictions::Afflictions;
    use crate::world::ids::CharacterId;
    use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};
    use alloc::collections::BTreeMap;

    /// The deterministic id of the spawned wraith (assigned in `build`, matched by
    /// the TS shadow). Spawned ids are not auto-derived.
    pub const WRAITH_ID: &str = "campaign-mob:wraith";

    /// Build the fixed conformance mob. `origin`/`current_room_id` are left `None`
    /// here — `World::maybe_spawn` sets `origin = "campaign"` and the room. Modeled
    /// on the mob shape the `mob-defeat` fixture round-trips: the `Mob`
    /// serializer (`Mob.serializeExtra`) ALWAYS emits `baseEscapeChance` (default
    /// 50), `materialDrops` (default `{}`), `lightAverse` (default `false`), and
    /// `naturalAttack` (default `{stat:"health",power:1}`), so a byte-faithful
    /// spawned snapshot must carry them too.
    pub fn build_wraith() -> CharacterSnapshot {
        CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: CharacterId(WRAITH_ID.into()),
            name: "Wraith".into(),
            stats: Stats {
                health: 4.0,
                sanity: 0.0,
                energy: 3.0,
            },
            actions_per_round: 1,
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
            base_escape_chance: Some(50),
            material_drops: Some(serde_json::json!({})),
            light_averse: Some(false),
            natural_attack: Some(serde_json::json!({ "stat": "health", "power": 1 })),
            npc_behavior_key: None,
            npc_state: serde_json::Value::Null,
            visible: true,
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
        use crate::world::afflictions::Afflictions;
        use crate::world::snapshot::{CharacterKind, InventorySnapshot, Stats};
        use alloc::collections::BTreeMap;
        let id = CharacterId(name.into());
        let room_id = RoomId(room.into());
        let snap = CharacterSnapshot {
            kind: CharacterKind::Mob,
            id: id.clone(),
            name: name.into(),
            stats: Stats {
                health: 4.0,
                sanity: 0.0,
                energy: 3.0,
            },
            actions_per_round: 1,
            actions_this_round: 0,
            current_room_id: Some(room_id.clone()),
            inventory: InventorySnapshot {
                slots: 0,
                item_ids: alloc::vec![],
                key_ids: alloc::vec![],
            },
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
            npc_state: serde_json::Value::Null,
            visible: true,
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
    /// Port of `EncounterTable.maybeSpawn`. Marks
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
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(&room.0)));
        if already {
            return Ok(Vec::new());
        }
        // Mark visited, creating the array if a hydrated table lacked the key
        // (serialized snapshots always carry `visited`; this is defensive parity
        // with TS's always-present `Set`).
        if let Some(obj) = self.campaign.encounter_table.as_object_mut() {
            // `entry(..).or_insert_with(..)` = "get, creating if missing" — the
            // one-lookup version of `map[k] ??= []`.
            let arr = obj
                .entry("visited")
                .or_insert_with(|| serde_json::Value::Array(alloc::vec::Vec::new()));
            if let Some(a) = arr.as_array_mut() {
                a.push(serde_json::Value::String(room.0.clone()));
            }
        }

        // 3. suppressed if any active (non-KO) non-party occupant present.
        let party: alloc::collections::BTreeSet<CharacterId> =
            self.campaign.party_ids.iter().cloned().collect();
        // The ids are cloned out rather than borrowed: holding a borrow of
        // `self.rooms` would lock `self` and forbid the `self.is_ko(..)` calls below.
        let occupants: Vec<CharacterId> = self
            .rooms
            .get(room)
            .map(|r| r.occupant_ids.clone())
            .unwrap_or_default();
        if occupants
            .iter()
            .any(|o| !party.contains(o) && !self.is_ko(o))
        {
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
        let base = self
            .campaign
            .encounter_table
            .get("baseChance")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let spawn_mod = self.rooms.get(room).map_or(1, |r| r.spawn_modifier);
        let threshold = (base * spawn_mod).clamp(0, 100);
        let r = i64::from(crate::dice::roll(100, self.rng.next_f64()));
        if r > threshold {
            return Ok(Vec::new());
        }

        // 6. weighted select (2nd rng draw).
        let total: i64 = formations.iter().map(|(_, w)| *w).sum();
        let mut pick = i64::from(crate::dice::roll(total as u32, self.rng.next_f64()));
        let mut chosen: Option<&str> = None;
        for (k, w) in &formations {
            pick -= *w;
            if pick <= 0 {
                chosen = Some(k);
                break;
            }
        }
        let key = chosen.unwrap_or(&formations[formations.len() - 1].0);

        // 7. resolve (native first, then descriptor) + build.
        let mobs = match resolve_formation(key, cat).ok_or_else(|| {
            ProceduralViolation(alloc::format!("Formation '{key}' is not registered."))
        })? {
            ResolvedFormation::Native(b) => {
                let view = self.build_campaign_view(cat);
                b.build(&view)
            }
            ResolvedFormation::Descriptor(d) => {
                let mut built = d.build();
                // Seed each MobSpec's drops. A dropped item id needs a matching
                // `ItemSnapshot` in `World.items` (the snapshot serializer emits
                // `items` by reachability — a dangling inventory id diverges the
                // gate). `build` returns snapshots in `d.mobs` order, so zip aligns
                // each built mob with its spec. Drop id scheme = `{mob.id}:drop#{i}`
                // (mirrors authored mobs). A freshly authored
                // drop item serializes with `durability = descriptor.maxDurability`
                // (omitted when absent) and `modifier = descriptor.modifier` — proven
                // byte-for-byte by the `mob-drop` golden.
                for (mob, spec) in built.iter_mut().zip(d.mobs.iter()) {
                    for (drop_index, drop_key) in spec.drops.iter().enumerate() {
                        let desc = cat.items.get(drop_key).ok_or_else(|| {
                            ProceduralViolation(alloc::format!(
                                "No item registered for drop key '{drop_key}'"
                            ))
                        })?;
                        let item_id = crate::world::ids::ItemId(alloc::format!(
                            "{}:drop#{drop_index}",
                            mob.id.0
                        ));
                        self.items.insert(
                            item_id.clone(),
                            crate::world::snapshot::ItemSnapshot::Item {
                                id: item_id.clone(),
                                behavior_key: drop_key.clone(),
                                durability: desc.max_durability,
                                modifier: desc.modifier,
                            },
                        );
                        mob.inventory.item_ids.push(item_id);
                    }
                    // `Mob` widens slots to hold its drops; a spawned
                    // mob starts at 0 slots, so slots = max(current, drops.len()).
                    let needed = spec.drops.len() as i64;
                    if mob.inventory.slots < needed {
                        mob.inventory.slots = needed;
                    }
                }
                built
            }
        };

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
            // Silent [PLACE] enter-scene firing: cues discarded. The freshly-placed
            // mob is the entering actor for any scripted enter-scene.
            let mut discard: Vec<PresentationCue> = Vec::new();
            self.fire_scenes(room, "enter", &id, cat, &mut discard)?;
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

    #[test]
    fn descriptor_build_produces_snapshots_with_deterministic_ids() {
        use crate::stats::StatType;
        use crate::world::formation_descriptor::{FormationDescriptor, MobSpec, NaturalAttack};
        use crate::world::snapshot::Stats;
        let spec = MobSpec {
            name: "Rat".into(),
            stats: Stats {
                health: 2.0,
                sanity: 2.0,
                energy: 3.0,
            },
            natural_attack: NaturalAttack {
                stat: StatType::Health,
                power: 1.0,
            },
            drops: alloc::vec!["items/rat-tail".into()],
            base_escape_chance: 50,
            light_averse: false,
            material_drops: serde_json::json!({}),
            actions_per_round: 2,
        };
        let desc = FormationDescriptor {
            mobs: alloc::vec![spec.clone(), spec],
        };
        let built = desc.build();
        assert_eq!(built.len(), 2);
        assert_eq!(built[0].id.0, "campaign-mob:rat");
        assert_eq!(built[1].id.0, "campaign-mob:rat#2"); // distinct, deterministic
        assert_eq!(built[0].kind, crate::world::snapshot::CharacterKind::Mob);
        assert_eq!(
            built[0].natural_attack,
            Some(serde_json::json!({ "stat": "health", "power": 1.0 }))
        );
        assert_eq!(built[0].base_escape_chance, Some(50));
    }

    #[test]
    fn resolve_formation_prefers_native_then_descriptor() {
        use crate::world::descriptor::Catalog;
        use crate::world::formation_descriptor::FormationDescriptor;
        use alloc::collections::BTreeMap;
        let mut formations = BTreeMap::new();
        formations.insert(
            "rat-single".to_string(),
            FormationDescriptor {
                mobs: alloc::vec![],
            },
        );
        let cat = Catalog {
            formations,
            ..Default::default()
        };
        assert!(matches!(
            resolve_formation("rat-single", &cat),
            Some(ResolvedFormation::Descriptor(_))
        ));
        assert!(resolve_formation("nope", &cat).is_none());
        // conformance:wraith stays native (test build has the cfg arm)
        assert!(matches!(
            resolve_formation("conformance:wraith", &cat),
            Some(ResolvedFormation::Native(_))
        ));
    }
}

#[cfg(test)]
mod spawn_tests {
    use crate::world::descriptor::Catalog;
    use crate::world::ids::CharacterId;
    use crate::world::test_support::rid;
    use crate::world::test_support::world_two_rooms;
    use crate::world::test_support::{item_desc, props};

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
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.spawn_modifier = 1;
        }
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert_eq!(
            spawned,
            alloc::vec![CharacterId("campaign-mob:wraith".into())]
        );
        // inserted into characters with origin "campaign" and room "next"
        let m = &w.characters[&CharacterId("campaign-mob:wraith".into())];
        assert_eq!(m.origin, Some(serde_json::json!("campaign")));
        assert_eq!(m.current_room_id, Some(rid("next")));
        // present in the room occupants
        assert!(w.rooms[&rid("next")]
            .occupant_ids
            .contains(&CharacterId("campaign-mob:wraith".into())));
        // visited marked
        assert!(w.campaign.encounter_table["visited"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "next"));
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
        assert!(!w
            .characters
            .contains_key(&CharacterId("campaign-mob:wraith".into())));
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
        assert!(w.campaign.encounter_table["visited"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "next"));
    }

    #[test]
    fn no_spawn_when_no_formations_but_marks_visited() {
        let mut w = world_two_rooms(false);
        w.campaign.encounter_table =
            serde_json::json!({ "baseChance": 100, "visited": [], "formations": [] });
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(w.campaign.encounter_table["visited"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "next"));
    }

    #[test]
    fn roll_miss_does_not_spawn() {
        let mut w = world_two_rooms(false);
        arm_encounter_table(&mut w, 0); // threshold 0 → roll(100) always > 0 → never spawn
        let spawned = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        assert!(spawned.is_empty());
        assert!(!w
            .characters
            .contains_key(&CharacterId("campaign-mob:wraith".into())));
    }

    /// A rat-tail-like consumable item descriptor: NO `maxDurability` (so a fresh
    /// snapshot omits `durability`), modifier 0 — matches the fresh-drop shape the
    /// `mob-drop` golden proves (a no-maxDurability item serializes with only
    /// `modifier`, no `durability`).
    fn rat_tail_desc() -> crate::world::descriptor::ItemDescriptor {
        use crate::stats::StatType;
        use crate::world::descriptor::{ItemDescriptor, ItemType};
        ItemDescriptor {
            properties: props(false, true, false),
            recipe: serde_json::json!({}),
            teaches: serde_json::json!(null),
            immunities: serde_json::json!(null),
            grants_immunity: serde_json::json!(null),
            ..item_desc("Rat Tail", ItemType::Consumable, StatType::Health, 0)
        }
    }

    /// Build a catalog with a `rat-single`/`rat-pair` descriptor formation whose
    /// mob(s) drop `items/rat-tail`, plus the matching item descriptor.
    fn rat_catalog(mob_count: usize) -> Catalog {
        use crate::stats::StatType;
        use crate::world::formation_descriptor::{FormationDescriptor, MobSpec, NaturalAttack};
        use crate::world::snapshot::Stats;
        use alloc::collections::BTreeMap;
        let spec = MobSpec {
            name: "Rat".into(),
            stats: Stats {
                health: 2.0,
                sanity: 2.0,
                energy: 3.0,
            },
            natural_attack: NaturalAttack {
                stat: StatType::Health,
                power: 1.0,
            },
            drops: alloc::vec!["items/rat-tail".into()],
            base_escape_chance: 50,
            light_averse: false,
            material_drops: serde_json::json!({}),
            actions_per_round: 2,
        };
        let mobs: alloc::vec::Vec<MobSpec> = (0..mob_count).map(|_| spec.clone()).collect();
        let mut formations = BTreeMap::new();
        formations.insert("rat-formation".to_string(), FormationDescriptor { mobs });
        let mut items = BTreeMap::new();
        items.insert("items/rat-tail".to_string(), rat_tail_desc());
        Catalog {
            formations,
            items,
            ..Default::default()
        }
    }

    fn arm_descriptor_table(w: &mut crate::world::World) {
        w.campaign.encounter_table = serde_json::json!({
            "baseChance": 100,
            "visited": [],
            "formations": [ { "behaviorKey": "rat-formation", "weight": 1 } ]
        });
        // threshold = clamp(100 * spawn_mod, 0, 100); ensure spawn_mod = 1 → always spawn
        if let Some(r) = w.rooms.get_mut(&rid("next")) {
            r.spawn_modifier = 1;
        }
    }

    #[test]
    fn descriptor_spawn_seeds_drop_item_and_inventory() {
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        let mut w = world_two_rooms(false);
        arm_descriptor_table(&mut w);
        let cat = rat_catalog(1);
        let spawned = w.maybe_spawn(&rid("next"), &cat).unwrap();
        assert_eq!(spawned, alloc::vec![CharacterId("campaign-mob:rat".into())]);

        let m = &w.characters[&CharacterId("campaign-mob:rat".into())];
        let drop_id = ItemId("campaign-mob:rat:drop#0".into());
        // inventory carries the drop id + a slot for it
        assert!(
            m.inventory.item_ids.contains(&drop_id),
            "drop id in inventory"
        );
        assert!(m.inventory.slots >= 1, "slots widened for the drop");

        // World.items has the minted snapshot (fresh: no durability, modifier 0)
        let snap = w.items.get(&drop_id).expect("drop snapshot in World.items");
        match snap {
            ItemSnapshot::Item {
                id,
                behavior_key,
                durability,
                modifier,
            } => {
                assert_eq!(id, &drop_id);
                assert_eq!(behavior_key, "items/rat-tail");
                assert_eq!(*durability, None, "no maxDurability → durability omitted");
                assert_eq!(*modifier, 0, "fresh item takes descriptor modifier");
            }
            _ => panic!("expected an Item snapshot, got a Key"),
        }
    }

    #[test]
    fn descriptor_pair_spawn_seeds_second_rats_drop() {
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        let mut w = world_two_rooms(false);
        arm_descriptor_table(&mut w);
        let cat = rat_catalog(2);
        let spawned = w.maybe_spawn(&rid("next"), &cat).unwrap();
        assert_eq!(
            spawned,
            alloc::vec![
                CharacterId("campaign-mob:rat".into()),
                CharacterId("campaign-mob:rat#2".into())
            ]
        );

        // 2nd rat's drop id derives from its own (indexed) mob id
        let second = &w.characters[&CharacterId("campaign-mob:rat#2".into())];
        let drop_id = ItemId("campaign-mob:rat#2:drop#0".into());
        assert!(second.inventory.item_ids.contains(&drop_id));
        assert!(second.inventory.slots >= 1);
        assert!(matches!(
            w.items.get(&drop_id),
            Some(ItemSnapshot::Item { behavior_key, .. }) if behavior_key == "items/rat-tail"
        ));
    }

    #[test]
    fn maybe_spawn_marks_visited_even_when_visited_key_absent() {
        let mut w = world_two_rooms(false);
        // encounter table with NO "visited" key at all
        w.campaign.encounter_table = serde_json::json!({ "baseChance": 0, "formations": [] });
        let _ = w.maybe_spawn(&rid("next"), &Catalog::default()).unwrap();
        // the mark must still land: "visited" now exists and contains "next"
        let visited = w
            .campaign
            .encounter_table
            .get("visited")
            .and_then(|v| v.as_array());
        assert!(
            visited.is_some(),
            "visited array should be created when absent"
        );
        assert!(visited.unwrap().iter().any(|v| v.as_str() == Some("next")));
    }
}
