//! Campaign persistence — versioned JSON blobs behind a primed in-memory cache.
//!
//! Schema (docs/campaign-studio-spec.md §Persistence): one blob per campaign under
//! `wickedways:studio:campaign:<id>` (the serialized [`EditorDoc`] + a
//! `schema_version`), plus an index at `wickedways:studio:index`. JSON of the editor
//! model — not TOML text — so editor ids and in-progress (not-yet-valid) drafts
//! persist; TOML is the interchange format only ([`crate::export`]).
//!
//! Campaign BLOBS live in the platform blob store — IndexedDB in the browser
//! (escaping the ~5 MB localStorage ceiling, with a one-time migration of any
//! pre-IndexedDB blobs), data-dir files in the native arm. At boot the app
//! primes every blob into an in-memory cache ([`prime_cache`]); reads are pure
//! cache hits and writes update the cache synchronously then persist
//! fire-and-forget, so every call site stays synchronous. The tiny INDEX stays
//! in the synchronous platform store (localStorage / a file). A failed index
//! write surfaces as an error banner; a failed async blob write is logged and
//! retried by the next save of that campaign.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use crate::model::EditorDoc;
use crate::platform;

// ---- storage keys + schema ------------------------------------------------

/// The current stored-blob schema. Bump on breaking `EditorDoc` shape changes and
/// add an upgrade arm in [`load_campaign`].
pub const SCHEMA_VERSION: u32 = 1;

const INDEX_KEY: &str = "wickedways:studio:index";

/// The blob-key namespace (also the prime scan's prefix).
pub const CAMPAIGN_PREFIX: &str = "wickedways:studio:campaign:";

fn campaign_key(id: &str) -> String {
    format!("{CAMPAIGN_PREFIX}{id}")
}

// ---- the boot-primed blob cache -------------------------------------------

/// The boot-primed blob cache: key → serialized [`CampaignBlob`].
///
/// The `OnceLock` initializes the map on first use — Rust statics cannot run
/// construction code, so this is the moral equivalent of a module-scope
/// `const cache = new Map()` in JS, plus the `Mutex` Rust demands before
/// letting anything mutate shared state.
fn cache() -> &'static Mutex<BTreeMap<String, String>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Seed the cache from [`platform::blob_store_prime`]'s result. Called once at
/// app boot, before any screen renders.
pub fn prime_cache(blobs: Vec<(String, String)>) {
    let mut c = cache().lock().expect("blob cache poisoned");
    for (k, v) in blobs {
        c.insert(k, v);
    }
}

// ---- stored shapes --------------------------------------------------------
// The Serialize/Deserialize derives are the storage contract: these structs
// ARE the JSON in the store, field names included — renaming a field here
// orphans every existing save.

/// One campaign-list row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    pub schema_version: u32,
}

/// The stored campaign blob.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CampaignBlob {
    pub schema_version: u32,
    pub doc: EditorDoc,
}

/// The result of loading a stored campaign. A three-arm tagged union — `match`
/// makes every caller handle all three outcomes; there is no forgotten branch.
pub enum Loaded {
    /// Current-schema blob, ready to edit (boxed — the doc dwarfs the other arms).
    Ok(Box<EditorDoc>),
    /// A blob written by a NEWER studio — opened read-only per the spec.
    NewerSchema(u32),
    /// Absent or unparseable.
    Missing,
}

// ---- the campaign API -----------------------------------------------------

/// The campaign index, newest-first. Missing/corrupt index reads as empty.
#[must_use]
pub fn read_index() -> Vec<IndexEntry> {
    let mut entries: Vec<IndexEntry> = platform::storage_read(INDEX_KEY)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    entries
}

fn write_index(entries: &[IndexEntry]) -> Result<(), String> {
    let json = serde_json::to_string(entries).map_err(|e| format!("serialize index: {e}"))?;
    platform::storage_write(INDEX_KEY, &json)
}

