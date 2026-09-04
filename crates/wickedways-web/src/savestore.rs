//! Single-player save/restore via the platform store.
//!
//! A save is the authoritative campaign [`CampaignSnapshot`] plus the surface's fog-of-war
//! [`MapSnapshot`], serialized to JSON and
//! stored under a slot key in the [`platform`](crate::platform) store (browser `localStorage`,
//! or a data-dir file in the desktop build). Restore rebuilds a fresh
//! [`SinglePlayerTransport`](crate::single_player::SinglePlayerTransport) from the snapshot and
//! hydrates the map — the same "reset the authority to a snapshot" the room server does, but local.
//!
//! Only meaningful in single-player: multiplayer state lives on the server, so the surfaces gate
//! save/restore on the offline mode. The persistence format is internal to this client, so it uses
//! plain Rust field names.
//!
//! The storage I/O lives in [`platform`](crate::platform); the [`SaveBlob`] JSON format is
//! host-tested.

use serde::{Deserialize, Serialize};

use wickedways_core::CampaignSnapshot;

use crate::map::MapSnapshot;

/// One saved game: the authoritative campaign snapshot + the surface's explored-map snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SaveBlob {
    pub snapshot: CampaignSnapshot,
    pub map: MapSnapshot,
}

/// The platform-store key for a save slot.
fn slot_key(slot: &str) -> String {
    format!("wickedways:save:{slot}")
}

/// Serialize `blob` to JSON and store it under `slot`. Returns an error string on a serialize failure
/// or if the platform store is unavailable (private-mode / disabled browser storage).
pub fn save(slot: &str, blob: &SaveBlob) -> Result<(), String> {
    let json = serde_json::to_string(blob).map_err(|e| format!("serialize save: {e}"))?;
    crate::platform::storage_write(&slot_key(slot), &json)
}

/// Load and parse the save in `slot`, or `None` if absent, unreadable, or malformed.
pub fn load(slot: &str) -> Option<SaveBlob> {
    let json = crate::platform::storage_read(&slot_key(slot))?;
    serde_json::from_str(&json).ok()
}

/// The save slot for a campaign. Saves are keyed PER CAMPAIGN so one campaign's Save can never
/// clobber — nor its Restore hydrate — another campaign's run against the wrong catalog (with two
/// shipped single-player campaigns, an un-namespaced slot would do exactly that). A room id
/// (`<slug>~<token>`) keys by its base campaign.
fn campaign_slot(campaign: &str) -> String {
    format!("{}:slot1", crate::driver::base_campaign(campaign))
}

/// Save `blob` into `campaign`'s slot.
pub fn save_for(campaign: &str, blob: &SaveBlob) -> Result<(), String> {
    save(&campaign_slot(campaign), blob)
}

/// Load `campaign`'s save. The Hollow House additionally falls back to the legacy un-namespaced
/// `"slot1"` — the only slot that existed before saves were campaign-keyed, and the only shipped
/// campaign that could have written it — so pre-existing saves keep restoring.
pub fn load_for(campaign: &str) -> Option<SaveBlob> {
    load(&campaign_slot(campaign)).or_else(|| {
        (crate::driver::base_campaign(campaign) == "hollow-house")
            .then(|| load("slot1"))
            .flatten()
    })
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
                image: None,
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
            villain: None,
            lights_out_rounds: None,
        };
        m.observe(&v);
        m.record_move("hall", Direction::North, "landing");
        v.room = ThinRoom {
            id: "landing".into(),
            name: "Landing".into(),
            description: String::new(),
            is_lit: true,
            image: None,
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

    /// The platform store is unavailable in host tests (no localStorage, no desktop data dir),
    /// so this pins the pure keying: distinct campaigns get distinct slots (one campaign's Save
    /// can never clobber another's run), and a room id keys by its base campaign.
    #[test]
    fn save_slots_are_keyed_per_campaign() {
        assert_eq!(campaign_slot("solomons-rest"), "solomons-rest:slot1");
        assert_eq!(campaign_slot("hollow-house"), "hollow-house:slot1");
        assert_ne!(
            campaign_slot("solomons-rest"),
            campaign_slot("hollow-house")
        );
        // A room id (`<slug>~<token>`) keys by its base campaign.
        assert_eq!(campaign_slot("solomons-rest~a5f3"), "solomons-rest:slot1");
        // No campaign-keyed slot ever collides with the legacy bare "slot1"
        // (the hollow-house read fallback in `load_for`).
        assert_ne!(campaign_slot("hollow-house"), "slot1");
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
