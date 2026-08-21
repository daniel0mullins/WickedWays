//! The platform seam — the host services the studio needs, in two arms selected
//! by the `native-app` cargo feature (the play client's idiom, `wickedways-web/
//! src/platform.rs`): the default browser arm (URL query, `localStorage`, a
//! transient download anchor) and a native arm for the desktop shell (a
//! CLI-seeded param store, file-backed storage under the platform data dir,
//! downloads written to the Downloads folder). The browser arm compiles on the
//! host too — `web-sys` externs — which keeps the model/refs/gate layers
//! host-testable.

#[cfg(not(feature = "native-app"))]
mod imp {
    //! Browser implementations.

    /// A param from the page URL query, `None` when absent or empty.
    pub fn query_param(key: &str) -> Option<String> {
        web_sys::window()
            .and_then(|w| w.location().search().ok())
            .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
            .and_then(|p| p.get(key))
            .filter(|v| !v.is_empty())
    }

    /// Mutate the current URL's query in place via `history.replaceState` (no reload).
    fn replace_query(f: impl FnOnce(&web_sys::UrlSearchParams)) {
        let Some(win) = web_sys::window() else { return };
        let Ok(href) = win.location().href() else {
            return;
        };
        let Ok(url) = web_sys::Url::new(&href) else {
            return;
        };
        f(&url.search_params());
        if let Ok(history) = win.history() {
            let _ =
                history.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&url.href()));
        }
    }

    /// Merge `pairs` into the page URL's query (no reload), so every editor
    /// location is deep-linkable.
    pub fn set_params(pairs: &[(&str, &str)]) {
        replace_query(|p| {
            for (k, v) in pairs {
                p.set(k, v);
            }
        });
    }

    /// Remove `keys` from the page URL's query (no reload).
    pub fn clear_params(keys: &[&str]) {
        replace_query(|p| {
            for k in keys {
                p.delete(k);
            }
        });
    }

    fn local_storage() -> Option<web_sys::Storage> {
        web_sys::window()?.local_storage().ok()?
    }

    /// Read a persisted value, or `None` if absent or storage is unavailable.
    pub fn storage_read(key: &str) -> Option<String> {
        local_storage()?.get_item(key).ok()?
    }

    /// Persist a value. Errors when storage is unavailable (private-mode /
    /// disabled storage) or full — surfaced as a banner, never a silent drop.
    pub fn storage_write(key: &str, value: &str) -> Result<(), String> {
        let storage = local_storage().ok_or("localStorage is unavailable")?;
        storage
            .set_item(key, value)
            .map_err(|e| format!("write storage: {e:?}"))
    }

    /// Delete a persisted value (best-effort).
    pub fn storage_delete(key: &str) {
        if let Some(storage) = local_storage() {
            let _ = storage.remove_item(key);
        }
    }

    /// Milliseconds since the epoch — campaign-id minting and `updated_at`
    /// stamps. Client bookkeeping only, never game state (engine randomness/time
    /// is forbidden outside `World.rng`).
    pub fn now_ms() -> u64 {
        js_sys::Date::now() as u64
    }

    /// Trigger a browser download of `text` as `filename` with the given MIME
    /// type (a transient `a[download]` with a data: URI — no Blob APIs). Built
    /// and clicked only when the user asks for an export, so the document is
    /// never re-serialized per render.
    pub fn download_text(filename: &str, mime: &str, text: &str) {
        use wasm_bindgen::JsCast;
        let Some(document) = web_sys::window().and_then(|w| w.document()) else {
            return;
        };
        let Ok(el) = document.create_element("a") else {
            return;
        };
        let Ok(anchor) = el.dyn_into::<web_sys::HtmlAnchorElement>() else {
            return;
        };
        let encoded = js_sys::encode_uri_component(text);
        anchor.set_href(&format!("data:{mime};charset=utf-8,{encoded}"));
        anchor.set_download(filename);
        anchor.click();
    }

    /// Open `url` in a new browser tab — the playtest handoff into the game client, which is
    /// served same-origin at `/` (so relative URLs resolve to it). Popup-blocked or windowless
    /// contexts are a silent no-op; the saved slot still appears in the game's launcher menu.
    pub fn open_url(url: &str) {
        if let Some(w) = web_sys::window() {
            let _ = w.open_with_url_and_target(url, "_blank");
        }
    }

    // ---- the campaign-blob store: IndexedDB ------------------------------
    // Campaign blobs live in IndexedDB (no ~5 MB localStorage ceiling); the
    // app primes them into an in-memory cache at boot and persists changes
    // fire-and-forget (`blob_put`/`blob_delete`), so every call site stays
    // synchronous. The tiny index remains in localStorage.

    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};

    const DB_NAME: &str = "wickedways-studio";
    const STORE: &str = "campaigns";

    /// Await an `IdbRequest` (they are event-driven, not Promises).
    async fn await_request(req: web_sys::IdbRequest) -> Result<JsValue, String> {
        let (tx, rx) = futures_channel::oneshot::channel::<Result<JsValue, String>>();
        let tx = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
        let tx_err = tx.clone();
        let req_ok = req.clone();
        let on_ok = Closure::once(move |_: web_sys::Event| {
            if let Some(tx) = tx.borrow_mut().take() {
                let _ = tx.send(Ok(req_ok.result().unwrap_or(JsValue::UNDEFINED)));
            }
        });
        let req_err = req.clone();
        let on_err = Closure::once(move |_: web_sys::Event| {
            if let Some(tx) = tx_err.borrow_mut().take() {
                let _ = tx.send(Err(format!("idb request: {:?}", req_err.error())));
            }
        });
        req.set_onsuccess(Some(on_ok.as_ref().unchecked_ref()));
        req.set_onerror(Some(on_err.as_ref().unchecked_ref()));
        let out = rx
            .await
            .map_err(|_| "idb request: channel dropped".to_string())?;
        drop(on_ok);
        drop(on_err);
        out
    }

    /// Open (creating/upgrading as needed) the studio database.
    async fn open_db() -> Result<web_sys::IdbDatabase, String> {
        let factory = web_sys::window()
            .and_then(|w| w.indexed_db().ok().flatten())
            .ok_or("IndexedDB is unavailable")?;
        let open = factory
            .open_with_u32(DB_NAME, 1)
            .map_err(|e| format!("idb open: {e:?}"))?;
        let on_upgrade = Closure::once(move |e: web_sys::IdbVersionChangeEvent| {
            let Some(target) = e.target() else { return };
            let Ok(req) = target.dyn_into::<web_sys::IdbOpenDbRequest>() else {
                return;
            };
            let Ok(result) = req.result() else { return };
            let Ok(db) = result.dyn_into::<web_sys::IdbDatabase>() else {
                return;
            };
            let _ = db.create_object_store(STORE);
        });
        open.set_onupgradeneeded(Some(on_upgrade.as_ref().unchecked_ref()));
        let db = await_request(open.clone().into()).await?;
        drop(on_upgrade);
        db.dyn_into::<web_sys::IdbDatabase>()
            .map_err(|_| "idb open: not a database".to_string())
    }

    fn store_tx(
        db: &web_sys::IdbDatabase,
        mode: web_sys::IdbTransactionMode,
    ) -> Result<web_sys::IdbObjectStore, String> {
        db.transaction_with_str_and_mode(STORE, mode)
            .map_err(|e| format!("idb tx: {e:?}"))?
            .object_store(STORE)
            .map_err(|e| format!("idb store: {e:?}"))
    }

    /// Load EVERY persisted campaign blob, migrating any blob still sitting in
    /// localStorage (the pre-IndexedDB store) into the database and freeing its
    /// localStorage quota. Returns `(key, blob)` pairs. Failures degrade to
    /// whatever localStorage holds — the studio still runs, ceiling and all.
    pub async fn blob_store_prime(prefix: &str) -> Vec<(String, String)> {
        // localStorage leftovers (also the fallback when IndexedDB is unavailable).
        let mut legacy: Vec<(String, String)> = Vec::new();
        if let Some(storage) = local_storage() {
            let len = storage.length().unwrap_or(0);
            for i in 0..len {
                if let Ok(Some(key)) = storage.key(i) {
                    if key.starts_with(prefix) {
                        if let Ok(Some(value)) = storage.get_item(&key) {
                            legacy.push((key, value));
                        }
                    }
                }
            }
        }
        let db = match open_db().await {
            Ok(db) => db,
            Err(e) => {
                web_sys::console::warn_1(&format!("studio blob store: {e}").into());
                return legacy;
            }
        };
        let mut out: Vec<(String, String)> = Vec::new();
        let read = |db: &web_sys::IdbDatabase| -> Result<
            (web_sys::IdbRequest, web_sys::IdbRequest),
            String,
        > {
            let store = store_tx(db, web_sys::IdbTransactionMode::Readonly)?;
            let keys = store.get_all_keys().map_err(|e| format!("{e:?}"))?;
            let vals = store.get_all().map_err(|e| format!("{e:?}"))?;
            Ok((keys, vals))
        };
        match read(&db) {
            Ok((keys_req, vals_req)) => {
                let keys = await_request(keys_req).await;
                let vals = await_request(vals_req).await;
                if let (Ok(keys), Ok(vals)) = (keys, vals) {
                    let keys = js_sys::Array::from(&keys);
                    let vals = js_sys::Array::from(&vals);
                    for (k, v) in keys.iter().zip(vals.iter()) {
                        if let (Some(k), Some(v)) = (k.as_string(), v.as_string()) {
                            out.push((k, v));
                        }
                    }
                }
            }
            Err(e) => web_sys::console::warn_1(&format!("studio blob store: {e}").into()),
        }
        // One-time migration: anything still in localStorage moves into the db.
        for (key, value) in legacy {
            if out.iter().any(|(k, _)| *k == key) {
                continue;
            }
            let put = store_tx(&db, web_sys::IdbTransactionMode::Readwrite).and_then(|s| {
                s.put_with_key(&JsValue::from_str(&value), &JsValue::from_str(&key))
                    .map_err(|e| format!("{e:?}"))
            });
            match put {
                Ok(req) => {
                    if await_request(req).await.is_ok() {
                        if let Some(storage) = local_storage() {
                            let _ = storage.remove_item(&key);
                        }
                        out.push((key, value));
                    } else {
                        out.push((key, value));
                    }
                }
                Err(e) => {
                    web_sys::console::warn_1(&format!("studio blob migrate: {e}").into());
                    out.push((key, value));
                }
            }
        }
        out
    }

    /// Persist one campaign blob (fire-and-forget; a failure is logged — the
    /// in-memory copy and the next successful write keep the session safe).
    pub fn blob_put(key: &str, value: &str) {
        let key = key.to_string();
        let value = value.to_string();
        wasm_bindgen_futures::spawn_local(async move {
            let result = async {
                let db = open_db().await?;
                let store = store_tx(&db, web_sys::IdbTransactionMode::Readwrite)?;
                let req = store
                    .put_with_key(&JsValue::from_str(&value), &JsValue::from_str(&key))
                    .map_err(|e| format!("idb put: {e:?}"))?;
                await_request(req).await.map(|_| ())
            }
            .await;
            if let Err(e) = result {
                web_sys::console::warn_1(&format!("studio blob put failed: {e}").into());
            }
        });
    }

    /// Delete one campaign blob (fire-and-forget).
    pub fn blob_delete(key: &str) {
        let key = key.to_string();
        wasm_bindgen_futures::spawn_local(async move {
            let result = async {
                let db = open_db().await?;
                let store = store_tx(&db, web_sys::IdbTransactionMode::Readwrite)?;
                let req = store
                    .delete(&JsValue::from_str(&key))
                    .map_err(|e| format!("idb delete: {e:?}"))?;
                await_request(req).await.map(|_| ())
            }
            .await;
            if let Err(e) = result {
                web_sys::console::warn_1(&format!("studio blob delete failed: {e}").into());
            }
        });
    }
}

