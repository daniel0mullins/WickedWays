//! The WickedWays Dioxus web client — library surface.
//!
//! The reusable, framework-agnostic pieces of the client live here so they are unit-testable on the
//! host target (the `wasm32`-only bits — the `web-sys` socket binding and the Dioxus UI — sit in the
//! bin and the UI modules). [`mirror`] is the warm-local-mirror half of the WebSocket transport.
//!
//! **Reading guide** (for the JS/TS developer new to Rust): Dioxus is React-shaped — a surface is a
//! component function returning `rsx!` (≈ JSX), state lives in `use_signal` (≈ `useState`), and the
//! long-lived work sits in `use_coroutine` async loops. The modules compose in layers:
//!
//! - **Shell & routing** — [`launcher`] is the root app (campaign menu → surface picker → mounted
//!   surface); [`driver`] is the shared glue every surface uses (config, boot, campaign registry,
//!   intent→command); [`lobby`] is the multiplayer pre-game screen; [`platform`] abstracts
//!   browser-vs-desktop page services; [`theme`] holds the `?theme=` palettes.
//! - **Surfaces** (the three interchangeable UIs) — [`crt`] the green-screen terminal, [`pnc`] the
//!   point-and-click scene, [`tabletop`] the physical-board simulator.
//! - **Surface support** (pure logic, host-tested) — [`parser`] (CRT input → intent), [`narrator`]
//!   (engine data → prose), [`link_nouns`] (clickable nouns), [`affordances`] (view → hotspots/verbs),
//!   [`scene_layout`] (hotspot placement), [`map`] (fog-of-war map + SVG), [`savestore`]
//!   (save/restore blobs).
//! - **Transport & sync** — [`transport`] the WebSocket client, [`mirror`] its pure local log
//!   mirror, [`single_player`] the offline in-process authority behind the same seam.
//! - **Audio stack** (top-down) — [`audio_runtime`] the orchestrator, [`audio_pack`] the
//!   director/soundpack decision layer, [`audio`] the cue→voice mapping, [`audio_engine`] the Web
//!   Audio renderer, [`ambient`] the sanity-reactive drone bed.

// Shell & routing.
pub mod driver;
pub mod launcher;
pub mod lobby;
pub mod platform;
pub mod theme;

// Surfaces.
pub mod crt;
pub mod pnc;
pub mod tabletop;

// Surface support (pure logic).
pub mod affordances;
pub mod link_nouns;
pub mod map;
pub mod narrator;
pub mod parser;
pub mod savestore;
pub mod scene_layout;

// Transport & sync.
pub mod mirror;
pub mod single_player;
pub mod transport;

// Audio stack.
pub mod ambient;
pub mod audio;
pub mod audio_engine;
pub mod audio_pack;
pub mod audio_runtime;
