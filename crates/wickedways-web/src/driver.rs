//! Shared surface driver (Phase 2c, sub-project D) — the framework-agnostic glue both the CRT and
//! point-and-click Dioxus apps use to talk to the engine over the multiplayer transport.
//!
//! Extracted from the CRT `main.rs` when the PnC surface (slice 3) needed the same pieces: reading
//! the page-URL config ([`read_config`]), projecting the replica into a [`ViewModel`] ([`project`]),
//! and resolving a parser [`Intent`] into a sync [`Command`] against the replica
//! ([`intent_to_command`]). Keeping these in the lib means the two surfaces can never drift on how a
//! click/line becomes a committed command. It also owns the launcher's campaign registry + route
//! resolution ([`resolve_route`]) and the URL-query writers ([`set_params`] / [`clear_params`]).

use std::collections::BTreeSet;

use wickedways_core::sync::{Command, LogEntry, SubmitResult, SyncCoordinator, SyncTransport};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::{CampaignSnapshot, World};

use crate::single_player::SinglePlayerTransport;
use crate::transport::WsTransport;

// ── Bundled single-player campaigns (`?campaign=`) ───────────────────────────────
// Each is a committed genesis snapshot + its authored catalog (item/behavior/formation data the
// authority resolves commands against). `demo` is pre-`started` and catalog-free (the same snapshot
// the room server serves and the transport tests seed); the others are `started: false` and carry a
// catalog, so booting them auto-`BeginCampaign`s. Real manifest-driven assembly (in place of these
// bundled snapshots) is a later increment.
const DEMO_GENESIS: &str = include_str!("../../../conformance/fixtures/sync-move.genesis.json");
const CARETAKER_GENESIS: &str = include_str!("../../../conformance/fixtures/caretaker.genesis.json");
const CARETAKER_CATALOG: &str = include_str!("../../../conformance/fixtures/caretaker.catalog.json");
const FACADE_GENESIS: &str = include_str!("../../../conformance/fixtures/facade-free-vs-advancing.genesis.json");
const FACADE_CATALOG: &str = include_str!("../../../conformance/fixtures/facade-free-vs-advancing.catalog.json");

/// The default single-player campaign id when `?campaign=` is absent or unknown.
pub const DEFAULT_CAMPAIGN: &str = "demo";

/// Resolve a bundled campaign id to `(genesis, catalog)` JSON, or `None` for an unknown id. A `None`
/// catalog means the default (empty) catalog.
fn bundled(id: &str) -> Option<(&'static str, Option<&'static str>)> {
    match id {
        "demo" | "crypt" => Some((DEMO_GENESIS, None)),
        "caretaker" => Some((CARETAKER_GENESIS, Some(CARETAKER_CATALOG))),
        "facade" | "facade-free-vs-advancing" => Some((FACADE_GENESIS, Some(FACADE_CATALOG))),
        _ => None,
    }
}

/// The parsed genesis snapshot + catalog for a bundled campaign id, falling back to
/// [`DEFAULT_CAMPAIGN`] for an unknown id.
pub fn bundled_campaign(id: &str) -> Result<(CampaignSnapshot, Catalog), String> {
    let (genesis, catalog) = bundled(id).or_else(|| bundled(DEFAULT_CAMPAIGN)).ok_or("no campaign")?;
    let snapshot = serde_json::from_str(genesis).map_err(|e| format!("genesis '{id}' malformed: {e}"))?;
    let catalog = match catalog {
        None => Catalog::default(),
        Some(json) => serde_json::from_str(json).map_err(|e| format!("catalog '{id}' malformed: {e}"))?,
    };
    Ok((snapshot, catalog))
}

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
    /// Built-in palette id (`?theme=`), applied by the surface. Empty = each surface's default.
    pub theme: String,
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
        theme: query_param("theme").unwrap_or_default(),
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

