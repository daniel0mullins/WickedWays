//! The WickedWays room server.
//!
//! Hosts a **native** [`SyncAuthority`](wickedways_core::sync::SyncAuthority) per campaign, gates
//! appends by seat ownership, persists durably (SQLite), and speaks the shared wire protocol
//! (the `wickedways-transport` crate) over WebSockets.
//!
//! The server has **no differential oracle** — it is conventional server code. Correctness is
//! established by behavioural tests (`server`/`table`/`membership`) and a two-client
//! [`SyncCoordinator`](wickedways_core::sync::SyncCoordinator) convergence e2e.
//!
//! ## Layers
//!
//! - the `transport` wire types, `Membership` (seats/GM), and the
//!   `CampaignStore`/`SqliteStore` persistence;
//! - the per-campaign `Table` tokio actor (in-order submit → persist → ack);
//! - the axum WebSocket handler + connection lifecycle;
//! - the binary entry point (plus the two-client convergence e2e in `tests/`).

// Re-export the core sync surface this crate hosts, so downstream code names it through the
// server crate rather than reaching into `wickedways_core` directly.
pub use wickedways_core::sync;

// The wire protocol lives in the shared `wickedways-transport` crate so the web client speaks the
// same types. Re-exported as `transport` so `crate::transport::*` — used throughout
// `table`/`server` — keeps resolving unchanged.
pub use wickedways_transport as transport;

pub mod membership;
pub mod server;
pub mod store;
pub mod table;
