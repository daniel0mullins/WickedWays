//! The launcher (Phase 2c, sub-project D).
//!
//! The root Dioxus app and campaign-selection shell, ported from `play-runtime/launcher.ts` +
//! `components/campaign-menu.ts` + `components/surface-picker.ts`. It reads `?campaign=` / `?surface=`
//! and routes ([`resolve_route`](crate::driver::resolve_route)):
//!
//! - no (valid) campaign → the **campaign menu** (pick from [`campaign_registry`]);
//! - a campaign with ≥ 2 surfaces and no chosen surface → the **surface picker**;
//! - a campaign + surface (deep-link or picked) → mounts that surface (the [`crt`](crate::crt)
//!   terminal or the [`pnc`](crate::pnc) scene), with a floating "back to campaigns" control layered
//!   over it.
//!
//! Navigation writes the route into the URL query (`history.replaceState`, no reload) so every state
//! is deep-linkable and the browser back-button-free flow stays shareable; returning to the menu
//! clears those params. The mounted surface reads the freshly-set params through
//! [`read_config`](crate::driver::read_config), and is keyed on `campaign+surface` so switching
//! campaigns remounts a clean session. The pure routing decision is host-tested in
//! [`driver`](crate::driver); this UI shell is browser-verified.

use dioxus::prelude::*;

use crate::crt::crt_app;
use crate::driver::{
    campaign_registry, clear_params, read_route, resolve_campaign_info, resolve_route, set_params,
    surface_info, LauncherRoute,
};
use crate::pnc::pnc_app;

const LAUNCHER_CSS: &str = include_str!("../assets/launcher.css");

/// The root app: reads the initial route from the URL, then renders menu / picker / surface.
pub fn launcher_app() -> Element {
    let route = use_signal(read_route);
    rsx! {
        style { "{LAUNCHER_CSS}" }
        match route() {
            LauncherRoute::Menu => menu_view(route),
            LauncherRoute::Picker { slug } => picker_view(slug, route),
            LauncherRoute::Surface { slug, surface } => surface_view(slug, surface, route),
        }
    }
}

/// Move the launcher to `next`, syncing the URL query first so the mounted surface reads the right
/// params and the state stays deep-linkable.
fn navigate(mut route: Signal<LauncherRoute>, next: LauncherRoute) {
    match &next {
        LauncherRoute::Surface { slug, surface } => set_params(&[("campaign", slug), ("surface", surface)]),
        LauncherRoute::Picker { slug } => {
            set_params(&[("campaign", slug)]);
            clear_params(&["surface"]);
        }
        LauncherRoute::Menu => clear_params(&["campaign", "surface", "theme"]),
    }
    route.set(next);
}

/// The campaign menu: one entry per registered campaign. Selecting one follows [`resolve_route`]
/// (straight to the surface, or the picker if the campaign offers ≥ 2).
fn menu_view(route: Signal<LauncherRoute>) -> Element {
    rsx! {
        div { class: "launcher",
            div { class: "launcher-menu",
                h1 { class: "launcher-heading", "WICKEDWAYS" }
                p { class: "launcher-sub", "Choose a campaign" }
                for c in campaign_registry() {
                    button {
                        key: "{c.slug}",
                        class: "launcher-entry",
                        onclick: move |_| navigate(route, resolve_route(Some(c.slug), None)),
                        span { class: "launcher-title", "{c.title}" }
                        span { class: "launcher-blurb", "{c.blurb}" }
                    }
                }
            }
        }
    }
}

/// The surface picker for a campaign that offers ≥ 2 surfaces; "← Campaigns" returns to the menu.
fn picker_view(slug: String, route: Signal<LauncherRoute>) -> Element {
    let info = resolve_campaign_info(Some(&slug));
    let title = info.map(|i| i.title).unwrap_or("");
    let surfaces = info.map(|i| i.surfaces).unwrap_or(&[]);
    rsx! {
        div { class: "launcher",
            div { class: "launcher-menu",
                button {
                    class: "launcher-back",
                    onclick: move |_| navigate(route, LauncherRoute::Menu),
                    "← Campaigns"
                }
                h1 { class: "launcher-heading", "{title}" }
                p { class: "launcher-sub", "Choose an interface" }
                for sid in surfaces {
                    {
                        let sid = *sid;
                        let label = surface_info(sid).map(|s| s.label).unwrap_or(sid);
                        let desc = surface_info(sid).map(|s| s.description).unwrap_or("");
                        let slug = slug.clone();
                        rsx! {
                            button {
                                key: "{sid}",
                                class: "launcher-entry",
                                onclick: move |_| navigate(route, LauncherRoute::Surface { slug: slug.clone(), surface: sid.into() }),
                                span { class: "launcher-title", "{label}" }
                                span { class: "launcher-blurb", "{desc}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The mounted surface, with the launcher's floating "back to campaigns" chrome layered over it. Keyed
/// on `campaign+surface` so switching either remounts a fresh surface session.
fn surface_view(slug: String, surface: String, route: Signal<LauncherRoute>) -> Element {
    let key = format!("{slug}-{surface}");
    rsx! {
        button {
            class: "launcher-exit",
            title: "Back to campaigns",
            onclick: move |_| navigate(route, LauncherRoute::Menu),
            "☰"
        }
        match surface.as_str() {
            "point-and-click" => rsx! { PncSurface { key: "{key}" } },
            _ => rsx! { CrtSurface { key: "{key}" } },
        }
    }
}

/// PascalCase component wrappers so each mounted surface gets its own hook scope (calling the surface
/// fn as a component, not inline, keeps its `use_signal`/`use_coroutine` state isolated from the shell).
#[component]
fn CrtSurface() -> Element {
    crt_app()
}

#[component]
fn PncSurface() -> Element {
    pnc_app()
}