/// Persist `doc` under `id` and upsert its index row (`now_ms` is the caller's
/// clock — [`platform::now_ms`] on wasm; injected in host tests).
pub fn save_campaign(id: &str, doc: &EditorDoc, now_ms: u64) -> Result<(), String> {
    let blob = CampaignBlob {
        schema_version: SCHEMA_VERSION,
        doc: doc.clone(),
    };
    let json = serde_json::to_string(&blob).map_err(|e| format!("serialize campaign: {e}"))?;
    let key = campaign_key(id);
    cache()
        .lock()
        .expect("blob cache poisoned")
        .insert(key.clone(), json.clone());
    platform::blob_put(&key, &json);
    let mut index = read_index();
    if let Some(row) = index.iter_mut().find(|e| e.id == id) {
        row.title.clone_from(&doc.title);
        row.updated_at = now_ms;
    } else {
        index.push(IndexEntry {
            id: id.to_string(),
            title: doc.title.clone(),
            updated_at: now_ms,
            schema_version: SCHEMA_VERSION,
        });
    }
    write_index(&index)
}

/// Load the campaign stored under `id`.
#[must_use]
pub fn load_campaign(id: &str) -> Loaded {
    // `let … else`: destructure or bail — Rust's guard-clause idiom for the
    // "return early unless this exists" shape.
    let Some(json) = cache()
        .lock()
        .expect("blob cache poisoned")
        .get(&campaign_key(id))
        .cloned()
    else {
        return Loaded::Missing;
    };
    let Ok(blob) = serde_json::from_str::<CampaignBlob>(&json) else {
        return Loaded::Missing;
    };
    if blob.schema_version > SCHEMA_VERSION {
        return Loaded::NewerSchema(blob.schema_version);
    }
    // schema_version < SCHEMA_VERSION: upgrade arms land here when v2 exists.
    Loaded::Ok(Box::new(blob.doc))
}

/// Delete a campaign blob and its index row.
pub fn delete_campaign(id: &str) {
    let key = campaign_key(id);
    cache().lock().expect("blob cache poisoned").remove(&key);
    platform::blob_delete(&key);
    let index: Vec<IndexEntry> = read_index().into_iter().filter(|e| e.id != id).collect();
    let _ = write_index(&index);
}

/// Mint a new campaign id: time-prefixed + collision-bumped against the index.
/// Wasm-clean (no getrandom) — uniqueness only has to hold within one store.
#[must_use]
pub fn mint_campaign_id(now_ms: u64) -> String {
    let taken = read_index();
    let mut n = 0u32;
    loop {
        let id = format!("c{now_ms:x}{n}");
        if !taken.iter().any(|e| e.id == id) {
            return id;
        }
        n += 1;
    }
}

/// Approximate stored bytes across the index + all cached blobs (informational —
/// blobs live in IndexedDB, whose quota is origin-wide and far larger than the
/// old ~5 MB localStorage ceiling).
#[must_use]
pub fn usage_bytes() -> usize {
    let blobs: usize = cache()
        .lock()
        .expect("blob cache poisoned")
        .values()
        .map(String::len)
        .sum();
    blobs + platform::storage_read(INDEX_KEY).map_or(0, |s| s.len())
}

#[cfg(test)]
mod tests {
    // Storage I/O needs a browser (web-sys externs panic on the host), so host
    // tests pin the serde shapes only — the same split savestore.rs uses.
    use super::*;

    #[test]
    fn blob_and_index_shapes_round_trip_through_json() {
        let blob = CampaignBlob {
            schema_version: SCHEMA_VERSION,
            doc: EditorDoc::new_blank("T"),
        };
        let back: CampaignBlob =
            serde_json::from_str(&serde_json::to_string(&blob).unwrap()).unwrap();
        assert_eq!(back, blob);

        let row = IndexEntry {
            id: "c1".into(),
            title: "T".into(),
            updated_at: 42,
            schema_version: SCHEMA_VERSION,
        };
        let back: IndexEntry = serde_json::from_str(&serde_json::to_string(&row).unwrap()).unwrap();
        assert_eq!(back, row);
    }
}
