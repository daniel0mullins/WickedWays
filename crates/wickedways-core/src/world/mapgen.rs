//! Procedural map generation (the port of the TS-era `buildMap`).
//!
//! A campaign that carries `campaign.map_gen` authors its rooms WITHOUT exits;
//! `begin_campaign` calls [`World::generate_map`] to wire them into a connected
//! graph via a randomized spanning tree: every room reachable, bidirectional
//! exits registered in both rooms under opposite compass directions, no
//! self-connections, and at most `max_exits_per_room` exits per room.
//! `required` pairs are pinned as neighbors BEFORE the tree is laid down (they
//! may carry door behaviors, so a keyed mausoleum gate exists in every
//! layout); `extra_connections` adds loop edges afterwards (an absolute count,
//! or a fraction of `n - 1` when strictly between 0 and 1).
//!
//! Determinism: room order comes from the `BTreeMap` (id-sorted) and every
//! random choice is drawn from `World.rng`, so a given seed always produces
//! the same map — replays and the golden gates hold. A fresh seed per
//! playthrough (the host's job) is what makes each night in the cemetery lay
//! out differently.
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::dice::roll;
use crate::error::ProceduralViolation;
use crate::world::direction::Direction;
use crate::world::ids::{ExitId, RoomId};
use crate::world::snapshot::{ExitSnapshot, RequiredExitSnapshot};
use crate::world::World;

