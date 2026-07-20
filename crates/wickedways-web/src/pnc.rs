//! The point-and-click Dioxus surface (Phase 2c, sub-project D — slice 3c).
//!
//! The click-driven counterpart to the CRT terminal (`main.rs`). It drives the same multiplayer loop
//! through the shared [`driver`](crate::driver) (connect → project → [`intent_to_command`] → submit →
//! narrate → map) but presents it as a scene of clickable hotspots instead of a text prompt: the
//! [`affordances`](crate::affordances) derive what each thing offers, the [`scene_layout`] places the
//! hotspots, a contextual action menu turns a click into an [`Intent`], and the sidebar shows the
//! status / inventory / running log. Ported from `packages/play-surface/src/pnc` (controller +
//! components), reusing the already-ported [`Narrator`] and [`MapModel`].
//!
//! Parity notes vs. the Lit surface: save-restore / settings menu and procedural audio are wired
//! (slice 4) — a topbar 🔊 toggle enables the shared [`AudioEngine`], which voices committed actions
//! and denials just like the CRT surface. The campaign manifest (title/intro/themes) is not carried
//! over the multiplayer wire, so this surface shows a generic welcome, a basic status line projected
//! from the `ViewModel` (the campaign `StatusField` cues aren't carried either — same as the CRT
//! surface), and a dev `nextPlayer` control. `examine`/`read` render the generic look line, since
//! per-entity lore / descriptions ride `PresentationCue`s the wire doesn't carry yet.
//!
//! [`AudioEngine`]: crate::audio_engine::AudioEngine
//!
//! [`intent_to_command`]: crate::driver::intent_to_command
//! [`Narrator`]: crate::narrator::Narrator
//! [`MapModel`]: crate::map::MapModel

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;

use crate::affordances::{inventory_actions, scene_hotspots, ActionDescriptor, HotspotKind};
use crate::audio::{error_sound, voice_for_intent};
use crate::audio_engine::AudioEngine;
use crate::driver::{
    boot, boot_single, intent_to_command, project, read_config, rebuild_single, AppTransport, Mode,
};
use crate::map::{layout_map, map_svg, MapModel};
use crate::narrator::Narrator;
use crate::savestore::{self, SaveBlob};
use crate::scene_layout::{body_position, dir_position, partition_hotspots};
use crate::theme::pnc_theme_vars;

const PNC_CSS: &str = include_str!("../assets/pnc.css");

/// One line in the running log, with a CSS class for its role (heading/error/end/plain).
#[derive(Clone, PartialEq)]
struct LogLine {
    text: String,
    class: &'static str,
}

impl LogLine {
    fn plain(text: String) -> Self {
        Self { text, class: "" }
    }
    fn heading(text: String) -> Self {
        Self { text, class: "heading" }
    }
    fn error(text: String) -> Self {
        Self { text, class: "error" }
    }
    fn end(text: String) -> Self {
        Self { text, class: "end" }
    }
}

/// An open contextual action menu: the verbs to offer and the viewport point to anchor at.
#[derive(Clone, PartialEq)]
struct ActionMenu {
    actions: Vec<ActionDescriptor>,
    x: f64,
    y: f64,
}

/// A request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum PncAction {
    /// Apply a chosen descriptor (an intent to submit, or a free examine/read).
    Run(ActionDescriptor),
    /// GM: advance to the next seat (dev affordance, mirrors the CRT control).
    NextPlayer,
    /// Single-player lifecycle verbs from the settings menu (mirror the CRT `save`/`restore`/`restart`).
    Save,
    Restore,
    Restart,
    /// Toggle procedural audio (the click is the user gesture that lets the `AudioContext` start).
    ToggleAudio,
}

/// Append the room heading + description/body to the log (mirrors the controller's `printRoom`).
fn print_room(mut log: Signal<Vec<LogLine>>, mut narrator: Signal<Narrator>, vm: &ViewModel) {
    let parts = narrator.write().render_room_parts(vm);
    log.write().push(LogLine::heading(parts.header));
    if let Some(desc) = parts.description {
        log.write().push(LogLine::plain(desc));
    }
    for line in parts.body {
        log.write().push(LogLine::plain(line));
    }
}

