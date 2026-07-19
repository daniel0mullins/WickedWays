//! The WickedWays room-server binary (Phase 2c, sub-project C — slice 4).
//!
//! Reads its configuration from the environment, builds a [`RoomServer`](wickedways_server::server::RoomServer),
//! and serves the axum `/ws` endpoint:
//!
//! - `PORT`         — listen port (default `8080`).
//! - `DB_PATH`      — SQLite path for durable campaigns; unset/empty ⇒ **ephemeral** (in-memory).
//! - `GM_IDENTITY`  — the GM identity seeded into a fresh campaign's membership (default `gm`).
//! - `GENESIS_DIR`  — directory of `<campaignId>.json` genesis snapshots (default `./genesis`).
//! - `CATALOG_PATH` — optional JSON [`Catalog`] the authority resolves item behaviour against.
//!
//! `verify_token` here is the development default (identity = the token string, empty rejected) —
//! a real deployment injects a proper verifier. Chat/AV are sub-project E.

use std::sync::Arc;

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::CampaignSnapshot;
use wickedways_server::server::{router, RoomServer, ServerOptions};
use wickedways_server::store::{CampaignStore, SqliteStore};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let gm_identity = std::env::var("GM_IDENTITY").unwrap_or_else(|_| "gm".into());
    let genesis_dir = std::env::var("GENESIS_DIR").unwrap_or_else(|_| "./genesis".into());

    let store: Option<Arc<dyn CampaignStore>> = match std::env::var("DB_PATH") {
        Ok(path) if !path.is_empty() => match SqliteStore::open(&path) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                eprintln!("wickedways-server: cannot open DB_PATH `{path}`: {e}");
                std::process::exit(1);
            }
        },
        _ => None,
    };
    let durable = store.is_some();

    let catalog = match std::env::var("CATALOG_PATH") {
        Ok(path) if !path.is_empty() => match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            Some(c) => c,
            None => {
                eprintln!("wickedways-server: cannot read/parse CATALOG_PATH `{path}`");
                std::process::exit(1);
            }
        },
        _ => Catalog::default(),
    };

    let opts = ServerOptions {
        verify_token: Box::new(|t: &str| (!t.is_empty()).then(|| t.to_string())),
        gm_identity_for: Box::new(move |_| gm_identity.clone()),
        genesis_for: Box::new(move |id: &str| load_genesis(&genesis_dir, id)),
        display_name_for: None,
        catalog,
        store,
        rng_seed: None,
    };

    let app = router(RoomServer::new(opts));
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("wickedways-server: cannot bind port {port}: {e}");
            std::process::exit(1);
        }
    };
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| format!("0.0.0.0:{port}"));
    println!(
        "wickedways-server listening on ws://{addr}/ws ({})",
        if durable { "durable" } else { "ephemeral" }
    );
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("wickedways-server: serve error: {e}");
        std::process::exit(1);
    }
}

/// Loads `<dir>/<id>.json` as a genesis snapshot, or `None` if absent/unreadable. Rejects any id that
/// could escape `dir` (path traversal), since the id comes from the wire.
fn load_genesis(dir: &str, id: &str) -> Option<CampaignSnapshot> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return None;
    }
    let path = std::path::Path::new(dir).join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}
