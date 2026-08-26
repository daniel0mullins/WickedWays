//! The shared fog-of-war map (framework-free).
//!
//! The explored-map model ([`MapModel`]) plus pure grid layout ([`layout_map`]): built incrementally
//! from what a surface sees each turn, unit-tested on the host, and free of any UI framework. The
//! Dioxus SVG emitter (`map_svg`) that renders a [`MapLayout`] lives in the web client
//! (`wickedways-web`); everything here is pure so the tabletop bridge and the web client share it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wickedways_core::world::direction::Direction;
use wickedways_core::world::view::ViewModel;

// ─── map data ────────────────────────────────────────────────────────────────

/// A room placed on the fog-of-war grid.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapRoom {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub has_remains: bool,
}

/// A traversed connection between two rooms (`dir` is from `a` to `b`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapEdge {
    pub a: String,
    pub b: String,
    pub dir: Direction,
    pub locked: bool,
}

/// An exit seen but not yet walked through.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapStub {
    pub dir: Direction,
    pub locked: bool,
}

/// Plain-data snapshot of the whole map, for save/restore.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct MapSnapshot {
    pub rooms: Vec<MapRoom>,
    pub edges: Vec<MapEdge>,
    pub stubs: Vec<(String, Vec<MapStub>)>,
    pub current_id: Option<String>,
}

// ─── the model ───────────────────────────────────────────────────────────────

/// Fog-of-war map of the house, built incrementally from what the play surface sees each turn. Pure
/// (no DOM); [`layout_map`]/[`map_svg`] read it via the getters.
//
// `BTreeMap` (not `HashMap`) is deliberate: it's a key-value map like JS `Map`, but iteration is
// always in sorted key order — so every walk over the rooms is deterministic, which the replayable
// engine (and its golden gates) depend on.
#[derive(Clone, Debug, Default)]
pub struct MapModel {
    rooms: BTreeMap<String, MapRoom>,
    edges: Vec<MapEdge>,
    stubs: BTreeMap<String, Vec<MapStub>>,
    current_id: Option<String>,
}

