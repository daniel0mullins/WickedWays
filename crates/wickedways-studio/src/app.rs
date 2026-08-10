//! The root app: routing, the studio store context, and navigation.

use dioxus::prelude::*;

use crate::model::EditorDoc;
use crate::platform;
use crate::refs::{check_refs, StudioProblem};

/// The studio's route, serialized to the URL query (`?c=<campaign>&s=<section>&a=<asset>`)
/// so every editor location is deep-linkable — the play client's launcher idiom.
#[derive(Clone, Debug, PartialEq)]
pub enum StudioRoute {
    /// The campaign list.
    Home,
    /// The editor shell for one stored campaign.
    Edit {
        campaign: String,
        section: String,
        asset: Option<u64>,
    },
}

/// Read the route from the page URL.
#[must_use]
pub fn read_route() -> StudioRoute {
    match platform::query_param("c") {
        Some(campaign) => StudioRoute::Edit {
            campaign,
            section: platform::query_param("s").unwrap_or_else(|| "settings".into()),
            asset: platform::query_param("a").and_then(|a| a.parse().ok()),
        },
        None => StudioRoute::Home,
    }
}

/// Move to `next`, syncing the URL query first (the state stays deep-linkable).
pub fn navigate(mut route: Signal<StudioRoute>, next: StudioRoute) {
    match &next {
        StudioRoute::Home => platform::clear_params(&["c", "s", "a"]),
        StudioRoute::Edit {
            campaign,
            section,
            asset,
        } => {
            platform::set_params(&[("c", campaign.as_str()), ("s", section.as_str())]);
            match asset {
                Some(id) => platform::set_params(&[("a", &id.to_string())]),
                None => platform::clear_params(&["a"]),
            }
        }
    }
    route.set(next);
}

/// The editor's shared state — the codebase's first `provide_context` (a document
/// editor's deep CRUD tree is what finally justifies one; see the spec §Architecture).
#[derive(Clone, Copy)]
pub struct StudioStore {
    /// The stored campaign id the open document belongs to.
    pub campaign_id: Signal<String>,
    /// The document under edit.
    pub doc: Signal<EditorDoc>,
    /// Live referential-integrity findings, refreshed on every mutation.
    pub problems: Signal<Vec<StudioProblem>>,
    /// A persistent storage-failure banner (never a silent drop).
    pub save_error: Signal<Option<String>>,
    /// The app route — screens navigate (select assets, jump across sections)
    /// through the store.
    pub route: Signal<StudioRoute>,
}

impl StudioStore {
    /// Jump to a section (optionally selecting an asset), keeping the URL in sync.
    pub fn select(self, section: &str, asset: Option<u64>) {
        let campaign = (self.campaign_id)();
        navigate(
            self.route,
            StudioRoute::Edit {
                campaign,
                section: section.to_string(),
                asset,
            },
        );
    }

    /// Apply a mutation, then re-lint and write through to storage. Returns the
    /// closure's value (add-handlers return the minted id to select it).
    pub fn mutate<R>(mut self, f: impl FnOnce(&mut EditorDoc) -> R) -> R {
        let mut doc = self.doc.write();
        let out = f(&mut doc);
        let snapshot = doc.clone();
        drop(doc);
        self.problems.set(check_refs(&snapshot));
        let id = (self.campaign_id)();
        match crate::store::save_campaign(&id, &snapshot, platform::now_ms()) {
            Ok(()) => self.save_error.set(None),
            Err(e) => self.save_error.set(Some(e)),
        }
        out
    }
}

/// The root component: route signal + the top-level match.
pub fn studio_app() -> Element {
    let route = use_signal(read_route);
    rsx! {
        style { {include_str!("../assets/studio.css")} }
        match route() {
            StudioRoute::Home => rsx! { crate::ui::home::HomeView { route } },
            StudioRoute::Edit { campaign, section, asset } => {
                // The remount key formats `campaign` while the prop consumes it —
                // a copy keeps the release rsx expansion (which moves eagerly) happy.
                let ckey = campaign.clone();
                rsx! {
                    crate::ui::shell::EditorShell {
                        key: "{ckey}",
                        campaign,
                        section,
                        asset,
                        route,
                    }
                }
            }
        }
    }
}
