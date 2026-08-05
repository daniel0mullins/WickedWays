//! The point-and-click Dioxus surface.
//!
//! The click-driven counterpart to the CRT terminal ([`crt`](crate::crt)). It drives the same
//! multiplayer loop
//! through the shared [`driver`](crate::driver) (connect → project → [`intent_to_command`] → submit →
//! narrate → map) but presents it as a scene of clickable hotspots instead of a text prompt: the
//! [`affordances`](crate::affordances) derive what each thing offers, the [`scene_layout`] places the
//! hotspots, a contextual action menu turns a click into an [`Intent`], and the sidebar shows the
//! status / inventory / running log. It reuses the shared [`Narrator`] and [`MapModel`].
//!
//! Save-restore, the settings menu, and procedural audio are wired —
//! a topbar 🔊 toggle enables the shared [`AudioRuntime`], which voices committed actions
//! and denials and runs the sanity-reactive ambient bed, just like the CRT surface. The welcome
//! screen shows the campaign's title + intro from the client-side registry
//! ([`welcome_for`](crate::driver::welcome_for)) — the manifest passthrough — and the campaign's
//! authored `StatusField` readout rides the sync delta's cues (absorbed by the coordinator), so
//! the status line shows it alongside the basic `ViewModel` projection. A dev `nextPlayer` control
//! remains; `examine`/`read` render the generic look line, since per-entity lore / descriptions ride
//! `PresentationCue`s the wire doesn't carry yet.
//!
//! [`AudioRuntime`]: crate::audio_runtime::AudioRuntime
//!
//! [`intent_to_command`]: crate::driver::intent_to_command
//! [`Narrator`]: crate::narrator::Narrator
//! [`MapModel`]: crate::map::MapModel

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::presentation::{PresentationCue, StatusField};
use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;

use crate::affordances::{inventory_actions, scene_hotspots, ActionDescriptor, HotspotKind};
use crate::audio::cue_for_intent;
use crate::audio_pack::wickedways_campaign_audio;
use crate::audio_runtime::AudioRuntime;
use crate::driver::{
    boot, boot_single, has_actions_left, intent_to_command, is_gm, is_my_turn, project,
    read_config, rebuild_single, toggle_fullscreen, welcome_for, AppTransport, Mode, GM_IDENTITY,
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
        Self {
            text,
            class: "heading",
        }
    }
    fn error(text: String) -> Self {
        Self {
            text,
            class: "error",
        }
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
    /// A player ends their own turn (multiplayer managed turns).
    EndTurn,
    /// Single-player lifecycle verbs from the settings menu (mirror the CRT `save`/`restore`/`restart`).
    Save,
    Restore,
    Restart,
    /// Single-player: revert the last committed command (mirrors the CRT `undo`).
    Undo,
    /// Toggle browser fullscreen for the page (mirrors the CRT `fullscreen`).
    Fullscreen,
    /// Toggle procedural audio (the click is the user gesture that lets the `AudioContext` start).
    ToggleAudio,
}

/// Append the room heading + description/body to the log.
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

/// An event the transport coroutine loops over: a UI [`PncAction`], or a `Refresh` tick from a server
/// push (another client's committed action) so the surface re-syncs + re-projects reactively.
enum PncEv {
    Act(PncAction),
    Refresh,
}

