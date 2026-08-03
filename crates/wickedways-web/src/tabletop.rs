//! The physical-tabletop Dioxus surface — the on-screen **simulator** for the physical board.
//!
//! The board is driven through the transport-agnostic [`wickedways_tabletop`] bridge: each turn the
//! surface projects the engine, computes the party [`roster`](wickedways_tabletop::roster), and calls
//! [`bridge::render`] to get a list of [`DeviceCommand`]s (paint tiles, place pieces, fill dashboards).
//! A `SimulatorTransport` (here, a `Signal<Vec<DeviceCommand>>`) holds them and the board renders
//! **from that device state** — the same commands real e-ink firmware would apply. Input builds
//! actor-tagged engine commands through the bridge's shared `command_for` (via
//! [`driver::intent_to_command`]). The contextual action rail stays a simulator affordance (its
//! hardware form — tile buttons / item taps — is a P3 question).
//!
//! **Multi-seat (hotseat).** In single-player the surface opens a party-builder; the offline `solo`
//! authority then rotates every seat, each piece an actor. Multiplayer is one seat per device.
//!
//! [`bridge::render`]: wickedways_tabletop::bridge::render
//! [`driver::intent_to_command`]: crate::driver::intent_to_command
//! [`DeviceCommand`]: wickedways_tabletop::protocol::DeviceCommand

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::presentation::{PresentationCue, StatusField};
use wickedways_core::sync::{Command, SubmitResult, SyncCoordinator};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;

use wickedways_tabletop::bridge;
use wickedways_tabletop::protocol::{DeviceCommand, PieceGlow};
use wickedways_tabletop::roster::party_roster;

use crate::affordances::{inventory_actions, scene_hotspots, ActionDescriptor, HotspotKind};
use crate::audio::cue_for_intent;
use crate::audio_pack::wickedways_campaign_audio;
use crate::audio_runtime::AudioRuntime;
use crate::driver::{
    boot, boot_hotseat, bundled_campaign, has_actions_left, intent_to_command, is_gm, is_my_turn,
    project, read_config, rebuild_single, toggle_fullscreen, welcome_for, AppTransport, Mode,
    SeatSpec, GM_IDENTITY,
};
use crate::lobby::{archetype_options, ArchetypeOption};
use crate::map::{layout_map, LaidBox, MapModel};
use crate::narrator::Narrator;
use crate::savestore::{self, SaveBlob};

const TABLETOP_CSS: &str = include_str!("../assets/tabletop.css");

/// Pixel scale applied to the fog-of-war layout so the minimap grid reads as a chunky game board.
const SCALE: f64 = 2.6;

/// The most extra explorers a hotseat party can add beyond the pre-seated seat 0.
const MAX_EXTRA_SEATS: usize = 3;

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

/// A row in the party-builder setup form: a display name and a chosen archetype id ("" = none).
#[derive(Clone, Default, PartialEq)]
struct SeatDraft {
    name: String,
    archetype: String,
}

/// A request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum TtAction {
    /// Begin a hotseat session with `seats` extra players joined (single-player only).
    StartHotseat {
        seats: Vec<SeatSpec>,
    },
    /// Apply a chosen descriptor (an intent to submit, or a free examine/read).
    Run(ActionDescriptor),
    /// The active seat passes (a `Wait`); under `solo` this ends its turn and advances the piece.
    Pass,
    /// GM: advance to the next seat.
    NextPlayer,
    /// A player ends their own turn (multiplayer managed turns).
    EndTurn,
    /// Supply a physical d20 for the engine's next mob to-hit (`Some(value)`), or "Roll for me"
    /// (`None`) — let the house roll from the seeded rng.
    SupplyDice {
        value: Option<u8>,
    },
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

/// Project the current board state into device commands (the `SimulatorTransport`'s payload).
fn device_for(coord: &SyncCoordinator, map: &MapModel, view: &ViewModel) -> Vec<DeviceCommand> {
    bridge::render(
        view,
        &party_roster(coord.replica()),
        map,
        coord.status_fields(),
    )
}

