//! The physical-tabletop bridge (P2).
//!
//! The transport-agnostic seam between the WickedWays engine and a physical board: it turns a
//! [`ViewModel`](wickedways_core::world::view::ViewModel) + party [`roster`] + fog-of-war [`map`] into
//! [`protocol::DeviceCommand`]s (paint tiles, place pieces, drive dashboards), and resolves inbound
//! [`protocol::DeviceEvent`]s into actor-tagged engine [`Command`](wickedways_core::sync::Command)s via
//! [`bridge`]. The [`transport`] trait is the only thing that changes between the on-screen simulator
//! (the web client) and real e-ink firmware; [`codec`] supplies the COBS-framed JSON wire format the
//! hardware transport uses. Depends only on `wickedways-core` + serde, so it compiles native (the
//! controller) and to wasm (the web simulator).

// The modules, alphabetically (rustfmt's order). A good *reading* order — unlike JS imports,
// `mod` declarations carry no load-order semantics — is:
//   protocol   the vocabulary: `DeviceCommand` out, `DeviceEvent` in
//   bridge     the pure mappers: engine state → device commands, device events → engine commands
//   command    `Intent` → engine `Command` for a *named* seat (the piece that moved)
//   map        the shared fog-of-war map model + grid layout
//   roster     every party seat's location + stats, read off the replica
//   transport  the seam a board (or its simulator) implements
//   codec      COBS-framed JSON for the serial hardware transport
pub mod bridge;
pub mod codec;
pub mod command;
pub mod map;
pub mod protocol;
pub mod roster;
pub mod transport;