#[cfg(feature = "native-app")]
mod imp {
    //! Native implementations for the desktop shell: a CLI-seeded in-memory
    //! param store (the desktop analog of the URL query — same keys, same
    //! routing, minus deep links), file-backed storage under the platform data
    //! dir, and exports written to the Downloads folder.

    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    fn params() -> &'static Mutex<BTreeMap<String, String>> {
        static PARAMS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
        PARAMS.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    /// Seed the param store before launch (the desktop shell parses CLI args
    /// into this). Later [`set_params`]/[`clear_params`] calls mutate the same
    /// store, so query-param routing works exactly as on the web.
    pub fn init_params<I: IntoIterator<Item = (String, String)>>(pairs: I) {
        let mut p = params().lock().expect("param store poisoned");
        p.extend(pairs);
    }

    /// A param from the launch/param store, `None` when absent or empty.
    pub fn query_param(key: &str) -> Option<String> {
        params()
            .lock()
            .expect("param store poisoned")
            .get(key)
            .filter(|v| !v.is_empty())
            .cloned()
    }

    /// Merge `pairs` into the param store (the router's writes).
    pub fn set_params(pairs: &[(&str, &str)]) {
        let mut p = params().lock().expect("param store poisoned");
        for (k, v) in pairs {
            p.insert((*k).into(), (*v).into());
        }
    }