/// The CSS class for a piece token by its device glow (worst affliction).
fn glow_class(glow: PieceGlow) -> &'static str {
    match glow {
        PieceGlow::Normal => "tt-piece-normal",
        PieceGlow::Fear => "tt-piece-fear",
        PieceGlow::Panic => "tt-piece-panic",
        PieceGlow::Ko => "tt-piece-ko",
    }
}

/// Whether a scene hotspot is a movement affordance (an exit or a locked door) rather than an
/// on-tile action target. Drives the split between the movement rail and the action rail.
fn is_movement_kind(kind: HotspotKind) -> bool {
    matches!(kind, HotspotKind::Exit | HotspotKind::Locked)
}

pub fn tabletop_app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    // The `SimulatorTransport` payload: the device commands the board renders from.
    let mut device = use_signal(Vec::<DeviceCommand>::new);
    let mut log = use_signal(Vec::<LogLine>::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    // Multiplayer skips the local setup screen (the lobby already seated this client).
    let started = use_signal(|| matches!(read_config().mode, Mode::Multi));
    let mut settings_open = use_signal(|| false);
    let mut audio_on = use_signal(|| false);
    // The dice-tray entry: the physical d20 face a player will supply for the next mob to-hit.
    let mut dice_value = use_signal(|| "20".to_string());
    let mode = use_hook(|| read_config().mode);
    let welcome = use_hook(|| welcome_for(&read_config().campaign));
    // Archetypes the party-builder offers, read once from the campaign's genesis.
    let arche_opts = use_hook(|| {
        bundled_campaign(&read_config().campaign)
            .ok()
            .map(|(snap, _)| archetype_options(&snap))
            .unwrap_or_default()
    });
    // The extra explorers the host adds in the setup screen (single-player only).
    let drafts = use_signal(Vec::<SeatDraft>::new);
    let is_gm = use_hook(is_gm);
    let mut my_turn = use_signal(|| false);
    let mut my_actions_left = use_signal(|| true);

    let driver = use_coroutine(move |rx: UnboundedReceiver<TtAction>| async move {
        let cfg = read_config();
        let single = matches!(cfg.mode, Mode::Single);
        let gm = single || cfg.token == GM_IDENTITY;
        let mut rx = rx;

        // Single-player defers boot until the setup screen submits the party; multiplayer boots now.
        let booted = if single {
            status.set("seat your party…".into());
            let seats = loop {
                match rx.next().await {
                    Some(TtAction::StartHotseat { seats }) => break seats,
                    Some(_) => {} // ignore stray actions before the party is set
                    None => return,
                }
            };
            boot_hotseat(&cfg.campaign, &seats).await
        } else {
            boot(&cfg).await
        };

        match booted {
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
                    device.set(device_for(&coord, &map_model.read(), v));
                }
                vm.set(initial);
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
                                device.set(device_for(&coord, &map_model.read(), a));
                            }
                            vm.set(after);
                            my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                            my_actions_left.set(has_actions_left(coord.replica(), single));
                            continue;
                        }
                    };
                    let intent = match action {
                        // Already booted — a stray StartHotseat is a no-op.
                        TtAction::StartHotseat { .. } => continue,
                        TtAction::NextPlayer => {
                            submit(&transport, &mut coord, Command::NextPlayer, log).await;
                            let after = project(&coord, &catalog);
                            if let Some(a) = &after {
                                map_model.write().observe(a);
                                audio.update(a);
                                device.set(device_for(&coord, &map_model.read(), a));
                            }
                            vm.set(after);
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
                                device.set(device_for(&coord, &map_model.read(), a));
                            }
                            vm.set(after);
                            my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                            my_actions_left.set(has_actions_left(coord.replica(), single));
                            continue;
                        }
                        TtAction::SupplyDice { value } => {
                            match value {
                                Some(v) => {
                                    let command = Command::SupplyDice {
                                        dice: vec![wickedways_core::dice::SuppliedDie {
                                            sides: 20,
                                            value: u32::from(v),
                                        }],
                                    };
                                    submit(&transport, &mut coord, command, log).await;
                                    log.write().push(LogLine::plain(format!(
                                        "🎲 Supplied a d20 = {v} for the next mob to-hit."
                                    )));
                                }
                                None => {
                                    log.write().push(LogLine::plain(
                                        "🎲 Roll for me — the house will roll the next mob to-hit."
                                            .to_string(),
                                    ));
                                }
                            }
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
                                            device.set(device_for(&coord, &map_model.read(), v));
                                        }
                                        vm.set(restored);
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
                                // Restart re-seats the same party from the setup drafts via a fresh
                                // hotseat boot; fall back to a plain begin if none were added.
                                let seats: Vec<SeatSpec> = drafts
                                    .peek()
                                    .iter()
                                    .map(|d| SeatSpec {
                                        name: d.name.clone(),
                                        archetype: (!d.archetype.is_empty())
                                            .then(|| d.archetype.clone()),
                                    })
                                    .collect();
                                match boot_hotseat(&cfg.campaign, &seats).await {
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
                                            device.set(device_for(&coord, &map_model.read(), v));
                                        }
                                        vm.set(fresh);
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
                                            device.set(device_for(&coord, &map_model.read(), v));
                                        }
                                        vm.set(reverted);
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
                        TtAction::Pass => Intent::Wait,
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
                    // Build the actor-tagged command through the shared bridge builder (active seat).
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
                        device.set(device_for(&coord, &map_model.read(), a));
                    }
                    vm.set(after);
                    my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                    my_actions_left.set(has_actions_left(coord.replica(), single));
                }
            }
        }
    });

    let view = vm();
    let device_state = device();
    let active_name = active_seat_name(&device_state);
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
                if !active_name.is_empty() {
                    span { class: "tt-acting", "Acting: {active_name}" }
                }
                div { class: "tt-controls",
                    if mode == Mode::Multi && my_turn() {
                        button { class: "tt-btn", title: "End your turn", onclick: move |_| driver.send(TtAction::EndTurn), "End Turn" }
                    }
                    if mode == Mode::Single && !finished {
                        button { class: "tt-btn", title: "Active seat passes its turn", onclick: move |_| driver.send(TtAction::Pass), "Pass" }
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
                // ── The board (rendered from the device commands) ───────────────
                div { class: if waiting { "tt-board-wrap waiting" } else { "tt-board-wrap" },
                    {board_view(&device_state, map_model)}
                }

                // ── Rail: dashboards · movement · actions · log ─────────────────
                aside { class: "tt-rail",
                    {dashboard_view(&device_state)}
                    div { class: if waiting { "tt-controls-gate waiting" } else { "tt-controls-gate" },
                        {movement_view(view.as_ref(), finished, driver)}
                        {actions_view(view.as_ref(), finished, driver)}
                        {inventory_view(view.as_ref(), finished, driver)}
                        // ── Dice tray: supply a physical d20 for a mob to-hit, or let the house roll ──
                        if !finished {
                            div { class: "tt-dice",
                                span { class: "tt-dice-label", "🎲 Mob d20" }
                                input {
                                    class: "tt-dice-input",
                                    r#type: "number",
                                    min: "1",
                                    max: "20",
                                    value: "{dice_value}",
                                    oninput: move |e| dice_value.set(e.value()),
                                }
                                button {
                                    class: "tt-btn",
                                    title: "Supply the die you rolled for the monster",
                                    onclick: move |_| {
                                        if let Ok(v) = dice_value().trim().parse::<u8>() {
                                            if (1..=20).contains(&v) {
                                                driver.send(TtAction::SupplyDice { value: Some(v) });
                                            }
                                        }
                                    },
                                    "Supply"
                                }
                                button {
                                    class: "tt-btn",
                                    title: "No dice? Let the house roll the mob's to-hit",
                                    onclick: move |_| driver.send(TtAction::SupplyDice { value: None }),
                                    "Roll for me"
                                }
                            }
                        }
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

            // ── Setup / welcome overlay ─────────────────────────────────────────
            if !started() {
                {setup_view(&welcome.title, &welcome.intro, &welcome.button, &arche_opts, drafts, started, driver)}
            }
        }
    }
}

/// The active seat's name, from the device dashboards.
fn active_seat_name(device: &[DeviceCommand]) -> String {
    device
        .iter()
        .find_map(|c| match c {
            DeviceCommand::Dashboard { name, active, .. } if *active => Some(name.clone()),
            _ => None,
        })
        .unwrap_or_default()
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

/// The board: the fog-of-war layout as chunky room tiles, rendered from the device `Tile`/`Piece`
/// commands (the `SimulatorTransport`). A dark, unlit current room renders concealed.
fn board_view(device: &[DeviceCommand], map_model: Signal<MapModel>) -> Element {
    let layout = layout_map(&map_model.read());
    let w = layout.width * SCALE;
    let h = layout.height * SCALE;

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
                {
                    let concealed = device.iter().any(|c| matches!(
                        c, DeviceCommand::Tile { tile_id, concealed, .. } if tile_id == &b.id && *concealed
                    ));
                    let pieces: Vec<PieceChip> = device
                        .iter()
                        .filter_map(|c| match c {
                            DeviceCommand::Piece { piece_id, name, tile_id, glow, active } if tile_id == &b.id => {
                                Some(PieceChip { id: piece_id.clone(), name: name.clone(), glow: *glow, active: *active })
                            }
                            _ => None,
                        })
                        .collect();
                    tile_view(i, b, concealed, &pieces)
                }
            }
        }
    }
}

