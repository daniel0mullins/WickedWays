//! The physical-tabletop Dioxus surface.
//!
//! A third surface alongside the CRT terminal ([`crt`](crate::crt)) and point-and-click
//! ([`pnc`](crate::pnc)) that renders the session as a **tile board**: the fog-of-war map, enlarged
//! into chunky room tiles, with the player's piece on the current tile, a movement + action rail, and
//! a seat dashboard. It simulates the physical e-ink tabletop (see `docs/tabletop-simulator-spec.md`)
//! on screen before any firmware exists.
//!
//! It drives the same shared [`driver`](crate::driver) loop as the other surfaces
//! (boot → [`project`] → [`intent_to_command`] → submit → narrate → map) and reuses the pure
//! [`affordances`](crate::affordances), [`map`](crate::map) geometry, [`Narrator`], and
//! [`AudioRuntime`] — only the presentation differs. v1 is single-piece: it rides the existing
//! single-player driver exactly like the other surfaces, and the multiplayer turn controls carry over
//! unchanged for campaigns that offer networked play.
//!
//! [`project`]: crate::driver::project
//! [`intent_to_command`]: crate::driver::intent_to_command
//! [`Narrator`]: crate::narrator::Narrator
//! [`AudioRuntime`]: crate::audio_runtime::AudioRuntime

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
use crate::map::{layout_map, LaidBox, MapModel};
use crate::narrator::Narrator;
use crate::savestore::{self, SaveBlob};

const TABLETOP_CSS: &str = include_str!("../assets/tabletop.css");

/// Pixel scale applied to the fog-of-war layout so the minimap grid reads as a chunky game board.
const SCALE: f64 = 2.6;

/// One line in the running log, with a CSS class for its role.
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

/// A request from the UI to the (non-Send, Rc-backed) transport coroutine. Mirrors the pnc surface's
/// action set so the board supports the same lifecycle + multiplayer verbs.
enum TtAction {
    /// Apply a chosen descriptor (an intent to submit, or a free examine/read).
    Run(ActionDescriptor),
    /// GM: advance to the next seat.
    NextPlayer,
    /// A player ends their own turn (multiplayer managed turns).
    EndTurn,
    Save,
    Restore,
    Restart,
    Undo,
    Fullscreen,
    ToggleAudio,
}