pub fn pnc_app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    let mut log = use_signal(Vec::<LogLine>::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    let mut menu = use_signal(|| None::<ActionMenu>);
    let mut map_open = use_signal(|| false);
    let mut started = use_signal(|| false);
    let mut settings_open = use_signal(|| false);
    let mut audio_on = use_signal(|| false);
    let inv_tab_items = use_signal(|| true); // true = Inventory tab, false = Key Items tab
    // The boot mode + launcher palette, read once. The settings menu (save/restore/restart) shows
    // only in single-player; the palette (`?theme=`) overrides the pnc.css defaults on `.pnc-app`.
    let mode = use_hook(|| read_config().mode);
    let theme_vars = use_hook(|| pnc_theme_vars(&read_config().theme));

    let driver = use_coroutine(move |mut rx: UnboundedReceiver<PncAction>| async move {
        let cfg = read_config();
        match boot(&cfg).await {
            Err(e) => {
                status.set("error".into());
                log.write().push(LogLine::error(format!("connect failed: {e}")));
            }
            Ok((transport, coord, catalog)) => {
                // Mutable so `restore`/`restart` can rebind to a fresh offline authority mid-session.
                // `catalog` is the campaign's, held for the session and used for every projection.
                let mut transport = transport;
                let mut coord = coord;
                // The Web Audio backend, lazily created when the player enables sound via the toggle.
                let mut audio = AudioEngine::new();
                status.set("connected".into());
                let initial = project(&coord, &catalog);
                if let Some(v) = &initial {
                    map_model.write().observe(v);
                    print_room(log, narrator, v);
                }
                vm.set(initial);

                while let Some(action) = rx.next().await {
                    let intent = match action {
                        PncAction::NextPlayer => {
                            submit(&transport, &mut coord, Command::NextPlayer, log).await;
                            let after = project(&coord, &catalog);
                            if let Some(a) = &after {
                                map_model.write().observe(a);
                            }
                            vm.set(after);
                            continue;
                        }
                        // ── Single-player lifecycle (mirrors the CRT verbs, same rebuild seam) ──
                        PncAction::Save => {
                            if cfg.mode == Mode::Single {
                                let blob = SaveBlob { snapshot: coord.snapshot(), map: map_model.read().serialize() };
                                match savestore::save("slot1", &blob) {
                                    Ok(()) => log.write().push(LogLine::plain("Saved.".into())),
                                    Err(e) => log.write().push(LogLine::error(format!("Save failed: {e}"))),
                                }
                            } else {
                                log.write().push(LogLine::plain("(save is single-player only)".into()));
                            }
                            continue;
                        }
                        PncAction::Restore => {
                            if cfg.mode == Mode::Single {
                                match savestore::load("slot1") {
                                    Some(blob) => {
                                        let (t, c) = rebuild_single(blob.snapshot, catalog.clone());
                                        transport = t;
                                        coord = c;
                                        map_model.write().hydrate(blob.map);
                                        let restored = project(&coord, &catalog);
                                        log.write().push(LogLine::plain("Restored.".into()));
                                        if let Some(v) = &restored {
                                            print_room(log, narrator, v);
                                        }
                                        vm.set(restored);
                                    }
                                    None => log.write().push(LogLine::plain("No save found.".into())),
                                }
                            } else {
                                log.write().push(LogLine::plain("(restore is single-player only)".into()));
                            }
                            continue;
                        }
                        PncAction::Restart => {
                            if cfg.mode == Mode::Single {
                                match boot_single(&cfg.campaign).await {
                                    Ok((t, c, _cat)) => {
                                        transport = t;
                                        coord = c;
                                        map_model.write().reset();
                                        narrator.set(Narrator::new());
                                        log.write().clear();
                                        let fresh = project(&coord, &catalog);
                                        if let Some(v) = &fresh {
                                            map_model.write().observe(v);
                                            print_room(log, narrator, v);
                                        }
                                        vm.set(fresh);
                                    }
                                    Err(e) => log.write().push(LogLine::error(format!("Restart failed: {e}"))),
                                }
                            } else {
                                log.write().push(LogLine::plain("(restart is single-player only)".into()));
                            }
                            continue;
                        }
                        PncAction::ToggleAudio => {
                            // The button click is the user gesture that lets the AudioContext start.
                            if audio_on() {
                                audio.suspend();
                                audio_on.set(false);
                            } else if audio.resume() {
                                audio_on.set(true);
                            } else {
                                log.write().push(LogLine::plain("Audio is unavailable.".into()));
                            }
                            continue;
                        }
                        PncAction::Run(ActionDescriptor::Examine { target_id, .. })
                        | PncAction::Run(ActionDescriptor::Read { target_id, .. }) => {
                            if let Some(v) = project(&coord, &catalog) {
                                if let Some(e) = v.scope.iter().find(|e| e.id == target_id) {
                                    let lines = narrator.read().render_examine(e);
                                    for line in lines {
                                        log.write().push(LogLine::plain(line));
                                    }
                                }
                            }
                            continue;
                        }
                        PncAction::Run(ActionDescriptor::Intent { intent, .. }) => intent,
                    };

                    let before = project(&coord, &catalog);
                    let command = match intent_to_command(coord.replica(), &intent) {
                        Ok(cmd) => cmd,
                        Err(note) => {
                            log.write().push(LogLine::plain(note));
                            continue;
                        }
                    };
                    if !submit(&transport, &mut coord, command, log).await {
                        if audio_on() {
                            audio.play(&error_sound());
                        }
                        continue;
                    }
                    let after = project(&coord, &catalog);
                    // Record a move BEFORE observe so the newly-entered room is placed relative to
                    // the one we left (observe would otherwise pin it at the grid origin).
                    if let (Intent::Move { dir }, Some(b), Some(a)) = (&intent, &before, &after) {
                        map_model.write().record_move(&b.room.id, *dir, &a.room.id);
                    }
                    if let Some(a) = &after {
                        map_model.write().observe(a);
                    }
                    if let (Some(b), Some(a)) = (&before, &after) {
                        let lines = narrator.read().render_action(&intent, b, a);
                        for line in lines {
                            log.write().push(LogLine::plain(line));
                        }
                        if matches!(intent, Intent::Move { .. }) {
                            print_room(log, narrator, a);
                        }
                        if a.finished {
                            log.write().push(LogLine::end("— THE END —".into()));
                        }
                    }
                    // Voice the committed action (attack/move/take/drop have a sound).
                    if audio_on() {
                        if let Some(voice) = voice_for_intent(&intent) {
                            audio.play(&voice);
                        }
                    }
                    vm.set(after);
                }
            }
        }
    });

    let view = vm();
    let room_name = view.as_ref().map(|v| v.status.location_name.clone()).unwrap_or_default();
    let finished = view.as_ref().map(|v| v.finished).unwrap_or(false);

    rsx! {
        style { "{PNC_CSS}" }
        div { class: "pnc-app", style: "{theme_vars}",
            // ── Topbar ──────────────────────────────────────────────────────────
            div { class: "pnc-topbar",
                div { class: "topbar-left", span { class: "room-name", "{room_name}" } }
                div { class: "topbar-controls",
                    span { class: "topbar-status", "{status}" }
                    button {
                        class: "topbar-btn",
                        title: if audio_on() { "Sound on" } else { "Sound off" },
                        onclick: move |_| driver.send(PncAction::ToggleAudio),
                        if audio_on() { "🔊" } else { "🔇" }
                    }
                    button { class: "topbar-btn", title: "Map", onclick: move |_| map_open.set(true), "🗺" }
                    button { class: "topbar-btn", title: "GM: next player", onclick: move |_| driver.send(PncAction::NextPlayer), "⏭" }
                    if mode == Mode::Single {
                        button { class: "topbar-btn", title: "Menu", onclick: move |_| settings_open.set(true), "⚙" }
                    }
                }
            }

            // ── Stage: scene + sidebar ──────────────────────────────────────────
            div { class: "pnc-stage",
                div { class: "pnc-scene",
                    {scene_view(view.as_ref(), finished, menu, driver)}
                }
                aside { class: "pnc-sidebar",
                    {status_view(view.as_ref())}
                    {inventory_view(view.as_ref(), finished, inv_tab_items, menu)}
                    div { class: "pnc-log",
                        div { class: "log",
                            for (i, line) in log().iter().enumerate() {
                                div { key: "log-{i}", class: "line {line.class}", "{line.text}" }
                            }
                        }
                    }
                }
            }

            // ── Contextual action menu ──────────────────────────────────────────
            if let Some(m) = menu() {
                div { class: "pnc-menu-backdrop", onclick: move |_| menu.set(None),
                    div {
                        class: "action-menu",
                        style: "left:{m.x}px;top:{m.y}px;",
                        onclick: move |e| e.stop_propagation(),
                        for (i, a) in m.actions.iter().enumerate() {
                            {
                                let act = a.clone();
                                rsx! {
                                    button {
                                        key: "menu-{i}",
                                        class: "menu-btn",
                                        onclick: move |_| { menu.set(None); driver.send(PncAction::Run(act.clone())); },
                                        "{a.label()}"
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ── Map overlay ─────────────────────────────────────────────────────
            if map_open() {
                div { class: "map-overlay", onclick: move |_| map_open.set(false),
                    div { class: "overlay-frame", onclick: move |e| e.stop_propagation(),
                        {map_svg(&layout_map(&map_model.read()))}
                    }
                    div { class: "overlay-legend",
                        "─ open   ╌ locked   ? unexplored   ✕ remains   ▣ here   ·   click to close"
                    }
                }
            }

            // ── Settings menu (single-player lifecycle) ─────────────────────────
            if settings_open() {
                div { class: "pnc-menu-backdrop", onclick: move |_| settings_open.set(false),
                    div { class: "settings-menu", onclick: move |e| e.stop_propagation(),
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Save); }, "Save" }
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Restore); }, "Restore" }
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Restart); }, "Restart" }
                    }
                }
            }

            // ── Welcome overlay ─────────────────────────────────────────────────
            if !started() {
                div { class: "pnc-welcome",
                    h1 { class: "welcome-title", "WICKEDWAYS" }
                    p { class: "welcome-intro", "A house that does not want to let you leave. Point, click, and find the way out." }
                    button { class: "enter-btn", onclick: move |_| started.set(true), "Enter" }
                }
            }
        }
    }
}

