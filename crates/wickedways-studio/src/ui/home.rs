//! The campaign list — the studio's home screen.

use dioxus::prelude::*;

use crate::app::{navigate, StudioRoute};
use crate::export::{export_filename, import, to_toml};
use crate::model::EditorDoc;
use crate::platform;
use crate::store::{self, IndexEntry};

/// The featured "start from template" seeds — full campaigns.
const TEMPLATES: &[(&str, &str)] = &[
    (
        "Hollow House (the full campaign)",
        include_str!("../../../../campaigns/hollow-house.toml"),
    ),
    (
        "Covenant (crafting: caches + recipes)",
        include_str!("../../../../campaigns/covenant.toml"),
    ),
    (
        "Vault (a keyed door)",
        include_str!("../../../../campaigns/g2-vault.toml"),
    ),
];

/// The full gallery — every single-feature `g2-*` fixture, each the smallest
/// working example of one mechanic (the fixtures corpus doubles as the template
/// library, per the spec).
const GALLERY: &[(&str, &str)] = &[
    (
        "archetypes",
        include_str!("../../../../campaigns/g2-archetype.toml"),
    ),
    (
        "dark rooms",
        include_str!("../../../../campaigns/g2-dark-rooms.toml"),
    ),
    (
        "a scripted door",
        include_str!("../../../../campaigns/g2-door.toml"),
    ),
    (
        "effects",
        include_str!("../../../../campaigns/g2-effects.toml"),
    ),
    (
        "equipment",
        include_str!("../../../../campaigns/g2-equipment.toml"),
    ),
    (
        "stateful exits",
        include_str!("../../../../campaigns/g2-exit-state.toml"),
    ),
    (
        "formations",
        include_str!("../../../../campaigns/g2-formations.toml"),
    ),
    (
        "a consumable item",
        include_str!("../../../../campaigns/g2-item.toml"),
    ),
    (
        "a mechanic",
        include_str!("../../../../campaigns/g2-mechanic.toml"),
    ),
    (
        "mechanic actions",
        include_str!("../../../../campaigns/g2-mechanic-actions.toml"),
    ),
    ("mobs", include_str!("../../../../campaigns/g2-mobs.toml")),
    (
        "an NPC dialogue",
        include_str!("../../../../campaigns/g2-npc.toml"),
    ),
    (
        "campaign opts",
        include_str!("../../../../campaigns/g2-opts.toml"),
    ),
    (
        "a scene",
        include_str!("../../../../campaigns/g2-scene.toml"),
    ),
    (
        "the status bar",
        include_str!("../../../../campaigns/g2-status-bar.toml"),
    ),
    (
        "the storyteller",
        include_str!("../../../../campaigns/g2-storyteller.toml"),
    ),
    (
        "timeout narration",
        include_str!("../../../../campaigns/g2-timeout.toml"),
    ),
    (
        "victory conditions",
        include_str!("../../../../campaigns/g2-victory.toml"),
    ),
    (
        "a villain + deck",
        include_str!("../../../../campaigns/g2-villain.toml"),
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
    // `use_memo` ≈ `useMemo`, but dependencies are tracked by READS, not a deps
    // array: calling `refresh()` inside subscribes the memo to that signal, so
    // bumping `refresh` after a delete/duplicate recomputes the index.
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
            details { class: "studio-gallery",
                summary { "Template gallery — one minimal example per mechanic" }
                div { class: "studio-home-actions",
                    for (label, toml_src) in GALLERY {
                        button {
                            key: "{label}",
                            class: "studio-btn small",
                            onclick: move |_| {
                                match import(toml_src) {
                                    Ok(doc) => create_and_open(route, &doc, &mut err),
                                    Err(e) => err.set(format!("Template failed to parse: {e}")),
                                }
                            },
                            "{label}"
                        }
                    }
                }
            }
            if import_open() {
                div { class: "studio-import",
                    label { class: "studio-btn",
                        "Choose a .toml file…"
                        input {
                            r#type: "file",
                            accept: ".toml",
                            style: "display: none",
                            onchange: move |e| {
                                if let Some(files) = e.files() {
                                    let mut err = err;
                                    // `spawn` schedules a future on the component —
                                    // the async-event-handler idiom (file reads are
                                    // async in the browser).
                                    spawn(async move {
                                        for name in files.files() {
                                            match files.read_file_to_string(&name).await {
                                                Some(text) => match import(&text) {
                                                    Ok(doc) => create_and_open(route, &doc, &mut err),
                                                    Err(e) => err.set(format!("{name}: import failed: {e}")),
                                                },
                                                None => err.set(format!("{name}: could not read the file")),
                                            }
                                        }
                                    });
                                }
                            },
                        }
                    }
                    p { "…or paste a campaign TOML file:" }
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
                    {
                        let row_key = entry.id.clone();
                        rsx! { CampaignRow { key: "{row_key}", entry, route, refresh, err } }
                    }
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
    // Props arrive immutable; Signals are `Copy` handles, so rebinding them as
    // `mut` locals is free — both copies point at the same state.
    let mut refresh = refresh;
    let mut err = err;
    // One owned copy of the id per `move` handler below: each closure OWNS its
    // captures (there is no shared GC reference to a `String`), so an id used by
    // four handlers is cloned four times up front.
    let id = entry.id.clone();
    let open_id = id.clone();
    let dup_id = id.clone();
    let del_id = id.clone();
    let exp_id = id.clone();
    let mut confirm_delete = use_signal(|| false);

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
                // Serializes on click only (platform::download_text), not per render.
                button {
                    class: "studio-btn small",
                    onclick: move |_| {
                        if let store::Loaded::Ok(doc) = store::load_campaign(&exp_id) {
                            match to_toml(&doc) {
                                Ok(toml_src) => platform::download_text(
                                    &export_filename(&doc.title),
                                    "application/toml",
                                    &toml_src,
                                ),
                                Err(e) => err.set(format!("Export failed: {e}")),
                            }
                        } else {
                            err.set("This campaign cannot be exported here (missing or newer-schema blob).".into());
                        }
                    },
                    "Export"
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
                                "This campaign was saved by a newer studio (schema v{v}) and cannot be opened by this one."
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