impl World {
    /// Wire the room graph from `campaign.map_gen`, drawing all randomness from
    /// `World.rng`. A no-op without a config, with fewer than two rooms, or when
    /// exits already exist (a restored mid-play world keeps its map).
    ///
    /// # Errors
    /// [`ProceduralViolation`] when a required connection names an unknown room,
    /// or a room cannot be wired in (its hosts fully saturated) — a stranded
    /// room would break the "any survivor can reach daybreak" contract, so the
    /// build fails loudly rather than leaving one.
    pub fn generate_map(&mut self) -> Result<(), ProceduralViolation> {
        let Some(cfg) = self.campaign.map_gen.clone() else {
            return Ok(());
        };
        if !self.exits.is_empty() {
            return Ok(());
        }
        let room_ids: Vec<RoomId> = self.rooms.keys().cloned().collect();
        let n = room_ids.len();
        if n < 2 {
            return Ok(());
        }
        let cap = cfg.max_exits_per_room.unwrap_or(8).clamp(2, 8) as usize;
        let index: BTreeMap<&RoomId, usize> =
            room_ids.iter().enumerate().map(|(i, r)| (r, i)).collect();

        // Sealed rooms take NO tree/loop edges — a `required` keyed door is
        // their only entrance. Unknown names fail loudly.
        let mut sealed = alloc::vec![false; n];
        for s in &cfg.sealed {
            let Some(&i) = index.get(s) else {
                return Err(ProceduralViolation(format!(
                    "Map generation: sealed entry references unknown room '{}'.",
                    s.0
                )));
            };
            sealed[i] = true;
        }

        // Union-find over room indices (path-halving find).
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(parent: &mut [usize], mut i: usize) -> usize {
            while parent[i] != i {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            i
        }

        // 1. Required connections first — pinned neighbors with authored doors.
        for req in &cfg.required {
            let (Some(&a), Some(&b)) = (index.get(&req.from), index.get(&req.to)) else {
                return Err(ProceduralViolation(format!(
                    "Map generation: required connection references unknown room \
                     ('{}' | '{}').",
                    req.from.0, req.to.0
                )));
            };
            if a == b {
                return Err(ProceduralViolation(format!(
                    "Map generation: required connection from room '{}' to itself.",
                    req.from.0
                )));
            }
            if self.adjacent(&room_ids[a], &room_ids[b]) {
                continue; // duplicate required pair — first declaration won
            }
            self.wire(&room_ids[a], &room_ids[b], cap, Some(req))?;
            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
            parent[ra] = rb;
        }

        // 2. Randomized spanning tree: grow outward from the start component in
        // shuffled room order, attaching each unconnected component by one edge.
        let order = self.shuffled_indices(n);
        let seed = self
            .campaign
            .party_ids
            .first()
            .and_then(|pid| self.characters.get(pid))
            .and_then(|c| c.current_room_id.as_ref())
            .and_then(|r| index.get(r).copied())
            .unwrap_or(order[0]);
        let seed_root = find(&mut parent, seed);
        let mut connected: Vec<usize> = (0..n)
            .filter(|&i| find(&mut parent, i) == seed_root)
            .collect();
        for &i in &order {
            if sealed[i] {
                continue; // reached only through its required passage(s)
            }
            let root = find(&mut parent, seed);
            if find(&mut parent, i) == root {
                continue;
            }
            // The whole component of `i` joins through one new edge. Try `i`
            // itself first, then the rest of its UNSEALED component members as
            // attach points (sealed rooms never take a generated edge).
            let component: Vec<usize> = {
                let ci = find(&mut parent, i);
                let mut c: Vec<usize> = (0..n)
                    .filter(|&j| find(&mut parent, j) == ci && !sealed[j])
                    .collect();
                // `i` first, the rest in id order (deterministic).
                c.retain(|&j| j != i);
                let mut with_i = alloc::vec![i];
                with_i.extend(c);
                with_i
            };
            let mut wired = false;
            'attach: for &member in &component {
                let hosts: Vec<usize> = connected
                    .iter()
                    .copied()
                    .filter(|&h| {
                        !sealed[h] && self.compatible(&room_ids[h], &room_ids[member], cap)
                    })
                    .collect();
                if hosts.is_empty() {
                    continue;
                }
                let pick = (i64::from(roll(hosts.len() as u32, self.rng.next_f64())) - 1) as usize;
                self.wire(&room_ids[hosts[pick]], &room_ids[member], cap, None)?;
                let (rm, rh) = (find(&mut parent, member), find(&mut parent, hosts[pick]));
                parent[rm] = rh;
                wired = true;
                break 'attach;
            }
            if !wired {
                return Err(ProceduralViolation(format!(
                    "Map generation: could not wire room '{}' — every connected room \
                     is saturated (raise maxExitsPerRoom or extraConnections).",
                    room_ids[i].0
                )));
            }
            let root = find(&mut parent, seed);
            connected = (0..n).filter(|&j| find(&mut parent, j) == root).collect();
        }

        // Every room — sealed included — must have ended up in the seed
        // component (a sealed room whose required passages reach no unsealed
        // room would be stranded).
        {
            let root = find(&mut parent, seed);
            for (i, room) in room_ids.iter().enumerate() {
                if find(&mut parent, i) != root {
                    return Err(ProceduralViolation(format!(
                        "Map generation: room '{}' is unreachable — a sealed room \
                         needs a required passage to the rest of the map.",
                        room.0
                    )));
                }
            }
        }

        // 3. Loop edges beyond the tree.
        let extra = if cfg.extra_connections > 0.0 && cfg.extra_connections < 1.0 {
            // libm-free round-half-up (no_std: f64::round needs std).
            (cfg.extra_connections * ((n - 1) as f64) + 0.5) as usize
        } else if cfg.extra_connections >= 1.0 {
            cfg.extra_connections as usize
        } else {
            0
        };
        let mut added = 0usize;
        let mut attempts = extra.saturating_mul(10);
        while added < extra && attempts > 0 {
            attempts -= 1;
            let a = (i64::from(roll(n as u32, self.rng.next_f64())) - 1) as usize;
            let b = (i64::from(roll(n as u32, self.rng.next_f64())) - 1) as usize;
            if a == b
                || sealed[a]
                || sealed[b]
                || self.adjacent(&room_ids[a], &room_ids[b])
                || !self.compatible(&room_ids[a], &room_ids[b], cap)
            {
                continue;
            }
            self.wire(&room_ids[a], &room_ids[b], cap, None)?;
            added += 1;
        }

        Ok(())
    }

    /// Fisher-Yates permutation of `0..n` over `World.rng` (the same shuffle
    /// idiom as the villain deck).
    fn shuffled_indices(&mut self, n: usize) -> Vec<usize> {
        let mut order: Vec<usize> = (0..n).collect();
        for i in (1..n).rev() {
            let unit = self.rng.next_f64();
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let j = (unit * ((i + 1) as f64)) as usize;
            order.swap(i, j.min(i));
        }
        order
    }