pub fn pnc_app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    // The campaign's live `Status` readout, absorbed from the coordinator after each sync.
    let mut status_fields = use_signal(Vec::<StatusField>::new);
    let mut log = use_signal(Vec::<LogLine>::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    let mut menu = use_signal(|| None::<ActionMenu>);
    let mut map_open = use_signal(|| false);
    // In multiplayer the launcher lobby already gated entry, so skip the surface's own welcome screen.
    let mut started = use_signal(|| matches!(read_config().mode, Mode::Multi));
    let mut settings_open = use_signal(|| false);
    let mut audio_on = use_signal(|| false);
    let inv_tab_items = use_signal(|| true); // true = Inventory tab, false = Key Items tab
    let mulligan_sel = use_signal(Vec::<usize>::new); // hand indices toggled for the mulligan
                                                      // The boot mode + launcher palette, read once. The settings menu (save/restore/restart) shows
                                                      // only in single-player; the palette (`?theme=`) overrides the pnc.css defaults on `.pnc-app`.
    let mode = use_hook(|| read_config().mode);
    let theme_vars = use_hook(|| pnc_theme_vars(&read_config().theme));
    // The campaign's welcome text (title/intro/button) — the manifest passthrough, read once.
    let welcome = use_hook(|| welcome_for(&read_config().campaign));
    // GM gate for the turn-advance control, and the "your turn" indicator (refreshed by the coroutine).
    let is_gm = use_hook(is_gm);
    let mut my_turn = use_signal(|| false);
    let mut my_actions_left = use_signal(|| true);

    let driver = use_coroutine(move |rx: UnboundedReceiver<PncAction>| async move {
        let cfg = read_config();
        let single = matches!(cfg.mode, Mode::Single);
        let gm = single || cfg.token == GM_IDENTITY;
        match boot(&cfg).await {
            Err(e) => {
                status.set("error".into());
                log.write()
                    .push(LogLine::error(format!("connect failed: {e}")));
            }
            Ok((transport, coord, catalog)) => {
                // Mutable so `restore`/`restart` can rebind to a fresh offline authority mid-session.
                // `catalog` is the campaign's, held for the session and used for every projection.
                let mut transport = transport;
                let mut coord = coord;
                // Single-player undo stack: the (snapshot + fog-of-war map) captured BEFORE each
                // committed command, newest last (mirrors the CRT surface).
                let mut undo_stack: Vec<SaveBlob> = Vec::new();
                // The audio runtime (engine + sanity-reactive ambient bed + chiptune pack), lazily
                // opening its AudioContext when the player enables sound via the topbar toggle.
                let mut audio = AudioRuntime::for_campaign(Some(wickedways_campaign_audio()));
                status.set("connected".into());
                let initial = project(&coord, &catalog);
                if let Some(v) = &initial {
                    map_model.write().observe(v);
                    print_room(log, narrator, v);
                    audio.update(v);
                }
                vm.set(initial);
                status_fields.set(coord.status_fields().to_vec());
                my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                my_actions_left.set(has_actions_left(coord.replica(), single));

                // Loop over UI actions AND server pushes: a pushed entry (another client's move, or the
                // GM advancing the turn) re-syncs + re-projects, so play stays live and `my_turn` flips
                // when the turn reaches this client — no polling.
                let pushes = transport.push_notifications();
                let mut events = futures_util::stream::select(
                    rx.map(PncEv::Act),
                    pushes.map(|()| PncEv::Refresh),
                );
                while let Some(ev) = events.next().await {
                    let action = match ev {
                        PncEv::Act(a) => a,
                        PncEv::Refresh => {
                            coord.sync(&transport);
                            let after = project(&coord, &catalog);
                            if let Some(a) = &after {
                                map_model.write().observe(a);
                                audio.update(a);
                            }
                            vm.set(after);
                            status_fields.set(coord.status_fields().to_vec());
                            my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                            my_actions_left.set(has_actions_left(coord.replica(), single));
                            continue;
                        }
                    };
                    let intent = match action {
                        PncAction::NextPlayer => {
                            submit(&transport, &mut coord, Command::NextPlayer, log).await;
                            let after = project(&coord, &catalog);
                            if let Some(a) = &after {
                                map_model.write().observe(a);
                                audio.update(a);
                            }
                            vm.set(after);
                            status_fields.set(coord.status_fields().to_vec());
                            my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                            my_actions_left.set(has_actions_left(coord.replica(), single));
                            continue;
                        }
                        // A player ends their OWN turn (the active character is theirs on their turn).
                        PncAction::EndTurn => {
                            if let Ok(actor_id) = coord.replica().active_character_id() {
                                submit(&transport, &mut coord, Command::EndTurn { actor_id }, log)
                                    .await;
                            }
                            let after = project(&coord, &catalog);
                            if let Some(a) = &after {
                                map_model.write().observe(a);
                                audio.update(a);
                            }
                            vm.set(after);
                            status_fields.set(coord.status_fields().to_vec());
                            my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                            my_actions_left.set(has_actions_left(coord.replica(), single));
                            continue;
                        }
                        // ── Single-player lifecycle (mirrors the CRT verbs, same rebuild seam) ──
                        PncAction::Save => {
                            if cfg.mode == Mode::Single {
                                let blob = SaveBlob {
                                    snapshot: coord.snapshot(),
                                    map: map_model.read().serialize(),
                                };
                                match savestore::save("slot1", &blob) {
                                    Ok(()) => log.write().push(LogLine::plain("Saved.".into())),
                                    Err(e) => log
                                        .write()
                                        .push(LogLine::error(format!("Save failed: {e}"))),
                                }
                            } else {
                                log.write()
                                    .push(LogLine::plain("(save is single-player only)".into()));
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
                                            audio.update(v);
                                        }
                                        vm.set(restored);
                                        status_fields.set(coord.status_fields().to_vec());
                                    }
                                    None => {
                                        log.write().push(LogLine::plain("No save found.".into()));
                                    }
                                }
                            } else {
                                log.write()
                                    .push(LogLine::plain("(restore is single-player only)".into()));
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
                                        // Fresh session: rebuild the director so tension's high-water mark resets.
                                        audio.reset();
                                        let fresh = project(&coord, &catalog);
                                        if let Some(v) = &fresh {
                                            map_model.write().observe(v);
                                            print_room(log, narrator, v);
                                            audio.update(v);
                                        }
                                        vm.set(fresh);
                                        status_fields.set(coord.status_fields().to_vec());
                                    }
                                    Err(e) => log
                                        .write()
                                        .push(LogLine::error(format!("Restart failed: {e}"))),
                                }
                            } else {
                                log.write()
                                    .push(LogLine::plain("(restart is single-player only)".into()));
                            }
                            continue;
                        }
                        PncAction::Undo => {
                            if cfg.mode == Mode::Single {
                                match undo_stack.pop() {
                                    Some(blob) => {
                                        // Rebuild the offline authority from the pre-command snapshot
                                        // and hydrate its map — the same seam as `restore`.
                                        let (t, c) = rebuild_single(blob.snapshot, catalog.clone());
                                        transport = t;
                                        coord = c;
                                        map_model.write().hydrate(blob.map);
                                        let reverted = project(&coord, &catalog);
                                        log.write().push(LogLine::plain("Undone.".into()));
                                        if let Some(v) = &reverted {
                                            print_room(log, narrator, v);
                                            audio.update(v);
                                        }
                                        vm.set(reverted);
                                        status_fields.set(coord.status_fields().to_vec());
                                    }
                                    None => {
                                        log.write().push(LogLine::plain("Nothing to undo.".into()));
                                    }
                                }
                            } else {
                                log.write()
                                    .push(LogLine::plain("(undo is single-player only)".into()));
                            }
                            continue;
                        }
                        PncAction::Fullscreen => {
                            let entering = toggle_fullscreen();
                            log.write().push(LogLine::plain(
                                if entering {
                                    "Fullscreen on."
                                } else {
                                    "Fullscreen off."
                                }
                                .into(),
                            ));
                            continue;
                        }
                        PncAction::ToggleAudio => {
                            // The button click is the user gesture that lets the AudioContext start.
                            if audio.enabled() {
                                audio.set_enabled(false);
                                audio_on.set(false);
                            } else {
                                audio.set_enabled(true);
                                audio_on.set(audio.enabled());
                                if audio.enabled() {
                                    // Seed the ambient bed with the current tension.
                                    if let Some(v) = project(&coord, &catalog) {
                                        audio.update(&v);
                                    }
                                } else {
                                    log.write()
                                        .push(LogLine::plain("Audio is unavailable.".into()));
                                }
                            }
                            continue;
                        }
                        PncAction::Run(
                            ActionDescriptor::Examine { target_id, .. }
                            | ActionDescriptor::Read { target_id, .. },
                        ) => {
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

                    // Opening a container is a local reveal: list its contents from the current view
                    // (the items are already takeable from room scope).
                    if let Intent::Open { target_id } = &intent {
                        if let Some(v) = project(&coord, &catalog) {
                            let lines = narrator.read().render_action(
                                &Intent::Open {
                                    target_id: target_id.clone(),
                                },
                                &v,
                                &v,
                            );
                            for line in lines {
                                log.write().push(LogLine::plain(line));
                            }
                        }
                        continue;
                    }

                    let before = project(&coord, &catalog);
                    let command = match intent_to_command(coord.replica(), &catalog, &intent) {
                        Ok(cmd) => cmd,
                        Err(note) => {
                            log.write().push(LogLine::plain(note));
                            continue;
                        }
                    };
                    // Capture the pre-command state for `undo` (single-player only), pushed only once
                    // the command commits.
                    let undo_point = (cfg.mode == Mode::Single).then(|| SaveBlob {
                        snapshot: coord.snapshot(),
                        map: map_model.read().serialize(),
                    });
                    let Some(cues) = submit(&transport, &mut coord, command, log).await else {
                        audio.note_error();
                        continue;
                    };
                    if let Some(point) = undo_point {
                        undo_stack.push(point);
                        if undo_stack.len() > 100 {
                            undo_stack.remove(0);
                        }
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
                    // Render the delta's mechanic cues as prose: NPC dialogue (the caretaker's
                    // lines), storyteller journal reveals, and any effect cues the command emitted.
                    for line in narrator.read().render_cues(&cues) {
                        log.write().push(LogLine::plain(line));
                    }
                    if let Some(a) = &after {
                        // Voice the committed action (attack/move/take/drop have a sound) and drive
                        // the ambient bed from the new view.
                        if let Some(cue) = cue_for_intent(&intent) {
                            audio.play_cue(&cue, a);
                        }
                        audio.update(a);
                    }
                    vm.set(after);
                    status_fields.set(coord.status_fields().to_vec());
                    my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                    my_actions_left.set(has_actions_left(coord.replica(), single));
                }
            }
        }
    });

    let view = vm();
    let room_name = view
        .as_ref()
        .map(|v| v.status.location_name.clone())
        .unwrap_or_default();
    let finished = view.as_ref().is_some_and(|v| v.finished);

    rsx! {
        style { "{PNC_CSS}" }
        div { class: "pnc-app", style: "{theme_vars}",
            // ── Topbar ──────────────────────────────────────────────────────────
            div { class: "pnc-topbar",
                div { class: "topbar-left", span { class: "room-name", "{room_name}" } }
                div { class: "topbar-controls",
                    if mode == Mode::Multi && my_turn() {
                        span { class: "turn-indicator", "● Your turn" }
                        // A player ends their own turn; the GM's ⏭ (below) ends anyone's.
                        button { class: "topbar-btn end-turn-btn", title: "End your turn", onclick: move |_| driver.send(PncAction::EndTurn), "End Turn" }
                    }
                    span { class: "topbar-status", "{status}" }
                    button {
                        class: "topbar-btn",
                        title: if audio_on() { "Sound on" } else { "Sound off" },
                        onclick: move |_| driver.send(PncAction::ToggleAudio),
                        if audio_on() { "🔊" } else { "🔇" }
                    }
                    button { class: "topbar-btn", title: "Map", onclick: move |_| map_open.set(true), "🗺" }
                    button { class: "topbar-btn", title: "Fullscreen", onclick: move |_| driver.send(PncAction::Fullscreen), "⛶" }
                    // The turn-advance control is the GM's only, and only in multiplayer.
                    if mode == Mode::Multi && is_gm {
                        button { class: "topbar-btn", title: "GM: next player", onclick: move |_| driver.send(PncAction::NextPlayer), "⏭" }
                    }
                    if mode == Mode::Single {
                        button { class: "topbar-btn", title: "Menu", onclick: move |_| settings_open.set(true), "⚙" }
                    }
                }
            }

            // ── Stage: scene + sidebar ──────────────────────────────────────────
            div { class: "pnc-stage",
                // Off-turn OR out of action budget (multiplayer): the scene + inventory are dimmed and
                // non-interactive until it's your turn with actions to spend. Single-player never engages.
                div { class: if mode == Mode::Multi && (!my_turn() || !my_actions_left()) { "pnc-scene waiting" } else { "pnc-scene" },
                    {scene_view(view.as_ref(), finished, menu, driver)}
                }
                aside { class: "pnc-sidebar",
                    {status_view(view.as_ref(), &status_fields())}
                    div { class: if mode == Mode::Multi && (!my_turn() || !my_actions_left()) { "pnc-inv-gate waiting" } else { "pnc-inv-gate" },
                        {inventory_view(view.as_ref(), finished, inv_tab_items, menu)}
                        {crafting_view(view.as_ref(), finished, driver)}
                        {villain_view(view.as_ref(), finished, is_gm, mulligan_sel, driver)}
                    }
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
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Undo); }, "Undo" }
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Save); }, "Save" }
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Restore); }, "Restore" }
                        button { class: "menu-btn", onclick: move |_| { settings_open.set(false); driver.send(PncAction::Restart); }, "Restart" }
                    }
                }
            }

            // ── Welcome overlay (campaign manifest: title / intro / start button) ─
            if !started() {
                div { class: "pnc-welcome",
                    h1 { class: "welcome-title", "{welcome.title}" }
                    p { class: "welcome-intro", "{welcome.intro}" }
                    button { class: "enter-btn", onclick: move |_| started.set(true), "{welcome.button}" }
                }
            }
        }
    }
}

