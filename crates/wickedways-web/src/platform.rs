//! The platform seam — page/window services that differ between the browser build and the
//! native desktop build.
//!
//! Everything the client needs from its host environment funnels through here: the launch
//! config + router state (the browser's URL query / the desktop's CLI-seeded param store),
//! persistent storage (`localStorage` / a data-dir file), fullscreen, the identity suffix
//! randomness, and the default socket URL. The rest of the crate calls these functions and
//! never touches `web-sys` for them directly, so the same surfaces/driver compile and run on
//! both hosts.
//!
//! Selection is by the `native-app` cargo feature (not `target_arch`): the default build is
//! the browser client (web impls; they also *compile* on the host — `web-sys` externs — which
//! is what keeps the crate host-testable), and the `desktop/` shell crate enables `native-app`
//! for the windowed build. Desktop-only services that need `dioxus::desktop` (fullscreen on a
//! real window) are injected by the shell via [`install_desktop_hooks`] so this crate never
//! depends on the native windowing stack.

/// Whether this build can reach the multiplayer room server. The desktop build has no
/// WebSocket transport yet, so the launcher hides hosting/joining and
/// [`read_config`](crate::driver::read_config) pins [`Mode::Single`](crate::driver::Mode).
pub const MULTIPLAYER: bool = cfg!(not(feature = "native-app"));

#[cfg(not(feature = "native-app"))]
mod imp {
    //! Browser implementations: URL query, `localStorage`, the Fullscreen API.

    /// A param from the page URL query, `None` when absent or empty. (The `and_then` chain is
    /// Rust's optional chaining — each step short-circuits to `None`, like `?.` in JS; `web_sys`
    /// calls are typed bindings to the same browser APIs, returning `Option`/`Result` where JS
    /// would return `null` or throw.)
    pub fn query_param(key: &str) -> Option<String> {
        web_sys::window()
            .and_then(|w| w.location().search().ok())
            .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
            .and_then(|p| p.get(key))
            .filter(|v| !v.is_empty())
    }

    /// Whether a bare flag param is present (regardless of value) — `?debug`, `?debug=1`, etc.
    pub fn has_flag(key: &str) -> bool {
        web_sys::window()
            .and_then(|w| w.location().search().ok())
            .and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok())
            .is_some_and(|p| p.has(key))
    }

    /// Mutate the current URL's query in place via `history.replaceState` (no reload), applying
    /// `f` to a live `UrlSearchParams`. Best-effort — silently skips in non-http environments.
    fn replace_query(f: impl FnOnce(&web_sys::UrlSearchParams)) {
        let Some(win) = web_sys::window() else { return };
        let Ok(href) = win.location().href() else {
            return;
        };
        let Ok(url) = web_sys::Url::new(&href) else {
            return;
        };
        // `url.searchParams` is spec-linked to `url.search`, so mutating it updates `url.href`.
        f(&url.search_params());
        if let Ok(history) = win.history() {
            let _ =
                history.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&url.href()));
        }
    }

    /// Merge `pairs` into the page URL's query (no reload), so the launcher's route is
    /// deep-linkable.
    pub fn set_params(pairs: &[(&str, &str)]) {
        replace_query(|p| {
            for (k, v) in pairs {
                p.set(k, v);
            }
        });
    }

    /// Remove `keys` from the page URL's query (no reload) — used when returning to the menu.
    pub fn clear_params(keys: &[&str]) {
        replace_query(|p| {
            for k in keys {
                p.delete(k);
            }
        });
    }

    /// Toggle browser fullscreen for the whole page. Enters fullscreen on the document element
    /// when none is active, else exits. Returns `true` if the page is entering fullscreen. A
    /// rejected request (e.g. no user gesture) is swallowed.
    pub fn toggle_fullscreen() -> bool {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else {
            return false;
        };
        if doc.fullscreen_element().is_some() {
            doc.exit_fullscreen();
            false
        } else if let Some(el) = doc.document_element() {
            let _ = el.request_fullscreen();
            true
        } else {
            false
        }
    }

    /// A random `u64` for the identity suffix — `Math.random()` (not the engine RNG; this is
    /// client identity, not game state).
    pub fn random_u64() -> u64 {
        (js_sys::Math::random() * f64::from(u32::MAX)) as u64
    }

    /// The default multiplayer socket URL: **same-origin and scheme-aware**, derived from the
    /// page (`wss://<host>/ws` on HTTPS, `ws://<host>/ws` otherwise) so a deployed client
    /// connects back to the one binary that served it. Falls back to the local-dev server when
    /// there's no page origin (non-browser / `file:`).
    pub fn default_ws() -> String {
        web_sys::window()
            .map(|w| w.location())
            .and_then(|loc| {
                let host = loc.host().ok().filter(|h| !h.is_empty())?;
                let scheme = if loc.protocol().ok().as_deref() == Some("https:") {
                    "wss"
                } else {
                    "ws"
                };
                Some(format!("{scheme}://{host}/ws"))
            })
            .unwrap_or_else(|| "ws://127.0.0.1:9000/ws".into())
    }

    fn local_storage() -> Option<web_sys::Storage> {
        // Host builds of this arm (the lib's unit tests) can't call wasm-bindgen imports —
        // `web_sys::window()` PANICS off-wasm rather than returning `None` — so storage is
        // simply absent there (e.g. no playtest slot in launcher tests).
        if cfg!(not(target_arch = "wasm32")) {
            return None;
        }
        web_sys::window()?.local_storage().ok()?
    }

    /// Read a persisted value, or `None` if absent or storage is unavailable.
    pub fn storage_read(key: &str) -> Option<String> {
        local_storage()?.get_item(key).ok()?
    }

    /// Persist a value. Errors when storage is unavailable (private-mode / disabled storage).
    pub fn storage_write(key: &str, value: &str) -> Result<(), String> {
        let storage = local_storage().ok_or("localStorage is unavailable")?;
        storage
            .set_item(key, value)
            .map_err(|e| format!("write save: {e:?}"))
    }
}

