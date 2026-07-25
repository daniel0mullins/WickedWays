//! Shared surface driver — the framework-agnostic glue both the CRT and
//! point-and-click Dioxus apps use to talk to the engine over the multiplayer transport.
//!
//! The pieces both surfaces need: reading
//! the page-URL config ([`read_config`]), projecting the replica into a [`ViewModel`] ([`project`]),
//! and resolving a parser [`Intent`] into a sync [`Command`] against the replica
//! ([`intent_to_command`]). Keeping these in the lib means the two surfaces can never drift on how a
//! click/line becomes a committed command. It also owns the launcher's campaign registry + route
//! resolution ([`resolve_route`]) and the URL-query writers ([`set_params`] / [`clear_params`]).

use std::collections::BTreeSet;

use wickedways_core::sync::{Command, LogEntry, SubmitResult, SyncCoordinator, SyncTransport};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId, MaterialCacheId};
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
// bundled snapshots) is future work.
const DEMO_GENESIS: &str = include_str!("../../../conformance/fixtures/sync-move.genesis.json");
const CARETAKER_GENESIS: &str =
    include_str!("../../../conformance/fixtures/caretaker.genesis.json");
const CARETAKER_CATALOG: &str =
    include_str!("../../../conformance/fixtures/caretaker.catalog.json");
const FACADE_GENESIS: &str =
    include_str!("../../../conformance/fixtures/facade-free-vs-advancing.genesis.json");
const FACADE_CATALOG: &str =
    include_str!("../../../conformance/fixtures/facade-free-vs-advancing.catalog.json");
const STATUS_BAR_GENESIS: &str =
    include_str!("../../../conformance/fixtures/g2-status-bar.genesis.json");
const STATUS_BAR_CATALOG: &str =
    include_str!("../../../conformance/fixtures/g2-status-bar.catalog.json");
// The Hollow House — the full authored campaign (TOML → author → assemble). The genesis is the
// pristine snapshot seated with one Heir PC (the GM); its catalog carries the scripted mechanics
// (dread/sanity status bar/victory conditions) the core runs.
const HOLLOW_GENESIS: &str =
    include_str!("../../../conformance/fixtures/hollow-house.genesis.json");
const HOLLOW_CATALOG: &str =
    include_str!("../../../conformance/fixtures/hollow-house.catalog.json");
// The Covenant — the co-op MULTIPLAYER campaign (TOML → author → assemble, seated with four Wardens,
// the first is GM). Its `twin-wards-held` victory needs two players in two different rooms at once, so
// it's designed for the room server; the bundle here is the single-player fallback (unwinnable solo)
// the launcher's `?campaign=` boot path requires.
const COVENANT_GENESIS: &str = include_str!("../../../conformance/fixtures/covenant.genesis.json");
const COVENANT_CATALOG: &str = include_str!("../../../conformance/fixtures/covenant.catalog.json");

/// The default single-player campaign id when `?campaign=` is absent or unknown.
pub const DEFAULT_CAMPAIGN: &str = "demo";

/// Resolve a bundled campaign id to `(genesis, catalog)` JSON, or `None` for an unknown id. A `None`
/// catalog means the default (empty) catalog.
fn bundled(id: &str) -> Option<(&'static str, Option<&'static str>)> {
    match id {
        "demo" | "crypt" => Some((DEMO_GENESIS, None)),
        "caretaker" => Some((CARETAKER_GENESIS, Some(CARETAKER_CATALOG))),
        "facade" | "facade-free-vs-advancing" => Some((FACADE_GENESIS, Some(FACADE_CATALOG))),
        "status-bar" | "g2-status-bar" => Some((STATUS_BAR_GENESIS, Some(STATUS_BAR_CATALOG))),
        "hollow-house" | "hollow" => Some((HOLLOW_GENESIS, Some(HOLLOW_CATALOG))),
        "covenant" => Some((COVENANT_GENESIS, Some(COVENANT_CATALOG))),
        _ => None,
    }
}

/// The parsed genesis snapshot + catalog for a bundled campaign id, falling back to
/// [`DEFAULT_CAMPAIGN`] for an unknown id.
pub fn bundled_campaign(id: &str) -> Result<(CampaignSnapshot, Catalog), String> {
    let (genesis, catalog) = bundled(id)
        .or_else(|| bundled(DEFAULT_CAMPAIGN))
        .ok_or("no campaign")?;
    let snapshot =
        serde_json::from_str(genesis).map_err(|e| format!("genesis '{id}' malformed: {e}"))?;
    let catalog = match catalog {
        None => Catalog::default(),
        Some(json) => {
            serde_json::from_str(json).map_err(|e| format!("catalog '{id}' malformed: {e}"))?
        }
    };
    Ok((snapshot, catalog))
}