impl MapModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current_id(&self) -> Option<&str> {
        self.current_id.as_deref()
    }

    pub fn rooms(&self) -> Vec<MapRoom> {
        self.rooms.values().cloned().collect()
    }

    pub fn edges(&self) -> &[MapEdge] {
        &self.edges
    }

    pub fn stubs_for(&self, id: &str) -> &[MapStub] {
        self.stubs.get(id).map_or(&[], Vec::as_slice)
    }

    /// Record/refresh the room the player is currently in.
    pub fn observe(&mut self, view: &ViewModel) {
        let id = view.room.id.clone();
        let name = view.room.name.clone();
        let has_remains = view.occupants.iter().any(|o| o.defeated == Some(true));
        // The map `entry` API is an upsert: update the room in place if it exists, insert it
        // otherwise — one lookup, no `if (map.has(k))` double-check.
        self.rooms
            .entry(id.clone())
            .and_modify(|r| {
                // `clone_from` is `r.name = name.clone()` that reuses the existing allocation.
                r.name.clone_from(&name);
                r.has_remains = has_remains;
            })
            // Only the first room is created here (at the origin); every other room is placed by
            // `record_move` before it is first observed.
            .or_insert_with(|| MapRoom {
                id: id.clone(),
                name,
                x: 0,
                y: 0,
                has_remains,
            });
        self.current_id = Some(id.clone());

        // Directions already traversed from this room get no stub.
        let mut traversed: Vec<Direction> = Vec::new();
        for e in &self.edges {
            if e.a == id {
                traversed.push(e.dir);
            }
            if e.b == id {
                traversed.push(reverse_direction(e.dir));
            }
        }
        let mut stubs: Vec<MapStub> = Vec::new();
        for ex in &view.exits {
            if !traversed.contains(&ex.dir) {
                stubs.push(MapStub {
                    dir: ex.dir,
                    locked: false,
                });
            }
        }
        for d in &view.locked_doors {
            if !traversed.contains(&d.dir) {
                stubs.push(MapStub {
                    dir: d.dir,
                    locked: true,
                });
            }
        }
        self.stubs.insert(id, stubs);
    }

    /// Record a traversal: place `to` relative to `from`, add the edge, drop the stub.
    pub fn record_move(&mut self, from_id: &str, dir: Direction, to_id: &str) {
        if let Some(from) = self.rooms.get(from_id).cloned() {
            if !self.rooms.contains_key(to_id) {
                let (dx, dy) = direction_delta(dir);
                self.rooms.insert(
                    to_id.to_string(),
                    MapRoom {
                        id: to_id.to_string(),
                        name: to_id.to_string(),
                        x: from.x + dx,
                        y: from.y + dy,
                        has_remains: false,
                    },
                );
            }
        }
        let known = self
            .edges
            .iter()
            .any(|e| (e.a == from_id && e.b == to_id) || (e.a == to_id && e.b == from_id));
        // A traversed edge is an open passage: you can only walk through a door once it's unlocked,
        // so edges are never locked (locked doors render as dashed *stubs* until walked).
        if !known {
            self.edges.push(MapEdge {
                a: from_id.to_string(),
                b: to_id.to_string(),
                dir,
                locked: false,
            });
        }
        if let Some(from_stubs) = self.stubs.get_mut(from_id) {
            from_stubs.retain(|s| s.dir != dir);
        }
    }

    /// Villain omniscience: reveal the ENTIRE world — every room and every
    /// exit — into the model, clearing the fog stubs (nothing is unexplored to
    /// the Villain). Idempotent, and it PRESERVES coordinates of rooms already
    /// placed (the fog origin anchors the reveal), so re-running after each
    /// refresh keeps the layout stable.
    ///
    /// Placement is a BFS over exit directions from the already-placed rooms
    /// (each additional disconnected component is seeded to the right of the
    /// current bounding box). A keyed exit whose persisted state is not
    /// `unlocked` renders as a locked (dashed) link — the Villain sees the
    /// house AND its wards.
    pub fn reveal_world(&mut self, world: &wickedways_core::World) {
        use std::collections::VecDeque;

        // Direction of `exit_id` as seen from room `from`, then its far side.
        let dir_from = |from: &wickedways_core::world::snapshot::RoomSnapshot,
                        exit_id: &wickedways_core::world::ids::ExitId|
         -> Option<Direction> {
            from.exits
                .iter()
                .find(|(_, id)| *id == exit_id)
                .and_then(|(k, _)| Direction::from_key(k))
        };

        // Seed the queue with every already-placed room; then sweep unplaced
        // rooms (BFS per component) until everything has coordinates.
        let mut queue: VecDeque<String> = self.rooms.keys().cloned().collect();
        loop {
            while let Some(id) = queue.pop_front() {
                // `let Some(x) = … else { continue; }` is a guard clause: bind the value if it's
                // there, skip this iteration if not — the shape JS writes as
                // `if (x == null) continue;`. It recurs throughout this sweep.
                let Some(here) = world
                    .rooms
                    .get(&wickedways_core::world::ids::RoomId(id.clone()))
                else {
                    continue;
                };
                let (hx, hy) = match self.rooms.get(&id) {
                    Some(r) => (r.x, r.y),
                    None => continue,
                };
                for (dir_key, exit_id) in &here.exits {
                    let Some(dir) = Direction::from_key(dir_key) else {
                        continue;
                    };
                    let Some(ex) = world.exits.get(exit_id) else {
                        continue;
                    };
                    let other = if ex.endpoint_ids[0].0 == id {
                        ex.endpoint_ids[1].clone()
                    } else {
                        ex.endpoint_ids[0].clone()
                    };
                    if self.rooms.contains_key(&other.0) {
                        continue;
                    }
                    let Some(dest) = world.rooms.get(&other) else {
                        continue;
                    };
                    let (dx, dy) = direction_delta(dir);
                    self.rooms.insert(
                        other.0.clone(),
                        MapRoom {
                            id: other.0.clone(),
                            name: dest.name.clone(),
                            x: hx + dx,
                            y: hy + dy,
                            has_remains: false,
                        },
                    );
                    queue.push_back(other.0.clone());
                }
            }
            // Any room still unplaced starts a fresh component, seeded past the
            // right edge of what's already laid out.
            let Some(seed) = world
                .rooms
                .values()
                .find(|r| !self.rooms.contains_key(&r.id.0))
            else {
                break;
            };
            let offset_x = self.rooms.values().map(|r| r.x).max().unwrap_or(0) + 2;
            self.rooms.insert(
                seed.id.0.clone(),
                MapRoom {
                    id: seed.id.0.clone(),
                    name: seed.name.clone(),
                    x: offset_x,
                    y: 0,
                    has_remains: false,
                },
            );
            queue.push_back(seed.id.0.clone());
        }

        // Refresh names + remains from the live world (fog placeholders carry
        // ids as names until observed; the reveal knows better).
        for (id, room) in &mut self.rooms {
            let Some(snap) = world
                .rooms
                .get(&wickedways_core::world::ids::RoomId(id.clone()))
            else {
                continue;
            };
            room.name.clone_from(&snap.name);
            room.has_remains = snap.occupant_ids.iter().any(|occ| {
                world.characters.get(occ).is_some_and(|c| {
                    c.afflictions
                        .is_active(wickedways_core::world::afflictions::Status::Ko)
                })
            });
        }

        // Every exit becomes an edge; a keyed, still-warded door renders locked.
        for ex in world.exits.values() {
            let known = self.edges.iter().any(|e| {
                (e.a == ex.endpoint_ids[0].0 && e.b == ex.endpoint_ids[1].0)
                    || (e.a == ex.endpoint_ids[1].0 && e.b == ex.endpoint_ids[0].0)
            });
            let locked = ex.behavior_key.is_some()
                && !ex
                    .state
                    .get("unlocked")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
            if known {
                // Keep traversal edges, but track the ward state live.
                for e in &mut self.edges {
                    if (e.a == ex.endpoint_ids[0].0 && e.b == ex.endpoint_ids[1].0)
                        || (e.a == ex.endpoint_ids[1].0 && e.b == ex.endpoint_ids[0].0)
                    {
                        e.locked = locked;
                    }
                }
                continue;
            }
            let Some(from) = world.rooms.get(&ex.endpoint_ids[0]) else {
                continue;
            };
            let Some(dir) = dir_from(from, &ex.id) else {
                continue;
            };
            self.edges.push(MapEdge {
                a: ex.endpoint_ids[0].0.clone(),
                b: ex.endpoint_ids[1].0.clone(),
                dir,
                locked,
            });
        }

        // Nothing is unexplored to the Villain.
        self.stubs.clear();
    }

    /// Snapshot the model as plain data (see [`MapSnapshot`]) for save/restore.
    pub fn serialize(&self) -> MapSnapshot {
        MapSnapshot {
            rooms: self.rooms(),
            edges: self.edges.clone(),
            stubs: self
                .stubs
                .iter()
                .map(|(id, s)| (id.clone(), s.clone()))
                .collect(),
            current_id: self.current_id.clone(),
        }
    }

    /// Restore the model from a saved [`MapSnapshot`] (the inverse of [`serialize`](Self::serialize)).
    pub fn hydrate(&mut self, snap: MapSnapshot) {
        self.rooms = snap.rooms.into_iter().map(|r| (r.id.clone(), r)).collect();
        self.edges = snap.edges;
        self.stubs = snap.stubs.into_iter().collect();
        self.current_id = snap.current_id;
    }

    /// Forget everything (new game / restart).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

