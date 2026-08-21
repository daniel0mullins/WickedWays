//! The editor shell: left nav with live problem badges, the header (save state,
//! Check campaign, Export), the section dispatch, and the problems panel.

use dioxus::prelude::*;

use crate::app::{navigate, StudioRoute, StudioStore};
use crate::export::{export_filename, to_toml};
use crate::gate::{check_campaign, GateReport};
use crate::model::EditorDoc;
use crate::refs::{check_refs, Severity, StudioProblem};
use crate::store::{self, Loaded};
use crate::ui::behaviors::BehaviorsScreen;
use crate::ui::screens::{
    ArchetypesScreen, CachesScreen, CardsScreen, ExitsScreen, FormationsScreen, ItemsScreen,
    LootScreen, MechanicsScreen, MobsScreen, NpcsScreen, RecipesScreen, RoomsScreen, ScenesScreen,
    SettingsScreen, VictoryScreen, VillainScreen,
};

/// The nav sections, in shell order: (slug, label).
const SECTIONS: &[(&str, &str)] = &[
    ("settings", "Settings"),
    ("rooms", "Rooms"),
    ("map", "Map"),
    ("exits", "Exits"),
    ("items", "Items"),
    ("loot", "Loot"),
    ("caches", "Caches"),
    ("recipes", "Recipes"),
    ("mobs", "Mobs"),
    ("npcs", "NPCs"),
    ("archetypes", "Archetypes"),
    ("formations", "Formations"),
    ("scenes", "Scenes"),
    ("mechanics", "Mechanics"),
    ("cards", "Cards"),
    ("villain", "Villain"),
    ("victory", "Victory"),
    ("behaviors", "Behaviors"),
];