    /// Remove `keys` from the param store.
    pub fn clear_params(keys: &[&str]) {
        let mut p = params().lock().expect("param store poisoned");
        for k in keys {
            p.remove(*k);
        }
    }

    /// The campaign-store directory: `$WICKEDWAYS_DATA_DIR`, else the platform
    /// data dir (`~/.local/share/wickedways`, …), else the working directory —
    /// the SAME resolution as the play client's saves, so one data dir holds both.
    fn data_dir() -> PathBuf {
        if let Ok(dir) = std::env::var("WICKEDWAYS_DATA_DIR") {
            return PathBuf::from(dir);
        }
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("wickedways")
    }

    /// A storage key as a filename: `:` separators become `_` (the web build's
    /// `localStorage` keys, e.g. `wickedways:studio:campaign:<id>`).
    fn key_path(key: &str) -> PathBuf {
        data_dir().join(format!("{}.json", key.replace(':', "_")))
    }

    /// Read a persisted value, or `None` if absent/unreadable.
    pub fn storage_read(key: &str) -> Option<String> {
        std::fs::read_to_string(key_path(key)).ok()
    }

    /// Persist a value under the data dir, creating it on first write.
    pub fn storage_write(key: &str, value: &str) -> Result<(), String> {
        let dir = data_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        std::fs::write(key_path(key), value).map_err(|e| format!("write store: {e}"))
    }