    /// Whether the two rooms already share an exit.
    fn adjacent(&self, a: &RoomId, b: &RoomId) -> bool {
        self.exits.contains_key(&gen_exit_id(a, b))
    }

    /// Whether a plain edge can still be wired between the two rooms: both
    /// below the exit cap, with at least one direction free on `a` whose
    /// opposite is free on `b`.
    fn compatible(&self, a: &RoomId, b: &RoomId, cap: usize) -> bool {
        !self.free_direction_pairs(a, b, cap).is_empty()
    }

    /// Every direction `d` such that `a` may still take an exit at `d` and `b`
    /// at `opposite(d)`, in `Direction::ALL` order (deterministic).
    fn free_direction_pairs(&self, a: &RoomId, b: &RoomId, cap: usize) -> Vec<Direction> {
        let (Some(ra), Some(rb)) = (self.rooms.get(a), self.rooms.get(b)) else {
            return Vec::new();
        };
        if ra.exits.len() >= cap || rb.exits.len() >= cap {
            return Vec::new();
        }
        Direction::ALL
            .into_iter()
            .filter(|d| {
                !ra.exits.contains_key(d.as_key()) && !rb.exits.contains_key(d.opposite().as_key())
            })
            .collect()
    }

    /// Register one bidirectional exit between `a` and `b` under a random free
    /// direction pair, carrying the required-connection door fields when given.
    fn wire(
        &mut self,
        a: &RoomId,
        b: &RoomId,
        cap: usize,
        req: Option<&RequiredExitSnapshot>,
    ) -> Result<(), ProceduralViolation> {
        let candidates = self.free_direction_pairs(a, b, cap);
        if candidates.is_empty() {
            return Err(ProceduralViolation(format!(
                "Map generation: no free direction between rooms '{}' and '{}'.",
                a.0, b.0
            )));
        }
        let pick = if candidates.len() == 1 {
            0
        } else {
            (i64::from(roll(candidates.len() as u32, self.rng.next_f64())) - 1) as usize
        };
        let dir = candidates[pick];

        let id = gen_exit_id(a, b);
        let (behavior_key, name, state) = match req {
            Some(r) => (
                r.behavior_key.clone(),
                r.name.clone(),
                if r.state.is_null() {
                    serde_json::json!({})
                } else {
                    r.state.clone()
                },
            ),
            None => (None, None, serde_json::json!({})),
        };
        self.exits.insert(
            id.clone(),
            ExitSnapshot {
                id: id.clone(),
                endpoint_ids: [a.clone(), b.clone()],
                behavior_key,
                name,
                state,
            },
        );
        if let Some(ra) = self.rooms.get_mut(a) {
            ra.exits.insert(String::from(dir.as_key()), id.clone());
        }
        if let Some(rb) = self.rooms.get_mut(b) {
            rb.exits.insert(String::from(dir.opposite().as_key()), id);
        }
        Ok(())
    }
}

