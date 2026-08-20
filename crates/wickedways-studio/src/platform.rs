//! The platform seam — the browser services the studio needs.
//!
//! A trimmed copy of the play client's seam (`wickedways-web/src/platform.rs`),
//! browser arm only (a `native-app` arm is deferred; the seam keeps the door open).
//! The functions compile on the host too — `web-sys` externs — which keeps the
//! model/refs/gate layers host-testable.

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
        let _ = history.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&url.href()));
    }
}

/// Merge `pairs` into the page URL's query (no reload), so every editor location is
/// deep-linkable.
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

/// Persist a value. Errors when storage is unavailable (private-mode / disabled
/// storage) or full — surfaced as a banner, never a silent drop.
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

/// Milliseconds since the epoch — campaign-id minting and `updated_at` stamps.
/// Client bookkeeping only, never game state (engine randomness/time is forbidden
/// outside `World.rng`).
pub fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

/// Trigger a browser download of `text` as `filename` with the given MIME type
/// (a transient `a[download]` with a data: URI — no Blob APIs). Built and clicked
/// only when the user asks for an export, so the document is never re-serialized
/// per render.
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
