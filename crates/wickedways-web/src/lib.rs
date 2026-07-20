//! The WickedWays Dioxus web client (Phase 2c, sub-project D) — library surface.
//!
//! The reusable, framework-agnostic pieces of the client live here so they are unit-testable on the
//! host target (the `wasm32`-only bits — the `web-sys` socket binding and the Dioxus UI — sit in the
//! bin and later modules). Slice 1 lands [`mirror`] — the warm-local-mirror half of the WebSocket
//! transport, ported from `packages/client/src/websocket-transport.ts`.

pub mod affordances;
pub mod driver;
pub mod map;
pub mod mirror;
pub mod narrator;
pub mod parser;
pub mod pnc;
pub mod savestore;
pub mod scene_layout;
pub mod single_player;
pub mod theme;
pub mod transport;