// ─── grid helpers (shared by the model and the layout) ───────────────────────

/// Grid step per direction (north = up). Shared with the map layout.
fn direction_delta(dir: Direction) -> (i32, i32) {
    use Direction::*;
    match dir {
        North => (0, -1),
        South => (0, 1),
        East => (1, 0),
        West => (-1, 0),
        Northeast => (1, -1),
        Northwest => (-1, -1),
        Southeast => (1, 1),
        Southwest => (-1, 1),
    }
}

/// The compass opposite of `dir`.
fn reverse_direction(dir: Direction) -> Direction {
    use Direction::*;
    match dir {
        North => South,
        South => North,
        East => West,
        West => East,
        Northeast => Southwest,
        Southwest => Northeast,
        Northwest => Southeast,
        Southeast => Northwest,
    }
}

// ─── layout ──────────────────────────────────────────────────────────────────

const CELL: f64 = 90.0;
const BOX_W: f64 = 70.0;
const BOX_H: f64 = 36.0;
const PAD: f64 = 30.0;
const STUB: f64 = CELL * 0.42;

/// A room tile in pixel space.
#[derive(Clone, Debug, PartialEq)]
pub struct LaidBox {
    /// The room id this tile represents, so a surface can match entities (pieces) to their tile.
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub label: String,
    pub current: bool,
    pub remains: bool,
}

