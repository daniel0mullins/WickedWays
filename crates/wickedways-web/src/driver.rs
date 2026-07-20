//! Shared surface driver (Phase 2c, sub-project D) — the framework-agnostic glue both the CRT and
//! point-and-click Dioxus apps use to talk to the engine over the multiplayer transport.
//!
//! Extracted from the CRT `main.rs` when the PnC surface (slice 3) needed the same pieces: reading
//! the page-URL config ([`read_config`]) and the chosen surface ([`read_surface`]), projecting the
//! replica into a [`ViewModel`] ([`project`]), and resolving a parser [`Intent`] into a sync
//! [`Command`] against the replica ([`intent_to_command`]). Keeping these in the lib means the two
//! surfaces can never drift on how a click/line becomes a committed command.

use std::collections::BTreeSet;

use wickedways_core::sync::{Command, LogEntry, SubmitResult, SyncCoordinator, SyncTransport};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::{CampaignSnapshot, World};

use crate::single_player::SinglePlayerTransport;
use crate::transport::WsTransport;

/// The bundled demo campaign genesis, used when booting single-player without a server. The same
/// committed `started` snapshot the room server serves as `demo` and the transport tests seed. The
/// launcher's real manifest-driven assembly (`?campaign=`) is a later slice-4 increment.
const DEMO_GENESIS: &str = include_str!("../../../conformance/fixtures/sync-move.genesis.json");

/// Which authority the client drives: an offline in-process authority, or a room server over WS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Offline: a local [`SinglePlayerTransport`] over the bundled genesis (`?mode=single`).
    Single,
    /// Multiplayer: a [`WsTransport`] to the room server (the default).
    Multi,
}

/// The connection config, read from the page URL query.
pub struct Config {
    pub mode: Mode,
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

/// Read `?mode=&ws=…&campaign=…&token=…`, falling back to the local-dev defaults. `?mode=single`
/// (or `?mode=offline`) selects the offline single-player authority; anything else is multiplayer.
pub fn read_config() -> Config {
    let mode = match query_param("mode").as_deref() {
        Some("single") | Some("offline") | Some("solo") => Mode::Single,
        _ => Mode::Multi,
    };
    Config {
        mode,
        ws: query_param("ws").unwrap_or_else(|| "ws://127.0.0.1:9000/ws".into()),
        campaign: query_param("campaign").unwrap_or_else(|| "demo".into()),
        token: query_param("token").unwrap_or_else(|| "gm".into()),
    }
}

/// The transport the surfaces drive, abstracting the two modes so the driver loop is
/// transport-agnostic: `SyncCoordinator::join` + the coordinator's synchronous reads go through the
/// [`SyncTransport`] impl, and each surface submits via [`submit_async`](AppTransport::submit_async).
/// "Single-player is multiplayer with one seat and an in-process authority" — the same coordinator,
/// only the transport changes.
pub enum AppTransport {
    Multi(WsTransport),
    // Boxed: a `SinglePlayerTransport` owns the whole authority `World`, far larger than the
    // pointer-sized `WsTransport`, so inlining it would bloat every `AppTransport`.
    Single(Box<SinglePlayerTransport>),
}

impl AppTransport {
    /// Connect per [`Config::mode`]: build the offline authority from the bundled genesis, or open a
    /// WebSocket to the room server.
    pub async fn connect(cfg: &Config) -> Result<AppTransport, String> {
        match cfg.mode {
            Mode::Single => {
                let snapshot: CampaignSnapshot = serde_json::from_str(DEMO_GENESIS)
                    .map_err(|e| format!("bundled genesis is malformed: {e}"))?;
                let genesis = World::from_snapshot(snapshot);
                Ok(AppTransport::Single(Box::new(SinglePlayerTransport::new(genesis, Catalog::default()))))
            }
            Mode::Multi => {
                Ok(AppTransport::Multi(WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await?))
            }
        }
    }

    /// Submit a command, awaiting the authoritative verdict (the socket round-trip in multiplayer, an
    /// immediate resolve offline).
    pub async fn submit_async(&self, command: Command) -> SubmitResult {
        match self {
            AppTransport::Multi(t) => t.submit_async(command).await,
            AppTransport::Single(t) => t.submit_async(command).await,
        }
    }
}

impl SyncTransport for AppTransport {
    fn head(&self) -> u64 {
        match self {
            AppTransport::Multi(t) => t.head(),
            AppTransport::Single(t) => t.head(),
        }
    }
    fn submit(&mut self, command: Command) -> SubmitResult {
        match self {
            AppTransport::Multi(t) => t.submit(command),
            AppTransport::Single(t) => t.submit(command),
        }
    }
    fn entries_since(&self, from_seq: u64) -> Vec<LogEntry> {
        match self {
            AppTransport::Multi(t) => t.entries_since(from_seq),
            AppTransport::Single(t) => t.entries_since(from_seq),
        }
    }
    fn load_snapshot(&self) -> (u64, CampaignSnapshot) {
        match self {
            AppTransport::Multi(t) => t.load_snapshot(),
            AppTransport::Single(t) => t.load_snapshot(),
        }
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