#[component]
pub fn EditorShell(
    campaign: String,
    section: String,
    asset: Option<u64>,
    route: Signal<StudioRoute>,
) -> Element {
    // Load once per mounted shell (the shell is keyed on the campaign id).
    let initial = use_hook(|| {
        match store::load_campaign(&campaign) {
        Loaded::Ok(doc) => Ok(*doc),
        Loaded::NewerSchema(v) => Err(format!(
            "This campaign was saved by a newer studio (schema v{v}) and cannot be opened by this one — opening it here could silently drop fields it doesn't know. The stored blob is untouched; use the newer studio."
        )),
        Loaded::Missing => Err("No campaign stored under this id.".to_string()),
    }
    });
    let campaign_id = use_signal(|| campaign.clone());
    let doc = use_signal(|| {
        initial
            .clone()
            .unwrap_or_else(|_| EditorDoc::new_blank("(unavailable)"))
    });
    let problems = use_signal(|| check_refs(&doc.peek()));
    let save_error = use_signal(|| None::<String>);
    let mut gate_report = use_signal(|| None::<GateReport>);
    let undo = use_signal(Vec::new);
    let undo_stamp = use_signal(|| 0u64);
    let store = use_context_provider(|| StudioStore {
        campaign_id,
        doc,
        problems,
        save_error,
        route,
        undo,
        undo_stamp,
    });

    if let Err(msg) = initial {
        return rsx! {
            div { class: "studio-shell-error",
                p { "{msg}" }
                button {
                    class: "studio-btn",
                    onclick: move |_| navigate(route, StudioRoute::Home),
                    "← Back to campaigns"
                }
            }
        };
    }

    let current = doc();
    let probs = problems();
    let error_count = probs
        .iter()
        .filter(|p| p.severity == Severity::Error)
        .count();

    rsx! {
        div { class: "studio-shell",
            header { class: "studio-head",
                button {
                    class: "studio-btn small",
                    onclick: move |_| navigate(route, StudioRoute::Home),
                    "← Campaigns"
                }
                h1 { class: "studio-head-title", "{current.title}" }
                span { class: "studio-savestate",
                    if let Some(err) = (store.save_error)() {
                        span { class: "studio-save-err", "⚠ not saved: {err}" }
                    } else {
                        "saved to this browser"
                    }
                }
                button {
                    class: "studio-btn",
                    disabled: (store.undo)().is_empty(),
                    onclick: move |_| store.undo(),
                    "Undo"
                }
                button {
                    class: "studio-btn",
                    onclick: move |_| gate_report.set(Some(check_campaign(&(store.doc)()))),
                    "Check campaign"
                }
                // Serialization happens ON CLICK (platform::download_text), not per
                // render — the shell re-renders on every keystroke.
                button {
                    class: "studio-btn primary",
                    onclick: move |_| {
                        let doc = (store.doc)();
                        if let Ok(toml_src) = to_toml(&doc) {
                            crate::platform::download_text(
                                &export_filename(&doc.title),
                                "application/toml",
                                &toml_src,
                            );
                        }
                    },
                    if error_count > 0 {
                        "Export ({error_count} error(s) outstanding)"
                    } else {
                        "Export .toml"
                    }
                }
            }
            div { class: "studio-main",
                nav { class: "studio-nav",
                    for (slug, label) in SECTIONS {
                        {
                            let count = probs.iter().filter(|p| p.family.slug() == *slug && p.severity != Severity::Info).count();
                            rsx! {
                                button {
                                    key: "{slug}",
                                    class: if section == *slug { "studio-navitem selected" } else { "studio-navitem" },
                                    onclick: move |_| store.select(slug, None),
                                    span { "{label}" }
                                    if count > 0 {
                                        span { class: "studio-badge", "{count}" }
                                    }
                                }
                            }
                        }
                    }
                }
                section { class: "studio-content",
                    match section.as_str() {
                        "settings" => rsx! { SettingsScreen {} },
                        "rooms" => rsx! { RoomsScreen { asset } },
                        "map" => rsx! { crate::ui::map::MapScreen {} },
                        "exits" => rsx! { ExitsScreen { asset } },
                        "items" => rsx! { ItemsScreen { asset } },
                        "loot" => rsx! { LootScreen { asset } },
                        "caches" => rsx! { CachesScreen { asset } },
                        "recipes" => rsx! { RecipesScreen { asset } },
                        "mobs" => rsx! { MobsScreen { asset } },
                        "npcs" => rsx! { NpcsScreen { asset } },
                        "archetypes" => rsx! { ArchetypesScreen { asset } },
                        "formations" => rsx! { FormationsScreen { asset } },
                        "scenes" => rsx! { ScenesScreen { asset } },
                        "mechanics" => rsx! { MechanicsScreen { asset } },
                        "cards" => rsx! { CardsScreen { asset } },
                        "villain" => rsx! { VillainScreen {} },
                        "victory" => rsx! { VictoryScreen {} },
                        "behaviors" => rsx! { BehaviorsScreen {} },
                        _ => rsx! { SettingsScreen {} },
                    }
                }
            }
            ProblemsPanel { problems: probs }
            if let Some(report) = gate_report() {
                GateOverlay { report, on_close: move |()| gate_report.set(None) }
            }
        }
    }
}

#[component]
fn ProblemsPanel(problems: Vec<StudioProblem>) -> Element {
    let store = use_context::<StudioStore>();
    let errors = problems
        .iter()
        .filter(|p| p.severity == Severity::Error)
        .count();
    let warns = problems
        .iter()
        .filter(|p| p.severity == Severity::Warning)
        .count();
    let infos = problems
        .iter()
        .filter(|p| p.severity == Severity::Info)
        .count();
    rsx! {
        details { class: "studio-problems", open: errors > 0,
            summary {
                if problems.is_empty() {
                    "No problems — references check out"
                } else {
                    "{errors} error(s) · {warns} warning(s) · {infos} note(s)"
                }
            }
            div { class: "studio-problems-list",
                for (i, p) in problems.into_iter().enumerate() {
                    {
                        let sev_class = match p.severity {
                            Severity::Error => "studio-problem error",
                            Severity::Warning => "studio-problem warn",
                            Severity::Info => "studio-problem info",
                        };
                        let slug = p.family.slug();
                        let asset = p.asset;
                        rsx! {
                            button {
                                key: "{i}",
                                class: sev_class,
                                onclick: move |_| store.select(slug, asset),
                                "{p.message}"
                            }
                        }
                    }
                }
            }
        }
    }
}

