//! The CRT terminal surface (Phase 2c, sub-project D).
//!
//! The green-screen text adventure: it drives the multiplayer loop against the room server (or the
//! offline single-player authority) through the shared [`driver`](crate::driver) (connect → project →
//! [`intent_to_command`](crate::driver::intent_to_command) → narrate → map), renders the engine
//! [`ViewModel`], and takes typed commands through the ported [`parse`](crate::parser::parse)r: the
//! prompt turns a line of input into an [`Intent`], which the shell resolves into a sync `Command` (a
//! `move`'s direction becomes the destination room id via the replica's exit graph) and submits;
//! informational queries (look/exits/inventory/help) render locally against the current view. The
//! [`Narrator`](crate::narrator::Narrator) turns cues/queries/intents into prose, the shared
//! [`MapModel`](crate::map::MapModel) tracks the explored map (`map` opens it as an overlay, `help` a
//! command list), and nouns in the room description and narration are clickable — a click fills the
//! prompt with `examine <noun>` ([`link_nouns`](crate::link_nouns), against the current scope's names
//! and aliases). Procedural audio plays through the shared [`AudioRuntime`] (the `audio` command
//! toggles it), and `save`/`restore`/`restart` drive the single-player lifecycle. A welcome gate
//! shows the campaign's title + intro ([`welcome_for`](crate::driver::welcome_for) — the manifest
//! passthrough) until the player presses Enter; the transport connects underneath while it's up.
//!
//! Mounted directly (deep-link) or by the [`launcher`](crate::launcher); connection is configured from
//! the page URL query (`?ws=…&campaign=…&token=…&mode=…&theme=…`).
//!
//! [`Intent`]: wickedways_core::world::intent::Intent
//! [`AudioRuntime`]: crate::audio_runtime::AudioRuntime

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::presentation::StatusField;
use wickedways_core::sync::{Command, SubmitResult};
use wickedways_core::world::intent::Intent;
use wickedways_core::world::view::ViewModel;

use crate::audio::cue_for_intent;
use crate::audio_pack::wickedways_campaign_audio;
use crate::audio_runtime::AudioRuntime;
use crate::driver::{
    boot, boot_single, has_actions_left, intent_to_command, is_gm, is_my_turn, project, read_config,
    rebuild_single, toggle_fullscreen, welcome_for, Mode, GM_IDENTITY,
};
use crate::link_nouns::{link_nouns, Segment};
use crate::map::{layout_map, map_svg, MapModel};
use crate::narrator::Narrator;
use crate::parser::{parse, Meta, ParseResult, Query};
use crate::savestore::{self, SaveBlob};
use crate::theme::crt_theme_vars;

const CRT_CSS: &str = include_str!("../assets/crt.css");

/// An event the transport coroutine loops over: a UI [`Action`], or a `Refresh` tick from a server
/// push (another client's committed action) so the surface re-syncs + re-projects reactively.
enum Ev {
    Act(Action),
    Refresh,
}

/// A driver request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum Action {
    NextPlayer,
    /// A player ends their own turn (multiplayer managed turns).
    EndTurn,
    /// Toggle procedural audio (the click is the user gesture that lets the `AudioContext` start).
    ToggleAudio,
    Input(String),
}

/// A side-effecting meta command deferred out of the parse match so it runs after the command path,
/// where the transport/coordinator can be rebound (restore swaps in a fresh offline authority).
enum MetaEffect {
    Save,
    Restore,
    Restart,
    Undo,
}

/// The one-at-a-time overlay (map or help), mirroring `crt-game.ts`'s `openMap`/`openHelp`.
#[derive(Clone, Debug, PartialEq)]
enum Overlay {
    None,
    Help(Vec<String>),
    Map,
}

