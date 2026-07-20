//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — the CRT game shell (slice 2).
//!
//! Drives the multiplayer loop against the C axum server (slice 1) and renders the **real
//! [`ViewModel`]** the engine projects from the replica: the room, its exits and locked doors, the
//! occupants, the player's inventory, and the turn/health/sanity HUD. The ViewModel is built by
//! [`World::view`] on the `SyncCoordinator`'s replica after every commit, so what the terminal shows
//! is exactly what the authority sees. The full CRT surface (parser → intents, narrator, SVG map)
//! layers on in the next slices; this slice lands the game *view* at structural parity.
//!
//! Connection is configured from the page URL query (`?ws=…&campaign=…&token=…`).
//!
//! [`ViewModel`]: wickedways_core::world::view::ViewModel
//! [`World::view`]: wickedways_core::World::view

use std::collections::BTreeSet;

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::view::ViewModel;
use wickedways_web::transport::WsTransport;

const CRT_CSS: &str = include_str!("../assets/crt.css");
const THEME_VARS: &str = "--color-bg:#0b0e0a; --color-text:#9be89b; --color-accent:#d7ffd7; \
    --font-body:'VT323',monospace; --base-size:26px; --crt-scanline:0.35; \
    --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;";

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

/// Projects the active character's ViewModel from a coordinator's replica (empty catalog + no opened
/// loot for now — the demo has no items; catalog fetch + loot tracking are later slices).
fn project(coord: &SyncCoordinator) -> Option<ViewModel> {
    coord.replica().view(&Catalog::default(), &BTreeSet::new()).ok()
}

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    let mut log = use_signal(Vec::<String>::new);

    let submitter = use_coroutine(move |mut rx: UnboundedReceiver<()>| async move {
        let cfg = read_config();
        log.write().push(format!("→ {}  [{}]", cfg.ws, cfg.campaign));
        match WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await {
            Err(e) => {
                status.set("error".into());
                log.write().push(format!("connect failed: {e}"));
            }
            Ok(transport) => {
                let coord = SyncCoordinator::join(&transport);
                status.set("connected".into());
                vm.set(project(&coord));
                let mut coord = coord;
                while (rx.next().await).is_some() {
                    match transport.submit_async(Command::NextPlayer).await {
                        SubmitResult::Committed { seq, .. } => {
                            coord.sync(&transport);
                            vm.set(project(&coord));
                            status.set(format!("committed seq {seq}"));
                        }
                        SubmitResult::Denied { reason } => {
                            status.set("denied".into());
                            log.write().push(format!("denied: {reason}"));
                        }
                    }
                }
            }
        }
    });

    let screen = match vm() {
        Some(v) => game_view(v),
        None => rsx! {
            div { class: "line system", "WICKEDWAYS" }
            div { class: "line", "status: {status}" }
            for (i, entry) in log().iter().enumerate() {
                div { key: "{i}", class: "line", "{entry}" }
            }
        },
    };

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{THEME_VARS}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        div { class: "transcript", {screen} }
                        div { class: "controls",
                            button { id: "submit", onclick: move |_| submitter.send(()), "GM: nextPlayer" }
                        }
                    }
                    div { class: "crt-overlay" }
                }
            }
        }
    }
}

/// Renders the engine's `ViewModel` as the CRT game view — HUD, room, exits, occupants, inventory.
fn game_view(v: ViewModel) -> Element {
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
                        span { key: "{e.dir.as_key()}", class: "chip",
                            "{e.dir.as_key()} → {e.to_name}"
                        }
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
                                span { key: "{k.id}", class: "chip", "{k.name} ",
                                    span { class: "meta", "(key)" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