/// Build a fresh offline transport + a coordinator joined to it, from an authoritative snapshot and
/// its catalog. Shared by single-player boot, `restore` (from a save), and `restart` (from a pristine
/// genesis) — the local analog of the room server's "reset the authority to a snapshot".
pub fn rebuild_single(snapshot: CampaignSnapshot, catalog: Catalog) -> (AppTransport, SyncCoordinator) {
    let transport = AppTransport::Single(Box::new(SinglePlayerTransport::new(
        World::from_snapshot(snapshot),
        catalog,
    )));
    let coord = SyncCoordinator::join(&transport);
    (transport, coord)
}

/// Boot the offline single-player authority for a bundled campaign: build it, and `BeginCampaign` if
/// the genesis hasn't started yet (single-player is the sole GM). Returns the transport, the joined
/// coordinator, and the campaign catalog the surface projects with. Shared by boot and `restart`.
pub async fn boot_single(campaign: &str) -> Result<(AppTransport, SyncCoordinator, Catalog), String> {
    let (snapshot, catalog) = bundled_campaign(campaign)?;
    let started = snapshot.campaign.started;
    let (transport, mut coord) = rebuild_single(snapshot, catalog.clone());
    if !started {
        match transport.submit_async(Command::BeginCampaign).await {
            SubmitResult::Committed { .. } => coord.sync(&transport),
            SubmitResult::Denied { reason } => return Err(format!("begin campaign: {reason}")),
        }
    }
    Ok((transport, coord, catalog))
}

/// Boot per [`Config::mode`]: the offline single-player authority (with its catalog), or a WebSocket
/// to the room server (which projects with the default catalog — the server owns the real one).
/// Returns everything the surface's driver loop needs: the transport, the joined coordinator, and the
/// catalog to [`project`] with.
pub async fn boot(cfg: &Config) -> Result<(AppTransport, SyncCoordinator, Catalog), String> {
    match cfg.mode {
        Mode::Single => boot_single(&cfg.campaign).await,
        Mode::Multi => {
            let transport = AppTransport::Multi(WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await?);
            let coord = SyncCoordinator::join(&transport);
            Ok((transport, coord, Catalog::default()))
        }
    }
}

impl AppTransport {
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

// ── Launcher registry + routing ──────────────────────────────────────────────────
// The launcher menu/picker present the bundled campaigns and the surfaces each offers. This is the
// display metadata parallel to `bundled` (the genesis/catalog): a campaign appears in the launcher
// iff it's listed here, and its `slug` is the canonical `?campaign=` deep-link value.

/// A surface a campaign can run on, with its launcher label + one-line description.
pub struct SurfaceInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

const SURFACE_INFOS: &[SurfaceInfo] = &[
    SurfaceInfo { id: "crt-terminal", label: "CRT Terminal", description: "Classic green-screen text adventure." },
    SurfaceInfo { id: "point-and-click", label: "Point & Click", description: "Visual scene with clickable hotspots." },
];

/// Look up a surface's launcher metadata by id.
pub fn surface_info(id: &str) -> Option<&'static SurfaceInfo> {
    SURFACE_INFOS.iter().find(|s| s.id == id)
}

/// Display + surface metadata for one bundled campaign, shown in the launcher menu.
pub struct CampaignInfo {
    /// `?campaign=` deep-link value and registry key (matches a [`bundled`] id).
    pub slug: &'static str,
    pub title: &'static str,
    pub blurb: &'static str,
    /// Surface ids this campaign offers; `surfaces[0]` is the default. ≥ 2 → the picker is shown.
    pub surfaces: &'static [&'static str],
}

/// Both surfaces, offered by every bundled campaign (so the surface picker is always reachable).
const BOTH_SURFACES: &[&str] = &["crt-terminal", "point-and-click"];