/// The bundled catalog for a campaign id (resolving a hosted `<slug>~<token>` room id to its base
/// campaign), or the empty catalog when the campaign ships none / isn't bundled. Used by the
/// multiplayer client for projection — the server holds the authoritative catalog, but the client
/// projects its replica locally and needs the same catalog to resolve aliases/recipes.
pub fn bundled_catalog(id: &str) -> Catalog {
    let base = base_campaign(id);
    match bundled(base).or_else(|| bundled(id)) {
        Some((_, Some(json))) => serde_json::from_str(json).unwrap_or_default(),
        _ => Catalog::default(),
    }
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

/// Whether a bare flag param is present (regardless of value) — `?debug`, `?debug=1`, etc.
fn has_flag(key: &str) -> bool {
    web_sys::window()
        .and_then(|w| w.location().search().ok())
        .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
        .is_some_and(|p| p.has(key))
}

/// Toggle browser fullscreen for the whole page (the `fullscreen`/`fs` verb and the surfaces'
/// fullscreen control). Enters fullscreen on the document element when none is active, else exits.
/// Returns `true` if the page is entering fullscreen, `false` if exiting (or on no-op), so the caller
/// can narrate the new state. A rejected request (e.g. no user gesture) is swallowed.
pub fn toggle_fullscreen() -> bool {
    let Some(doc) = web_sys::window().and_then(|w| w.document()) else {
        return false;
    };
    if doc.fullscreen_element().is_some() {
        doc.exit_fullscreen();
        false
    } else if let Some(el) = doc.document_element() {
        let _ = el.request_fullscreen();
        true
    } else {
        false
    }
}

/// Whether the page carries `?debug` — unlocks the demo/conformance campaigns in the launcher.
pub fn debug_enabled() -> bool {
    has_flag("debug")
}

/// The default multiplayer socket URL: **same-origin and scheme-aware**, derived from the page
/// (`wss://<host>/ws` on HTTPS, `ws://<host>/ws` otherwise) so a deployed client connects back to the
/// one binary that served it — no hardcoded host/port, no mixed-content block over HTTPS. Falls back
/// to the local-dev server when there's no page origin (non-browser / `file:`).
fn default_ws() -> String {
    web_sys::window()
        .map(|w| w.location())
        .and_then(|loc| {
            let host = loc.host().ok().filter(|h| !h.is_empty())?;
            let scheme = if loc.protocol().ok().as_deref() == Some("https:") {
                "wss"
            } else {
                "ws"
            };
            Some(format!("{scheme}://{host}/ws"))
        })
        .unwrap_or_else(|| "ws://127.0.0.1:9000/ws".into())
}

/// A distinct per-tab player identity for multiplayer. An explicit `?token=` wins (so a GM joins as
/// the configured GM identity — `?token=gm` — and a link can pin an identity); otherwise this mints a
/// random `player-XXXXXX` and persists it to the URL, so the lobby and the surface it hands off to
/// connect as ONE identity (and the same seat). Not a security token — real auth maps a signed-in user
/// to an identity server-side.
pub fn ensure_player_identity() -> String {
    if let Some(t) = query_param("token") {
        return t;
    }
    let id = format!("player-{}", random_suffix());
    set_params(&[("token", &id)]);
    id
}

/// Six base-36 chars from `Math.random()` — enough to tell tabs apart, not a secret.
fn random_suffix() -> String {
    let n = (js_sys::Math::random() * 2_176_782_336.0) as u64; // 36^6
    let mut x = n;
    let mut s = String::new();
    for _ in 0..6 {
        let d = (x % 36) as u32;
        s.push(char::from_digit(d, 36).unwrap_or('0'));
        x /= 36;
    }
    s
}

/// Read `?mode=&ws=…&campaign=…&token=…`, falling back to the same-origin socket + local-dev defaults.
/// `?mode=single` (or `?mode=offline`) selects the offline single-player authority; anything else is
/// multiplayer.
pub fn read_config() -> Config {
    let mode = match query_param("mode").as_deref() {
        Some("single" | "offline" | "solo") => Mode::Single,
        _ => Mode::Multi,
    };
    Config {
        mode,
        ws: query_param("ws").unwrap_or_else(default_ws),
        campaign: query_param("campaign").unwrap_or_else(|| "demo".into()),
        token: query_param("token").unwrap_or_else(|| GM_IDENTITY.into()),
        theme: query_param("theme").unwrap_or_default(),
    }
}

/// The GM's identity in the dev model: the host mints `?token=gm`, matching the server's default
/// `GM_IDENTITY`. Whoever presents this token is the GM.
pub const GM_IDENTITY: &str = "gm";

/// Whether this client is the GM: the sole GM in single-player, or the `gm` identity in multiplayer
/// (the host mints `?token=gm`; joiners get a random `player-*` identity via [`ensure_player_identity`]).
pub fn is_gm() -> bool {
    let cfg = read_config();
    matches!(cfg.mode, Mode::Single) || cfg.token == GM_IDENTITY
}

/// Whether it's this client's turn to act. Not started → no. Single-player → always (you drive every
/// seat). Multiplayer → the active character is the one you control: the GM controls the campaign's
/// `gmId`; a joined player controls `player:<identity>`.
pub fn is_my_turn(snapshot: &CampaignSnapshot, token: &str, is_gm: bool, single: bool) -> bool {
    let c = &snapshot.campaign;
    if !c.started {
        return false;
    }
    if single {
        return true;
    }
    let active = c.party_ids.get(c.active_character_index.max(0) as usize);
    let mine = if is_gm {
        c.gm_id.clone()
    } else {
        Some(CharacterId(format!("player:{token}")))
    };
    active == mine.as_ref()
}

/// Whether the active player still has action budget left this turn. In single-player (and before the
/// campaign starts) there is no client-side budget gate — returns `true`. Multiplayer managed turns
/// refuse actions once `actionsThisRound` reaches `actionsPerRound`; the surfaces mirror that by
/// dimming the input so the player knows to end their turn.
pub fn has_actions_left(world: &World, single: bool) -> bool {
    if single {
        return true;
    }
    match world.active_character_id().ok().and_then(|id| {
        world
            .characters
            .get(&id)
            .map(|c| (c.actions_this_round, c.actions_per_round))
    }) {
        Some((used, cap)) => used < cap,
        None => true,
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
pub fn rebuild_single(
    snapshot: CampaignSnapshot,
    catalog: Catalog,
) -> (AppTransport, SyncCoordinator) {
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
pub async fn boot_single(
    campaign: &str,
) -> Result<(AppTransport, SyncCoordinator, Catalog), String> {
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
            let transport = AppTransport::Multi(
                WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await?,
            );
            let coord = SyncCoordinator::join(&transport);
            // Project against the campaign's bundled catalog (resolving a hosted `<slug>~<token>`
            // room id to its base) so item aliases, recipes, and other catalog-derived view data
            // render — the server owns authority, but the client owns projection. An unbundled
            // campaign falls back to the empty catalog (unchanged behaviour).
            Ok((transport, coord, bundled_catalog(&cfg.campaign)))
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

    /// A stream that ticks on every server push (another client's committed action, or a presence
    /// change), so a surface can re-sync + re-project reactively — e.g. to show other players' moves
    /// live and flip the "your turn" indicator when the turn reaches you. Single-player has no server,
    /// so its stream is empty (the sender is dropped immediately).
    pub fn push_notifications(&self) -> futures_channel::mpsc::UnboundedReceiver<()> {
        match self {
            AppTransport::Multi(t) => t.push_notifications(),
            AppTransport::Single(_) => futures_channel::mpsc::unbounded().1,
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
    SurfaceInfo {
        id: "crt-terminal",
        label: "CRT Terminal",
        description: "Classic green-screen text adventure.",
    },
    SurfaceInfo {
        id: "point-and-click",
        label: "Point & Click",
        description: "Visual scene with clickable hotspots.",
    },
];

/// Look up a surface's launcher metadata by id.
pub fn surface_info(id: &str) -> Option<&'static SurfaceInfo> {
    SURFACE_INFOS.iter().find(|s| s.id == id)
}

/// Display + surface metadata for one bundled campaign, shown in the launcher menu and carried
/// through to each surface's welcome screen (the `CampaignManifest` passthrough — see [`welcome_for`]).
pub struct CampaignInfo {
    /// `?campaign=` deep-link value and registry key (matches a [`bundled`] id).
    pub slug: &'static str,
    /// Campaign name — the launcher-menu heading and the welcome-screen title.
    pub title: &'static str,
    /// One-line description under the title in the launcher menu.
    pub blurb: &'static str,
    /// Welcome-screen body prose shown before the player enters the campaign.
    pub intro: &'static str,
    /// Welcome start-button label; empty → the default `"Enter <title>"`.
    pub button_text: &'static str,
    /// Surface ids this campaign offers; `surfaces[0]` is the default. ≥ 2 → the picker is shown.
    pub surfaces: &'static [&'static str],
    /// Debug-only: hidden from the launcher menu and not resolvable unless the page has `?debug`
    /// (the demo/conformance campaigns). The shipped campaign (Hollow House) is always visible.
    pub debug: bool,
    /// Multiplayer: selecting it from the menu **hosts a new room** (a unique `<slug>~<token>` id) with
    /// this client as GM, and mounts the join lobby. A single-player campaign launches offline
    /// (`?mode=single`) with no lobby.
    pub multiplayer: bool,
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
            intro: "You wake on cold stone. A vault waits beyond the far door — cross to it and find the way out.",
            button_text: "",
            surfaces: BOTH_SURFACES,
            debug: true,
            multiplayer: true,
        },
        CampaignInfo {
            slug: "caretaker",
            title: "The Caretaker",
            blurb: "A foyer with a watchful NPC and a locked cellar door.",
            intro: "The foyer is still but for the Caretaker's watchful eyes. The cellar door is locked; the way down is not freely given.",
            button_text: "",
            surfaces: BOTH_SURFACES,
            debug: true,
            multiplayer: false,
        },
        CampaignInfo {
            slug: "facade-free-vs-advancing",
            title: "Façade: Free vs. Advancing",
            blurb: "A hall stalked by a lurking mob, with a chest to plunder.",
            intro: "The hall stretches long and watched. Something lurks between you and the chest at its end.",
            button_text: "",
            surfaces: BOTH_SURFACES,
            debug: true,
            multiplayer: false,
        },
        CampaignInfo {
            slug: "status-bar",
            title: "Status Bar",
            blurb: "A bare hall that shows a live Sanity / Round status readout.",
            intro: "A cold stone hall. Watch the status bar — the campaign paints your Sanity and the round as you play.",
            button_text: "",
            surfaces: BOTH_SURFACES,
            debug: true,
            multiplayer: false,
        },
        CampaignInfo {
            slug: "hollow-house",
            title: "The Hollow House",
            blurb: "A nine-room haunted estate. Reach the attic with the journal before the dark takes your mind.",
            intro: "Word came that the last of your kin had died alone in the old estate — and that the house would not give the body back. You arrive at dusk to settle what remains. The Hollow House has been waiting, and it remembers everything. Find the truth it keeps — before the dark finds you first.",
            button_text: "Enter Hollow House",
            surfaces: BOTH_SURFACES,
            debug: false,
            multiplayer: false,
        },
        CampaignInfo {
            slug: "covenant",
            title: "The Covenant",
            blurb: "A co-op multiplayer rite for two to four. The seal only breaks when two of you hold the twin wards at once.",
            intro: "You descend into the sealed sanctum together. An old rite bars the only way out, and it answers to no one alone: one Warden must take the North Ward and another the South, in the same moment, or the way stays shut. Split up. Trust each other. Leave together, or not at all.",
            button_text: "Join the Covenant",
            surfaces: BOTH_SURFACES,
            debug: false,
            multiplayer: true,
        },
    ];
    REGISTRY
}

/// The base campaign of a room id: a multiplayer room is `<slug>~<token>` (a unique per-host session),
/// so `covenant~a5f3` resolves to the `covenant` registry entry. An id with no `~` is its own base.
pub fn base_campaign(id: &str) -> &str {
    id.split('~').next().unwrap_or(id)
}

/// Mint a unique room id for hosting a fresh session of `slug`: `<slug>~<token>`. The token
/// distinguishes concurrent games so separate hosts don't collide; the server maps it back to `slug`.
pub fn mint_room_id(slug: &str) -> String {
    format!("{slug}~{}", random_suffix())
}

/// Resolve a `?campaign=` value to its launcher metadata, or `None` for an absent/unknown one (→ menu).
/// Accepts a room id (`<slug>~<token>`) and resolves it to its base campaign, so a shared/hosted room
/// still shows the right title, surfaces, and welcome.
pub fn resolve_campaign_info(slug: Option<&str>) -> Option<&'static CampaignInfo> {
    let slug = base_campaign(slug?);
    campaign_registry().iter().find(|c| c.slug == slug)
}

/// Whether a campaign is selectable given the debug flag: the shipped campaign always is; debug-only
/// ones require `?debug`.
fn visible(info: &CampaignInfo, debug: bool) -> bool {
    !info.debug || debug
}

/// The campaigns the launcher menu should list, in order: the shipped Hollow House always, plus the
/// debug/conformance campaigns when `?debug` is present.
pub fn menu_campaigns(debug: bool) -> Vec<&'static CampaignInfo> {
    campaign_registry()
        .iter()
        .filter(|c| visible(c, debug))
        .collect()
}