pub fn crt_app() -> Element {
    let mut status = use_signal(|| "connecting…".to_string());
    let mut vm = use_signal(|| None::<ViewModel>);
    // The campaign's live `Status` readout, absorbed from the coordinator after each sync.
    let mut status_fields = use_signal(Vec::<StatusField>::new);
    let mut narration = use_signal(Vec::<String>::new);
    let mut draft = use_signal(String::new);
    let mut narrator = use_signal(Narrator::new);
    let mut map_model = use_signal(MapModel::new);
    let mut overlay = use_signal(|| Overlay::None);
    // The welcome gate: the campaign's title/intro/button (manifest passthrough), shown until the
    // player presses Enter. The transport coroutine connects underneath while it's up. In multiplayer
    // the launcher lobby already gated entry, so skip this second welcome and show the game directly.
    let mut started = use_signal(|| matches!(read_config().mode, Mode::Multi));
    let welcome = use_hook(|| welcome_for(&read_config().campaign));
    // The launcher palette (`?theme=`), read once and applied to the CRT root.
    let theme_vars = use_hook(|| crt_theme_vars(&read_config().theme));
    // Whether this client is the GM (gates the `nextPlayer` control), and whether it's this client's
    // turn (the "your turn" indicator) — the coroutine refreshes `my_turn` as the turn moves.
    let is_gm = use_hook(is_gm);
    // Turn-passing is a multiplayer-only concept — in single-player you drive every seat, so neither
    // the GM turn-advance control nor the "your turn" indicator belong.
    let multiplayer = use_hook(|| matches!(read_config().mode, Mode::Multi));
    let mut my_turn = use_signal(|| false);
    // Whether the active player still has action budget this turn (multiplayer). Dims the input so the
    // player knows to end their turn once the budget is spent.
    let mut my_actions_left = use_signal(|| true);
    // Whether procedural audio is on — drives the footer's sound toggle (the coroutine owns the
    // AudioRuntime and keeps this in sync when the state flips via the verb or the button).
    let mut audio_on = use_signal(|| false);

    // Auto-scroll the transcript to the newest line whenever the narration or view changes, so the
    // latest output stays in view between the pinned status bar and dock.
    use_effect(move || {
        let _ = narration.read();
        let _ = vm.read();
        if let Some(el) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.get_element_by_id("transcript"))
        {
            el.set_scroll_top(el.scroll_height());
        }
    });

    let driver = use_coroutine(move |rx: UnboundedReceiver<Action>| async move {
        let cfg = read_config();
        let single = matches!(cfg.mode, Mode::Single);
        let gm = single || cfg.token == GM_IDENTITY;
        match boot(&cfg).await {
            Err(e) => {
                status.set("error".into());
                narration.write().push(format!("connect failed: {e}"));
            }
            Ok((transport, coord, catalog)) => {
                // Mutable so `restore`/`restart` can rebind to a fresh offline authority mid-session.
                // `catalog` is the campaign's, held for the session and used for every projection.
                let mut transport = transport;
                let mut coord = coord;
                // Single-player undo stack: the (snapshot + fog-of-war map) captured BEFORE each
                // committed command, newest last. `undo` pops the last and rebuilds the offline
                // authority from it (the same seam as `restore`). Capped so a long session can't grow
                // it without bound.
                let mut undo_stack: Vec<SaveBlob> = Vec::new();
                // The audio runtime (engine + sanity-reactive ambient bed + chiptune pack), lazily
                // opening its AudioContext when the player enables sound via `audio`.
                let mut audio = AudioRuntime::for_campaign(Some(wickedways_campaign_audio()));
                status.set("connected".into());
                let initial = project(&coord, &catalog);
                if let Some(v) = &initial {
                    map_model.write().observe(v);
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
                let mut events = futures_util::stream::select(rx.map(Ev::Act), pushes.map(|_| Ev::Refresh));
                while let Some(ev) = events.next().await {
                    let action = match ev {
                        Ev::Act(a) => a,
                        Ev::Refresh => {
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
                    let mut intent_for_narration: Option<Intent> = None;
                    let mut before_view: Option<ViewModel> = None;
                    let mut meta_effect: Option<MetaEffect> = None;
                    let mut toggle_audio = false;
                    let command = match action {
                        Action::NextPlayer => Some(Command::NextPlayer),
                        // End the acting player's own turn (the active character is theirs on their turn).
                        Action::EndTurn => coord
                            .replica()
                            .active_character_id()
                            .ok()
                            .map(|actor_id| Command::EndTurn { actor_id }),
                        Action::ToggleAudio => {
                            toggle_audio = true;
                            None
                        }
                        Action::Input(text) => {
                            let view = project(&coord, &catalog);
                            before_view = view.clone();
                            let scope = view.as_ref().map(|v| v.scope.as_slice()).unwrap_or(&[]);
                            match parse(&text, scope) {
                                ParseResult::Query(q) => {
                                    if let Some(v) = &view {
                                        if matches!(q, Query::Help) {
                                            let rows = narrator.write().render_query(q, v);
                                            overlay.set(Overlay::Help(rows));
                                        } else {
                                            let lines = narrator.write().render_query(q, v);
                                            narration.write().extend(lines);
                                        }
                                    }
                                    None
                                }
                                // Opening a container is a local reveal: list its contents from the
                                // current view (the items are already takeable from room scope).
                                ParseResult::Intent(Intent::Open { target_id }) => {
                                    if let Some(v) = &view {
                                        let lines = narrator.write().render_action(
                                            &Intent::Open { target_id },
                                            v,
                                            v,
                                        );
                                        narration.write().extend(lines);
                                    }
                                    None
                                }
                                ParseResult::Intent(intent) => match intent_to_command(coord.replica(), &catalog, &intent) {
                                    Ok(cmd) => {
                                        intent_for_narration = Some(intent);
                                        Some(cmd)
                                    }
                                    Err(note) => {
                                        narration.write().push(note);
                                        None
                                    }
                                },
                                ParseResult::Examine(t) => {
                                    let lines = narrator.write().render_examine(&t);
                                    narration.write().extend(lines);
                                    None
                                }
                                ParseResult::Ambiguous(cands) => {
                                    let names = cands.iter().map(|e| e.name.clone()).collect::<Vec<_>>().join(", ");
                                    narration.write().push(format!("Which do you mean: {names}?"));
                                    None
                                }
                                ParseResult::Meta(meta) => {
                                    match meta {
                                        Meta::Map => overlay.set(Overlay::Map),
                                        Meta::Save => meta_effect = Some(MetaEffect::Save),
                                        Meta::Restore => meta_effect = Some(MetaEffect::Restore),
                                        Meta::Restart => meta_effect = Some(MetaEffect::Restart),
                                        Meta::Undo => meta_effect = Some(MetaEffect::Undo),
                                        // The Enter keypress that submitted this line is the user
                                        // gesture that lets the browser grant fullscreen.
                                        Meta::Fullscreen => {
                                            let entering = toggle_fullscreen();
                                            narration.write().push(
                                                if entering { "Fullscreen on." } else { "Fullscreen off." }.into(),
                                            );
                                        }
                                        // The Enter keypress that submitted this line is the user
                                        // gesture that lets the AudioContext start; the actual toggle
                                        // runs below, shared with the footer's sound button.
                                        Meta::Audio => toggle_audio = true,
                                    }
                                    None
                                }
                                ParseResult::Error(msg) => {
                                    narration.write().push(msg);
                                    audio.note_error();
                                    None
                                }
                            }
                        }
                    };

                    // Audio toggle (from the `audio` verb or the footer button). Kept in one place so
                    // both routes stay in sync, including the reactive `audio_on` flag for the button.
                    if toggle_audio {
                        if audio.enabled() {
                            audio.set_enabled(false);
                            narration.write().push("Audio off.".into());
                        } else {
                            audio.set_enabled(true);
                            if audio.enabled() {
                                narration.write().push("Audio on.".into());
                                // Seed the ambient bed with the current tension.
                                if let Some(v) = project(&coord, &catalog) {
                                    audio.update(&v);
                                }
                            } else {
                                narration.write().push("Audio is unavailable.".into());
                            }
                        }
                        audio_on.set(audio.enabled());
                    }

                    if let Some(cmd) = command {
                        // Capture the pre-command state for `undo` (single-player only): a snapshot +
                        // the current fog-of-war map, pushed onto the stack only once the command
                        // actually commits.
                        let undo_point = (cfg.mode == Mode::Single)
                            .then(|| SaveBlob { snapshot: coord.snapshot(), map: map_model.read().serialize() });
                        match transport.submit_async(cmd).await {
                            SubmitResult::Committed { seq, delta } => {
                                if let Some(point) = undo_point {
                                    undo_stack.push(point);
                                    // Bound the history so a marathon session can't grow it unbounded.
                                    if undo_stack.len() > 100 {
                                        undo_stack.remove(0);
                                    }
                                }
                                coord.sync(&transport);
                                let after = project(&coord, &catalog);
                                // A move must be recorded BEFORE `observe`: `record_move` places the
                                // newly-entered room relative to the one we left and adds the
                                // traversed edge, whereas `observe` seeds any unseen room at the
                                // grid origin and (relying on that edge) suppresses the back-stub.
                                // Observe-first would pin every new room at (0,0) and keep a
                                // spurious `?` stub pointing back the way the player came.
                                if let (Some(Intent::Move { dir }), Some(b), Some(a)) =
                                    (&intent_for_narration, &before_view, &after)
                                {
                                    map_model.write().record_move(&b.room.id, *dir, &a.room.id);
                                }
                                if let Some(a) = &after {
                                    map_model.write().observe(a);
                                }
                                if let (Some(intent), Some(b), Some(a)) = (intent_for_narration, &before_view, &after) {
                                    let action_lines = narrator.write().render_action(&intent, b, a);
                                    narration.write().extend(action_lines);
                                    // The room name/description/occupants live in the persistent header
                                    // (game_view), so entering a room updates that panel rather than
                                    // re-printing the room into the transcript. The transcript stays an
                                    // action + dialogue log.
                                    // Voice the action (attack/move/take/drop have a sound).
                                    if let Some(cue) = cue_for_intent(&intent) {
                                        audio.play_cue(&cue, a);
                                    }
                                }
                                // Render the delta's mechanic cues as prose: NPC dialogue (the
                                // caretaker's lines), storyteller journal reveals, and any effect
                                // cues the command emitted. `render_action` deliberately returns
                                // nothing for `talk` — the dialogue cue is its whole feedback.
                                let cue_lines = narrator.read().render_cues(&delta.cues);
                                if !cue_lines.is_empty() {
                                    narration.write().extend(cue_lines);
                                }
                                // Drive the ambient bed from the new view (also covers nextPlayer,
                                // which has no intent to voice).
                                if let Some(a) = &after {
                                    audio.update(a);
                                }
                                vm.set(after);
                                status_fields.set(coord.status_fields().to_vec());
                                status.set(format!("committed seq {seq}"));
                            }
                            SubmitResult::Denied { reason } => {
                                narration.write().push(format!("✗ {reason}"));
                                audio.note_error();
                            }
                        }
                    }

                    // Save/restore run after the command path so `transport`/`coord` are free to
                    // rebind. Both are single-player only — multiplayer state lives on the server.
                    match meta_effect {
                        Some(MetaEffect::Save) if cfg.mode == Mode::Single => {
                            let blob = SaveBlob { snapshot: coord.snapshot(), map: map_model.read().serialize() };
                            match savestore::save("slot1", &blob) {
                                Ok(()) => narration.write().push("Saved.".into()),
                                Err(e) => narration.write().push(format!("Save failed: {e}")),
                            }
                        }
                        Some(MetaEffect::Restore) if cfg.mode == Mode::Single => {
                            match savestore::load("slot1") {
                                Some(blob) => {
                                    // Rebuild the offline authority from the saved snapshot (with the
                                    // campaign catalog) and hydrate the saved fog-of-war map.
                                    let (t, c) = rebuild_single(blob.snapshot, catalog.clone());
                                    transport = t;
                                    coord = c;
                                    map_model.write().hydrate(blob.map);
                                    let restored = project(&coord, &catalog);
                                    narration.write().push("Restored.".into());
                                    if let Some(v) = &restored {
                                        audio.update(v);
                                    }
                                    vm.set(restored);
                                    status_fields.set(coord.status_fields().to_vec());
                                }
                                None => narration.write().push("No save found.".into()),
                            }
                        }
                        Some(MetaEffect::Restart) if cfg.mode == Mode::Single => {
                            // Re-boot the campaign from its pristine genesis (auto-begins if needed)
                            // and reset the surface state (map, narrator's visited-rooms, transcript).
                            match boot_single(&cfg.campaign).await {
                                Ok((t, c, _cat)) => {
                                    transport = t;
                                    coord = c;
                                    map_model.write().reset();
                                    narrator.set(Narrator::new());
                                    narration.write().clear();
                                    // Fresh session: rebuild the director so tension's high-water mark resets.
                                    audio.reset();
                                    let fresh = project(&coord, &catalog);
                                    if let Some(v) = &fresh {
                                        map_model.write().observe(v);
                                        audio.update(v);
                                    }
                                    vm.set(fresh);
                                    status_fields.set(coord.status_fields().to_vec());
                                }
                                Err(e) => narration.write().push(format!("Restart failed: {e}")),
                            }
                        }
                        Some(MetaEffect::Undo) if cfg.mode == Mode::Single => {
                            match undo_stack.pop() {
                                Some(blob) => {
                                    // Rebuild the offline authority from the pre-command snapshot and
                                    // hydrate its fog-of-war map — the same rebuild seam as `restore`.
                                    let (t, c) = rebuild_single(blob.snapshot, catalog.clone());
                                    transport = t;
                                    coord = c;
                                    map_model.write().hydrate(blob.map);
                                    let reverted = project(&coord, &catalog);
                                    narration.write().push("Undone.".into());
                                    if let Some(v) = &reverted {
                                        audio.update(v);
                                    }
                                    vm.set(reverted);
                                    status_fields.set(coord.status_fields().to_vec());
                                }
                                None => narration.write().push("Nothing to undo.".into()),
                            }
                        }
                        Some(_) => narration.write().push("(save/restore/restart/undo is single-player only)".into()),
                        None => {}
                    }

                    // Recompute whose turn it is after the action (a nextPlayer/move can move the seat).
                    my_turn.set(is_my_turn(&coord.snapshot(), &cfg.token, gm, single));
                                my_actions_left.set(has_actions_left(coord.replica(), single));
                }
            }
        }
    });

    // The status bar (pinned top) and the exits/inventory dock (pinned bottom) render OUTSIDE the
    // scrolling transcript, so they stay in view as narration grows. Only the room/occupants/narration
    // scroll. Both empty until the first projection.
    let vmodel = vm();
    let (hud, dock, side) = match &vmodel {
        Some(v) => (hud_bar(v, &status_fields()), dock_bar(v), side_bar(v)),
        None => (rsx! {}, rsx! {}, rsx! {}),
    };
    let screen = match vmodel {
        Some(v) => game_view(v, narration, draft),
        None => rsx! {
            div { class: "line system", "WICKEDWAYS" }
            div { class: "line", "status: {status}" }
        },
    };

    // Prompt state: locked off-turn or once the action budget is spent (multiplayer).
    let prompt_disabled = !my_turn() || !my_actions_left();
    let prompt_placeholder = if !my_turn() {
        "Waiting for your turn…"
    } else if !my_actions_left() {
        "No actions left — end your turn"
    } else {
        ""
    };

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{theme_vars}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        {hud}
                        // Two columns: the transcript + exits on the left, inventory + materials on
                        // the right. The prompt and controls sit BELOW the columns, full width.
                        div { class: "screen-cols",
                            div { class: "screen-main",
                                div { class: "transcript", id: "transcript", {screen} }
                                {dock}
                            }
                            aside { class: "screen-side", {side} }
                        }
                        div { class: if my_turn() && my_actions_left() { "prompt" } else { "prompt waiting" },
                            span { class: "caret", "›" }
                            input {
                                id: "prompt",
                                value: "{draft}",
                                // Off-turn OR out of budget (multiplayer): the input is locked. Single-
                                // player is always your turn with no budget gate, so it never disables.
                                disabled: prompt_disabled,
                                placeholder: "{prompt_placeholder}",
                                oninput: move |e| draft.set(e.value()),
                                onkeydown: move |e| if e.key() == Key::Enter {
                                    let text = draft.read().trim().to_string();
                                    if !text.is_empty() {
                                        narration.write().push(format!("› {text}"));
                                        driver.send(Action::Input(text));
                                        draft.set(String::new());
                                    }
                                },
                            }
                        }
                        div { class: "controls",
                            if multiplayer && my_turn() {
                                span { class: "turn-indicator", "● Your turn" }
                                // A player ends their own turn; the GM's `nextPlayer` (below) ends anyone's.
                                button { class: "end-turn-btn", onclick: move |_| driver.send(Action::EndTurn), "End Turn" }
                            }
                            // The turn-advance control is the GM's only, and only in multiplayer.
                            if multiplayer && is_gm {
                                button { id: "submit", onclick: move |_| driver.send(Action::NextPlayer), "GM: nextPlayer" }
                            }
                        }
                    }
                    div { class: "crt-overlay" }
                }
                // The molded bezel chin: the brand plate + the physical sound toggle, on the plastic
                // housing (outside the screen), like a real CRT's front panel.
                div { class: "bezel",
                    span { class: "brand", "WICKEDWAYS" }
                    button {
                        class: "audio-btn",
                        title: if audio_on() { "Sound on" } else { "Sound off" },
                        onclick: move |_| driver.send(Action::ToggleAudio),
                        if audio_on() { "🔊" } else { "🔇" }
                    }
                }
            }
        }
        // ── Welcome gate (campaign manifest: title / intro / start button) ──
        // Carries `theme_vars` because it renders OUTSIDE `.backdrop` (which holds the palette vars),
        // so it must set them itself or `var(--color-*)` is undefined → transparent bg + black text.
        if !started() {
            div { class: "crt-welcome", style: "{theme_vars}",
                h1 { class: "welcome-title", "{welcome.title}" }
                p { class: "welcome-intro", "{welcome.intro}" }
                button { class: "enter-btn", onclick: move |_| started.set(true), "{welcome.button}" }
            }
        }
        if overlay() != Overlay::None {
            // Same as the welcome gate: this renders outside `.backdrop`, so it carries the palette vars.
            div { class: "overlay", style: "{theme_vars}", onclick: move |_| overlay.set(Overlay::None),
                // Clicks on the framed content don't dismiss (only the backdrop does) — matches the
                // `.overlay-frame { cursor: default }` affordance and `crt-game.ts`, where frame
                // clicks never close the overlay.
                div { class: "overlay-frame", onclick: move |e| e.stop_propagation(),
                    match overlay() {
                        Overlay::Help(rows) => rsx! {
                            div { class: "help-list",
                                for (i, row) in rows.iter().enumerate() {
                                    div { key: "help-{i}", class: "help-row", "{row}" }
                                }
                            }
                        },
                        Overlay::Map => rsx! { {map_svg(&layout_map(&map_model.read()))} },
                        Overlay::None => rsx! {},
                    }
                }
                div { class: "overlay-legend",
                    if overlay() == Overlay::Map {
                        "─ open   ╌ locked   ? unexplored   ✕ remains   ▣ here   ·   click to close"
                    } else {
                        "click to close"
                    }
                }
            }
        }
    }
}