// The playtest handoff: on a green gate the compiled genesis + catalog are written under these
// storage keys and the game client (served same-origin at `/`) is opened on the `playtest`
// campaign. The key + URL literals are MIRRORED in `wickedways-web` (`driver.rs`) — change both
// sides or the handoff breaks.
const PLAYTEST_GENESIS_KEY: &str = "wickedways:playtest:genesis";
const PLAYTEST_CATALOG_KEY: &str = "wickedways:playtest:catalog";
const PLAYTEST_URL: &str = "/?campaign=playtest&mode=single";

#[component]
fn GateOverlay(report: GateReport, on_close: EventHandler<()>) -> Element {
    let store = use_context::<StudioStore>();
    // Compiled-artifact downloads (green gate only): the same files `wwauthor`
    // writes, named `<title-slug>.<artifact>.json`.
    let artifacts: Vec<(&str, Option<String>)> = vec![
        ("description", report.description_json.clone()),
        ("catalog", report.catalog_json.clone()),
        ("genesis", report.genesis_json.clone()),
    ];
    // Playtest needs the genesis (the catalog may legally be empty-but-present; a green gate
    // serializes both, but degrade gracefully if only the genesis is there).
    let playtest = report
        .genesis_json
        .clone()
        .map(|g| (g, report.catalog_json.clone()));
    rsx! {
        div { class: "studio-overlay", onclick: move |_| on_close.call(()),
            div { class: "studio-overlay-frame", onclick: move |e| e.stop_propagation(),
                if report.ok() {
                    h2 { class: "studio-gate-ok", "✓ Campaign checks out" }
                    p { "It compiles, assembles, and loads — the full engine pipeline is green." }
                    if let Some((genesis, catalog)) = playtest {
                        div { class: "studio-playtest",
                            button {
                                class: "studio-btn",
                                onclick: move |_| {
                                    if crate::platform::storage_write(PLAYTEST_GENESIS_KEY, &genesis).is_ok() {
                                        match &catalog {
                                            Some(c) => {
                                                let _ = crate::platform::storage_write(PLAYTEST_CATALOG_KEY, c);
                                            }
                                            None => crate::platform::storage_delete(PLAYTEST_CATALOG_KEY),
                                        }
                                        crate::platform::open_url(PLAYTEST_URL);
                                    }
                                },
                                "▶ Playtest"
                            }
                            span { class: "studio-playtest-hint",
                                "Saves this build as the game's “Studio Playtest” campaign and opens it."
                            }
                        }
                    }
                    div { class: "studio-artifacts",
                        for (kind, json) in artifacts {
                            if let Some(json) = json {
                                button {
                                    key: "{kind}",
                                    class: "studio-btn small",
                                    onclick: move |_| {
                                        let stem = crate::export::export_filename(&(store.doc)().title);
                                        let stem = stem.trim_end_matches(".toml");
                                        crate::platform::download_text(
                                            &format!("{stem}.{kind}.json"),
                                            "application/json",
                                            &json,
                                        );
                                    },
                                    "Download {kind}.json"
                                }
                            }
                        }
                    }
                } else {
                    h2 { class: "studio-gate-bad", "Campaign has problems" }
                    if !report.compile_errors.is_empty() {
                        h3 { "Compile ({report.compile_errors.len()} finding(s))" }
                        for (i, e) in report.compile_errors.iter().enumerate() {
                            p { key: "{i}", class: "studio-gate-err", "{e}" }
                        }
                    }
                    if !report.assemble_problems.is_empty() {
                        h3 { "Assemble ({report.assemble_problems.len()} problem(s))" }
                        for (i, p) in report.assemble_problems.iter().enumerate() {
                            p { key: "{i}", class: "studio-gate-err", "{p}" }
                        }
                    }
                    if let Some(e) = &report.mechanics_error {
                        h3 { "Engine load (validate_mechanics)" }
                        p { class: "studio-gate-err", "{e}" }
                    }
                }
                button { class: "studio-btn", onclick: move |_| on_close.call(()), "Close" }
            }
            div { class: "studio-overlay-legend", "click outside to close" }
        }
    }
}