/// Deterministic generated-exit id: the two ROOM ids, sorted — `exit:{a}|{b}`
/// with the `room:` prefixes intact, so generated ids never collide with the
/// assembler's authored `exit:{nameA}|{nameB}` scheme yet stay stable for a
/// given pair.
fn gen_exit_id(a: &RoomId, b: &RoomId) -> ExitId {
    let mut pair = [a.0.as_str(), b.0.as_str()];
    pair.sort_unstable();
    ExitId(format!("exit:{}|{}", pair[0], pair[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::snapshot::{MapGenSnapshot, RequiredExitSnapshot, RoomSnapshot};
    use crate::world::test_support::world_with_party;

    fn add_room(w: &mut World, name: &str) {
        let id = RoomId(format!("room:{name}"));
        w.rooms.insert(
            id.clone(),
            RoomSnapshot {
                id,
                name: name.into(),
                description: "a plot".into(),
                exits: BTreeMap::new(),
                dark: false,
                spawn_modifier: 1,
                occupant_ids: Vec::new(),
                loot_ids: Vec::new(),
                material_cache_ids: Vec::new(),
                light_source_ids: Vec::new(),
                scenes: Vec::new(),
            },
        );
    }

    /// A party-less world with `names` rooms and a mapgen config.
    fn gen_world(names: &[&str], cfg: MapGenSnapshot) -> World {
        let mut w = world_with_party(&[], 10);
        for n in names {
            add_room(&mut w, n);
        }
        w.campaign.map_gen = Some(cfg);
        w
    }

    fn cfg() -> MapGenSnapshot {
        MapGenSnapshot {
            extra_connections: 0.0,
            required: Vec::new(),
            max_exits_per_room: None,
            sealed: Vec::new(),
        }
    }

    /// BFS over the generated exits: every room reachable from the first.
    fn all_reachable(w: &World) -> bool {
        let Some(start) = w.rooms.keys().next().cloned() else {
            return true;
        };
        let mut seen = alloc::collections::BTreeSet::new();
        let mut queue = alloc::vec![start];
        while let Some(r) = queue.pop() {
            if !seen.insert(r.clone()) {
                continue;
            }
            if let Some(room) = w.rooms.get(&r) {
                for exit_id in room.exits.values() {
                    if let Some(e) = w.exits.get(exit_id) {
                        for ep in &e.endpoint_ids {
                            if !seen.contains(ep) {
                                queue.push(ep.clone());
                            }
                        }
                    }
                }
            }
        }
        seen.len() == w.rooms.len()
    }

    #[test]
    fn spanning_tree_connects_every_room_with_n_minus_1_edges() {
        let names: Vec<String> = (0..12).map(|i| format!("plot-{i:02}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut w = gen_world(&refs, cfg());
        w.generate_map().expect("generate");
        assert_eq!(w.exits.len(), 11, "a tree has n-1 edges");
        assert!(all_reachable(&w), "every room reachable");
        // Bidirectional: each exit appears in BOTH endpoint rooms under
        // opposite directions.
        for e in w.exits.values() {
            for (i, ep) in e.endpoint_ids.iter().enumerate() {
                let room = w.rooms.get(ep).expect("endpoint room");
                let dir = room
                    .exits
                    .iter()
                    .find(|(_, id)| **id == e.id)
                    .map(|(d, _)| d.clone())
                    .expect("exit registered in endpoint");
                let far = &e.endpoint_ids[1 - i];
                let far_room = w.rooms.get(far).expect("far room");
                let far_dir = far_room
                    .exits
                    .iter()
                    .find(|(_, id)| **id == e.id)
                    .map(|(d, _)| d.clone())
                    .expect("exit registered in far endpoint");
                let d = Direction::from_key(&dir).expect("compass key");
                assert_eq!(far_dir, d.opposite().as_key(), "opposite directions");
            }
        }
    }

    #[test]
    fn same_seed_same_map_different_seed_different_map() {
        let build = |seed: u32| {
            let names: Vec<String> = (0..10).map(|i| format!("plot-{i:02}")).collect();
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            let mut w = gen_world(
                &refs,
                MapGenSnapshot {
                    extra_connections: 3.0,
                    ..cfg()
                },
            );
            w.rng = crate::world::rng::Rng::seeded(seed);
            w.generate_map().expect("generate");
            w.rooms
                .values()
                .map(|r| (r.id.0.clone(), r.exits.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(build(7), build(7), "same seed must build the same map");
        assert_ne!(build(7), build(8), "different seed builds a different map");
    }

    #[test]
    fn required_connection_is_pinned_and_carries_the_door() {
        let mut w = gen_world(&["gate", "chapel", "yard", "crypt"], cfg());
        if let Some(m) = w.campaign.map_gen.as_mut() {
            m.required.push(RequiredExitSnapshot {
                from: RoomId("room:gate".into()),
                to: RoomId("room:chapel".into()),
                behavior_key: Some("chapel-door".into()),
                name: Some("chapel door".into()),
                state: serde_json::json!({ "unlocked": false }),
            });
        }
        w.generate_map().expect("generate");
        let e = w
            .exits
            .get(&ExitId("exit:room:chapel|room:gate".into()))
            .expect("required exit exists");
        assert_eq!(e.behavior_key.as_deref(), Some("chapel-door"));
        assert_eq!(e.name.as_deref(), Some("chapel door"));
        assert_eq!(e.state, serde_json::json!({ "unlocked": false }));
        assert!(all_reachable(&w));
    }

    #[test]
    fn sealed_room_is_reachable_only_through_its_required_door() {
        // 8 rooms, heavy looping, "vault" sealed behind a required keyed door
        // off "gate". Across several seeds the vault's ONLY exit must be that
        // door.
        for seed in 0..12u32 {
            let names = [
                "gate", "yard", "path", "well", "rows", "yews", "pool", "vault",
            ];
            let mut w = gen_world(
                &names,
                MapGenSnapshot {
                    extra_connections: 6.0,
                    required: alloc::vec![RequiredExitSnapshot {
                        from: RoomId("room:gate".into()),
                        to: RoomId("room:vault".into()),
                        behavior_key: Some("vault-door".into()),
                        name: None,
                        state: serde_json::Value::Null,
                    }],
                    max_exits_per_room: None,
                    sealed: alloc::vec![RoomId("room:vault".into())],
                },
            );
            w.rng = crate::world::rng::Rng::seeded(seed);
            w.generate_map().expect("generate");
            let vault = w.rooms.get(&RoomId("room:vault".into())).expect("vault");
            assert_eq!(
                vault.exits.len(),
                1,
                "seed {seed}: the door is the only way in"
            );
            let exit = w
                .exits
                .get(vault.exits.values().next().expect("one exit"))
                .expect("exit");
            assert_eq!(exit.behavior_key.as_deref(), Some("vault-door"));
            assert!(all_reachable(&w), "seed {seed}: still fully connected");
        }
    }

    #[test]
    fn stranded_sealed_room_is_a_violation() {
        // A sealed room with no required passage cannot be reached.
        let mut w = gen_world(&["a", "b", "c"], cfg());
        if let Some(m) = w.campaign.map_gen.as_mut() {
            m.sealed.push(RoomId("room:c".into()));
        }
        assert!(w.generate_map().is_err());
    }

    #[test]
    fn extra_connections_add_loop_edges() {
        let names: Vec<String> = (0..10).map(|i| format!("plot-{i:02}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut w = gen_world(
            &refs,
            MapGenSnapshot {
                extra_connections: 4.0,
                ..cfg()
            },
        );
        w.generate_map().expect("generate");
        assert!(
            w.exits.len() > 9,
            "loops beyond the tree: {}",
            w.exits.len()
        );
        assert!(w.exits.len() <= 13);
    }

    #[test]
    fn fractional_extra_connections_scale_with_n() {
        let names: Vec<String> = (0..9).map(|i| format!("plot-{i:02}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut w = gen_world(
            &refs,
            MapGenSnapshot {
                extra_connections: 0.5,
                ..cfg()
            },
        );
        w.generate_map().expect("generate");
        // n-1 = 8 tree edges + round(0.5 * 8) = 4 loops.
        assert_eq!(w.exits.len(), 12);
    }

    #[test]
    fn exit_cap_is_respected() {
        let names: Vec<String> = (0..14).map(|i| format!("plot-{i:02}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut w = gen_world(
            &refs,
            MapGenSnapshot {
                extra_connections: 8.0,
                max_exits_per_room: Some(3),
                ..cfg()
            },
        );
        w.generate_map().expect("generate");
        for room in w.rooms.values() {
            assert!(room.exits.len() <= 3, "room over cap: {}", room.id.0);
        }
        assert!(all_reachable(&w));
    }

    #[test]
    fn noop_without_config_or_with_existing_exits() {
        let mut w = world_with_party(&[], 10);
        add_room(&mut w, "a");
        add_room(&mut w, "b");
        let rng_before = w.rng.clone();
        w.generate_map().expect("no config is fine");
        assert!(w.exits.is_empty());
        assert_eq!(w.rng, rng_before, "config-less generate draws no rng");
    }

    #[test]
    fn unknown_required_room_is_a_violation() {
        let mut w = gen_world(&["a", "b"], cfg());
        if let Some(m) = w.campaign.map_gen.as_mut() {
            m.required.push(RequiredExitSnapshot {
                from: RoomId("room:a".into()),
                to: RoomId("room:nope".into()),
                behavior_key: None,
                name: None,
                state: serde_json::Value::Null,
            });
        }
        assert!(w.generate_map().is_err());
    }
}
