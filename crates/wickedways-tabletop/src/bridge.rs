//! The pure bridge: engine state → [`DeviceCommand`]s, and [`DeviceEvent`]s → engine [`Command`]s.
//!
//! Both directions are pure functions of a projection, so they're identical for the on-screen
//! simulator and real firmware — only the [`transport`](crate::transport) differs.

use wickedways_core::presentation::CampaignOutcome;
use wickedways_core::sync::Command;
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::CharacterId;
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::{presentation::StatusField, World};

use crate::command::command_for;
use crate::map::MapModel;
use crate::protocol::{DeviceCommand, DeviceEvent, PieceGlow};
use crate::roster::SeatView;

/// The glow for a seat's piece — worst affliction first.
fn glow_for(seat: &SeatView) -> PieceGlow {
    if seat.ko {
        PieceGlow::Ko
    } else if seat.panic {
        PieceGlow::Panic
    } else if seat.fear {
        PieceGlow::Fear
    } else {
        PieceGlow::Normal
    }
}

/// The wire label for a campaign outcome.
fn outcome_str(o: &CampaignOutcome) -> String {
    match o {
        CampaignOutcome::Ongoing => "ongoing",
        CampaignOutcome::Won => "won",
        CampaignOutcome::Lost => "lost",
        CampaignOutcome::TimedOut => "timed-out",
        CampaignOutcome::Ended => "ended",
    }
    .to_string()
}

/// The affliction chip labels for a seat's dashboard.
fn affliction_labels(seat: &SeatView) -> Vec<String> {
    let mut labels = Vec::new();
    for (on, label) in [
        (seat.ko, "KO"),
        (seat.panic, "Panic"),
        (seat.fear, "Fear"),
        (seat.confused, "Confused"),
    ] {
        if on {
            labels.push(label.to_string());
        }
    }
    labels
}

/// Project the whole board: a `Tile` per placed room, a `Piece` + `Dashboard` per seat, the shared
/// status `Banner`, and a `Resolution` when the campaign has ended. v1 re-emits the full board each
/// turn (the device/simulator is idempotent); diffing is a later optimization.
///
/// Lit/concealed state is known only for the **active viewer's** current room (`view.room`); other
/// tiles render lit, mirroring the fog-of-war the map already models.
pub fn render(
    view: &ViewModel,
    seats: &[SeatView],
    map: &MapModel,
    status_fields: &[StatusField],
) -> Vec<DeviceCommand> {
    let mut cmds = Vec::new();
    let current = view.room.id.as_str();

    for room in map.rooms() {
        let is_current = room.id == current;
        cmds.push(DeviceCommand::Tile {
            tile_id: room.id.clone(),
            label: room.name.clone(),
            lit: !is_current || view.room.is_lit,
            concealed: is_current && !view.room.is_lit,
            remains: room.has_remains,
        });
    }

    for seat in seats {
        if let Some(tile_id) = &seat.room_id {
            cmds.push(DeviceCommand::Piece {
                piece_id: seat.id.clone(),
                name: seat.name.clone(),
                tile_id: tile_id.clone(),
                glow: glow_for(seat),
                active: seat.active,
            });
        }
        cmds.push(DeviceCommand::Dashboard {
            seat_id: seat.id.clone(),
            name: seat.name.clone(),
            health: seat.health,
            sanity: seat.sanity,
            afflictions: affliction_labels(seat),
            active: seat.active,
        });
    }

    if !status_fields.is_empty() {
        cmds.push(DeviceCommand::Banner {
            fields: status_fields.to_vec(),
        });
    }

    if view.finished {
        cmds.push(DeviceCommand::Resolution {
            outcome: outcome_str(&view.outcome),
        });
    }

    cmds
}

