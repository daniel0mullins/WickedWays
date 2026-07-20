//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — the slice-1 multiplayer shell.
//!
//! A bare shell that drives the real multiplayer loop end-to-end against the C axum server: on mount
//! it opens a [`WsTransport`](wickedways_web::transport::WsTransport), seeds a
//! [`SyncCoordinator`](wickedways_core::sync::SyncCoordinator) from the handshake snapshot, and lets
//! the GM submit `nextPlayer` — applying the server's authoritative delta to the local replica and
//! showing the head advance. The CRT housing CSS from slice 0 is reused so the shell looks like the
//! terminal it will become; the full CRT surface (parser/narrator/map) is slice 2.
//!
//! Connection is configured from the page URL query (`?ws=…&campaign=…&token=…`) so the e2e can point
//! it at a live server; sensible localhost defaults otherwise.

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator, SyncTransport};
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

/// Reads `?ws=&campaign=&token=` from the page URL, with localhost defaults.
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

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut head = use_signal(|| 0u64);
    let mut log = use_signal(Vec::<String>::new);

    // The driver coroutine owns the (non-Send, Rc-backed) transport + coordinator and talks to the UI
    // only through signals; the button sends a unit message to request a submit.
    let submitter = use_coroutine(move |mut rx: UnboundedReceiver<()>| async move {
        let cfg = read_config();
        log.write().push(format!("→ {}  [{}]", cfg.ws, cfg.campaign));
        match WsTransport::connect(&cfg.ws, &cfg.campaign, &cfg.token).await {
            Err(e) => {
                status.set("error".into());
                log.write().push(format!("connect failed: {e}"));
            }
            Ok(transport) => {
                let mut coord = SyncCoordinator::join(&transport);
                status.set("connected".into());
                head.set(transport.head());
                log.write().push(format!(
                    "joined at head {} — {} characters in the replica",
                    transport.head(),
                    coord.replica().characters.len()
                ));
                while (rx.next().await).is_some() {
                    match transport.submit_async(Command::NextPlayer).await {
                        SubmitResult::Committed { seq, .. } => {
                            coord.sync(&transport);
                            head.set(transport.head());
                            status.set(format!("committed seq {seq}"));
                            log.write().push(format!("GM » nextPlayer committed → seq {seq}"));
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

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{THEME_VARS}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        div { class: "transcript",
                            div { class: "line system", "WICKEDWAYS — multiplayer shell (D slice 1)" }
                            div { class: "line", "status: {status}  ·  head: {head}" }
                            for (i, entry) in log().iter().enumerate() {
                                div { key: "{i}", class: "line", "{entry}" }
                            }
                        }
                        div { class: "controls",
                            button {
                                id: "submit",
                                onclick: move |_| submitter.send(()),
                                "GM: nextPlayer"
                            }
                        }
                    }
                    div { class: "crt-overlay" }
                }
            }
        }
    }
}