/// An event the transport coroutine loops over: a UI [`TtAction`], or a `Refresh` from a server push.
enum TtEv {
    Act(TtAction),
    Refresh,
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

pub fn tabletop_app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    let mut status_fields = use_signal(Vec::<StatusField>::new);
    let mut log = use_signal(Vec::<LogLine>::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    let mut started = use_signal(|| matches!(read_config().mode, Mode::Multi));
    let mut settings_open = use_signal(|| false);
    let mut audio_on = use_signal(|| false);
    let mode = use_hook(|| read_config().mode);
    let welcome = use_hook(|| welcome_for(&read_config().campaign));
    let is_gm = use_hook(is_gm);
    let mut my_turn = use_signal(|| false);
    let mut my_actions_left = use_signal(|| true);

    let driver = use_coroutine(move |rx: UnboundedReceiver<TtAction>| async move {
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
                let mut transport = transport;
                let mut coord = coord;
                let mut undo_stack: Vec<SaveBlob> = Vec::new();
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

                let pushes = transport.push_notifications();
                let mut events =
                    futures_util::stream::select(rx.map(TtEv::Act), pushes.map(|()| TtEv::Refresh));
                while let Some(ev) = events.next().await {
                    let action = match ev {
                        TtEv::Act(a) => a,
                        TtEv::Refresh => {
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
                        TtAction::NextPlayer => {
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
                        TtAction::EndTurn => {
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
                        TtAction::Save => {
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
                        TtAction::Restore => {
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
                        TtAction::Restart => {
                            if cfg.mode == Mode::Single {
                                match boot_single(&cfg.campaign).await {
                                    Ok((t, c, _cat)) => {
                                        transport = t;
                                        coord = c;
                                        map_model.write().reset();
                                        narrator.set(Narrator::new());
                                        log.write().clear();
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
                        TtAction::Undo => {
                            if cfg.mode == Mode::Single {
                                match undo_stack.pop() {
                                    Some(blob) => {
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
                        TtAction::Fullscreen => {
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
                        TtAction::ToggleAudio => {
                            if audio.enabled() {
                                audio.set_enabled(false);
                                audio_on.set(false);
                            } else {
                                audio.set_enabled(true);
                                audio_on.set(audio.enabled());
                                if audio.enabled() {
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
                        TtAction::Run(
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
                        TtAction::Run(ActionDescriptor::Intent { intent, .. }) => intent,
                    };

                    // Opening a container is a local reveal.
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
                    // Record a move BEFORE observe so the new room is placed relative to the one we left.
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
                    for line in narrator.read().render_cues(&cues) {
                        log.write().push(LogLine::plain(line));
                    }
                    if let Some(a) = &after {
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
    let waiting = mode == Mode::Multi && (!my_turn() || !my_actions_left());

    rsx! {
        style { "{TABLETOP_CSS}" }
        div { class: "tt-app",
            // ── Topbar ──────────────────────────────────────────────────────────
            div { class: "tt-topbar",
                span { class: "tt-title", "🎲 Tabletop" }
                span { class: "tt-room", "{room_name}" }
                div { class: "tt-controls",
                    if mode == Mode::Multi && my_turn() {
                        span { class: "tt-turn", "● Your turn" }
                        button { class: "tt-btn", title: "End your turn", onclick: move |_| driver.send(TtAction::EndTurn), "End Turn" }
                    }
                    span { class: "tt-status", "{status}" }
                    button {
                        class: "tt-btn",
                        title: if audio_on() { "Sound on" } else { "Sound off" },
                        onclick: move |_| driver.send(TtAction::ToggleAudio),
                        if audio_on() { "🔊" } else { "🔇" }
                    }
                    button { class: "tt-btn", title: "Fullscreen", onclick: move |_| driver.send(TtAction::Fullscreen), "⛶" }
                    if mode == Mode::Multi && is_gm {
                        button { class: "tt-btn", title: "GM: next player", onclick: move |_| driver.send(TtAction::NextPlayer), "⏭" }
                    }
                    if mode == Mode::Single {
                        button { class: "tt-btn", title: "Menu", onclick: move |_| settings_open.set(true), "⚙" }
                    }
                }
            }

            div { class: "tt-stage",
                // ── The board ───────────────────────────────────────────────────
                div { class: if waiting { "tt-board-wrap waiting" } else { "tt-board-wrap" },
                    {board_view(view.as_ref(), map_model)}
                }

                // ── Rail: dashboard · movement · actions · log ──────────────────
                aside { class: "tt-rail",
                    {dashboard_view(view.as_ref(), &status_fields())}
                    div { class: if waiting { "tt-controls-gate waiting" } else { "tt-controls-gate" },
                        {movement_view(view.as_ref(), finished, driver)}
                        {actions_view(view.as_ref(), finished, driver)}
                        {inventory_view(view.as_ref(), finished, driver)}
                    }
                    div { class: "tt-log",
                        for (i, line) in log().iter().enumerate() {
                            div { key: "log-{i}", class: "tt-line {line.class}", "{line.text}" }
                        }
                    }
                }
            }

            // ── Settings menu (single-player lifecycle) ─────────────────────────
            if settings_open() {
                div { class: "tt-backdrop", onclick: move |_| settings_open.set(false),
                    div { class: "tt-menu", onclick: move |e| e.stop_propagation(),
                        button { class: "tt-menu-btn", onclick: move |_| { settings_open.set(false); driver.send(TtAction::Undo); }, "Undo" }
                        button { class: "tt-menu-btn", onclick: move |_| { settings_open.set(false); driver.send(TtAction::Save); }, "Save" }
                        button { class: "tt-menu-btn", onclick: move |_| { settings_open.set(false); driver.send(TtAction::Restore); }, "Restore" }
                        button { class: "tt-menu-btn", onclick: move |_| { settings_open.set(false); driver.send(TtAction::Restart); }, "Restart" }
                    }
                }
            }

            // ── Welcome overlay ─────────────────────────────────────────────────
            if !started() {
                div { class: "tt-welcome",
                    h1 { class: "tt-welcome-title", "{welcome.title}" }
                    p { class: "tt-welcome-intro", "{welcome.intro}" }
                    button { class: "tt-enter-btn", onclick: move |_| started.set(true), "{welcome.button}" }
                }
            }
        }
    }
}

/// Submit a command; on a denial push the reason to the log. Returns the committed delta's cues.
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

/// The CSS piece class for an occupant standing on the current tile, by its state.
fn piece_class(defeated: bool, ally: bool) -> &'static str {
    if defeated {
        "tt-piece-remains"
    } else if ally {
        "tt-piece-ally"
    } else {
        "tt-piece-mob"
    }
}

/// Whether a scene hotspot is a movement affordance (an exit or a locked door) rather than an
/// on-tile action target. Drives the split between the movement rail and the action rail.
fn is_movement_kind(kind: HotspotKind) -> bool {
    matches!(kind, HotspotKind::Exit | HotspotKind::Locked)
}

/// The board: the fog-of-war layout rendered as chunky room tiles, with the player + occupant pieces on
/// the current tile. A dark, unlit current room renders concealed until a light is brought.
fn board_view(view: Option<&ViewModel>, map_model: Signal<MapModel>) -> Element {
    let layout = layout_map(&map_model.read());
    let w = layout.width * SCALE;
    let h = layout.height * SCALE;
    let current_lit = view.is_none_or(|v| v.room.is_lit);
    // Pieces standing on the current tile: the player ("you") plus any co-located occupants.
    let pieces: Vec<(String, &'static str)> = view.map_or_else(Vec::new, |v| {
        let mut ps: Vec<(String, &'static str)> = vec![("You".to_string(), "tt-piece-you")];
        for occ in &v.occupants {
            let cls = piece_class(occ.defeated == Some(true), occ.player == Some(true));
            ps.push((occ.name.clone(), cls));
        }
        ps
    });

    rsx! {
        div { class: "tt-board", style: "width:{w}px;height:{h}px;",
            // Connective passages behind the tiles.
            svg { class: "tt-links", view_box: "0 0 {w} {h}", width: "{w}", height: "{h}",
                for (i, lk) in layout.links.iter().enumerate() {
                    line {
                        key: "lk-{i}",
                        x1: "{lk.x1 * SCALE}", y1: "{lk.y1 * SCALE}",
                        x2: "{lk.x2 * SCALE}", y2: "{lk.y2 * SCALE}",
                        class: if lk.locked { "tt-link locked" } else { "tt-link" },
                    }
                }
            }
            for (i, b) in layout.boxes.iter().enumerate() {
                {tile_view(i, b, current_lit, &pieces)}
            }
        }
    }
}

/// One room tile. The current tile carries the pieces; a dark unlit current tile is concealed.
fn tile_view(
    i: usize,
    b: &LaidBox,
    current_lit: bool,
    pieces: &[(String, &'static str)],
) -> Element {
    let concealed = b.current && !current_lit;
    let mut cls = String::from("tt-tile");
    if b.current {
        cls.push_str(" current");
    }
    if concealed {
        cls.push_str(" concealed");
    }
    let left = b.x * SCALE;
    let top = b.y * SCALE;
    let tw = b.w * SCALE;
    let th = b.h * SCALE;
    rsx! {
        div {
            key: "tile-{i}",
            class: "{cls}",
            style: "left:{left}px;top:{top}px;width:{tw}px;height:{th}px;",
            span { class: "tt-tile-label", if concealed { "· · ·" } else { "{b.label}" } }
            if b.remains {
                span { class: "tt-tile-remains", "✕" }
            }
            if b.current {
                div { class: "tt-pieces",
                    for (j, (name, piece_cls)) in pieces.iter().enumerate() {
                        span { key: "pc-{j}", class: "tt-piece {piece_cls}", title: "{name}", "●" }
                    }
                }
            }
        }
    }
}

/// The seat dashboard: HP / SAN / turn from the projection, plus the campaign's live `StatusField`
/// readout (the physical board's per-seat panel).
fn dashboard_view(view: Option<&ViewModel>, fields: &[StatusField]) -> Element {
    let Some(v) = view else {
        return rsx! { div { class: "tt-dash" } };
    };
    let s = &v.status;
    rsx! {
        div { class: "tt-dash",
            div { class: "tt-dash-row",
                span { class: "tt-stat", span { class: "tt-stat-label", "HP" } " " span { class: "tt-stat-value", "{s.health}" } }
                span { class: "tt-stat", span { class: "tt-stat-label", "SAN" } " " span { class: "tt-stat-value", "{s.sanity}" } }
                span { class: "tt-stat", span { class: "tt-stat-label", "Turn" } " " span { class: "tt-stat-value", "{s.turn}/{s.max_turns}" } }
            }
            if !fields.is_empty() {
                div { class: "tt-dash-row campaign",
                    for f in fields.iter() {
                        span {
                            key: "sf-{f.label}",
                            class: status_field_class(f),
                            span { class: "tt-stat-label", "{f.label}" } " "
                            span { class: "tt-stat-value", "{f.value}" }
                        }
                    }
                }
            }
        }
    }
}

/// The CSS class for a campaign status field by its (optional) emphasis.
fn status_field_class(field: &StatusField) -> &'static str {
    match field.emphasis.as_deref() {
        Some("critical") => "tt-stat status-critical",
        Some("warn") => "tt-stat status-warn",
        _ => "tt-stat",
    }
}

/// The movement rail: one button per exit (moving the piece that direction); locked doors are shown
/// disabled. Exits come from `scene_hotspots`, so movement stays in lockstep with the engine.
fn movement_view(view: Option<&ViewModel>, finished: bool, driver: Coroutine<TtAction>) -> Element {
    let Some(v) = view else { return rsx! {} };
    let hotspots = scene_hotspots(v);
    let moves: Vec<_> = hotspots
        .iter()
        .filter(|h| is_movement_kind(h.kind))
        .cloned()
        .collect();
    if moves.is_empty() {
        return rsx! {
            div { class: "tt-panel",
                span { class: "tt-panel-label", "Move" }
                p { class: "tt-empty", "No way out." }
            }
        };
    }
    rsx! {
        div { class: "tt-panel",
            span { class: "tt-panel-label", "Move the piece" }
            div { class: "tt-move-grid",
                for hs in moves.iter() {
                    {
                        let locked = hs.kind == HotspotKind::Locked;
                        let label = hs.label.clone();
                        let action = hs.actions.first().cloned();
                        rsx! {
                            button {
                                key: "mv-{hs.key}",
                                class: if locked { "tt-move-btn locked" } else { "tt-move-btn" },
                                disabled: locked || finished || action.is_none(),
                                title: if locked { "Locked" } else { "Move {label}" },
                                onclick: move |_| if let Some(a) = &action { driver.send(TtAction::Run(a.clone())); },
                                if locked { "🔒 {label}" } else { "{label}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The action rail: everything on the current tile you can act on (occupants, loot, floor items,
/// caches) with its engine-gated verbs, straight from `scene_hotspots`.
fn actions_view(view: Option<&ViewModel>, finished: bool, driver: Coroutine<TtAction>) -> Element {
    let Some(v) = view else { return rsx! {} };
    let hotspots = scene_hotspots(v);
    let targets: Vec<_> = hotspots
        .iter()
        .filter(|h| !is_movement_kind(h.kind) && !h.actions.is_empty())
        .cloned()
        .collect();
    if targets.is_empty() {
        return rsx! {};
    }
    rsx! {
        div { class: "tt-panel",
            span { class: "tt-panel-label", "On this tile" }
            for hs in targets.iter() {
                div { key: "tgt-{hs.key}", class: "tt-target",
                    span { class: "tt-target-name", "{hs.label}" }
                    div { class: "tt-verbs",
                        for (i, a) in hs.actions.iter().enumerate() {
                            {
                                let act = a.clone();
                                rsx! {
                                    button {
                                        key: "verb-{hs.key}-{i}",
                                        class: "tt-verb-btn",
                                        disabled: finished,
                                        onclick: move |_| driver.send(TtAction::Run(act.clone())),
                                        "{a.label()}"
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A compact inventory rail so the player can equip a light (revealing a dark tile), use, or drop —
/// the on-board equivalent of the pnc inventory panel.
fn inventory_view(
    view: Option<&ViewModel>,
    finished: bool,
    driver: Coroutine<TtAction>,
) -> Element {
    let Some(v) = view else { return rsx! {} };
    let inv = &v.inventory;
    if inv.items.is_empty() && inv.keys.is_empty() {
        return rsx! {};
    }
    rsx! {
        div { class: "tt-panel",
            span { class: "tt-panel-label", "Carrying" }
            for item in inv.items.iter() {
                {
                    let equipped = inv.equipped_names.contains(&item.name);
                    let name = item.name.clone();
                    rsx! {
                        div { key: "inv-{item.id}", class: "tt-target",
                            span { class: "tt-target-name",
                                "{name}"
                                if equipped { span { class: "tt-eq", " (equipped)" } }
                            }
                            div { class: "tt-verbs",
                                for (i, a) in inventory_actions(item, equipped).iter().enumerate() {
                                    {
                                        let act = a.clone();
                                        rsx! {
                                            button {
                                                key: "iv-{item.id}-{i}",
                                                class: "tt-verb-btn",
                                                disabled: finished,
                                                onclick: move |_| driver.send(TtAction::Run(act.clone())),
                                                "{a.label()}"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for key in inv.keys.iter() {
                div { key: "invk-{key.id}", class: "tt-target key",
                    span { class: "tt-target-name", "🔑 {key.name}" }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_movement_kind, piece_class};
    use crate::affordances::HotspotKind;

    #[test]
    fn piece_class_ranks_defeated_over_ally_over_mob() {
        // Defeated wins regardless of the ally flag (remains are remains).
        assert_eq!(piece_class(true, false), "tt-piece-remains");
        assert_eq!(piece_class(true, true), "tt-piece-remains");
        // A live co-located party member is an ally; anything else is a hostile.
        assert_eq!(piece_class(false, true), "tt-piece-ally");
        assert_eq!(piece_class(false, false), "tt-piece-mob");
    }

    #[test]
    fn only_exits_and_locked_doors_are_movement_affordances() {
        assert!(is_movement_kind(HotspotKind::Exit));
        assert!(is_movement_kind(HotspotKind::Locked));
        for kind in [
            HotspotKind::Occupant,
            HotspotKind::Player,
            HotspotKind::Loot,
            HotspotKind::Item,
            HotspotKind::Cache,
        ] {
            assert!(
                !is_movement_kind(kind),
                "{kind:?} is an on-tile target, not a move"
            );
        }
    }
}