/// Submit a command; on a denial push the reason to the log. Returns the committed delta's
/// presentation cues (so the caller can re-project, narrate, and render dialogue/mechanic cues), or
/// `None` on a denial.
async fn submit(
    transport: &AppTransport,
    coord: &mut SyncCoordinator,
    command: Command,
    mut log: Signal<Vec<LogLine>>,
) -> Option<Vec<PresentationCue>> {
    match transport.submit_async(command).await {
        SubmitResult::Committed { delta, .. } => {
            coord.sync(transport);
            Some(delta.cues)
        }
        SubmitResult::Denied { reason } => {
            log.write().push(LogLine::error(format!("✗ {reason}")));
            None
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
                    let pos = hs.dir.map_or(crate::scene_layout::ScenePosition { left: 50.0, top: 50.0 }, dir_position);
                    let locked = hs.kind == HotspotKind::Locked;
                    let actions = hs.actions.clone();
                    let label = hs.label.clone();
                    let cls = if locked { "hotspot locked" } else { "hotspot" };
                    rsx! {
                        div {
                            key: "peri-{hs.key}",
                            class: "{cls}",
                            style: "left:{pos.left}%;top:{pos.top}%;z-index:2;",
                            onclick: move |e| if !locked && !finished { offer(&actions, &e, menu, driver) },
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
                        HotspotKind::Player => "body-marker player-marker",
                        HotspotKind::Occupant => "body-marker occupant-marker",
                        HotspotKind::Loot => "body-marker loot-marker",
                        _ => "body-marker item-marker",
                    };
                    rsx! {
                        div {
                            key: "body-{hs.key}",
                            class: "hotspot",
                            style: "left:{pos.left}%;top:{pos.top}%;z-index:1;",
                            onclick: move |e| if !finished { offer(&actions, &e, menu, driver) },
                            div { class: "{marker_cls}" }
                            span { class: "label", "{label}" }
                        }
                    }
                }
            }
        }
    }
}

