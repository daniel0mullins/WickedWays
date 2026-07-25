//! Single-player save/restore via `localStorage`.
//!
//! A save is the authoritative campaign [`CampaignSnapshot`] plus the surface's fog-of-war
//! [`MapSnapshot`], serialized to JSON and
//! stored under a slot key in the browser's `localStorage`. Restore rebuilds a fresh
//! [`SinglePlayerTransport`](crate::single_player::SinglePlayerTransport) from the snapshot and
//! hydrates the map — the same "reset the authority to a snapshot" the room server does, but local.
//!
//! Only meaningful in single-player: multiplayer state lives on the server, so the surfaces gate
//! save/restore on the offline mode. The persistence format is internal to this client, so it uses
//! plain Rust field names.
//!
//! The `localStorage` I/O is `web-sys` (browser-only); the [`SaveBlob`] JSON format is host-tested.

use serde::{Deserialize, Serialize};

use wickedways_core::CampaignSnapshot;

use crate::map::MapSnapshot;

/// One saved game: the authoritative campaign snapshot + the surface's explored-map snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SaveBlob {
    pub snapshot: CampaignSnapshot,
    pub map: MapSnapshot,
}

/// The `localStorage` key for a save slot.
fn slot_key(slot: &str) -> String {
    format!("wickedways:save:{slot}")
}

fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

/// Serialize `blob` to JSON and store it under `slot`. Returns an error string on a serialize failure
/// or if `localStorage` is unavailable (private-mode / disabled storage).
pub fn save(slot: &str, blob: &SaveBlob) -> Result<(), String> {
    let json = serde_json::to_string(blob).map_err(|e| format!("serialize save: {e}"))?;
    let storage = local_storage().ok_or("localStorage is unavailable")?;
    storage
        .set_item(&slot_key(slot), &json)
        .map_err(|e| format!("write save: {e:?}"))
}

/// Load and parse the save in `slot`, or `None` if absent, unreadable, or malformed.
pub fn load(slot: &str) -> Option<SaveBlob> {
    let storage = local_storage()?;
    let json = storage.get_item(&slot_key(slot)).ok()??;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{MapModel, MapSnapshot};
    use wickedways_core::presentation::CampaignOutcome;
    use wickedways_core::world::direction::Direction;
    use wickedways_core::world::view::{ExitView, Inventory, StatusView, ThinRoom, ViewModel};

    const GENESIS: &str = include_str!("../../../conformance/fixtures/sync-move.genesis.json");

    fn snapshot() -> CampaignSnapshot {
        serde_json::from_str(GENESIS).expect("genesis fixture parses")
    }

    /// Build a non-trivial map snapshot (two rooms + an edge + a stub) by driving the model, so the
    /// round-trip exercises rooms, edges, stubs, and current_id.
    fn map() -> MapSnapshot {
        let mut m = MapModel::new();
        let mut v = ViewModel {
            room: ThinRoom {
                id: "hall".into(),
                name: "Hall".into(),
                description: String::new(),
                is_lit: true,
            },
            exits: vec![ExitView {
                dir: Direction::North,
                to_name: "Landing".into(),
            }],
            locked_doors: Vec::new(),
            occupants: Vec::new(),
            loot: Vec::new(),
            caches: Vec::new(),
            inventory: Inventory {
                items: Vec::new(),
                keys: Vec::new(),
                equipped_names: Vec::new(),
                slots: 0,
            },
            scope: Vec::new(),
            materials: Vec::new(),
            recipes: Vec::new(),
            status: StatusView {
                location_name: "Hall".into(),
                turn: 0,
                max_turns: 1,
                health: 10.0,
                sanity: 10.0,
            },
            outcome: CampaignOutcome::Ongoing,
            finished: false,
        };
        m.observe(&v);
        m.record_move("hall", Direction::North, "landing");
        v.room = ThinRoom {
            id: "landing".into(),
            name: "Landing".into(),
            description: String::new(),
            is_lit: true,
        };
        v.exits = Vec::new();
        m.observe(&v);
        m.serialize()
    }

    #[test]
    fn save_blob_round_trips_through_json() {
        let blob = SaveBlob {
            snapshot: snapshot(),
            map: map(),
        };
        let json = serde_json::to_string(&blob).expect("serialize");
        let back: SaveBlob = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            back, blob,
            "the save blob must survive a JSON round-trip byte-for-byte"
        );
    }

    #[test]
    fn round_trip_preserves_the_map_topology() {
        let blob = SaveBlob {
            snapshot: snapshot(),
            map: map(),
        };
        let back: SaveBlob = serde_json::from_str(&serde_json::to_string(&blob).unwrap()).unwrap();
        assert_eq!(back.map.current_id.as_deref(), Some("landing"));
        assert_eq!(back.map.rooms.len(), 2);
        assert_eq!(back.map.edges.len(), 1);
        // Rebuilding a model from the restored snapshot reproduces the same layout inputs.
        let mut restored = MapModel::new();
        restored.hydrate(back.map);
        assert_eq!(restored.current_id(), Some("landing"));
        assert_eq!(restored.rooms().len(), 2);
    }

    #[test]
    fn a_malformed_or_absent_save_parses_to_none() {
        assert!(serde_json::from_str::<SaveBlob>("not json").is_err());
        assert!(serde_json::from_str::<SaveBlob>("{}").is_err());
    }
}
