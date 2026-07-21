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
    boot, boot_single, intent_to_command, project, read_config, rebuild_single, welcome_for, Mode,
};
use crate::link_nouns::{link_nouns, Segment};
use crate::map::{layout_map, map_svg, MapModel};
use crate::narrator::Narrator;
use crate::parser::{parse, Meta, ParseResult, Query};
use crate::savestore::{self, SaveBlob};
use crate::theme::crt_theme_vars;

const CRT_CSS: &str = include_str!("../assets/crt.css");

/// A driver request from the UI to the (non-Send, Rc-backed) transport coroutine.
enum Action {
    NextPlayer,
    Input(String),
}

/// A side-effecting meta command deferred out of the parse match so it runs after the command path,
/// where the transport/coordinator can be rebound (restore swaps in a fresh offline authority).
enum MetaEffect {
    Save,
    Restore,
    Restart,
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
    // player presses Enter. The transport coroutine connects underneath while it's up.
    let mut started = use_signal(|| false);
    let welcome = use_hook(|| welcome_for(&read_config().campaign));
    // The launcher palette (`?theme=`), read once and applied to the CRT root.
    let theme_vars = use_hook(|| crt_theme_vars(&read_config().theme));

    let driver = use_coroutine(move |mut rx: UnboundedReceiver<Action>| async move {
        let cfg = read_config();
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
                // The audio runtime (engine + sanity-reactive ambient bed + chiptune pack), lazily
                // opening its AudioContext when the player enables sound via `audio`.
                let mut audio = AudioRuntime::for_campaign(Some(wickedways_campaign_audio()));
                status.set("connected".into());
                let initial = project(&coord, &catalog);
                if let Some(v) = &initial {
                    map_model.write().observe(v);
                    narration.write().extend(narrator.write().render_room(v));
                    audio.update(v);
                }
                vm.set(initial);
                status_fields.set(coord.status_fields().to_vec());

                while let Some(action) = rx.next().await {
                    let mut intent_for_narration: Option<Intent> = None;
                    let mut before_view: Option<ViewModel> = None;
                    let mut meta_effect: Option<MetaEffect> = None;
                    let command = match action {
                        Action::NextPlayer => Some(Command::NextPlayer),
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
                                ParseResult::Intent(intent) => match intent_to_command(coord.replica(), &intent) {
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
                                        // The Enter keypress that submitted this line is the user
                                        // gesture that lets the AudioContext start.
                                        Meta::Audio => {
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
                                        }
                                        _ => narration.write().push("(that's not available here yet)".into()),
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
                    if let Some(cmd) = command {
                        match transport.submit_async(cmd).await {
                            SubmitResult::Committed { seq, .. } => {
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
                                    if matches!(intent, Intent::Move { .. }) {
                                        let room_lines = narrator.write().render_room(a);
                                        narration.write().extend(room_lines);
                                    }
                                    // Voice the action (attack/move/take/drop have a sound).
                                    if let Some(cue) = cue_for_intent(&intent) {
                                        audio.play_cue(&cue, a);
                                    }
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
                                        let lines = narrator.write().render_room(v);
                                        narration.write().extend(lines);
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
                                        let lines = narrator.write().render_room(v);
                                        narration.write().extend(lines);
                                        audio.update(v);
                                    }
                                    vm.set(fresh);
                                    status_fields.set(coord.status_fields().to_vec());
                                }
                                Err(e) => narration.write().push(format!("Restart failed: {e}")),
                            }
                        }
                        Some(_) => narration.write().push("(save/restore/restart is single-player only)".into()),
                        None => {}
                    }
                }
            }
        }
    });

    let screen = match vm() {
        Some(v) => game_view(v, narration, draft, status_fields()),
        None => rsx! {
            div { class: "line system", "WICKEDWAYS" }
            div { class: "line", "status: {status}" }
        },
    };

    rsx! {
        style { "{CRT_CSS}" }
        div { class: "backdrop", style: "{theme_vars}",
            div { class: "monitor",
                div { class: "monitor-screen",
                    div { class: "screen",
                        div { class: "transcript", {screen} }
                        div { class: "prompt",
                            span { class: "caret", "›" }
                            input {
                                id: "prompt",
                                value: "{draft}",
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
                            button { id: "submit", onclick: move |_| driver.send(Action::NextPlayer), "GM: nextPlayer" }
                        }
                    }
                    div { class: "crt-overlay" }
                }
            }
        }
        // ── Welcome gate (campaign manifest: title / intro / start button) ──
        if !started() {
            div { class: "crt-welcome",
                h1 { class: "welcome-title", "{welcome.title}" }
                p { class: "welcome-intro", "{welcome.intro}" }
                button { class: "enter-btn", onclick: move |_| started.set(true), "{welcome.button}" }
            }
        }
        if overlay() != Overlay::None {
            div { class: "overlay", onclick: move |_| overlay.set(Overlay::None),
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
fn game_view(v: ViewModel, narration: Signal<Vec<String>>, draft: Signal<String>, fields: Vec<StatusField>) -> Element {
    let s = &v.status;
    let nouns = clickable_nouns(&v);
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
        if !fields.is_empty() {
            div { class: "campaign-status",
                for f in fields.iter() {
                    span { key: "sf-{f.label}", class: emphasis_class(f), "{f.label} {f.value}" }
                }
            }
        }
        div { class: "room-name", "{v.room.name}" }
        div {
            class: if v.room.is_lit { "room-desc" } else { "room-desc dark" },
            if v.room.is_lit {
                {linked_line(&v.room.description, &nouns, draft)}
            } else {
                "It is too dark to see."
            }
        }

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

        if !v.occupants.is_empty() {
            div { class: "section",
                div { class: "section-label", "Here" }
                div { class: "chips",
                    for o in v.occupants.iter() {
                        span {
                            key: "{o.id}",
                            class: if o.defeated == Some(true) { "chip defeated" } else { "chip" },
                            "{o.name}"
                            if let Some(h) = o.health {
                                span { class: "meta", " ({h} hp)" }
                            }
                        }
                    }
                }
            }
        }

        {
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