/// Render one line of prose with the current scope's nouns as clickable spans; clicking a noun fills
/// the prompt with `examine <noun>` (ported from `crt-transcript`/`crt-hud`'s noun linking).
fn linked_line(line: &str, nouns: &[String], draft: Signal<String>) -> Element {
    rsx! {
        for (i, seg) in link_nouns(line, nouns).into_iter().enumerate() {
            {
                let Segment { text, noun } = seg;
                match noun {
                    Some(n) => rsx! {
                        span {
                            key: "seg{i}",
                            class: "noun",
                            onclick: move |_| { let mut d = draft; d.set(format!("examine {n}")); },
                            "{text}"
                        }
                    },
                    None => rsx! { span { key: "seg{i}", "{text}" } },
                }
            }
        }
    }
}

/// The scope's clickable nouns — each entity's name + aliases, de-duplicated case-insensitively
/// (mirrors the controller's `computeClickableNouns`).
fn clickable_nouns(v: &ViewModel) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for e in &v.scope {
        for name in std::iter::once(&e.name).chain(e.aliases.iter()) {
            if seen.insert(name.to_ascii_lowercase()) {
                out.push(name.clone());
            }
        }
    }
    out
}

/// The CSS class for a status field by its (optional) emphasis (mirrors `crt-status`'s color-coding).
fn emphasis_class(field: &StatusField) -> &'static str {
    match field.emphasis.as_deref() {
        Some("critical") => "status-field status-critical",
        Some("warn") => "status-field status-warn",
        _ => "status-field",
    }
}