/// Open a menu for the hotspot's verbs at the click point, or fire a lone move-intent immediately.
fn offer(
    actions: &[ActionDescriptor],
    e: &Event<MouseData>,
    mut menu: Signal<Option<ActionMenu>>,
    driver: Coroutine<PncAction>,
) {
    if actions.is_empty() {
        return;
    }
    if actions.len() == 1 {
        if let ActionDescriptor::Intent {
            intent: Intent::Move { .. },
            ..
        } = &actions[0]
        {
            driver.send(PncAction::Run(actions[0].clone()));
            return;
        }
    }
    let coords = e.client_coordinates();
    menu.set(Some(ActionMenu {
        actions: actions.to_vec(),
        x: coords.x,
        y: coords.y,
    }));
}

/// The CSS class for a campaign status field by its (optional) emphasis.
fn status_field_class(field: &StatusField) -> &'static str {
    match field.emphasis.as_deref() {
        Some("critical") => "field status-critical",
        Some("warn") => "field status-warn",
        _ => "field",
    }
}

/// The status line: the `ViewModel` projection (turn · HP · SAN) plus the campaign's live `StatusField`
/// readout when present (the manifest status passthrough — carried on the delta's cues).
fn status_view(view: Option<&ViewModel>, fields: &[StatusField]) -> Element {
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
            if !fields.is_empty() {
                div { class: "status campaign-status",
                    for f in fields.iter() {
                        span {
                            key: "sf-{f.label}",
                            class: status_field_class(f),
                            span { class: "field-label", "{f.label}" } " "
                            span { class: "field-value", "{f.value}" }
                        }
                    }
                }
            }
        }
    }
}

