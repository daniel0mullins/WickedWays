//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — slice-0 spike.
//!
//! This is the program-mandated **CSS-carryover spike** plus the crate skeleton. It is deliberately
//! small and proves the three things D's toolchain hinges on, before any real surface work:
//!
//! 1. **A Dioxus app compiles to `wasm32-unknown-unknown`** in this environment (verified).
//! 2. **Campaign CRT theming carries from Lit to RSX** — the housing/monitor/screen/scanline CSS from
//!    `packages/play-surface/src/crt` rides on CSS custom properties set on the root, so swapping the
//!    theme (the button below) reskins the terminal with no framework-specific machinery.
//! 3. **`wickedways-core` links directly and runs on wasm** — the "GM: nextPlayer" button builds a
//!    real [`Command`](wickedways_core::sync::Command) and serializes it with `serde_json`, all native
//!    Rust in the browser (no wasm-pack/JS boundary).
//!
//! The real transport (`WebSocketTransport` → `SyncCoordinator`) and the full CRT/PnC surfaces land in
//! slices 1-5. This file is a spike: throwaway once slice 2 renders the CRT surface for real.

use dioxus::prelude::*;
use wickedways_core::sync::Command;

const CRT_CSS: &str = include_str!("../assets/crt.css");

/// A campaign theme = a set of CSS custom properties applied to the housing root. Two presets here
/// stand in for campaign-owned themes; the carryover claim is that swapping these reskins everything.
struct Theme {
    label: &'static str,
    vars: &'static str,
}

const THEMES: &[Theme] = &[
    Theme {
        label: "Phosphor",
        vars: "--color-bg:#0b0e0a; --color-text:#9be89b; --color-accent:#d7ffd7; \
               --font-body:'VT323',monospace; --base-size:26px; --crt-scanline:0.35; \
               --plastic:#c9c4b4; --plastic-light:#e6e1d2; --plastic-dark:#8f8b7d; --plastic-shadow:#5f5c52;",
    },
    Theme {
        label: "Amber",
        vars: "--color-bg:#160f04; --color-text:#f0b552; --color-accent:#ffd591; \
               --font-body:'VT323',monospace; --base-size:26px; --crt-scanline:0.28; \
               --plastic:#b8b0a0; --plastic-light:#d8d2c2; --plastic-dark:#837d6f; --plastic-shadow:#524e45;",
    },
];

fn main() {
    dioxus::launch(app);
}

fn app() -> Element {
    let mut theme = use_signal(|| 0usize);
    let mut lines = use_signal(|| {
        vec![
            (true, "WICKEDWAYS TERMINAL — Dioxus CRT spike".to_string()),
            (false, "The glass, the scanlines, and the type are all CSS custom properties.".to_string()),
            (false, "Type below, toggle the theme, or emit a GM command.".to_string()),
        ]
    });
    let mut draft = use_signal(String::new);

    // The engine, on wasm: build a real sync Command and serialize it.
    let emit_next_player = move |_| {
        let cmd = Command::NextPlayer;
        let json = serde_json::to_string(&cmd).unwrap_or_else(|_| "<serialize error>".into());
        lines.write().push((true, format!("GM » {json}")));
    };

    let toggle_theme = move |_| {
        let next = (theme() + 1) % THEMES.len();
        theme.set(next);
        lines.write().push((true, format!("theme → {}", THEMES[next].label)));
    };

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{THEMES[theme()].vars}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        div { class: "transcript",
                            for (i, (system, text)) in lines().iter().enumerate() {
                                div {
                                    key: "{i}",
                                    class: if *system { "line system" } else { "line" },
                                    "{text}"
                                }
                            }
                        }
                        div { class: "prompt",
                            span { class: "caret", "›" }
                            input {
                                value: "{draft}",
                                oninput: move |e| draft.set(e.value()),
                                onkeydown: move |e| if e.key() == Key::Enter {
                                    let text = draft.read().trim().to_string();
                                    if !text.is_empty() {
                                        lines.write().push((false, format!("> {text}")));
                                        draft.set(String::new());
                                    }
                                },
                            }
                        }
                        div { class: "controls",
                            button { onclick: emit_next_player, "GM: nextPlayer" }
                            button { onclick: toggle_theme, "theme: {THEMES[theme()].label}" }
                        }
                    }
                    div { class: "crt-overlay" }
                }
            }
        }
    }
}
