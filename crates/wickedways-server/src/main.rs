//! The WickedWays room-server binary (Phase 2c, sub-project C).
//!
//! Slice 0 is a compiling placeholder: the real entry point (read `PORT`/`DB_PATH`/`GM_IDENTITY`,
//! build the axum router, serve the `/ws` endpoint — ephemeral vs. durable by `DB_PATH`) lands in
//! Slice 4, once the `Table` actor and the WebSocket handler exist.

fn main() {
    // Intentionally minimal until Slice 4 wires the axum router. Kept as a plain `fn main` (no
    // `#[tokio::main]`) so the skeleton commit pulls in no async runtime it does not yet use.
    println!("wickedways-server: not yet runnable (Phase 2c sub-project C, slice 0 skeleton)");
}