/// The crafting panel: the shared material pool readout plus a button per known recipe (disabled
/// until the pool can afford it). Forging dispatches a free `Craft` intent through the shared driver.
/// Hidden entirely when the campaign has no recipes.
fn crafting_view(
    view: Option<&ViewModel>,
    finished: bool,
    driver: Coroutine<PncAction>,
) -> Element {
    let Some(v) = view else { return rsx! {} };
    if v.recipes.is_empty() && v.materials.is_empty() {
        return rsx! {};
    }
    rsx! {
        div { class: "pnc-crafting",
            if !v.materials.is_empty() {
                div { class: "crafting-materials",
                    span { class: "panel-label", "Materials" }
                    for m in v.materials.iter() {
                        span { key: "mat-{m.component}", class: "material", "{m.component} ×{m.quantity}" }
                    }
                }
            }
            if !v.recipes.is_empty() {
                div { class: "crafting-recipes",
                    span { class: "panel-label", "Recipes" }
                    for r in v.recipes.iter() {
                        {
                            let recipe_id = r.id.clone();
                            let name = r.name.clone();
                            let enabled = r.affordable && !finished;
                            rsx! {
                                button {
                                    key: "recipe-{r.id}",
                                    class: if r.affordable { "craft-btn" } else { "craft-btn unaffordable" },
                                    disabled: !enabled,
                                    title: if r.affordable { "Forge {name}" } else { "Not enough materials" },
                                    onclick: move |_| driver.send(PncAction::Run(ActionDescriptor::Intent {
                                        label: "Forge".into(),
                                        intent: Intent::Craft { recipe_id: recipe_id.clone() },
                                    })),
                                    "Forge {name}"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The Villain panel: the Wicked Ways hand. For the villain's own seat (GM identity, or
/// single-player) each card shows face-up with a Play button and a toggle for the mulligan
/// selection — "Mulligan (n/3)" fires once exactly three are marked. Everyone else sees only the
/// villain's name and pile counts. Hidden entirely when the campaign has no villain.
///
/// A room-targeted play (Shadow Step) has no picker here yet — the engine's denial names the
/// problem, and the CRT terminal's `play <card> to <room>` covers targeted plays.
fn villain_view(
    view: Option<&ViewModel>,
    finished: bool,
    is_gm: bool,
    mut mulligan_sel: Signal<Vec<usize>>,
    driver: Coroutine<PncAction>,
) -> Element {
    let Some(v) = view else { return rsx! {} };
    let Some(vn) = v.villain.as_ref() else {
        return rsx! {};
    };
    let show_hand = vn.is_you && is_gm;
    if !show_hand {
        return rsx! {
            div { class: "pnc-villain",
                span { class: "panel-label", "Villain" }
                span { class: "villain-status",
                    "{vn.name} — hand {vn.hand.len()} · deck {vn.deck_count} · discard {vn.discard_count}"
                }
            }
        };
    }
    let spent = vn.card_action_taken;
    let selected = mulligan_sel();
    let sel_count = selected.len();
    let mulligan_ready = sel_count == 3 && !spent && !finished;
    let mulligan_keys: Vec<String> = selected
        .iter()
        .filter_map(|i| vn.hand.get(*i).map(|c| c.key.clone()))
        .collect();
    rsx! {
        div { class: "pnc-villain",
            span { class: "panel-label",
                "Wicked Ways — deck {vn.deck_count} · discard {vn.discard_count}"
                if spent { " · card action spent" }
            }
            for (i, c) in vn.hand.iter().enumerate() {
                {
                    let key = c.key.clone();
                    let name = c.name.clone();
                    let text = c.text.clone().unwrap_or_default();
                    let is_sel = selected.contains(&i);
                    rsx! {
                        div { key: "card-{i}-{c.key}", class: "villain-card",
                            button {
                                class: if is_sel { "card-toggle selected" } else { "card-toggle" },
                                title: "Mark for the mulligan (discard 3, draw 3)",
                                onclick: move |_| {
                                    let mut sel = mulligan_sel.write();
                                    if let Some(pos) = sel.iter().position(|x| *x == i) {
                                        sel.remove(pos);
                                    } else if sel.len() < 3 {
                                        sel.push(i);
                                    }
                                },
                                if is_sel { "☑" } else { "☐" }
                            }
                            button {
                                class: "craft-btn card-play",
                                disabled: spent || finished,
                                title: "{text}",
                                onclick: move |_| {
                                    mulligan_sel.write().clear();
                                    driver.send(PncAction::Run(ActionDescriptor::Intent {
                                        label: "Play".into(),
                                        intent: Intent::PlayCard { card_key: key.clone(), room: None },
                                    }));
                                },
                                "Play {name}"
                            }
                        }
                    }
                }
            }
            if vn.hand.is_empty() {
                span { class: "villain-status", "No cards in hand." }
            } else {
                button {
                    class: "craft-btn mulligan-btn",
                    disabled: !mulligan_ready,
                    title: "Discard the three marked cards and draw three",
                    onclick: move |_| {
                        let keys = mulligan_keys.clone();
                        mulligan_sel.write().clear();
                        driver.send(PncAction::Run(ActionDescriptor::Intent {
                            label: "Mulligan".into(),
                            intent: Intent::Mulligan { card_keys: keys },
                        }));
                    },
                    "Mulligan ({sel_count}/3)"
                }
            }
        }
    }
}

/// The inventory panel: an "Inventory" tab of numbered slots and a "Key Items" tab. Clicking a
/// filled entry opens its verb menu.
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
