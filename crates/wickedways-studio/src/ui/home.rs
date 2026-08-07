//! The campaign list — the studio's home screen.

use dioxus::prelude::*;

use crate::app::{navigate, StudioRoute};
use crate::export::{export_filename, import, to_toml};
use crate::model::EditorDoc;
use crate::platform;
use crate::store::{self, IndexEntry};

/// Bundled fixture campaigns offered as "start from template" seeds.
const TEMPLATES: &[(&str, &str)] = &[
    (
        "Hollow House (the full campaign)",
        include_str!("../../../../conformance/fixtures/hollow-house.toml"),
    ),
    (
        "Covenant (crafting: caches + recipes)",
        include_str!("../../../../conformance/fixtures/covenant.toml"),
    ),
    (
        "Vault (a keyed door)",
        include_str!("../../../../conformance/fixtures/g2-vault.toml"),
    ),
];

/// Create a campaign from a document and open it.
fn create_and_open(route: Signal<StudioRoute>, doc: &EditorDoc, err: &mut Signal<String>) {
    let id = store::mint_campaign_id(platform::now_ms());
    match store::save_campaign(&id, doc, platform::now_ms()) {
        Ok(()) => navigate(
            route,
            StudioRoute::Edit {
                campaign: id,
                section: "settings".into(),
                asset: None,
            },
        ),
        Err(e) => err.set(format!("Could not save the new campaign: {e}")),
    }
}

#[component]
pub fn HomeView(route: Signal<StudioRoute>) -> Element {
    let refresh = use_signal(|| 0u32);
    let mut err = use_signal(String::new);
    let mut import_open = use_signal(|| false);
    let mut import_text = use_signal(String::new);
    let index = use_memo(move || {
        let _ = refresh();
        store::read_index()
    });
    let usage_kb = use_memo(move || {
        let _ = refresh();
        store::usage_bytes() / 1024
    });

    rsx! {
        div { class: "studio-home",
            header { class: "studio-home-head",
                h1 { "CAMPAIGN STUDIO" }
                p { class: "studio-sub", "Author WickedWays campaigns — stored in this browser, exported as TOML." }
            }
            if !err().is_empty() {
                p { class: "studio-error-banner", "{err}" }
            }
            div { class: "studio-home-actions",
                button {
                    class: "studio-btn primary",
                    onclick: move |_| create_and_open(route, &EditorDoc::new_blank("Untitled Campaign"), &mut err),
                    "New blank campaign"
                }
                for (label, toml_src) in TEMPLATES {
                    button {
                        key: "{label}",
                        class: "studio-btn",
                        onclick: move |_| {
                            match import(toml_src) {
                                Ok(doc) => create_and_open(route, &doc, &mut err),
                                Err(e) => err.set(format!("Template failed to parse: {e}")),
                            }
                        },
                        "New from: {label}"
                    }
                }
                button {
                    class: "studio-btn",
                    onclick: move |_| import_open.set(!import_open()),
                    "Import .toml…"
                }
            }
            if import_open() {
                div { class: "studio-import",
                    p { "Paste a campaign TOML file (or open one and copy its contents):" }
                    textarea {
                        class: "studio-import-text",
                        value: "{import_text}",
                        oninput: move |e| import_text.set(e.value()),
                        placeholder: "title = \"…\"",
                    }
                    button {
                        class: "studio-btn primary",
                        disabled: import_text().trim().is_empty(),
                        onclick: move |_| {
                            match import(&import_text()) {
                                Ok(doc) => {
                                    import_text.set(String::new());
                                    import_open.set(false);
                                    create_and_open(route, &doc, &mut err);
                                }
                                Err(e) => err.set(format!("Import failed: {e}")),
                            }
                        },
                        "Import as new campaign"
                    }
                }
            }
            div { class: "studio-home-list",
                if index().is_empty() {
                    p { class: "studio-empty", "No campaigns yet — create one above." }
                }
                for entry in index() {
                    CampaignRow { key: "{entry.id}", entry, route, refresh, err }
                }
            }
            p { class: "studio-usage", "~{usage_kb} KB of browser storage in use" }
        }
    }
}

#[component]
fn CampaignRow(
    entry: IndexEntry,
    route: Signal<StudioRoute>,
    refresh: Signal<u32>,
    err: Signal<String>,
) -> Element {
    let mut refresh = refresh;
    let mut err = err;
    let id = entry.id.clone();
    let open_id = id.clone();
    let dup_id = id.clone();
    let del_id = id.clone();
    let exp_id = id.clone();
    let mut confirm_delete = use_signal(|| false);
    // The export link is a data: URI so no Blob APIs are needed.
    let export_href = use_memo(move || match store::load_campaign(&exp_id) {
        store::Loaded::Ok(doc) => to_toml(&doc).ok().map(|t| {
            let encoded = js_sys::encode_uri_component(&t);
            (
                format!("data:application/toml;charset=utf-8,{encoded}"),
                export_filename(&doc.title),
            )
        }),
        _ => None,
    });

    rsx! {
        div { class: "studio-row",
            button {
                class: "studio-row-open",
                onclick: move |_| navigate(route, StudioRoute::Edit {
                    campaign: open_id.clone(),
                    section: "settings".into(),
                    asset: None,
                }),
                span { class: "studio-row-title", "{entry.title}" }
                span { class: "studio-row-id", "{entry.id}" }
            }
            div { class: "studio-row-actions",
                if let Some((href, filename)) = export_href() {
                    a { class: "studio-btn small", href, download: "{filename}", "Export" }
                }
                button {
                    class: "studio-btn small",
                    onclick: move |_| {
                        match store::load_campaign(&dup_id) {
                            store::Loaded::Ok(mut doc) => {
                                doc.title = format!("{} (copy)", doc.title);
                                let new_id = store::mint_campaign_id(platform::now_ms());
                                if let Err(e) = store::save_campaign(&new_id, &doc, platform::now_ms()) {
                                    err.set(format!("Duplicate failed: {e}"));
                                }
                                refresh.set(refresh() + 1);
                            }
                            store::Loaded::NewerSchema(v) => err.set(format!(
                                "This campaign was saved by a newer studio (schema v{v}) and is read-only here."
                            )),
                            store::Loaded::Missing => err.set("Campaign blob is missing.".into()),
                        }
                    },
                    "Duplicate"
                }
                if confirm_delete() {
                    button {
                        class: "studio-btn small danger",
                        onclick: move |_| {
                            store::delete_campaign(&del_id);
                            refresh.set(refresh() + 1);
                        },
                        "Really delete?"
                    }
                    button {
                        class: "studio-btn small",
                        onclick: move |_| confirm_delete.set(false),
                        "Keep"
                    }
                } else {
                    button {
                        class: "studio-btn small danger",
                        onclick: move |_| confirm_delete.set(true),
                        "Delete"
                    }
                }
            }
        }
    }
}
