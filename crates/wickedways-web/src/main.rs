//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — the CRT game shell (slice 2).
//!
//! Drives the multiplayer loop against the C axum server (slice 1), renders the real engine
//! [`ViewModel`] the core projects from the replica (slice 2a), and takes typed commands through the
//! ported [`parse`](wickedways_web::parser::parse)r (slice 2b): the prompt turns a line of input into
//! an [`Intent`], which the shell resolves into a sync `Command` (a `move`'s direction becomes the
//! destination room id via the replica's exit graph) and submits; informational queries
//! (look/exits/inventory/help) render locally against the current view. This slice adds the
//! [`Narrator`] (cue/query/intent → prose) and the shared [`MapModel`]/SVG map: room entry and action
//! confirmations print through the narrator, `map` opens an explored-map overlay, and `help` opens a
//! command-list overlay (mirroring `crt-game.ts`'s `openMap`/`openHelp`).
//!
//! Connection is configured from the page URL query (`?ws=…&campaign=…&token=…`).
//!
//! [`ViewModel`]: wickedways_core::world::view::ViewModel
//! [`Intent`]: wickedways_core::world::intent::Intent
//! [`Narrator`]: wickedways_web::narrator::Narrator
//! [`MapModel`]: wickedways_web::map::MapModel

use std::collections::BTreeSet;

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::World;
use wickedways_web::map::{layout_map, map_svg, MapModel};
use wickedways_web::narrator::Narrator;
use wickedways_web::parser::{parse, Meta, ParseResult, Query};
use wickedways_web::transport::WsTransport;

const CRT_CSS: &str = include_str!("../assets/crt.css");
const THEME_VARS: &str = "--color-bg:#0b0e0a; --color-text:#9be89b; --color-accent:#d7ffd7; \
    --color-muted:#8a8f80; --color-border:#2a281f; --color-chip-bg:#25241d; --color-error:#e86b6b; \
    --font-body:'VT323',monospace; --base-size:26px; --crt-scanline:0.35; \
    --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;";

/// A driver request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum Action {
    NextPlayer,
    Input(String),
}

/// The one-at-a-time overlay (map or help), mirroring `crt-game.ts`'s `openMap`/`openHelp`.
#[derive(Clone, Debug, PartialEq)]
enum Overlay {
    None,
    Help(Vec<String>),
    Map,
}

struct Config {
    ws: String,
    campaign: String,
    token: String,
}

fn read_config() -> Config {
    let params = web_sys::window()
        .and_then(|w| w.location().search().ok())
        .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok());
    let get = |k: &str, default: &str| {
        params.as_ref().and_then(|p| p.get(k)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.into())
    };
    Config {
        ws: get("ws", "ws://127.0.0.1:9000/ws"),
        campaign: get("campaign", "demo"),
        token: get("token", "gm"),
    }
}

fn project(coord: &SyncCoordinator) -> Option<ViewModel> {
    coord.replica().view(&Catalog::default(), &BTreeSet::new()).ok()
}