/// A campaign's welcome-screen text — the `CampaignManifest` display passthrough consumed by both
/// surfaces' welcome screens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WelcomeText {
    pub title: String,
    pub intro: String,
    /// Start-button label, already resolved (a campaign's `button_text`, or `"Enter <title>"`).
    pub button: String,
}

/// The welcome text for a campaign id, from the [`campaign_registry`]. The client knows `?campaign=`
/// in both modes, so this carries the manifest's title/intro/button that the multiplayer wire can't.
/// An unknown campaign (e.g. a multiplayer campaign not bundled here) gets a generic fallback.
pub fn welcome_for(campaign: &str) -> WelcomeText {
    match resolve_campaign_info(Some(campaign)) {
        Some(i) => WelcomeText {
            title: i.title.into(),
            intro: i.intro.into(),
            button: if i.button_text.is_empty() {
                format!("Enter {}", i.title)
            } else {
                i.button_text.into()
            },
        },
        None => WelcomeText {
            title: "WICKEDWAYS".into(),
            intro: "A house that does not want to let you leave.".into(),
            button: "Enter".into(),
        },
    }
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
            return LauncherRoute::Surface {
                slug: slug.into(),
                surface: sid.into(),
            };
        }
    }
    if surfaces.len() >= 2 {
        LauncherRoute::Picker { slug: slug.into() }
    } else {
        LauncherRoute::Surface {
            slug: slug.into(),
            surface: surfaces.first().copied().unwrap_or("crt-terminal").into(),
        }
    }
}

