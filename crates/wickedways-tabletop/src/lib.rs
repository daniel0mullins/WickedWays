//! The physical-tabletop bridge (P2).
//!
//! The transport-agnostic seam between the WickedWays engine and a physical board: it turns a
//! [`ViewModel`](wickedways_core::world::view::ViewModel) + party [`roster`] + fog-of-war [`map`] into
//! [`protocol::DeviceCommand`]s (paint tiles, place pieces, drive dashboards), and resolves inbound
//! [`protocol::DeviceEvent`]s into actor-tagged engine [`Command`](wickedways_core::sync::Command)s via
//! [`bridge`]. The [`transport`] trait is the only thing that changes between the on-screen simulator
//! (the web client) and real e-ink firmware. Depends only on `wickedways-core` + serde, so it compiles
//! native (the controller) and to wasm (the web simulator).

pub mod bridge;
pub mod command;
pub mod map;
pub mod protocol;
pub mod roster;
pub mod transport;