/// Resolves a parser [`Intent`] into a sync [`Command`] against the replica — the key step is a
/// `move`, whose compass direction becomes the destination room id via the active character's room
/// and the exit graph. Intents with no sync command (open/talk/wait) return a note.
fn intent_to_command(world: &World, intent: &Intent) -> Result<Command, String> {
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

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    let mut narration = use_signal(Vec::<String>::new);
    let mut draft = use_signal(String::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    let mut overlay = use_signal(|| Overlay::None);

    let driver = use_coroutine(move |mut rx: UnboundedReceiver<Action>| async move {
        let cfg = read_config();
        match WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await {
            Err(e) => {
                status.set("error".into());
                narration.write().push(format!("connect failed: {e}"));
            }
            Ok(transport) => {
                let mut coord = SyncCoordinator::join(&transport);
                status.set("connected".into());
                let initial = project(&coord);
                if let Some(v) = &initial {
                    map_model.write().observe(v);
                    narration.write().extend(narrator.write().render_room(v));
                }
                vm.set(initial);

                while let Some(action) = rx.next().await {
                    let mut intent_for_narration: Option<Intent> = None;
                    let mut before_view: Option<ViewModel> = None;
                    let command = match action {
                        Action::NextPlayer => Some(Command::NextPlayer),
                        Action::Input(text) => {
                            let view = project(&coord);
                            before_view = view.clone();
                            let scope = view.as_ref().map(|v| v.scope.as_slice()).unwrap_or(&[]);
                            match parse(&text, scope) {
                                ParseResult::Query(q) => {
                                    if let Some(v) = &view {
                                        if matches!(q, Query::Help) {
                                            let rows = narrator.write().render_query(q, v);
                                            overlay.set(Overlay::Help(rows));
                                        } else {
                                            let lines = narrator.write().render_query(q, v);
                                            narration.write().extend(lines);
                                        }
                                    }
                                    None
                                }
                                ParseResult::Intent(intent) => match intent_to_command(coord.replica(), &intent) {
                                    Ok(cmd) => {
                                        intent_for_narration = Some(intent);
                                        Some(cmd)
                                    }
                                    Err(note) => {
                                        narration.write().push(note);
                                        None
                                    }
                                },
                                ParseResult::Examine(t) => {
                                    let lines = narrator.write().render_examine(&t);
                                    narration.write().extend(lines);
                                    None
                                }
                                ParseResult::Ambiguous(cands) => {
                                    let names = cands.iter().map(|e| e.name.clone()).collect::<Vec<_>>().join(", ");
                                    narration.write().push(format!("Which do you mean: {names}?"));
                                    None
                                }
                                ParseResult::Meta(meta) => {
                                    match meta {
                                        Meta::Map => overlay.set(Overlay::Map),
                                        _ => narration.write().push("(that's not available here yet)".into()),
                                    }
                                    None
                                }
                                ParseResult::Error(msg) => {
                                    narration.write().push(msg);
                                    None
                                }
                            }
                        }
                    };
                    if let Some(cmd) = command {
                        match transport.submit_async(cmd).await {
                            SubmitResult::Committed { seq, .. } => {
                                coord.sync(&transport);
                                let after = project(&coord);
                                // A move must be recorded BEFORE `observe`: `record_move` places the
                                // newly-entered room relative to the one we left and adds the
                                // traversed edge, whereas `observe` seeds any unseen room at the
                                // grid origin and (relying on that edge) suppresses the back-stub.
                                // Observe-first would pin every new room at (0,0) and keep a
                                // spurious `?` stub pointing back the way the player came.
                                if let (Some(Intent::Move { dir }), Some(b), Some(a)) =
                                    (&intent_for_narration, &before_view, &after)
                                {
                                    map_model.write().record_move(&b.room.id, *dir, &a.room.id);
                                }
                                if let Some(a) = &after {
                                    map_model.write().observe(a);
                                }
                                if let (Some(intent), Some(b), Some(a)) = (intent_for_narration, &before_view, &after) {
                                    let action_lines = narrator.write().render_action(&intent, b, a);
                                    narration.write().extend(action_lines);
                                    if matches!(intent, Intent::Move { .. }) {
                                        let room_lines = narrator.write().render_room(a);
                                        narration.write().extend(room_lines);
                                    }
                                }
                                vm.set(after);
                                status.set(format!("committed seq {seq}"));
                            }
                            SubmitResult::Denied { reason } => {
                                narration.write().push(format!("✗ {reason}"));
                            }
                        }
                    }
                }
            }
        }
    });

    let screen = match vm() {
        Some(v) => game_view(v, narration),
        None => rsx! {
            div { class: "line system", "WICKEDWAYS" }
            div { class: "line", "status: {status}" }
        },
    };

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{THEME_VARS}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        div { class: "transcript", {screen} }
                        div { class: "prompt",
                            span { class: "caret", "›" }
                            input {
                                id: "prompt",
                                value: "{draft}",
                                oninput: move |e| draft.set(e.value()),
                                onkeydown: move |e| if e.key() == Key::Enter {
                                    let text = draft.read().trim().to_string();
                                    if !text.is_empty() {
                                        narration.write().push(format!("› {text}"));
                                        driver.send(Action::Input(text));
                                        draft.set(String::new());
                                    }
                                },
                            }
                        }
                        div { class: "controls",
                            button { id: "submit", onclick: move |_| driver.send(Action::NextPlayer), "GM: nextPlayer" }
                        }
                    }
                    div { class: "crt-overlay" }
                }
            }
        }
        if overlay() != Overlay::None {
            div { class: "overlay", onclick: move |_| overlay.set(Overlay::None),
                // Clicks on the framed content don't dismiss (only the backdrop does) — matches the
                // `.overlay-frame { cursor: default }` affordance and `crt-game.ts`, where frame
                // clicks never close the overlay.
                div { class: "overlay-frame", onclick: move |e| e.stop_propagation(),
                    match overlay() {
                        Overlay::Help(rows) => rsx! {
                            div { class: "help-list",
                                for (i, row) in rows.iter().enumerate() {
                                    div { key: "help-{i}", class: "help-row", "{row}" }
                                }
                            }
                        },
                        Overlay::Map => rsx! { {map_svg(&layout_map(&map_model.read()))} },
                        Overlay::None => rsx! {},
                    }
                }
                div { class: "overlay-legend",
                    if overlay() == Overlay::Map {
                        "─ open   ╌ locked   ? unexplored   ✕ remains   ▣ here   ·   click to close"
                    } else {
                        "click to close"
                    }
                }
            }
        }
    }
}