#[cfg(feature = "native-app")]
mod imp {
    //! Native implementations: a CLI-seeded in-memory param store (the desktop analog of the
    //! URL query — same keys, same launcher/router semantics, minus deep links), file-backed
    //! storage under the platform data dir, and shell-injected window services.

    use std::collections::BTreeMap;
    use std::hash::{BuildHasher, RandomState};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    fn params() -> &'static Mutex<BTreeMap<String, String>> {
        static PARAMS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
        PARAMS.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    /// Seed the param store before launch (the desktop shell parses CLI args into this).
    /// Later [`set_params`]/[`clear_params`] calls mutate the same store, so the launcher's
    /// param-driven navigation works exactly as on the web — the state just isn't shareable.
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

    /// Whether a flag param is present (a bare `--debug` seeds an empty value — still present).
    pub fn has_flag(key: &str) -> bool {
        params()
            .lock()
            .expect("param store poisoned")
            .contains_key(key)
    }

    /// Merge `pairs` into the param store (the launcher's route/selection writes).
    pub fn set_params(pairs: &[(&str, &str)]) {
        let mut p = params().lock().expect("param store poisoned");
        for (k, v) in pairs {
            p.insert((*k).into(), (*v).into());
        }
    }

    /// Remove `keys` from the param store — used when returning to the menu.
    pub fn clear_params(keys: &[&str]) {
        let mut p = params().lock().expect("param store poisoned");
        for k in keys {
            p.remove(*k);
        }
    }

    /// Window services only the desktop shell can provide (they need `dioxus::desktop`, which
    /// this crate deliberately does not depend on).
    pub struct DesktopHooks {
        /// Toggle window fullscreen; returns `true` when entering fullscreen.
        pub toggle_fullscreen: fn() -> bool,
    }

    static HOOKS: OnceLock<DesktopHooks> = OnceLock::new();

    /// Install the shell's window services. Call once before launch; a second call is ignored.
    pub fn install_desktop_hooks(hooks: DesktopHooks) {
        let _ = HOOKS.set(hooks);
    }

    /// Toggle window fullscreen via the shell hook; a hook-less run (host tests) is a no-op.
    pub fn toggle_fullscreen() -> bool {
        HOOKS.get().is_some_and(|h| (h.toggle_fullscreen)())
    }

    /// A random `u64` for the identity suffix, from OS-seeded hasher entropy (not the engine
    /// RNG; this is client identity, not game state).
    pub fn random_u64() -> u64 {
        RandomState::new().hash_one(0u64)
    }

    /// The default multiplayer socket URL (the local room server; unused until the desktop
    /// build grows a native transport).
    pub fn default_ws() -> String {
        "ws://127.0.0.1:8080/ws".into()
    }

    /// The save-file directory: `$WICKEDWAYS_DATA_DIR`, else the platform data dir
    /// (`~/.local/share/wickedways`, `~/Library/Application Support/wickedways`, …), else the
    /// working directory.
    fn data_dir() -> PathBuf {
        if let Ok(dir) = std::env::var("WICKEDWAYS_DATA_DIR") {
            return PathBuf::from(dir);
        }
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("wickedways")
    }

    /// A storage key as a filename: the key's `:` separators become `_` (keys are the web
    /// build's `localStorage` keys, e.g. `wickedways:save:slot`).
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
        std::fs::write(key_path(key), value).map_err(|e| format!("write save: {e}"))
    }
}

pub use imp::*;
