//! The WickedWays room-server binary (Phase 2c, sub-project C — slice 4).
//!
//! Reads its configuration from the environment, builds a [`RoomServer`](wickedways_server::server::RoomServer),
//! and serves the axum `/ws` endpoint:
//!
//! - `PORT`         — listen port (default `8080`).
//! - `DB_PATH`      — SQLite path for durable campaigns; unset/empty ⇒ **ephemeral** (in-memory).
//! - `GM_IDENTITY`  — the GM identity seeded into a fresh campaign's membership (default `gm`).
//! - `GENESIS_DIR`  — directory of `<campaignId>.json` genesis snapshots (default `./genesis`). A
//!   campaign may ship its own `<campaignId>.catalog.json` beside its genesis; that per-campaign
//!   catalog resolves its authored behaviours (victory scripts, item/exit/mechanic bodies), so one
//!   server can host several authored campaigns. Absent ⇒ the shared `CATALOG_PATH` catalog.
//! - `CATALOG_PATH` — optional JSON [`Catalog`], the shared default when a campaign ships no catalog.
//! - `WEB_DIR`      — directory of the bundled Dioxus web client served as a fallback under `/ws` (default `./dist`; empty ⇒ off). Unmatched paths fall back to `index.html` so `?campaign=…`/`?surface=…` deep-links load.
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

    // A campaign may ship its own catalog beside its genesis (`<id>.catalog.json`), so several
    // authored campaigns (each with their own victory/item/mechanic behaviors) can be hosted at once.
    // Absent → the shared `CATALOG_PATH` catalog above.
    let genesis_dir_for_catalog = genesis_dir.clone();
    let opts = ServerOptions {
        verify_token: Box::new(|t: &str| (!t.is_empty()).then(|| t.to_string())),
        gm_identity_for: Box::new(move |_| gm_identity.clone()),
        genesis_for: Box::new(move |id: &str| load_genesis(&genesis_dir, id)),
        catalog_for: Some(Box::new(move |id: &str| load_catalog(&genesis_dir_for_catalog, id))),
        display_name_for: None,
        catalog,
        store,
        rng_seed: None,
    };

    // Serve the bundled Dioxus web client as a fallback under `/ws`: any non-`/ws` request tries a
    // file in `WEB_DIR`, and anything unmatched falls back to `index.html` (SPA deep-links). Absent
    // or empty `WEB_DIR` leaves the server socket-only (unchanged behaviour).
    let web_dir = std::env::var("WEB_DIR").unwrap_or_else(|_| "./dist".into());
    let mut app = router(RoomServer::new(opts));
    if !web_dir.is_empty() {
        let index = std::path::Path::new(&web_dir).join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(&web_dir)
                .fallback(tower_http::services::ServeFile::new(index)),
        );
    }

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("wickedways-server: cannot bind port {port}: {e}");
            std::process::exit(1);
        }
    };
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or_else(|_| format!("0.0.0.0:{port}"));
    println!(
        "wickedways-server listening on {addr} — /ws ({}), web client: {}",
        if durable { "durable" } else { "ephemeral" },
        if web_dir.is_empty() { "disabled".to_string() } else { format!("{web_dir}/") }
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

/// Loads a campaign's own catalog from `<dir>/<id>.catalog.json`, or `None` if absent/unreadable (→
/// the server's shared catalog). Same path-traversal guard as [`load_genesis`]: the id is off the wire.
fn load_catalog(dir: &str, id: &str) -> Option<Catalog> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return None;
    }
    let path = std::path::Path::new(dir).join(format!("{id}.catalog.json"));
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}