/// Submit a command; on a denial push the reason to the log. Returns whether it committed (so the
/// caller knows to re-project + narrate).
async fn submit(
    transport: &AppTransport,
    coord: &mut SyncCoordinator,
    command: Command,
    mut log: Signal<Vec<LogLine>>,
) -> bool {
    match transport.submit_async(command).await {
        SubmitResult::Committed { .. } => {
            coord.sync(transport);
            true
        }
        SubmitResult::Denied { reason } => {
            log.write().push(LogLine::error(format!("✗ {reason}")));
            false
        }
    }
}

/// The scene box: perimeter hotspots (exits/doors by bearing) + body hotspots (occupants/loot/items
/// spread across the central band). A click opens the contextual menu, or fires a lone move at once.
fn scene_view(
    view: Option<&ViewModel>,
    finished: bool,
    menu: Signal<Option<ActionMenu>>,
    driver: Coroutine<PncAction>,
) -> Element {
    let Some(v) = view else {
        return rsx! { div { class: "scene" } };
    };
    let hotspots = scene_hotspots(v);
    let (perimeter, body) = partition_hotspots(&hotspots);
    let body_total = body.len();

    rsx! {
        div { class: "scene",
            for hs in perimeter.iter() {
                {
                    let pos = hs.dir.map(dir_position).unwrap_or(crate::scene_layout::ScenePosition { left: 50.0, top: 50.0 });
                    let locked = hs.kind == HotspotKind::Locked;
                    let actions = hs.actions.clone();
                    let label = hs.label.clone();
                    let cls = if locked { "hotspot locked" } else { "hotspot" };
                    rsx! {
                        div {
                            key: "peri-{hs.key}",
                            class: "{cls}",
                            style: "left:{pos.left}%;top:{pos.top}%;z-index:2;",
                            onclick: move |e| if !locked && !finished { offer(&actions, e, menu, driver) },
                            div { class: "door-marker" }
                            span { class: "label", "{label}" }
                        }
                    }
                }
            }
            for (i, hs) in body.iter().enumerate() {
                {
                    let pos = body_position(i, body_total);
                    let actions = hs.actions.clone();
                    let label = hs.label.clone();
                    let marker_cls = match hs.kind {
                        HotspotKind::Occupant => "body-marker occupant-marker",
                        HotspotKind::Loot => "body-marker loot-marker",
                        _ => "body-marker item-marker",
                    };
                    rsx! {
                        div {
                            key: "body-{hs.key}",
                            class: "hotspot",
                            style: "left:{pos.left}%;top:{pos.top}%;z-index:1;",
                            onclick: move |e| if !finished { offer(&actions, e, menu, driver) },
                            div { class: "{marker_cls}" }
                            span { class: "label", "{label}" }
                        }
                    }
                }
            }
        }
    }
}