/// Resolve an inbound board event into an engine command to submit.
///
/// - `Ok(Some(cmd))` — submit it (the engine's `authorize` still gates it by turn/lock).
/// - `Ok(None)` — a local-only or reserved event (a container open, a lantern) — nothing to submit.
/// - `Err(reason)` — the move is blocked (a locked door) — the caller flashes a `reject` LED.
pub fn resolve(
    event: &DeviceEvent,
    world: &World,
    catalog: &Catalog,
) -> Result<Option<Command>, String> {
    match event {
        DeviceEvent::PieceMoved { actor_id, dir } => {
            let cmd = command_for(
                world,
                catalog,
                CharacterId(actor_id.clone()),
                &Intent::Move { dir: *dir },
            )?;
            Ok(Some(cmd))
        }
        DeviceEvent::TileAction { actor_id, intent } => {
            // `open` reveals a container locally — no engine command.
            if matches!(intent, Intent::Open { .. }) {
                return Ok(None);
            }
            let cmd = command_for(world, catalog, CharacterId(actor_id.clone()), intent)?;
            Ok(Some(cmd))
        }
        // A light prop maps to a place-light on the physical board (P3); no-op in the v1 simulator.
        DeviceEvent::Lantern { .. } => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wickedways_core::world::view::{Inventory, StatusView, ThinRoom};

    fn vm(room_id: &str, name: &str, lit: bool) -> ViewModel {
        ViewModel {
            room: ThinRoom {
                id: room_id.into(),
                name: name.into(),
                description: String::new(),
                is_lit: lit,
            },
            exits: Vec::new(),
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
                location_name: name.into(),
                turn: 0,
                max_turns: 1,
                health: 10.0,
                sanity: 10.0,
            },
            outcome: CampaignOutcome::Ongoing,
            finished: false,
        }
    }

    fn seat(id: &str, room: &str, active: bool) -> SeatView {
        SeatView {
            id: id.into(),
            name: id.into(),
            room_id: Some(room.into()),
            health: 10.0,
            sanity: 10.0,
            ko: false,
            panic: false,
            fear: false,
            confused: false,
            active,
        }
    }

    fn map_with(rooms: &[(&str, &str)]) -> MapModel {
        // Seed the first room via observe (origin), then chain the rest as eastward moves so each is
        // placed on the grid.
        let mut m = MapModel::new();
        if let Some((first, name)) = rooms.first() {
            m.observe(&vm(first, name, true));
            let mut prev = *first;
            for (id, _name) in &rooms[1..] {
                m.record_move(prev, wickedways_core::world::direction::Direction::East, id);
                prev = id;
            }
        }
        m
    }

    #[test]
    fn render_emits_a_tile_and_piece_for_the_current_room() {
        let v = vm("foyer", "Foyer", true);
        let seats = [seat("player:heir", "foyer", true)];
        let map = map_with(&[("foyer", "Foyer")]);
        let cmds = render(&v, &seats, &map, &[]);

        assert!(cmds.iter().any(|c| matches!(c, DeviceCommand::Tile { tile_id, concealed, .. } if tile_id == "foyer" && !concealed)));
        assert!(cmds.iter().any(|c| matches!(c, DeviceCommand::Piece { piece_id, tile_id, active, .. } if piece_id == "player:heir" && tile_id == "foyer" && *active)));
        assert!(cmds.iter().any(
            |c| matches!(c, DeviceCommand::Dashboard { seat_id, .. } if seat_id == "player:heir")
        ));
    }

    #[test]
    fn a_dark_unlit_current_room_is_concealed() {
        let v = vm("cellar", "Cellar", false);
        let map = map_with(&[("cellar", "Cellar")]);
        let cmds = render(&v, &[], &map, &[]);
        assert!(cmds.iter().any(|c| matches!(c, DeviceCommand::Tile { tile_id, lit, concealed, .. } if tile_id == "cellar" && !lit && *concealed)));
    }

    #[test]
    fn each_seat_piece_lands_on_its_own_tile() {
        let v = vm("foyer", "Foyer", true);
        let seats = [
            seat("player:heir", "hall", false),
            seat("player:ada", "foyer", true),
        ];
        let map = map_with(&[("foyer", "Foyer"), ("hall", "Hall")]);
        let cmds = render(&v, &seats, &map, &[]);
        let piece_tile = |id: &str| {
            cmds.iter().find_map(|c| match c {
                DeviceCommand::Piece {
                    piece_id, tile_id, ..
                } if piece_id == id => Some(tile_id.clone()),
                _ => None,
            })
        };
        assert_eq!(piece_tile("player:heir").as_deref(), Some("hall"));
        assert_eq!(piece_tile("player:ada").as_deref(), Some("foyer"));
    }

    #[test]
    fn a_finished_campaign_emits_a_resolution() {
        let mut v = vm("foyer", "Foyer", true);
        v.finished = true;
        v.outcome = CampaignOutcome::Won;
        let map = map_with(&[("foyer", "Foyer")]);
        let cmds = render(&v, &[], &map, &[]);
        assert!(cmds
            .iter()
            .any(|c| matches!(c, DeviceCommand::Resolution { outcome } if outcome == "won")));
    }
}