/// One piece standing on a tile — extracted from a device `Piece` command.
struct PieceChip {
    id: String,
    name: String,
    glow: PieceGlow,
    active: bool,
}

/// One room tile carrying the pieces standing on it.
fn tile_view(i: usize, b: &LaidBox, concealed: bool, pieces: &[PieceChip]) -> Element {
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
            div { class: "tt-pieces",
                for p in pieces.iter() {
                    {
                        let cls = format!("tt-piece {}{}", glow_class(p.glow), if p.active { " active" } else { "" });
                        rsx! { span { key: "pc-{p.id}", class: "{cls}", title: "{p.name}", "●" } }
                    }
                }
            }
        }
    }
}

/// The seat dashboards + shared banner, rendered from the device `Dashboard`/`Banner` commands.
fn dashboard_view(device: &[DeviceCommand]) -> Element {
    let banner: Vec<StatusField> = device
        .iter()
        .find_map(|c| match c {
            DeviceCommand::Banner { fields } => Some(fields.clone()),
            _ => None,
        })
        .unwrap_or_default();
    rsx! {
        div { class: "tt-dash",
            div { class: "tt-seats",
                for c in device.iter() {
                    if let DeviceCommand::Dashboard { seat_id, name, health, sanity, afflictions, active } = c {
                        div { key: "seat-{seat_id}", class: if *active { "tt-seat active" } else { "tt-seat" },
                            div { class: "tt-seat-top",
                                if *active { span { class: "tt-seat-active", "●" } }
                                span { class: "tt-seat-name", "{name}" }
                            }
                            div { class: "tt-seat-stats",
                                span { class: "tt-stat", span { class: "tt-stat-label", "HP" } " " span { class: "tt-stat-value", "{health}" } }
                                span { class: "tt-stat", span { class: "tt-stat-label", "SAN" } " " span { class: "tt-stat-value", "{sanity}" } }
                            }
                            if !afflictions.is_empty() {
                                div { class: "tt-seat-chips",
                                    for label in afflictions.iter() {
                                        span { key: "chip-{seat_id}-{label}", class: "tt-chip chip-{label.to_lowercase()}", "{label}" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if !banner.is_empty() {
                div { class: "tt-banner",
                    for f in banner.iter() {
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

/// The movement rail: one button per exit (moving the active seat's piece); locked doors are disabled.
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
            span { class: "tt-panel-label", "Move the active piece" }
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

/// The action rail: everything on the active seat's tile with its engine-gated verbs.
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

/// A compact inventory rail so the active seat can equip a light, use, or drop.
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

/// The party-builder / welcome overlay (single-player): the pre-seated seat is Player 1; the host adds
/// up to [`MAX_EXTRA_SEATS`] more explorers, then Begin joins them and boots the hotseat.
fn setup_view(
    title: &str,
    intro: &str,
    button: &str,
    arche_opts: &[ArchetypeOption],
    mut drafts: Signal<Vec<SeatDraft>>,
    mut started: Signal<bool>,
    driver: Coroutine<TtAction>,
) -> Element {
    let rows = drafts();
    let can_add = rows.len() < MAX_EXTRA_SEATS;
    let button = if button.is_empty() {
        "Enter".to_string()
    } else {
        button.to_string()
    };
    rsx! {
        div { class: "tt-welcome",
            h1 { class: "tt-welcome-title", "{title}" }
            p { class: "tt-welcome-intro", "{intro}" }

            div { class: "tt-party",
                div { class: "tt-party-head", "Your party" }
                div { class: "tt-party-row fixed",
                    span { class: "tt-party-num", "1" }
                    span { class: "tt-party-name", "The Heir (you)" }
                }
                for (i, row) in rows.iter().enumerate() {
                    div { key: "draft-{i}", class: "tt-party-row",
                        span { class: "tt-party-num", "{i + 2}" }
                        input {
                            class: "tt-party-name-input",
                            r#type: "text",
                            placeholder: "Explorer {i + 2}",
                            value: "{row.name}",
                            oninput: move |e| { drafts.write()[i].name = e.value(); },
                        }
                        if !arche_opts.is_empty() {
                            select {
                                class: "tt-party-arche",
                                onchange: move |e| { drafts.write()[i].archetype = e.value(); },
                                option { value: "", "— archetype —" }
                                for opt in arche_opts.iter() {
                                    option { key: "opt-{opt.id}", value: "{opt.id}", selected: row.archetype == opt.id, "{opt.name}" }
                                }
                            }
                        }
                        button {
                            class: "tt-party-remove",
                            title: "Remove",
                            onclick: move |_| { drafts.write().remove(i); },
                            "✕"
                        }
                    }
                }
                if can_add {
                    button {
                        class: "tt-party-add",
                        onclick: move |_| drafts.write().push(SeatDraft::default()),
                        "+ Add explorer"
                    }
                }
            }

            button {
                class: "tt-enter-btn",
                onclick: move |_| {
                    let seats: Vec<SeatSpec> = drafts
                        .peek()
                        .iter()
                        .map(|d| SeatSpec {
                            name: d.name.clone(),
                            archetype: (!d.archetype.is_empty()).then(|| d.archetype.clone()),
                        })
                        .collect();
                    driver.send(TtAction::StartHotseat { seats });
                    started.set(true);
                },
                "{button}"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{glow_class, is_movement_kind};
    use crate::affordances::HotspotKind;
    use wickedways_tabletop::protocol::PieceGlow;

    #[test]
    fn glow_class_maps_each_affliction() {
        assert_eq!(glow_class(PieceGlow::Normal), "tt-piece-normal");
        assert_eq!(glow_class(PieceGlow::Fear), "tt-piece-fear");
        assert_eq!(glow_class(PieceGlow::Panic), "tt-piece-panic");
        assert_eq!(glow_class(PieceGlow::Ko), "tt-piece-ko");
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
