//! The WickedWays room server (Phase 2c, sub-project C).
//!
//! Ports `packages/server/` to Rust/axum. Hosts a **native**
//! [`SyncAuthority`](wickedways_core::sync::SyncAuthority) per campaign, gates appends by seat
//! ownership, persists durably (SQLite), and speaks the existing `transport-shared` wire protocol
//! over WebSockets.
//!
//! Unlike the sync core (sub-project B), the server has **no differential oracle** — it is
//! conventional server code. Correctness is established by ported behavioural tests
//! (`server`/`table`/`membership`), wire parity against `packages/transport-shared`, and a
//! two-client [`SyncCoordinator`](wickedways_core::sync::SyncCoordinator) convergence e2e.
//!
//! ## Layers (built slice by slice; see
//! `docs/superpowers/plans/2026-07-17-rust-phase-2c-c-axum-room-server.md`)
//!
//! - **Slice 1** — the `transport` wire types, `Membership` (seats/GM), and the
//!   `CampaignStore`/`SqliteStore` persistence.
//! - **Slice 2** — the per-campaign `Table` tokio actor (in-order submit → persist → ack).
//! - **Slice 3** — the axum WebSocket handler + connection lifecycle.
//! - **Slice 4** — wire parity + the convergence e2e + the binary entry point.
//!
//! Slice 0 (this commit) is the crate skeleton only: it establishes the workspace member and
//! retires the dependency-build environment risk before any logic lands.

// Re-export the core sync surface this crate hosts, so downstream slices (and D) name it through
// the server crate rather than reaching into `wickedways_core` directly.
pub use wickedways_core::sync;

pub mod membership;
pub mod server;
pub mod store;
pub mod table;
pub mod transport;
