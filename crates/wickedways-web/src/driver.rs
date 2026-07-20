//! Shared surface driver (Phase 2c, sub-project D) — the framework-agnostic glue both the CRT and
//! point-and-click Dioxus apps use to talk to the engine over the multiplayer transport.
//!
//! Extracted from the CRT `main.rs` when the PnC surface (slice 3) needed the same pieces: reading
//! the page-URL config ([`read_config`]) and the chosen surface ([`read_surface`]), projecting the
//! replica into a [`ViewModel`] ([`project`]), and resolving a parser [`Intent`] into a sync
//! [`Command`] against the replica ([`intent_to_command`]). Keeping these in the lib means the two
//! surfaces can never drift on how a click/line becomes a committed command.

use std::collections::BTreeSet;

use wickedways_core::sync::{Command, SyncCoordinator};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::World;

/// The WebSocket connection config, read from the page URL query.
pub struct Config {
    pub ws: String,
    pub campaign: String,
    pub token: String,
}

/// Which surface to boot. The launcher's fuller `?campaign=`/`?theme=` handling is slice 4; this is
/// the minimal `?surface=` switch the CRT/PnC split needs now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Crt,
    Pnc,
}

fn query_param(key: &str) -> Option<String> {
    web_sys::window()
        .and_then(|w| w.location().search().ok())
        .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
        .and_then(|p| p.get(key))
        .filter(|v| !v.is_empty())
}

/// Read `?ws=…&campaign=…&token=…`, falling back to the local-dev defaults.
pub fn read_config() -> Config {
    Config {
        ws: query_param("ws").unwrap_or_else(|| "ws://127.0.0.1:9000/ws".into()),
        campaign: query_param("campaign").unwrap_or_else(|| "demo".into()),
        token: query_param("token").unwrap_or_else(|| "gm".into()),
    }
}

/// Read `?surface=pnc` → [`Surface::Pnc`]; anything else (including absent) → [`Surface::Crt`].
pub fn read_surface() -> Surface {
    match query_param("surface").as_deref() {
        Some("pnc") | Some("point-and-click") => Surface::Pnc,
        _ => Surface::Crt,
    }
}

/// Project the coordinator's replica into a [`ViewModel`] (the default catalog, no opened-loot set).
pub fn project(coord: &SyncCoordinator) -> Option<ViewModel> {
    coord.replica().view(&Catalog::default(), &BTreeSet::new()).ok()
}

/// Resolve a parser [`Intent`] into a sync [`Command`] against the replica. The key step is a
/// `move`, whose compass direction becomes the destination room id via the active character's room
/// and the exit graph. Intents with no sync command in the multiplayer path (open/talk/wait) return
/// a human-readable note the surface narrates back.
pub fn intent_to_command(world: &World, intent: &Intent) -> Result<Command, String> {
    let actor = world.active_character_id().map_err(|e| e.0)?;
    match intent {
        Intent::Move { dir } => {
            let room_id = world
                .characters
                .get(&actor)
                .and_then(|c| c.current_room_id.clone())
                .ok_or("you are nowhere")?;
            let room = world.rooms.get(&room_id).ok_or("room not found")?;
            let exit_id = room.exits.get(dir.as_key()).ok_or_else(|| format!("no exit {}", dir.as_key()))?;
            let ex = world.exits.get(exit_id).ok_or("exit not found")?;
            let dest = if ex.endpoint_ids[0] == room_id {
                ex.endpoint_ids[1].clone()
            } else {
                ex.endpoint_ids[0].clone()
            };
            Ok(Command::Move { actor_id: actor, room_id: dest })
        }
        Intent::Take { target_id } => Ok(Command::PickUp { actor_id: actor, item_ids: vec![ItemId(target_id.clone())] }),
        Intent::Drop { target_id } => Ok(Command::Drop { actor_id: actor, item_ids: vec![ItemId(target_id.clone())] }),
        Intent::Attack { target_id } => Ok(Command::Attack { actor_id: actor, target_id: CharacterId(target_id.clone()) }),
        Intent::Equip { target_id } => Ok(Command::Equip { actor_id: actor, item_id: ItemId(target_id.clone()), slot: None }),
        Intent::Unequip { target_id } => Ok(Command::Unequip { actor_id: actor, item_id: ItemId(target_id.clone()) }),
        Intent::Use { target_id } => Ok(Command::Use { actor_id: actor, item_id: ItemId(target_id.clone()) }),
        Intent::Open { .. } => Err("(opening is a local view action — not yet wired)".into()),
        Intent::Talk { .. } => Err("(dialogue is a later slice)".into()),
        Intent::Wait => Err("(wait is not yet wired)".into()),
    }
}