/// The bundled campaigns the launcher presents, in menu order.
pub fn campaign_registry() -> &'static [CampaignInfo] {
    const REGISTRY: &[CampaignInfo] = &[
        CampaignInfo {
            slug: "demo",
            title: "The Crypt",
            blurb: "A two-room sync demo — cross from the crypt to the vault.",
            surfaces: BOTH_SURFACES,
        },
        CampaignInfo {
            slug: "caretaker",
            title: "The Caretaker",
            blurb: "A foyer with a watchful NPC and a locked cellar door.",
            surfaces: BOTH_SURFACES,
        },
        CampaignInfo {
            slug: "facade-free-vs-advancing",
            title: "Façade: Free vs. Advancing",
            blurb: "A hall stalked by a lurking mob, with a chest to plunder.",
            surfaces: BOTH_SURFACES,
        },
    ];
    REGISTRY
}

/// Resolve a `?campaign=` slug to its launcher metadata, or `None` for an absent/unknown slug (→ menu).
pub fn resolve_campaign_info(slug: Option<&str>) -> Option<&'static CampaignInfo> {
    let slug = slug?;
    campaign_registry().iter().find(|c| c.slug == slug)
}

/// Where the launcher should be: the campaign menu, a surface picker, or a mounted surface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LauncherRoute {
    /// No (valid) campaign selected — show the campaign menu.
    Menu,
    /// A campaign with ≥ 2 surfaces and no chosen surface — show the surface picker.
    Picker { slug: String },
    /// A resolved campaign + surface — mount that surface.
    Surface { slug: String, surface: String },
}

/// The surface-choice decision for a known campaign: an explicit valid `surface` mounts directly;
/// otherwise ≥ 2 surfaces show the picker and a lone surface mounts directly. Pure (over the slug +
/// its surface list) so the launcher boot flow is host-tested without a DOM.
fn choose(slug: &str, surfaces: &[&str], surface: Option<&str>) -> LauncherRoute {
    if let Some(sid) = surface {
        if surfaces.contains(&sid) {
            return LauncherRoute::Surface { slug: slug.into(), surface: sid.into() };
        }
    }
    if surfaces.len() >= 2 {
        LauncherRoute::Picker { slug: slug.into() }
    } else {
        LauncherRoute::Surface { slug: slug.into(), surface: surfaces.first().copied().unwrap_or("crt-terminal").into() }
    }
}

/// Resolve the launcher route from the `?campaign=` / `?surface=` params: an unknown/absent campaign
/// → [`LauncherRoute::Menu`]; a known campaign follows [`choose`]. Mirrors the TS `bootLauncher` boot.
pub fn resolve_route(campaign: Option<&str>, surface: Option<&str>) -> LauncherRoute {
    match resolve_campaign_info(campaign) {
        Some(info) => choose(info.slug, info.surfaces, surface),
        None => LauncherRoute::Menu,
    }
}

/// Read the launcher route from the page URL (`?campaign=` / `?surface=`).
pub fn read_route() -> LauncherRoute {
    resolve_route(query_param("campaign").as_deref(), query_param("surface").as_deref())
}

/// Mutate the current URL's query in place via `history.replaceState` (no reload), applying `f` to a
/// live [`UrlSearchParams`]. Best-effort — silently skips in non-http environments. Shared by
/// [`set_params`] / [`clear_params`].
fn replace_query(f: impl FnOnce(&web_sys::UrlSearchParams)) {
    let Some(win) = web_sys::window() else { return };
    let Ok(href) = win.location().href() else { return };
    let Ok(url) = web_sys::Url::new(&href) else { return };
    // `url.searchParams` is spec-linked to `url.search`, so mutating it updates `url.href`.
    f(&url.search_params());
    if let Ok(history) = win.history() {
        let _ = history.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&url.href()));
    }
}

/// Merge `pairs` into the page URL's query (no reload), so the launcher's route is deep-linkable.
pub fn set_params(pairs: &[(&str, &str)]) {
    replace_query(|p| {
        for (k, v) in pairs {
            p.set(k, v);
        }
    });
}

/// Remove `keys` from the page URL's query (no reload) — used when returning to the menu.
pub fn clear_params(keys: &[&str]) {
    replace_query(|p| {
        for k in keys {
            p.delete(k);
        }
    });
}

