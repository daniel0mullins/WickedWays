//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — the CRT game shell (slice 2).
//!
//! Drives the multiplayer loop against the C axum server (slice 1), renders the real engine
//! [`ViewModel`] the core projects from the replica (slice 2a), and now takes typed commands through
//! the ported [`parse`](wickedways_web::parser::parse)r (slice 2b): the prompt turns a line of input
//! into an [`Intent`], which the shell resolves into a sync `Command` (a `move`'s direction becomes
//! the destination room id via the replica's exit graph) and submits; informational queries
//! (look/exits/inventory/help) render locally against the current view. The narrator (cue → prose)
//! and the SVG map are later slices.
//!
//! Connection is configured from the page URL query (`?ws=…&campaign=…&token=…`).
//!
//! [`ViewModel`]: wickedways_core::world::view::ViewModel
//! [`Intent`]: wickedways_core::world::intent::Intent

use std::collections::BTreeSet;

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;
use wickedways_core::World;
use wickedways_web::parser::{parse, ParseResult, Query};
use wickedways_web::transport::WsTransport;

const CRT_CSS: &str = include_str!("../assets/crt.css");
const THEME_VARS: &str = "--color-bg:#0b0e0a; --color-text:#9be89b; --color-accent:#d7ffd7; \
    --font-body:'VT323',monospace; --base-size:26px; --crt-scanline:0.35; \
    --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;";

/// A driver request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum Action {
    NextPlayer,
    Input(String),
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
fn intent_to_command(world: &World, intent: Intent) -> Result<Command, String> {
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
        Intent::Take { target_id } => Ok(Command::PickUp { actor_id: actor, item_ids: vec![ItemId(target_id)] }),
        Intent::Drop { target_id } => Ok(Command::Drop { actor_id: actor, item_ids: vec![ItemId(target_id)] }),
        Intent::Attack { target_id } => Ok(Command::Attack { actor_id: actor, target_id: CharacterId(target_id) }),
        Intent::Equip { target_id } => Ok(Command::Equip { actor_id: actor, item_id: ItemId(target_id), slot: None }),
        Intent::Unequip { target_id } => Ok(Command::Unequip { actor_id: actor, item_id: ItemId(target_id) }),
        Intent::Use { target_id } => Ok(Command::Use { actor_id: actor, item_id: ItemId(target_id) }),
        Intent::Open { .. } => Err("(opening is a local view action — not yet wired)".into()),
        Intent::Talk { .. } => Err("(dialogue is a later slice)".into()),
        Intent::Wait => Err("(wait is not yet wired)".into()),
    }
}

/// Renders an informational query against the current view as a narration line.
fn narrate_query(q: Query, v: &ViewModel) -> String {
    match q {
        Query::Look => format!("{} — {}", v.room.name, v.room.description),
        Query::Exits => {
            if v.exits.is_empty() {
                "No obvious exits.".into()
            } else {
                let list = v.exits.iter().map(|e| format!("{} → {}", e.dir.as_key(), e.to_name)).collect::<Vec<_>>();
                format!("Exits: {}", list.join(", "))
            }
        }
        Query::Inventory => {
            let names: Vec<String> = v.inventory.items.iter().chain(v.inventory.keys.iter()).map(|e| e.name.clone()).collect();
            if names.is_empty() {
                "You carry nothing.".into()
            } else {
                format!("Carrying: {}", names.join(", "))
            }
        }
        Query::Help => "Try: look · exits · inventory · a direction (north/n) · take/attack/use <thing>.".into(),
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
                vm.set(project(&coord));
                while let Some(action) = rx.next().await {
                    let command = match action {
                        Action::NextPlayer => Some(Command::NextPlayer),
                        Action::Input(text) => {
                            let view = project(&coord);
                            let scope = view.as_ref().map(|v| v.scope.as_slice()).unwrap_or(&[]);
                            match parse(&text, scope) {
                                ParseResult::Query(q) => {
                                    if let Some(v) = &view {
                                        narration.write().push(narrate_query(q, v));
                                    }
                                    None
                                }
                                ParseResult::Intent(intent) => match intent_to_command(coord.replica(), intent) {
                                    Ok(cmd) => Some(cmd),
                                    Err(note) => {
                                        narration.write().push(note);
                                        None
                                    }
                                },
                                ParseResult::Examine(t) => {
                                    narration.write().push(format!("You look at the {}.", t.name));
                                    None
                                }
                                ParseResult::Ambiguous(cands) => {
                                    let names = cands.iter().map(|e| e.name.clone()).collect::<Vec<_>>().join(", ");
                                    narration.write().push(format!("Which do you mean: {names}?"));
                                    None
                                }
                                ParseResult::Meta(_) => {
                                    narration.write().push("(that's not available here yet)".into());
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
                                vm.set(project(&coord));
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