/// Open a menu for the hotspot's verbs at the click point, or fire a lone move-intent immediately
/// (mirrors the controller's `offerActions`).
fn offer(
    actions: &[ActionDescriptor],
    e: Event<MouseData>,
    mut menu: Signal<Option<ActionMenu>>,
    driver: Coroutine<PncAction>,
) {
    if actions.is_empty() {
        return;
    }
    if actions.len() == 1 {
        if let ActionDescriptor::Intent { intent: Intent::Move { .. }, .. } = &actions[0] {
            driver.send(PncAction::Run(actions[0].clone()));
            return;
        }
    }
    let coords = e.client_coordinates();
    menu.set(Some(ActionMenu { actions: actions.to_vec(), x: coords.x, y: coords.y }));
}

/// A basic status line projected from the `ViewModel` (location · turn · HP · SAN). The campaign's
/// richer `StatusField` cues aren't carried over the multiplayer wire yet (slice 4).
fn status_view(view: Option<&ViewModel>) -> Element {
    let Some(v) = view else {
        return rsx! { div { class: "pnc-status" } };
    };
    let s = &v.status;
    rsx! {
        div { class: "pnc-status",
            div { class: "status",
                span { class: "field", span { class: "field-label", "Turn" } " " span { class: "field-value", "{s.turn}/{s.max_turns}" } }
                span { class: "field", span { class: "field-label", "HP" } " " span { class: "field-value", "{s.health}" } }
                span { class: "field", span { class: "field-label", "SAN" } " " span { class: "field-value", "{s.sanity}" } }
            }
        }
    }
}

