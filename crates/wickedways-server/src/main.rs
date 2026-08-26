//! The WickedWays room-server binary.
//!
//! Reads its configuration from the environment, builds a [`RoomServer`](wickedways_server::server::RoomServer),
//! and serves the axum `/ws` endpoint (plus a `GET /healthz` liveness probe → `200 "ok"` for
//! container orchestrators):
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
//! - `STUDIO_DIR`   — directory of the bundled Campaign Studio (the authoring app), served under
//!   `/studio` (default `./studio`; empty or absent directory ⇒ off). The studio routes entirely by
//!   query params, so `/studio/?c=…` deep-links resolve to its `index.html` naturally.
//!
//! `verify_token` here is the development default (identity = the token string, empty rejected) —
//! a real deployment injects a proper verifier. Chat/AV are not implemented yet.

use std::sync::Arc;

use wickedways_core::world::descriptor::Catalog;
use wickedways_core::CampaignSnapshot;
use wickedways_server::server::{router, RoomServer, ServerOptions};
use wickedways_server::store::{CampaignStore, SqliteStore};

// Unlike Node, Rust has no ambient event loop: `#[tokio::main]` builds the tokio runtime and
// blocks the process on this one async fn. Everything async below runs inside it.
#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
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
        Ok(path) if !path.is_empty() => match std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
        {
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
        catalog_for: Some(Box::new(move |id: &str| {
            load_catalog(&genesis_dir_for_catalog, id)
        })),
        display_name_for: None,
        catalog,
        store,
        rng_seed: None,
    };

    // Serve the bundled Dioxus web client as a fallback under `/ws`: any non-`/ws` request tries a
    // file in `WEB_DIR`, and anything unmatched falls back to `index.html` (SPA deep-links). Absent
    // or empty `WEB_DIR` leaves the server socket-only (unchanged behaviour).
    let web_dir = std::env::var("WEB_DIR").unwrap_or_else(|_| "./dist".into());
    // Campaign Studio (the authoring app) rides the same binary under `/studio`, so one deploy
    // ships play + authoring. Its bundle is fully static (no server endpoints of its own); the
    // route is mounted only when the directory exists, so a bundle-less deploy stays unchanged.
    let studio_dir = std::env::var("STUDIO_DIR").unwrap_or_else(|_| "./studio".into());
    let mut app = router(RoomServer::new(opts));
    let studio_on = !studio_dir.is_empty() && std::path::Path::new(&studio_dir).is_dir();
    if studio_on {
        let index = std::path::Path::new(&studio_dir).join("index.html");
        app = app
            .nest_service(
                "/studio",
                tower_http::services::ServeDir::new(&studio_dir)
                    .fallback(tower_http::services::ServeFile::new(index)),
            )
            // Bare `/studio` must redirect to `/studio/`: the nested ServeDir happily
            // serves index.html at the slash-less URL, but the page's relative module
            // import (`./wickedways-studio.js`) then resolves against `/` and falls
            // through to the WEB client's catch-all — which returns HTML where the
            // browser demands a JS module (strict MIME checking). ServeDir does this
            // redirect for subdirectories itself; the nest root needs it done here.
            .layer(axum::middleware::from_fn(redirect_bare_studio));
    }
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
    let addr = listener
        .local_addr()
        .map_or_else(|_| format!("0.0.0.0:{port}"), |a| a.to_string());
    println!(
        "wickedways-server listening on {addr} — /ws ({}), web client: {}, studio: {}",
        if durable { "durable" } else { "ephemeral" },
        if web_dir.is_empty() {
            "disabled".to_string()
        } else {
            format!("{web_dir}/")
        },
        if studio_on {
            format!("/studio ({studio_dir}/)")
        } else {
            "disabled".to_string()
        }
    );
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("wickedways-server: serve error: {e}");
        std::process::exit(1);
    }
}

/// Redirect exactly `/studio` (no trailing slash) to `/studio/`, preserving the
/// query, so the studio page's relative asset URLs resolve under its mount.
async fn redirect_bare_studio(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if req.uri().path() == "/studio" {
        let query = req
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        return axum::response::Redirect::permanent(&format!("/studio/{query}")).into_response();
    }
    next.run(req).await
}

/// The base campaign an id belongs to: a **room id** is `<base>~<token>` (a unique per-host session of
/// `<base>`), so `covenant~a5f3` shares the `covenant` genesis/catalog. An id with no `~` is its own
/// base. This is how a GM's shareable room id resolves to a seeded campaign.
fn base_campaign(id: &str) -> &str {
    id.split('~').next().unwrap_or(id)
}

/// Read + parse `<dir>/<key>.<suffix>` for the id, trying the exact id first, then its
/// [`base_campaign`] (so an unseeded per-host room id resolves to its base). Rejects any id that could
/// escape `dir` (path traversal), since the id comes from the wire.
fn read_campaign_file<T: serde::de::DeserializeOwned>(
    dir: &str,
    id: &str,
    suffix: &str,
) -> Option<T> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return None;
    }
    for key in [id, base_campaign(id)] {
        let path = std::path::Path::new(dir).join(format!("{key}.{suffix}"));
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str(&s) {
                return Some(v);
            }
        }
    }
    None
}

/// Loads a genesis snapshot for a room id (exact, else its base campaign), or `None`.
fn load_genesis(dir: &str, id: &str) -> Option<CampaignSnapshot> {
    read_campaign_file(dir, id, "json")
}

/// Loads a campaign's own catalog (exact id, else its base campaign), or `None` (→ the server's shared
/// catalog).
fn load_catalog(dir: &str, id: &str) -> Option<Catalog> {
    read_campaign_file(dir, id, "catalog.json")
}

#[cfg(test)]
mod tests {
    use super::base_campaign;

    #[test]
    fn base_campaign_strips_the_per_host_room_token() {
        assert_eq!(base_campaign("covenant"), "covenant");
        assert_eq!(base_campaign("covenant~a5f3"), "covenant");
        assert_eq!(
            base_campaign("covenant~a~b"),
            "covenant",
            "only the first segment is the base"
        );
        assert_eq!(base_campaign("demo"), "demo");
    }
}