/// Renders the engine's `ViewModel` as the CRT game view — HUD, room, exits, occupants, inventory,
/// plus the running narration log. The room description and narration lines link the scope's nouns;
/// `fields` are the campaign's live `Status` readout, shown as a color-coded status bar when present.
/// The fixed status bar pinned to the top of the CRT screen (above the scrolling transcript): the
/// core HUD (location · turn · HP · SAN) plus the campaign's authored `StatusField` readout.
fn hud_bar(v: &ViewModel, fields: &[StatusField]) -> Element {
    let s = &v.status;
    // The HUD already shows turn / HP / SAN, so a campaign's authored StatusFields that just repeat
    // them are redundant (e.g. Hollow House's `status-bar` mechanic emits "Sanity" and "Round").
    // Drop those; keep any field the HUD doesn't cover (Energy, custom readouts).
    let extra: Vec<StatusField> =
        fields.iter().filter(|f| !duplicates_hud_stat(&f.label)).cloned().collect();
    rsx! {
        div { class: "hud",
            span { "{s.location_name}" }
            span { class: "sep", "·" }
            span { "turn {s.turn}/{s.max_turns}" }
            span { class: "sep", "·" }
            span { "HP {s.health}" }
            span { class: "sep", "·" }
            span { "SAN {s.sanity}" }
        }
        if !extra.is_empty() {
            div { class: "campaign-status",
                for f in extra.iter() {
                    span { key: "sf-{f.label}", class: emphasis_class(f), "{f.label} {f.value}" }
                }
            }
        }
    }
}