/// The inventory panel: an "Inventory" tab of numbered slots and a "Key Items" tab. Clicking a
/// filled entry opens its verb menu (mirrors the controller's `inventory-activate` wiring).
fn inventory_view(
    view: Option<&ViewModel>,
    finished: bool,
    mut inv_tab_items: Signal<bool>,
    menu: Signal<Option<ActionMenu>>,
) -> Element {
    let Some(v) = view else {
        return rsx! { div { class: "pnc-inventory" } };
    };
    let inv = &v.inventory;
    let show_items = inv_tab_items();
    let slot_count = inv.slots.max(inv.items.len() as i64).max(0) as usize;

    rsx! {
        div { class: "pnc-inventory",
            div { class: "tabs",
                button {
                    class: if show_items { "tab active" } else { "tab" },
                    onclick: move |_| inv_tab_items.set(true),
                    "Inventory"
                }
                button {
                    class: if show_items { "tab" } else { "tab active" },
                    onclick: move |_| inv_tab_items.set(false),
                    "Key Items"
                }
            }
            if show_items {
                ol { class: "slot-list",
                    for slot in 0..slot_count {
                        li { key: "slot-{slot}", class: "slot",
                            if let Some(item) = inv.items.get(slot) {
                                {inventory_entry(item, inv.equipped_names.contains(&item.name), finished, menu)}
                            } else {
                                span { class: "slot-empty", "--empty--" }
                            }
                        }
                    }
                }
            } else if inv.keys.is_empty() {
                p { class: "empty-note", "No key items." }
            } else {
                ul { class: "key-list",
                    for key in inv.keys.iter() {
                        li { key: "key-{key.id}", class: "key",
                            {inventory_entry(key, false, finished, menu)}
                        }
                    }
                }
            }
        }
    }
}

/// One clickable inventory entry; clicking opens its verb menu at the click point.
fn inventory_entry(
    item: &wickedways_core::world::view::ScopeEntity,
    equipped: bool,
    finished: bool,
    mut menu: Signal<Option<ActionMenu>>,
) -> Element {
    let actions = inventory_actions(item, equipped);
    let name = item.name.clone();
    rsx! {
        button {
            class: "inventory-entry",
            onclick: move |e| {
                if finished { return; }
                let coords = e.client_coordinates();
                menu.set(Some(ActionMenu { actions: actions.clone(), x: coords.x, y: coords.y }));
            },
            span { class: "entry-name", "{name}" }
            if equipped {
                span { class: "equipped-tag", "(equipped)" }
            }
        }
    }
}