    /// Delete a persisted value (best-effort).
    pub fn storage_delete(key: &str) {
        let _ = std::fs::remove_file(key_path(key));
    }

    /// Milliseconds since the epoch (client bookkeeping only, never game state).
    pub fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    /// "Download" = write the file to the Downloads folder (else the data dir).
    /// The MIME type is meaningless on disk and ignored.
    pub fn download_text(filename: &str, _mime: &str, text: &str) {
        let dir = dirs::download_dir().unwrap_or_else(data_dir);
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(filename);
        match std::fs::write(&path, text) {
            Ok(()) => eprintln!("wickedways-studio: exported {}", path.display()),
            Err(e) => eprintln!(
                "wickedways-studio: export to {} failed: {e}",
                path.display()
            ),
        }
    }

    /// Opening the game client isn't possible from the native studio process — the playtest
    /// slot is still written (to the shared data dir the desktop game shell reads), so the
    /// campaign appears in that app's launcher menu; this only notes where to find it.
    pub fn open_url(url: &str) {
        eprintln!("wickedways-studio: playtest saved — open the WickedWays app ({url})");
    }

    // ---- the campaign-blob store: data-dir files -------------------------
    // The native analog of the browser arm's IndexedDB store: blobs are files
    // (no quota to escape); prime scans the data dir back into keys.

    /// Load every persisted campaign blob whose key starts with `prefix`.
    pub async fn blob_store_prime(prefix: &str) -> Vec<(String, String)> {
        let mangled_prefix = prefix.replace(':', "_");
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(data_dir()) else {
            return out;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            if !stem.starts_with(&mangled_prefix) {
                continue;
            }
            if let Ok(value) = std::fs::read_to_string(entry.path()) {
                // Reverse the key mangling: `_` separators back to `:` for the
                // fixed studio prefix, keeping the free-form id tail intact.
                let id_tail = &stem[mangled_prefix.len()..];
                out.push((format!("{prefix}{id_tail}"), value));
            }
        }
        out
    }

    /// Persist one campaign blob.
    pub fn blob_put(key: &str, value: &str) {
        if let Err(e) = storage_write(key, value) {
            eprintln!("wickedways-studio: blob put failed: {e}");
        }
    }

    /// Delete one campaign blob.
    pub fn blob_delete(key: &str) {
        storage_delete(key);
    }
}

pub use imp::*;