/// Whether a campaign `StatusField` label just repeats a stat the built-in HUD already shows
/// (turn / HP / SAN), so the surface can drop it rather than print the value twice.
fn duplicates_hud_stat(label: &str) -> bool {
    matches!(
        label.trim().to_lowercase().as_str(),
        "sanity" | "san" | "health" | "hp" | "round" | "turn"
    )
}

/// The fixed dock pinned to the bottom of the main column (between the transcript and the input): the
/// current room's exits, kept in view as the transcript scrolls. Inventory and materials live in the
/// right-hand [`side_bar`].
fn dock_bar(v: &ViewModel) -> Element {
    rsx! {
        div { class: "dock",
            if !v.exits.is_empty() || !v.locked_doors.is_empty() {
                div { class: "section",
                    div { class: "section-label", "Exits" }
                    div { class: "chips",
                        for e in v.exits.iter() {
                            span { key: "{e.dir.as_key()}", class: "chip", "{e.dir.as_key()} → {e.to_name}" }
                        }
                        for d in v.locked_doors.iter() {
                            span { key: "locked-{d.dir.as_key()}", class: "chip",
                                "{d.dir.as_key()} → {d.name} "
                                span { class: "meta", "(locked)" }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The right-third sidebar: the player's inventory and the shared material pool, kept in view
/// alongside the scrolling transcript.
fn side_bar(v: &ViewModel) -> Element {
    let inv = &v.inventory;
    let empty = inv.items.is_empty() && inv.keys.is_empty();
    rsx! {
        div { class: "section",
            div { class: "section-label", "Inventory ({inv.items.len() + inv.keys.len()}/{inv.slots})" }
            if empty {
                div { class: "chip meta", "empty" }
            } else {
                div { class: "chips",
                    for it in inv.items.iter() {
                        span { key: "{it.id}", class: "chip", "{it.name}" }
                    }
                    for k in inv.keys.iter() {
                        span { key: "{k.id}", class: "chip", "{k.name} ", span { class: "meta", "(key)" } }
                    }
                }
            }
        }
        if !v.materials.is_empty() {
            div { class: "section",
                div { class: "section-label", "Materials" }
                div { class: "chips",
                    for m in v.materials.iter() {
                        span { key: "mat-{m.component}", class: "chip", "{m.component} ×{m.quantity}" }
                    }
                }
            }
        }
    }
}

fn game_view(v: ViewModel, narration: Signal<Vec<String>>, draft: Signal<String>) -> Element {
    let nouns = clickable_nouns(&v);
    rsx! {
        div { class: "room-name", "{v.room.name}" }
        div {
            class: if v.room.is_lit { "room-desc" } else { "room-desc dark" },
            if v.room.is_lit {
                {linked_line(&v.room.description, &nouns, draft)}
            } else {
                "It is too dark to see."
            }
        }

        if !v.occupants.is_empty() {
            div { class: "section",
                div { class: "section-label", "Here" }
                div { class: "chips",
                    for o in v.occupants.iter() {
                        {
                            let is_player = o.player == Some(true);
                            // A co-located party member is marked so you can see who you're with.
                            let chip_class = if is_player { "chip player" }
                                else if o.defeated == Some(true) { "chip defeated" }
                                else { "chip" };
                            let marker = if is_player { "◆ " } else { "" };
                            let health = o.health;
                            rsx! {
                                span { key: "{o.id}", class: "{chip_class}",
                                    "{marker}{o.name}"
                                    if let Some(h) = health {
                                        span { class: "meta", " ({h} hp)" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if !v.caches.is_empty() {
            div { class: "section",
                div { class: "section-label", "Caches" }
                div { class: "chips",
                    for c in v.caches.iter() {
                        span { key: "{c.id}", class: "chip", "{c.name} ", span { class: "meta", "(harvest)" } }
                    }
                }
            }
        }

        if !v.recipes.is_empty() {
            div { class: "section",
                div { class: "section-label", "Recipes" }
                div { class: "chips",
                    for r in v.recipes.iter() {
                        {
                            let chip_class = if r.affordable { "chip" } else { "chip meta" };
                            let hint = if r.affordable { "(craft)" } else { "(need materials)" };
                            rsx! {
                                span { key: "{r.id}", class: "{chip_class}", "{r.name} ", span { class: "meta", "{hint}" } }
                            }
                        }
                    }
                }
            }
        }

        if !narration().is_empty() {
            div { class: "section narration",
                for (i, line) in narration().iter().enumerate() {
                    div { key: "n{i}", class: "line", {linked_line(line, &nouns, draft)} }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::duplicates_hud_stat;

    #[test]
    fn hud_stat_dedup_drops_built_in_labels_case_insensitively() {
        // Labels the built-in HUD already shows (turn / HP / SAN) are dropped from the campaign
        // StatusField row, however the campaign cased them.
        for redundant in ["Sanity", "SAN", "san", "Round", "round", "Health", "HP", "hp", " Turn "] {
            assert!(duplicates_hud_stat(redundant), "{redundant:?} should be dropped");
        }
        // Anything the HUD doesn't cover stays.
        for kept in ["Energy", "Dread", "Journal", "Keys"] {
            assert!(!duplicates_hud_stat(kept), "{kept:?} should be kept");
        }
    }
}