/// A traversed passage drawn between two tile centers (dashed when `locked`).
#[derive(Clone, Debug, PartialEq)]
pub struct LaidLink {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub locked: bool,
}

/// An unexplored-exit stub: a short line out of a tile, with a `?` glyph at (`qx`, `qy`).
#[derive(Clone, Debug, PartialEq)]
pub struct LaidStub {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub qx: f64,
    pub qy: f64,
    pub locked: bool,
}

/// The whole laid-out map: overall size plus every shape a renderer needs to draw.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct MapLayout {
    pub width: f64,
    pub height: f64,
    pub boxes: Vec<LaidBox>,
    pub links: Vec<LaidLink>,
    pub stubs: Vec<LaidStub>,
}

/// Pure layout: grid coords → pixel shapes, normalized to a `PAD`-margined origin.
pub fn layout_map(model: &MapModel) -> MapLayout {
    let rooms = model.rooms();
    if rooms.is_empty() {
        return MapLayout {
            width: BOX_W + 2.0 * PAD,
            height: BOX_H + 2.0 * PAD,
            ..Default::default()
        };
    }

    // `.min()`/`.max()` return `Option` (an empty list has no minimum); the `unwrap()`s are safe
    // because the empty case returned above.
    let min_x = rooms.iter().map(|r| r.x).min().unwrap();
    let min_y = rooms.iter().map(|r| r.y).min().unwrap();
    let max_x = rooms.iter().map(|r| r.x).max().unwrap();
    let max_y = rooms.iter().map(|r| r.y).max().unwrap();

    // Local closures (arrow functions, capturing the bounds above). `f64::from` is the explicit
    // int→float conversion — Rust never coerces numeric types implicitly.
    let left = |r: &MapRoom| f64::from(r.x - min_x) * CELL + PAD;
    let top = |r: &MapRoom| f64::from(r.y - min_y) * CELL + PAD;
    let cx = |r: &MapRoom| left(r) + BOX_W / 2.0;
    let cy = |r: &MapRoom| top(r) + BOX_H / 2.0;

    let current = model.current_id();
    let boxes: Vec<LaidBox> = rooms
        .iter()
        .map(|r| LaidBox {
            id: r.id.clone(),
            x: left(r),
            y: top(r),
            w: BOX_W,
            h: BOX_H,
            label: r.name.clone(),
            current: Some(r.id.as_str()) == current,
            remains: r.has_remains,
        })
        .collect();

    let by_id: BTreeMap<&str, &MapRoom> = rooms.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut links: Vec<LaidLink> = Vec::new();
    for e in model.edges() {
        let (Some(a), Some(b)) = (by_id.get(e.a.as_str()), by_id.get(e.b.as_str())) else {
            continue;
        };
        links.push(LaidLink {
            x1: cx(a),
            y1: cy(a),
            x2: cx(b),
            y2: cy(b),
            locked: e.locked,
        });
    }

    let mut stubs: Vec<LaidStub> = Vec::new();
    for r in &rooms {
        for s in model.stubs_for(&r.id) {
            let (dx, dy) = direction_delta(s.dir);
            let x1 = cx(r);
            let y1 = cy(r);
            let x2 = x1 + f64::from(dx) * STUB;
            let y2 = y1 + f64::from(dy) * STUB;
            stubs.push(LaidStub {
                x1,
                y1,
                x2,
                y2,
                qx: x2 + f64::from(dx) * 8.0,
                qy: y2 + f64::from(dy) * 8.0,
                locked: s.locked,
            });
        }
    }

    let width = f64::from(max_x - min_x) * CELL + BOX_W + 2.0 * PAD;
    let height = f64::from(max_y - min_y) * CELL + BOX_H + 2.0 * PAD;
    MapLayout {
        width,
        height,
        boxes,
        links,
        stubs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::presentation::CampaignOutcome;
    use wickedways_core::world::view::{
        ExitView, LockedDoorView, ScopeEntity, StatusView, ThinRoom,
    };

    fn vm(id: &str, name: &str) -> ViewModel {
        ViewModel {
            room: ThinRoom {
                id: id.into(),
                name: name.into(),
                description: String::new(),
                is_lit: true,
            },
            exits: Vec::new(),
            locked_doors: Vec::new(),
            occupants: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            inventory: wickedways_core::world::view::Inventory {
                items: Vec::new(),
                keys: Vec::new(),
                equipped_names: Vec::new(),
                slots: 0,
            },
            scope: Vec::new(),
            materials: Vec::new(),
            recipes: Vec::new(),
            status: StatusView {
                location_name: name.into(),
                turn: 0,
                max_turns: 1,
                health: 10.0,
                sanity: 10.0,
            },
            outcome: CampaignOutcome::Ongoing,
            finished: false,
            villain: None,
            lights_out_rounds: None,
        }
    }

    #[test]
    fn observe_seeds_the_first_room_at_the_origin() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        let rooms = m.rooms();
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].x, 0);
        assert_eq!(rooms[0].y, 0);
        assert_eq!(m.current_id(), Some("hall"));
    }

    #[test]
    fn observe_tracks_remains_from_defeated_occupants() {
        let mut m = MapModel::new();
        let mut v = vm("hall", "Hall");
        v.occupants = vec![ScopeEntity {
            id: "w".into(),
            name: "Wraith".into(),
            aliases: Vec::new(),
            kind: "occupant".into(),
            health: Some(0.0),
            image: None,
            equippable: None,
            usable: None,
            has_lore: None,
            droppable: None,
            destroyable: None,
            damaged: None,
            defeated: Some(true),
            talkable: None,
            player: None,
        }];
        m.observe(&v);
        assert!(m.rooms()[0].has_remains);
    }

    #[test]
    fn observe_records_unexplored_exits_as_stubs() {
        let mut m = MapModel::new();
        let mut v = vm("hall", "Hall");
        v.exits = vec![ExitView {
            dir: Direction::North,
            to_name: "Landing".into(),
        }];
        v.locked_doors = vec![LockedDoorView {
            name: "Iron Door".into(),
            dir: Direction::East,
        }];
        m.observe(&v);
        let stubs = m.stubs_for("hall");
        assert_eq!(stubs.len(), 2);
        assert!(stubs.iter().any(|s| s.dir == Direction::North && !s.locked));
        assert!(stubs.iter().any(|s| s.dir == Direction::East && s.locked));
    }

    #[test]
    fn record_move_places_the_new_room_relative_to_the_origin_and_drops_the_stub() {
        let mut m = MapModel::new();
        let mut v = vm("hall", "Hall");
        v.exits = vec![ExitView {
            dir: Direction::North,
            to_name: "Landing".into(),
        }];
        m.observe(&v);
        m.record_move("hall", Direction::North, "landing");
        let landing = m.rooms().into_iter().find(|r| r.id == "landing").unwrap();
        assert_eq!((landing.x, landing.y), (0, -1));
        assert!(
            m.stubs_for("hall").is_empty(),
            "the traversed stub is dropped"
        );
        assert_eq!(m.edges().len(), 1);
    }

    #[test]
    fn record_move_does_not_duplicate_a_known_edge() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        m.record_move("hall", Direction::North, "landing");
        m.observe(&vm("landing", "Landing"));
        m.record_move("landing", Direction::South, "hall");
        assert_eq!(
            m.edges().len(),
            1,
            "the reverse traversal reuses the same edge"
        );
    }

    #[test]
    fn observe_after_a_move_drops_the_reverse_stub_via_the_traversed_edge() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        m.record_move("hall", Direction::North, "landing");
        let mut back = vm("landing", "Landing");
        back.exits = vec![ExitView {
            dir: Direction::South,
            to_name: "Hall".into(),
        }];
        m.observe(&back);
        assert!(
            m.stubs_for("landing").is_empty(),
            "south is already traversed (as the edge's reverse)"
        );
    }

    #[test]
    fn layout_of_an_empty_model_is_a_single_padded_box() {
        let layout = layout_map(&MapModel::new());
        assert!(layout.boxes.is_empty());
        assert_eq!(layout.width, BOX_W + 2.0 * PAD);
        assert_eq!(layout.height, BOX_H + 2.0 * PAD);
    }

    #[test]
    fn layout_marks_the_current_room_and_centers_links_on_boxes() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        m.record_move("hall", Direction::North, "landing");
        m.observe(&vm("landing", "Landing"));
        let layout = layout_map(&m);
        assert_eq!(layout.boxes.len(), 2);
        let current: Vec<_> = layout.boxes.iter().filter(|b| b.current).collect();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].label, "Landing");
        assert_eq!(layout.links.len(), 1);
    }

    #[test]
    fn serialize_hydrate_round_trips() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        m.record_move("hall", Direction::North, "landing");
        let snap = m.serialize();
        let mut restored = MapModel::new();
        restored.hydrate(snap);
        assert_eq!(restored.rooms().len(), 2);
        assert_eq!(restored.current_id(), Some("hall"));
        assert_eq!(restored.edges().len(), 1);
    }

    #[test]
    fn reset_clears_everything() {
        let mut m = MapModel::new();
        m.observe(&vm("hall", "Hall"));
        m.reset();
        assert!(m.rooms().is_empty());
        assert_eq!(m.current_id(), None);
    }

    /// The g2-villain genesis (Parlor —north→ Gallery, behavior-free exit).
    fn villain_world() -> wickedways_core::World {
        let snap: wickedways_core::CampaignSnapshot = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/g2-villain.genesis.json"
        ))
        .expect("g2-villain genesis parses");
        wickedways_core::World::from_snapshot(snap)
    }

    #[test]
    fn reveal_world_places_every_room_and_edge_and_clears_stubs() {
        let world = villain_world();
        let mut m = MapModel::new();
        m.reveal_world(&world);
        assert_eq!(m.rooms().len(), 2, "both rooms revealed");
        assert_eq!(m.edges().len(), 1, "the one exit becomes an edge");
        for r in m.rooms() {
            assert!(m.stubs_for(&r.id).is_empty(), "nothing unexplored");
        }
        // Idempotent: a second reveal changes nothing.
        m.reveal_world(&world);
        assert_eq!(m.rooms().len(), 2);
        assert_eq!(m.edges().len(), 1);
    }

    #[test]
    fn reveal_world_anchors_on_already_observed_rooms() {
        let world = villain_world();
        let mut m = MapModel::new();
        // The fog origin: the player has seen the Parlor at (0, 0).
        m.observe(&vm("room:Parlor", "Parlor"));
        m.reveal_world(&world);
        let parlor = m.rooms().into_iter().find(|r| r.name == "Parlor").unwrap();
        assert_eq!((parlor.x, parlor.y), (0, 0), "the fog origin is preserved");
        let gallery = m.rooms().into_iter().find(|r| r.name == "Gallery").unwrap();
        assert_eq!(
            (gallery.x, gallery.y),
            (0, -1),
            "the Gallery lies north of the Parlor"
        );
        assert_eq!(m.current_id(), Some("room:Parlor"));
    }
}