/// Project the coordinator's replica into a [`ViewModel`] against the campaign catalog (no opened-loot
/// set). The catalog resolves item names/behaviors and exit passability, so a campaign with authored
/// items/doors must project with its own catalog (multiplayer uses the default — the server owns it).
pub fn project(coord: &SyncCoordinator, catalog: &Catalog) -> Option<ViewModel> {
    coord.replica().view(catalog, &BTreeSet::new()).ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every bundled campaign parses, boots an offline authority, `BeginCampaign`s when it hasn't
    /// started, and projects a view against its catalog — the offline path `?campaign=` drives. This
    /// is the sync equivalent of `boot_single` (host tests can't await), exercising the same
    /// build → begin → project sequence.
    #[test]
    fn every_bundled_campaign_boots_begins_and_projects() {
        for id in ["demo", "caretaker", "facade-free-vs-advancing"] {
            let (snapshot, catalog) = bundled_campaign(id).unwrap_or_else(|e| panic!("{id}: {e}"));
            let started = snapshot.campaign.started;
            let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
            if !started {
                let res = coord.submit(&mut transport, Command::BeginCampaign);
                assert!(matches!(res, SubmitResult::Committed { .. }), "{id}: begin should commit, got {res:?}");
            }
            assert!(project(&coord, &catalog).is_some(), "{id}: should project a view");
        }
    }

    #[test]
    fn an_unknown_campaign_falls_back_to_the_default() {
        // Unknown ids resolve to DEFAULT_CAMPAIGN rather than erroring, so a stray `?campaign=` still
        // boots something playable.
        let (snapshot, _) = bundled_campaign("does-not-exist").unwrap();
        let (expected, _) = bundled_campaign(DEFAULT_CAMPAIGN).unwrap();
        assert_eq!(snapshot.campaign.title, expected.campaign.title);
    }

    #[test]
    fn every_registered_campaign_is_bootable_and_its_surfaces_are_known() {
        // The launcher must never present a campaign it can't boot or a surface it can't mount.
        for c in campaign_registry() {
            assert!(bundled(c.slug).is_some(), "{}: registry slug must be a bundled campaign", c.slug);
            assert!(!c.surfaces.is_empty(), "{}: must offer at least one surface", c.slug);
            for sid in c.surfaces {
                assert!(surface_info(sid).is_some(), "{}: surface '{sid}' must have metadata", c.slug);
            }
        }
    }

    #[test]
    fn resolve_route_shows_the_menu_for_an_absent_or_unknown_campaign() {
        assert_eq!(resolve_route(None, None), LauncherRoute::Menu);
        assert_eq!(resolve_route(Some("no-such-campaign"), None), LauncherRoute::Menu);
        // A dangling `?surface=` without a campaign is still the menu.
        assert_eq!(resolve_route(None, Some("crt-terminal")), LauncherRoute::Menu);
    }

    #[test]
    fn resolve_route_deep_links_a_valid_surface_and_pickers_otherwise() {
        // A known campaign + valid surface mounts directly.
        assert_eq!(
            resolve_route(Some("demo"), Some("point-and-click")),
            LauncherRoute::Surface { slug: "demo".into(), surface: "point-and-click".into() }
        );
        // Known campaign, no surface → picker (every bundled campaign offers ≥ 2).
        assert_eq!(resolve_route(Some("demo"), None), LauncherRoute::Picker { slug: "demo".into() });
        // An invalid surface id is ignored → picker (not a bogus mount).
        assert_eq!(resolve_route(Some("demo"), Some("hologram")), LauncherRoute::Picker { slug: "demo".into() });
    }

    #[test]
    fn choose_mounts_directly_when_only_one_surface_is_offered() {
        // The <2-surface branch (no bundled campaign exercises it, so test `choose` directly).
        assert_eq!(
            choose("solo", &["crt-terminal"], None),
            LauncherRoute::Surface { slug: "solo".into(), surface: "crt-terminal".into() }
        );
        // A single-surface campaign with no surfaces at all still yields a safe default.
        assert_eq!(
            choose("empty", &[], None),
            LauncherRoute::Surface { slug: "empty".into(), surface: "crt-terminal".into() }
        );
    }
}