/// Renders the engine's `ViewModel` as the CRT game view — HUD, room, exits, occupants, inventory,
/// plus the running narration log.
fn game_view(v: ViewModel, narration: Signal<Vec<String>>) -> Element {
    let s = &v.status;
    rsx! {
        div { class: "hud",
            span { "{s.location_name}" }
            span { class: "sep", "·" }
            span { "turn {s.turn}/{s.max_turns}" }
            span { class: "sep", "·" }
            span { "HP {s.health}" }
            span { class: "sep", "·" }
            span { "SAN {s.sanity}" }
        }
        div { class: "room-name", "{v.room.name}" }
        div {
            class: if v.room.is_lit { "room-desc" } else { "room-desc dark" },
            if v.room.is_lit { "{v.room.description}" } else { "It is too dark to see." }
        }

        if !v.exits.is_empty() || !v.locked_doors.is_empty() {
            div { class: "section",
                div { class: "section-label", "Exits" }
                div { class: "chips",
                    for e in v.exits.iter() {
                        span { key: "{e.dir.as_key()}", class: "chip", "{e.dir.as_key()} → {e.to_name}" }
                    }
                    for d in v.locked_doors.iter() {
                        span { key: "locked-{d.dir.as_key()}", class: "chip",
                            "{d.dir.as_key()} → {d.name} "
                            span { class: "meta", "(locked)" }
                        }
                    }
                }
            }
        }

        if !v.occupants.is_empty() {
            div { class: "section",
                div { class: "section-label", "Here" }
                div { class: "chips",
                    for o in v.occupants.iter() {
                        span {
                            key: "{o.id}",
                            class: if o.defeated == Some(true) { "chip defeated" } else { "chip" },
                            "{o.name}"
                            if let Some(h) = o.health {
                                span { class: "meta", " ({h} hp)" }
                            }
                        }
                    }
                }
            }
        }

        {
            let inv = &v.inventory;
            let empty = inv.items.is_empty() && inv.keys.is_empty();
            rsx! {
                div { class: "section",
                    div { class: "section-label", "Inventory ({inv.items.len() + inv.keys.len()}/{inv.slots})" }
                    if empty {
                        div { class: "chip meta", "empty" }
                    } else {
                        div { class: "chips",
                            for it in inv.items.iter() {
                                span { key: "{it.id}", class: "chip", "{it.name}" }
                            }
                            for k in inv.keys.iter() {
                                span { key: "{k.id}", class: "chip", "{k.name} ", span { class: "meta", "(key)" } }
                            }
                        }
                    }
                }
            }
        }

        if !narration().is_empty() {
            div { class: "section narration",
                for (i, line) in narration().iter().enumerate() {
                    div { key: "n{i}", class: "line", "{line}" }
                }
            }
        }
    }
}