/// Resolve the launcher route from the `?campaign=` / `?surface=` params: an absent/unknown campaign
/// — or a debug-only one without `debug` — → [`LauncherRoute::Menu`]; an available campaign follows
/// [`choose`].
pub fn resolve_route(campaign: Option<&str>, surface: Option<&str>, debug: bool) -> LauncherRoute {
    match resolve_campaign_info(campaign) {
        // Route on the ORIGINAL id (a room id `<slug>~<token>` stays intact for the connection); the
        // surfaces/visibility come from its base campaign via `resolve_campaign_info`.
        Some(info) if visible(info, debug) => {
            choose(campaign.unwrap_or(info.slug), info.surfaces, surface)
        }
        _ => LauncherRoute::Menu,
    }
}

/// Read the launcher route from the page URL (`?campaign=` / `?surface=` / `?debug`).
pub fn read_route() -> LauncherRoute {
    resolve_route(
        query_param("campaign").as_deref(),
        query_param("surface").as_deref(),
        debug_enabled(),
    )
}

/// Mutate the current URL's query in place via `history.replaceState` (no reload), applying `f` to a
/// live [`UrlSearchParams`]. Best-effort — silently skips in non-http environments. Shared by
/// [`set_params`] / [`clear_params`].
fn replace_query(f: impl FnOnce(&web_sys::UrlSearchParams)) {
    let Some(win) = web_sys::window() else { return };
    let Ok(href) = win.location().href() else {
        return;
    };
    let Ok(url) = web_sys::Url::new(&href) else {
        return;
    };
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
pub fn intent_to_command(
    world: &World,
    catalog: &Catalog,
    intent: &Intent,
) -> Result<Command, String> {
    let actor = world.active_character_id().map_err(|e| e.0)?;
    match intent {
        Intent::Move { dir } => {
            let room_id = world
                .characters
                .get(&actor)
                .and_then(|c| c.current_room_id.clone())
                .ok_or("you are nowhere")?;
            let room = world.rooms.get(&room_id).ok_or("room not found")?;
            let exit_id = room
                .exits
                .get(dir.as_key())
                .ok_or_else(|| format!("no exit {}", dir.as_key()))?;
            let ex = world.exits.get(exit_id).ok_or("exit not found")?;
            // Gate the move on the exit's keyed-door behavior, the way the single-seat `go` does — the
            // sync `move` (by room id) lands via `move_to`, which performs no door check. A locked
            // door returns its fail message and no command is issued.
            if let Some(reason) = world.exit_block_reason(&actor, *dir, catalog) {
                return Err(reason);
            }
            let dest = if ex.endpoint_ids[0] == room_id {
                ex.endpoint_ids[1].clone()
            } else {
                ex.endpoint_ids[0].clone()
            };
            Ok(Command::Move {
                actor_id: actor,
                room_id: dest,
            })
        }
        Intent::Take { target_id } => Ok(Command::PickUp {
            actor_id: actor,
            item_ids: vec![ItemId(target_id.clone())],
        }),
        Intent::Drop { target_id } => Ok(Command::Drop {
            actor_id: actor,
            item_ids: vec![ItemId(target_id.clone())],
        }),
        Intent::Attack { target_id } => Ok(Command::Attack {
            actor_id: actor,
            target_id: CharacterId(target_id.clone()),
        }),
        Intent::Equip { target_id } => Ok(Command::Equip {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
            slot: None,
        }),
        Intent::Unequip { target_id } => Ok(Command::Unequip {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        Intent::Use { target_id } => Ok(Command::Use {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        // Materials & crafting — all free (turn-gated by authorize, no budget tick).
        Intent::Harvest { target_id } => Ok(Command::Harvest {
            actor_id: actor,
            cache_id: MaterialCacheId(target_id.clone()),
        }),
        Intent::Craft { recipe_id } => Ok(Command::Craft {
            actor_id: actor,
            recipe_id: recipe_id.clone(),
        }),
        Intent::Repair { target_id } => Ok(Command::Repair {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        Intent::Destroy { target_id } => Ok(Command::Destroy {
            actor_id: actor,
            item_id: ItemId(target_id.clone()),
        }),
        // `open` is a local view reveal (list a container's contents) — the surfaces handle it
        // directly against the current view, so it never reaches the sync layer.
        Intent::Open { .. } => Err("(opening is a local view action)".into()),
        Intent::Talk { npc_id, prompt } => Ok(Command::Talk {
            actor_id: actor,
            npc_id: CharacterId(npc_id.clone()),
            prompt: prompt.clone(),
        }),
        // `wait` passes the turn; in single-player the solo authority runs the full turn loop around
        // it (dread + mob reactions + advance), in multiplayer it is a no-op the GM supersedes.
        Intent::Wait => Ok(Command::Wait { actor_id: actor }),
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
    fn the_status_bar_campaign_emits_status_fields_on_begin() {
        // End-to-end through the engine: the g2-status-bar mechanic emits a `Status` cue on the
        // round-start hook (fired by BeginCampaign); it rides the delta's cues and the coordinator
        // absorbs it, so `status_fields()` reflects the campaign's live readout.
        let (snapshot, catalog) = bundled_campaign("status-bar").unwrap();
        assert!(
            !snapshot.campaign.started,
            "status-bar boots pre-started so BeginCampaign fires onRoundStart"
        );
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog);
        assert!(
            coord.status_fields().is_empty(),
            "no status before BeginCampaign"
        );
        let res = coord.submit(&mut transport, Command::BeginCampaign);
        assert!(
            matches!(res, SubmitResult::Committed { .. }),
            "begin should commit, got {res:?}"
        );
        let fields = coord.status_fields();
        assert!(
            fields.iter().any(|f| f.label == "Sanity"),
            "status bar paints Sanity, got {fields:?}"
        );
        assert!(
            fields.iter().any(|f| f.label == "Round"),
            "status bar paints Round, got {fields:?}"
        );
    }

    #[test]
    fn every_bundled_campaign_boots_begins_and_projects() {
        for id in [
            "demo",
            "caretaker",
            "facade-free-vs-advancing",
            "status-bar",
            "hollow-house",
        ] {
            let (snapshot, catalog) = bundled_campaign(id).unwrap_or_else(|e| panic!("{id}: {e}"));
            let started = snapshot.campaign.started;
            let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
            if !started {
                let res = coord.submit(&mut transport, Command::BeginCampaign);
                assert!(
                    matches!(res, SubmitResult::Committed { .. }),
                    "{id}: begin should commit, got {res:?}"
                );
            }
            assert!(
                project(&coord, &catalog).is_some(),
                "{id}: should project a view"
            );
        }
    }

    #[test]
    fn talking_to_the_hollow_house_caretaker_runs_dialogue_and_hands_over_the_key() {
        // The full dialogue chain end-to-end against the real campaign catalog:
        // Intent::Talk → intent_to_command → Command::Talk → authority → world.talk. The caretaker
        // speaks (a mechanic cue), gives the cellar key, and vanishes (setVisible false).
        use wickedways_core::presentation::PresentationCue;
        use wickedways_core::world::intent::Intent;
        use wickedways_core::world::snapshot::CharacterKind;

        let (snapshot, catalog) = bundled_campaign("hollow-house").unwrap();
        let started = snapshot.campaign.started;
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
        if !started {
            assert!(matches!(
                coord.submit(&mut transport, Command::BeginCampaign),
                SubmitResult::Committed { .. }
            ));
        }

        // The caretaker is the campaign's lone NPC, visible before the first talk.
        let caretaker = coord
            .replica()
            .characters
            .iter()
            .find(|(_, c)| c.kind == CharacterKind::Npc)
            .map(|(id, c)| (id.clone(), c.visible))
            .expect("hollow-house seats a caretaker npc");
        assert!(
            caretaker.1,
            "the caretaker is visible before the first talk"
        );

        let intent = Intent::Talk {
            npc_id: caretaker.0 .0.clone(),
            prompt: None,
        };
        let cmd = intent_to_command(coord.replica(), &catalog, &intent)
            .expect("talk maps to a Talk command");
        let res = coord.submit(&mut transport, cmd);
        let SubmitResult::Committed { delta, .. } = res else {
            panic!("talk should commit, got {res:?}");
        };

        // The caretaker speaks: a mechanic cue carries the dialogue response line.
        assert!(
            delta
                .cues
                .iter()
                .any(|c| matches!(c, PresentationCue::Mechanic { .. })),
            "talk emits the caretaker's dialogue as a mechanic cue, got {:?}",
            delta.cues
        );
        // …and its `once` effects fire: the caretaker hands over the key and vanishes.
        let still_visible = coord
            .replica()
            .characters
            .get(&caretaker.0)
            .is_none_or(|c| c.visible);
        assert!(
            !still_visible,
            "the caretaker vanishes after handing over the cellar key"
        );
    }

    #[test]
    fn a_locked_door_blocks_movement_until_the_caretaker_hands_over_the_key() {
        // Keyed doors gate movement client-side (the sync `move` by room id performs no door check).
        // The Foyer's cellar door (south) is locked until the caretaker's dialogue hands over the
        // cellar key — tying the dialogue fix to the door mechanic it exists to serve.
        use wickedways_core::world::direction::Direction;
        use wickedways_core::world::intent::Intent;
        use wickedways_core::world::snapshot::CharacterKind;

        let (snapshot, catalog) = bundled_campaign("hollow-house").unwrap();
        let started = snapshot.campaign.started;
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
        if !started {
            assert!(matches!(
                coord.submit(&mut transport, Command::BeginCampaign),
                SubmitResult::Committed { .. }
            ));
        }

        // The player starts in the Foyer; the cellar door (south) is locked without the key.
        let blocked = intent_to_command(
            coord.replica(),
            &catalog,
            &Intent::Move {
                dir: Direction::South,
            },
        );
        assert!(
            blocked.is_err(),
            "the cellar door is locked without the key, got {blocked:?}"
        );

        // Talk to the caretaker → receive the cellar key.
        let caretaker = coord
            .replica()
            .characters
            .iter()
            .find(|(_, c)| c.kind == CharacterKind::Npc)
            .map(|(id, _)| id.clone())
            .expect("hollow-house seats a caretaker");
        let talk = intent_to_command(
            coord.replica(),
            &catalog,
            &Intent::Talk {
                npc_id: caretaker.0.clone(),
                prompt: None,
            },
        )
        .unwrap();
        assert!(matches!(
            coord.submit(&mut transport, talk),
            SubmitResult::Committed { .. }
        ));

        // With the cellar key in hand, the door is now passable.
        let allowed = intent_to_command(
            coord.replica(),
            &catalog,
            &Intent::Move {
                dir: Direction::South,
            },
        );
        assert!(
            matches!(allowed, Ok(Command::Move { .. })),
            "with the cellar key the door is passable, got {allowed:?}"
        );
    }

    #[test]
    fn a_solo_player_gets_its_full_action_budget_per_turn() {
        // The turn respects `actionsPerRound`: the player takes its whole budget of actions before
        // the turn ends (mobs react, round advances), and dread (onTurnStart) fires once per turn —
        // not once per action. This is the fix for "a player can move unlimited times".
        use wickedways_core::world::direction::Direction;
        use wickedways_core::world::intent::Intent;

        let (snapshot, catalog) = bundled_campaign("hollow-house").unwrap();
        let started = snapshot.campaign.started;
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
        if !started {
            assert!(matches!(
                coord.submit(&mut transport, Command::BeginCampaign),
                SubmitResult::Committed { .. }
            ));
        }
        let pc = coord.replica().active_character_id().unwrap();
        let budget = coord.replica().characters[&pc].actions_per_round; // 3 for the Heir
        assert!(
            budget >= 2,
            "the test needs a multi-action budget, got {budget}"
        );
        let round0 = coord.snapshot().campaign.round;
        let sanity0 = coord.replica().characters[&pc].stats.sanity;

        // Alternate Foyer↔Hall (both open corridors) so exits stay valid. The turn must NOT advance
        // until the budget is spent.
        let dir = |i: i64| {
            if i % 2 == 0 {
                Direction::North
            } else {
                Direction::South
            }
        };
        for i in 0..(budget - 1) {
            let cmd = intent_to_command(coord.replica(), &catalog, &Intent::Move { dir: dir(i) })
                .unwrap();
            assert!(matches!(
                coord.submit(&mut transport, cmd),
                SubmitResult::Committed { .. }
            ));
            assert_eq!(
                coord.snapshot().campaign.round,
                round0,
                "the turn must not advance before the budget is spent (after move {})",
                i + 1
            );
        }
        // The budget-spending move ends the turn → the round advances.
        let cmd = intent_to_command(
            coord.replica(),
            &catalog,
            &Intent::Move {
                dir: dir(budget - 1),
            },
        )
        .unwrap();
        coord.submit(&mut transport, cmd);
        assert_eq!(
            coord.snapshot().campaign.round,
            round0 + 1,
            "the turn advances once the action budget is spent"
        );
        // Dread fired exactly once this turn, not once per action.
        assert_eq!(
            coord.replica().characters[&pc].stats.sanity,
            sanity0 - 1.0,
            "dread drains once per turn, not per action"
        );
    }

    #[test]
    fn a_solo_wait_advances_the_round_and_drains_dread_in_hollow_house() {
        // The single-player turn loop over the offline transport: `wait` passes the turn, and the
        // solo authority runs start_turn (dread drains sanity) → next_player (round advances). This
        // is the machinery the multiplayer sync path skips — solo mode supplies it locally.
        use wickedways_core::world::intent::Intent;

        let (snapshot, catalog) = bundled_campaign("hollow-house").unwrap();
        let started = snapshot.campaign.started;
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
        if !started {
            assert!(matches!(
                coord.submit(&mut transport, Command::BeginCampaign),
                SubmitResult::Committed { .. }
            ));
        }

        let pc = coord
            .replica()
            .active_character_id()
            .expect("a started campaign has an active seat");
        let round_before = coord.snapshot().campaign.round;
        let sanity_before = coord
            .replica()
            .characters
            .get(&pc)
            .map(|c| c.stats.sanity)
            .unwrap();

        let cmd = intent_to_command(coord.replica(), &catalog, &Intent::Wait)
            .expect("wait maps to a command");
        let res = coord.submit(&mut transport, cmd);
        assert!(
            matches!(res, SubmitResult::Committed { .. }),
            "solo wait commits, got {res:?}"
        );

        let round_after = coord.snapshot().campaign.round;
        let sanity_after = coord
            .replica()
            .characters
            .get(&pc)
            .map(|c| c.stats.sanity)
            .unwrap();
        assert_eq!(
            round_after,
            round_before + 1,
            "a solo wait advances the round"
        );
        assert!(
            sanity_after < sanity_before,
            "dread drains sanity on turn start (was {sanity_before}, now {sanity_after})"
        );
    }

    #[test]
    fn undo_rebuilds_the_authority_from_the_captured_pre_command_snapshot() {
        // The surfaces stash `coord.snapshot()` before each committed command and, on `undo`, rebuild
        // the offline authority from it (via `rebuild_single`). This proves that round-trip reverts a
        // real committed change: a solo wait drains dread, and rebuilding from the pre-wait snapshot
        // restores the sanity and round.
        use wickedways_core::world::intent::Intent;

        let (snapshot, catalog) = bundled_campaign("hollow-house").unwrap();
        let started = snapshot.campaign.started;
        let (mut transport, mut coord) = rebuild_single(snapshot, catalog.clone());
        if !started {
            assert!(matches!(
                coord.submit(&mut transport, Command::BeginCampaign),
                SubmitResult::Committed { .. }
            ));
        }
        let pc = coord.replica().active_character_id().unwrap();
        let before = coord.snapshot(); // the undo point
        let sanity_before = coord.replica().characters[&pc].stats.sanity;
        let round_before = coord.snapshot().campaign.round;

        // A committed action moves the state forward.
        let cmd = intent_to_command(coord.replica(), &catalog, &Intent::Wait).unwrap();
        assert!(matches!(
            coord.submit(&mut transport, cmd),
            SubmitResult::Committed { .. }
        ));
        assert!(
            coord.replica().characters[&pc].stats.sanity < sanity_before,
            "the wait advanced state"
        );

        // Undo: rebuild from the captured snapshot restores the pre-command state exactly.
        let (_t, reverted) = rebuild_single(before, catalog.clone());
        assert_eq!(
            reverted.replica().characters[&pc].stats.sanity,
            sanity_before,
            "undo restores sanity"
        );
        assert_eq!(
            reverted.snapshot().campaign.round,
            round_before,
            "undo restores the round"
        );
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
            assert!(
                bundled(c.slug).is_some(),
                "{}: registry slug must be a bundled campaign",
                c.slug
            );
            assert!(
                !c.surfaces.is_empty(),
                "{}: must offer at least one surface",
                c.slug
            );
            for sid in c.surfaces {
                assert!(
                    surface_info(sid).is_some(),
                    "{}: surface '{sid}' must have metadata",
                    c.slug
                );
            }
        }
    }

    #[test]
    fn is_my_turn_tracks_the_active_seat() {
        let (mut snap, _) = bundled_campaign("covenant").unwrap();
        // Not started → never your turn.
        assert!(!is_my_turn(&snap, "gm", true, false));
        // Started; active seat 0 is the GM host (the campaign's gmId character).
        snap.campaign.started = true;
        snap.campaign.active_character_index = 0;
        assert!(
            is_my_turn(&snap, "gm", true, false),
            "the GM's turn when its own seat is active"
        );
        assert!(
            !is_my_turn(&snap, "player-x", false, false),
            "not a joiner's turn while the GM seat is active"
        );
        // Single-player drives every seat → always your turn once started.
        assert!(is_my_turn(&snap, "whatever", true, true));
    }

    #[test]
    fn a_room_id_resolves_to_its_base_campaign_but_keeps_the_room_in_the_route() {
        // A hosted/shared room id `<slug>~<token>` resolves to its base campaign's metadata…
        assert_eq!(base_campaign("covenant~a5f3"), "covenant");
        assert_eq!(
            resolve_campaign_info(Some("covenant~a5f3")).map(|c| c.slug),
            Some("covenant")
        );
        // …while the route keeps the FULL room id so the connection targets that specific room.
        assert_eq!(
            resolve_route(Some("covenant~a5f3"), Some("crt-terminal"), false),
            LauncherRoute::Surface {
                slug: "covenant~a5f3".into(),
                surface: "crt-terminal".into()
            }
        );
        // A room id with two surfaces and none chosen still routes to the picker (keeping the room id).
        assert_eq!(
            resolve_route(Some("covenant~a5f3"), None, false),
            LauncherRoute::Picker {
                slug: "covenant~a5f3".into()
            }
        );
        // An unknown base still falls back to the menu.
        assert_eq!(
            resolve_route(Some("nope~x"), None, false),
            LauncherRoute::Menu
        );
    }

    #[test]
    fn resolve_route_shows_the_menu_for_an_absent_or_unknown_campaign() {
        assert_eq!(resolve_route(None, None, false), LauncherRoute::Menu);
        assert_eq!(
            resolve_route(Some("no-such-campaign"), None, false),
            LauncherRoute::Menu
        );
        // A dangling `?surface=` without a campaign is still the menu.
        assert_eq!(
            resolve_route(None, Some("crt-terminal"), false),
            LauncherRoute::Menu
        );
    }

    #[test]
    fn the_menu_lists_the_shipped_campaigns_and_debug_adds_the_rest() {
        // The default menu shows the shipped campaigns: Hollow House (single-player) and The Covenant
        // (multiplayer). The demo/conformance campaigns stay behind `?debug`.
        let shipped: Vec<_> = menu_campaigns(false).iter().map(|c| c.slug).collect();
        assert_eq!(
            shipped,
            vec!["hollow-house", "covenant"],
            "default menu shows the shipped campaigns"
        );
        assert_eq!(
            menu_campaigns(true).len(),
            campaign_registry().len(),
            "?debug shows every campaign"
        );
        assert!(
            menu_campaigns(true).iter().any(|c| c.slug == "demo"),
            "?debug includes the demo campaigns"
        );
    }

    #[test]
    fn resolve_route_gates_debug_only_campaigns_behind_the_debug_flag() {
        // The shipped campaign is always available.
        assert_eq!(
            resolve_route(Some("hollow-house"), None, false),
            LauncherRoute::Picker {
                slug: "hollow-house".into()
            }
        );
        // A debug-only campaign is hidden (→ menu) without `?debug`, even with a valid surface…
        assert_eq!(
            resolve_route(Some("demo"), Some("crt-terminal"), false),
            LauncherRoute::Menu
        );
        assert_eq!(
            resolve_route(Some("demo"), None, false),
            LauncherRoute::Menu
        );
        // …and available with it.
        assert_eq!(
            resolve_route(Some("demo"), None, true),
            LauncherRoute::Picker {
                slug: "demo".into()
            }
        );
        assert_eq!(
            resolve_route(Some("demo"), Some("crt-terminal"), true),
            LauncherRoute::Surface {
                slug: "demo".into(),
                surface: "crt-terminal".into()
            }
        );
    }

    #[test]
    fn resolve_route_deep_links_a_valid_surface_and_pickers_otherwise() {
        // A known, available campaign + valid surface mounts directly.
        assert_eq!(
            resolve_route(Some("hollow-house"), Some("point-and-click"), false),
            LauncherRoute::Surface {
                slug: "hollow-house".into(),
                surface: "point-and-click".into()
            }
        );
        // Available campaign, no surface → picker (every bundled campaign offers ≥ 2).
        assert_eq!(
            resolve_route(Some("hollow-house"), None, false),
            LauncherRoute::Picker {
                slug: "hollow-house".into()
            }
        );
        // An invalid surface id is ignored → picker (not a bogus mount).
        assert_eq!(
            resolve_route(Some("hollow-house"), Some("hologram"), false),
            LauncherRoute::Picker {
                slug: "hollow-house".into()
            }
        );
    }

    #[test]
    fn welcome_text_comes_from_the_registry_with_a_default_button_and_a_generic_fallback() {
        // A registered campaign carries its title + intro; an empty button_text → "Enter <title>".
        let demo = welcome_for("demo");
        assert_eq!(demo.title, "The Crypt");
        assert!(
            !demo.intro.is_empty(),
            "intro should be the campaign's prose"
        );
        assert_eq!(demo.button, "Enter The Crypt");
        // An unknown campaign (e.g. a multiplayer one not bundled here) → the generic welcome.
        let unknown = welcome_for("some-server-campaign");
        assert_eq!(unknown.title, "WICKEDWAYS");
        assert_eq!(unknown.button, "Enter");
    }

    #[test]
    fn choose_mounts_directly_when_only_one_surface_is_offered() {
        // The <2-surface branch (no bundled campaign exercises it, so test `choose` directly).
        assert_eq!(
            choose("solo", &["crt-terminal"], None),
            LauncherRoute::Surface {
                slug: "solo".into(),
                surface: "crt-terminal".into()
            }
        );
        // A single-surface campaign with no surfaces at all still yields a safe default.
        assert_eq!(
            choose("empty", &[], None),
            LauncherRoute::Surface {
                slug: "empty".into(),
                surface: "crt-terminal".into()
            }
        );
    }
}
