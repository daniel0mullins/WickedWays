//! The launcher.
//!
//! The root Dioxus app and campaign-selection shell. It reads `?campaign=` / `?surface=`
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
    clear_params, debug_enabled, menu_campaigns, mint_room_id, read_config, read_route,
    resolve_campaign_info, resolve_route, set_params, surface_info, LauncherRoute, Mode,
};
use crate::lobby::MultiplayerLobby;
use crate::pnc::pnc_app;

const LAUNCHER_CSS: &str = include_str!("../assets/launcher.css");

/// The root app: reads the initial route from the URL, then renders menu / picker / surface.
pub fn launcher_app() -> Element {
    let route = use_signal(read_route);
    // `?debug` unlocks the demo/conformance campaigns; read once (it persists in the URL across
    // navigation, which only rewrites campaign/surface/theme).
    let debug = use_hook(debug_enabled);
    rsx! {
        style { "{LAUNCHER_CSS}" }
        // `MenuView` / `SurfaceView` are components (not inline calls) so their hooks live in their own
        // scopes — the `match` mounts/unmounts them by route without perturbing this shell's hook order
        // (calling a hook-bearing fn conditionally here would violate the rules of hooks). `picker_view`
        // has no hooks, so it stays a plain builder.
        match route() {
            LauncherRoute::Menu => rsx! { MenuView { route, debug } },
            LauncherRoute::Picker { slug } => picker_view(&slug, route),
            LauncherRoute::Surface { slug, surface } => rsx! { SurfaceView { slug, surface, route } },
        }
    }
}

/// Move the launcher to `next`, syncing the URL query first so the mounted surface reads the right
/// params and the state stays deep-linkable.
fn navigate(mut route: Signal<LauncherRoute>, next: LauncherRoute) {
    match &next {
        LauncherRoute::Surface { slug, surface } => {
            set_params(&[("campaign", slug), ("surface", surface)]);
        }
        LauncherRoute::Picker { slug } => {
            set_params(&[("campaign", slug)]);
            clear_params(&["surface"]);
        }
        // Returning to the menu also clears the per-selection mode/token so the next pick starts clean
        // (a previous host's `token=gm` or a single-player `mode=single` must not leak into it).
        LauncherRoute::Menu => clear_params(&["campaign", "surface", "theme", "mode", "token"]),
    }
    route.set(next);
}

/// Select a campaign from the menu. A **multiplayer** campaign hosts a fresh room (`<slug>~<token>`)
/// with this client as GM (`token=gm`); a **single-player** campaign launches offline (`?mode=single`).
/// Either way the selection's params are set before [`navigate`] so the mounted lobby/surface reads them.
fn select_campaign(route: Signal<LauncherRoute>, slug: &str, multiplayer: bool, debug: bool) {
    if multiplayer {
        set_params(&[("token", "gm")]);
        clear_params(&["mode"]);
        let room = mint_room_id(slug);
        navigate(route, resolve_route(Some(&room), None, debug));
    } else {
        set_params(&[("mode", "single")]);
        clear_params(&["token"]);
        navigate(route, resolve_route(Some(slug), None, debug));
    }
}

/// Join an existing multiplayer room by the id a host shared — as a PLAYER, not the GM. Clears any host
/// `token=gm` / single-player `mode` so this client joins with a fresh player identity over the wire.
fn join_by_id(route: Signal<LauncherRoute>, id: &str, debug: bool) {
    let id = id.trim();
    if id.is_empty() {
        return;
    }
    clear_params(&["token", "mode"]);
    navigate(route, resolve_route(Some(id), None, debug));
}

