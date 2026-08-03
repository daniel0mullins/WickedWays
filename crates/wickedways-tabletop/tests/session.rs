//! Integration: drive the bridge against a real in-process engine session (Hollow House), the way a
//! controller would. Confirms `render` places the seated piece on the start tile and `resolve` turns a
//! directional piece move into an actor-tagged `Move` (rejecting an illegal one).

use std::collections::BTreeSet;

use wickedways_core::sync::{
    AuthorityOpts, Command, InProcessTransport, SubmitResult, SyncAuthority, SyncCoordinator,
};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::direction::Direction;
use wickedways_core::world::view::ViewModel;
use wickedways_core::{CampaignSnapshot, World};

use wickedways_tabletop::bridge::{render, resolve};
use wickedways_tabletop::map::MapModel;
use wickedways_tabletop::protocol::{DeviceCommand, DeviceEvent};
use wickedways_tabletop::roster::party_roster;

const GENESIS: &str = include_str!("../../../conformance/fixtures/hollow-house.genesis.json");
const CATALOG: &str = include_str!("../../../conformance/fixtures/hollow-house.catalog.json");

fn boot() -> (InProcessTransport, SyncCoordinator, Catalog) {
    let genesis: CampaignSnapshot = serde_json::from_str(GENESIS).expect("genesis parses");
    let catalog: Catalog = serde_json::from_str(CATALOG).expect("catalog parses");
    let world = World::from_snapshot(genesis);
    let authority = SyncAuthority::new(
        world,
        catalog.clone(),
        AuthorityOpts {
            solo: true,
            ..Default::default()
        },
    );
    let mut transport = InProcessTransport::new(authority);
    let mut coord = SyncCoordinator::join(&transport);
    match coord.submit(&mut transport, Command::BeginCampaign) {
        SubmitResult::Committed { .. } => {}
        SubmitResult::Denied { reason } => panic!("begin denied: {reason}"),
    }
    coord.sync(&transport);
    (transport, coord, catalog)
}

fn project(coord: &SyncCoordinator, catalog: &Catalog) -> ViewModel {
    coord
        .replica()
        .view(catalog, &BTreeSet::new())
        .expect("project view")
}

fn heir_id(coord: &SyncCoordinator) -> String {
    coord.replica().campaign.party_ids[0].0.clone()
}

#[test]
fn renders_the_start_room_with_the_seated_piece() {
    let (_t, coord, catalog) = boot();
    let v = project(&coord, &catalog);
    let mut map = MapModel::new();
    map.observe(&v);
    let seats = party_roster(coord.replica());
    let cmds = render(&v, &seats, &map, coord.status_fields());

    let heir = heir_id(&coord);
    assert!(
        cmds.iter()
            .any(|c| matches!(c, DeviceCommand::Tile { tile_id, .. } if *tile_id == v.room.id)),
        "a tile for the start room",
    );
    assert!(
        cmds.iter().any(|c| matches!(
            c,
            DeviceCommand::Piece { piece_id, tile_id, .. } if *piece_id == heir && *tile_id == v.room.id
        )),
        "the Heir's piece on the start tile",
    );
}

#[test]
fn a_piece_move_resolves_to_a_move_for_that_actor() {
    let (_t, coord, catalog) = boot();
    let heir = heir_id(&coord);
    // The Foyer opens North to the Hall.
    let event = DeviceEvent::PieceMoved {
        actor_id: heir.clone(),
        dir: Direction::North,
    };
    match resolve(&event, coord.replica(), &catalog) {
        Ok(Some(Command::Move { actor_id, .. })) => assert_eq!(actor_id.0, heir),
        other => panic!("expected a Move for the Heir, got {other:?}"),
    }
}

#[test]
fn an_illegal_move_is_rejected() {
    let (_t, coord, catalog) = boot();
    let heir = heir_id(&coord);
    // No diagonal exit from the Foyer — a rejected move (→ a reject LED on the device).
    let event = DeviceEvent::PieceMoved {
        actor_id: heir,
        dir: Direction::Northeast,
    };
    assert!(
        resolve(&event, coord.replica(), &catalog).is_err(),
        "an exit-less direction is rejected",
    );
}