/// The campaign menu: the shipped Hollow House, plus the debug/conformance campaigns when `?debug`.
/// Selecting one follows [`resolve_route`] (straight to the surface, or the picker if it offers ≥ 2). A
/// component (not an inline builder) because it owns a hook (`join_id`) — see the `match` in
/// [`launcher_app`].
#[component]
fn MenuView(route: Signal<LauncherRoute>, debug: bool) -> Element {
    let join_id = use_signal(String::new);
    let mut join_err = use_signal(String::new);
    // Try to join the id in the box; set a visible message instead of silently doing nothing when it's
    // empty or isn't a known game. A `use_callback` is Copy, so both handlers can call it.
    let try_join = use_callback(move |()| {
        let id = join_id().trim().to_string();
        if id.is_empty() {
            join_err.set("Enter a game ID to join.".into());
        } else if resolve_campaign_info(Some(&id)).is_none() {
            join_err.set(format!("No game found for \u{201c}{id}\u{201d}."));
        } else {
            join_err.set(String::new());
            join_by_id(route, &id, debug);
        }
    });
    rsx! {
        div { class: "launcher",
            div { class: "launcher-menu",
                h1 { class: "launcher-heading", "WICKEDWAYS" }
                p { class: "launcher-sub", "Choose a campaign" }
                // A build with no multiplayer transport (the desktop app) lists only the
                // single-player campaigns and offers no join-by-id.
                for c in menu_campaigns(debug).into_iter().filter(|c| crate::platform::MULTIPLAYER || !c.multiplayer) {
                    button {
                        key: "{c.slug}",
                        class: "launcher-entry",
                        onclick: move |_| select_campaign(route, c.slug, c.multiplayer, debug),
                        span { class: "launcher-title", "{c.title}" }
                        span { class: "launcher-blurb", "{c.blurb}" }
                    }
                }
                if crate::platform::MULTIPLAYER {
                div { class: "launcher-joinbyid",
                    p { class: "launcher-joinlabel", "Have a game ID from a host? Join their game:" }
                    div { class: "launcher-joinrow",
                        input {
                            class: "launcher-joininput",
                            value: "{join_id}",
                            placeholder: "paste game ID (e.g. covenant~a5f3)",
                            oninput: move |e| { let mut j = join_id; j.set(e.value()); if !join_err().is_empty() { join_err.set(String::new()); } },
                            onkeydown: move |e| { if e.key() == Key::Enter { try_join(()); } },
                        }
                        button {
                            class: "launcher-joinbtn",
                            disabled: join_id().trim().is_empty(),
                            onclick: move |_| try_join(()),
                            "Join"
                        }
                    }
                    if !join_err().is_empty() {
                        p { class: "launcher-joinerr", "{join_err}" }
                    }
                }
                }
            }
        }
    }
}

/// The surface picker for a campaign that offers ≥ 2 surfaces; "← Campaigns" returns to the menu.
fn picker_view(slug: &str, route: Signal<LauncherRoute>) -> Element {
    let info = resolve_campaign_info(Some(slug));
    let title = info.map_or("", |i| i.title);
    let surfaces: &[_] = info.map_or(&[], |i| i.surfaces);
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
                        let label = surface_info(sid).map_or(sid, |s| s.label);
                        let desc = surface_info(sid).map_or("", |s| s.description);
                        let slug = slug.to_string();
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
/// on `campaign+surface` so switching either remounts a fresh surface session. In multiplayer, the
/// [`MultiplayerLobby`] gates the surface first — the player joins a character (name + archetype) and
/// the GM starts — and `on_enter` hands off to the actual surface (which reconnects with the same
/// identity, so the joined seat carries over). A component (not an inline builder) because it owns
/// hooks (`mode`, `entered`) — see the `match` in [`launcher_app`].
#[component]
fn SurfaceView(slug: String, surface: String, route: Signal<LauncherRoute>) -> Element {
    let mode = use_hook(|| read_config().mode);
    let mut entered = use_signal(|| false);
    let key = format!("{slug}-{surface}");
    let in_lobby = matches!(mode, Mode::Multi) && !entered();
    rsx! {
        button {
            class: "launcher-exit",
            title: "Back to campaigns",
            onclick: move |_| navigate(route, LauncherRoute::Menu),
            "☰"
        }
        if in_lobby {
            MultiplayerLobby { key: "lobby-{slug}", slug: slug.clone(), on_enter: move |()| entered.set(true) }
        } else {
            match surface.as_str() {
                "point-and-click" => rsx! { PncSurface { key: "{key}" } },
                _ => rsx! { CrtSurface { key: "{key}" } },
            }
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
