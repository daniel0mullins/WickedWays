//! The multiplayer join lobby (Phase 2c, sub-project D).
//!
//! The pre-game screen for a multiplayer campaign: a player **names their character**, **picks an
//! archetype** (when the campaign offers them), and **joins a campaign by id**. The GM (the identity
//! that owns the seeded GM seat) additionally gets a **Start** control to begin the campaign.
//!
//! The join itself is the engine's self-service `JoinCampaign` (add your own character) followed by an
//! optional `SelectArchetype` (apply its statline) — both pre-begin. The server replicates the new
//! character to every connected client via the sync **push** (a committed log entry), which the
//! [`transport`](crate::transport) surfaces as a wake-up so the lobby roster refreshes live rather than
//! polling.
//!
//! The wiring (connect / submit / refresh-on-push / hand off to the surface) is the browser-verified
//! Dioxus shell; the pure pieces below — deriving the archetype options, building the joining
//! character, and sequencing the join commands — are host-tested.

use std::cell::RefCell;
use std::rc::Rc;

use dioxus::prelude::*;
use futures_util::StreamExt;

use wickedways_core::sync::{Command, SyncCoordinator, SyncTransport};
use wickedways_core::world::ids::CharacterId;
use wickedways_core::world::snapshot::{CampaignSnapshot, CharacterKind, CharacterSnapshot};

use crate::driver::{ensure_player_identity, read_config, set_params, welcome_for};
use crate::transport::{Roster, WsTransport};

/// One archetype a joiner can pick, from the campaign's `campaign.archetypes` catalogue.
#[derive(Clone, Debug, PartialEq)]
pub struct ArchetypeOption {
    pub id: String,
    pub name: String,
}

/// The archetypes a joining player may choose, read from the (inert) `archetypes` catalogue the
/// genesis snapshot carries. Empty when the campaign defines none (then the join keeps the template
/// statline — see [`build_joining_character`]).
pub fn archetype_options(snapshot: &CampaignSnapshot) -> Vec<ArchetypeOption> {
    #[derive(serde::Deserialize)]
    struct A {
        id: String,
        #[serde(default)]
        name: String,
    }
    serde_json::from_value::<Vec<A>>(snapshot.campaign.archetypes.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|a| {
            let name = if a.name.is_empty() {
                a.id.clone()
            } else {
                a.name
            };
            ArchetypeOption { id: a.id, name }
        })
        .collect()
}

/// Build the bare player character a joiner submits with `JoinCampaign`, using an existing campaign
/// character (the GM host, else any player) as a field template so every tail field stays valid. The
/// joiner takes a fresh id + the player's chosen name, spawns where the template stands (the campaign's
/// entry room), and carries NO archetype yet (a following `SelectArchetype` applies one) and none of
/// the template's items/equipment/history. Returns `None` for a campaign with no character to template
/// from (never the case for a GM-hosted campaign).
pub fn build_joining_character(
    snapshot: &CampaignSnapshot,
    name: &str,
    character_id: &str,
) -> Option<CharacterSnapshot> {
    let template = snapshot
        .campaign
        .gm_id
        .as_ref()
        .and_then(|gm| snapshot.characters.iter().find(|c| &c.id == gm))
        .or_else(|| {
            snapshot
                .characters
                .iter()
                .find(|c| c.kind == CharacterKind::Player)
        })
        .or_else(|| snapshot.characters.first())?;
    let mut c = template.clone();
    c.kind = CharacterKind::Player;
    c.id = CharacterId(character_id.to_string());
    c.name = name.to_string();
    c.archetype_id = None;
    c.archetype_immunities = Vec::new();
    c.inventory.item_ids = Vec::new();
    c.inventory.key_ids = Vec::new();
    c.equipment = Default::default();
    c.history = Vec::new();
    c.actions_this_round = 0;
    Some(c)
}

/// The command sequence a join submits: `JoinCampaign` (add the character), then — when an archetype
/// was chosen — `SelectArchetype` to apply its statline. Both are pre-begin setup.
pub fn join_commands(character: CharacterSnapshot, archetype_id: Option<&str>) -> Vec<Command> {
    let actor = character.id.clone();
    let mut cmds = vec![Command::JoinCampaign {
        character: Box::new(character),
    }];
    if let Some(a) = archetype_id.filter(|s| !s.is_empty()) {
        cmds.push(Command::SelectArchetype {
            actor_id: actor,
            archetype_id: a.to_string(),
        });
    }
    cmds
}

/// A stable, collision-resistant character id for a joiner, derived from their connection identity
/// (unique per tab) so two players who pick the same name still get distinct seats.
pub fn character_id_for(identity: &str) -> String {
    format!("player:{identity}")
}

const LOBBY_CSS: &str = include_str!("../assets/lobby.css");

/// The multiplayer join lobby for `slug`: connect, let the player create + join a character (name +
/// archetype), show the live roster (refreshed on server push, not polled), let the GM start, and hand
/// off to the surface via `on_enter` once the campaign has begun.
#[component]
pub fn MultiplayerLobby(slug: String, on_enter: EventHandler<()>) -> Element {
    let identity = use_hook(ensure_player_identity);
    let welcome = use_hook(|| welcome_for(&slug));

    let mut status = use_signal(|| "connecting…".to_string());
    let mut started = use_signal(|| false);
    let mut you_joined = use_signal(|| false);
    let mut archetypes = use_signal(Vec::<ArchetypeOption>::new);
    let mut roster = use_signal(Roster::default);
    let mut snapshot = use_signal(|| None::<CampaignSnapshot>);
    let mut name = use_signal(String::new);
    let mut archetype = use_signal(String::new);
    // The connected transport, shared with the button handlers that submit through it.
    let transport = use_hook(|| Rc::new(RefCell::new(None::<Rc<WsTransport>>)));

    // Connect, then refresh state on every server PUSH (no polling): the push channel ticks on each
    // committed entry / presence update, and we re-read the coordinator + roster.
    use_future({
        let slug = slug.clone();
        let identity = identity.clone();
        let transport = transport.clone();
        move || {
            let slug = slug.clone();
            let identity = identity.clone();
            let transport = transport.clone();
            async move {
                let cfg = read_config();
                match WsTransport::connect(&cfg.ws, &slug, &identity).await {
                    Err(e) => status.set(format!("couldn't reach the campaign: {e}")),
                    Ok(t) => {
                        let t = Rc::new(t);
                        *transport.borrow_mut() = Some(t.clone());
                        let mut coord = SyncCoordinator::join(t.as_ref());
                        let seed = SyncTransport::load_snapshot(t.as_ref()).1;
                        archetypes.set(archetype_options(&seed));
                        let cid = character_id_for(&identity);
                        let mut pushes = t.push_notifications();
                        status.set("in the lobby".to_string());
                        loop {
                            coord.sync(t.as_ref());
                            let s = coord.snapshot();
                            started.set(s.campaign.started);
                            you_joined.set(s.campaign.party_ids.iter().any(|p| p.0 == cid));
                            snapshot.set(Some(s));
                            roster.set(t.roster());
                            if pushes.next().await.is_none() {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });

    let you_are_gm = roster().gm.as_ref().is_some_and(|g| g.identity == identity);
    let gm_online = roster().gm.as_ref().is_some_and(|g| g.online);
    let can_enter = started() && (you_joined() || you_are_gm);
    let players = roster().players;
    // Resolve each seat's character id to its display name from the snapshot, so the roster reads
    // "Rowan" rather than the raw "player:player-xxxx" id.
    let snap = snapshot();
    let seat_rows: Vec<(String, Option<String>, bool)> = roster()
        .seats
        .iter()
        .map(|s| {
            let name = snap
                .as_ref()
                .and_then(|sn| sn.characters.iter().find(|c| c.id.0 == s.character_id))
                .map(|c| c.name.clone())
                .unwrap_or_else(|| s.character_id.clone());
            (name, s.owner.clone(), s.online)
        })
        .collect();

    // Submit the join: build a bare character from the snapshot, then the join (+ archetype) commands.
    let do_join = {
        let identity = identity.clone();
        let transport = transport.clone();
        move |_| {
            let Some(snap) = snapshot() else { return };
            let picked = name();
            let picked = picked.trim();
            if picked.is_empty() {
                status.set("enter a name for your character first".into());
                return;
            }
            let cid = character_id_for(&identity);
            let Some(character) = build_joining_character(&snap, picked, &cid) else {
                return;
            };
            let arch = archetype();
            let cmds = join_commands(character, (!arch.is_empty()).then_some(arch.as_str()));
            let Some(t) = transport.borrow().clone() else {
                return;
            };
            spawn(async move {
                for c in cmds {
                    let _ = t.submit_async(c).await;
                }
            });
        }
    };

    let do_start = {
        let transport = transport.clone();
        move |_| {
            let Some(t) = transport.borrow().clone() else {
                return;
            };
            spawn(async move {
                let _ = t.submit_async(Command::BeginCampaign).await;
            });
        }
    };

    rsx! {
        style { "{LOBBY_CSS}" }
        div { class: "lobby",
            div { class: "lobby-card",
                h1 { class: "lobby-title", "{welcome.title}" }
                p { class: "lobby-status", "{status}" }

                // The room id the GM hands out — others paste it into the menu's "Join by ID".
                div { class: "lobby-share",
                    span { class: "lobby-label", "Game ID — share so others can Join by ID" }
                    code { class: "lobby-id", "{slug}" }
                }

                // The join form: whenever a non-GM player hasn't taken a character — including a LATE
                // join into a game that already started. The archetype pick is pre-start only
                // (SelectArchetype must run before the campaign begins); a late joiner keeps the
                // default statline. (The GM plays its own pre-seated character — see the server's
                // GM-seat claim — so it doesn't use this form.)
                if !you_joined() && !you_are_gm {
                    div { class: "lobby-form",
                        label { class: "lobby-label", "Character name" }
                        input {
                            class: "lobby-input",
                            value: "{name}",
                            placeholder: "Name your Warden",
                            oninput: move |e| name.set(e.value()),
                        }
                        if !started() && !archetypes().is_empty() {
                            label { class: "lobby-label", "Archetype" }
                            select {
                                class: "lobby-input",
                                value: "{archetype}",
                                onchange: move |e| archetype.set(e.value()),
                                option { value: "", "— choose an archetype —" }
                                for a in archetypes() {
                                    option { key: "{a.id}", value: "{a.id}", "{a.name}" }
                                }
                            }
                        }
                        button { class: "lobby-btn primary", onclick: do_join,
                            if started() { "Join the game in progress" } else { "Join the campaign" }
                        }
                    }
                }

                if you_joined() && !started() && !you_are_gm {
                    p { class: "lobby-note", "You're in as \"{name}\". Waiting for the GM to begin…" }
                }

                if !started() {
                    if you_are_gm {
                        button { class: "lobby-btn", onclick: do_start, "Start the campaign (GM)" }
                    } else if !gm_online {
                        // No GM is present, so no one can begin — offer to host. Reconnecting as the
                        // GM identity (`?token=gm`) makes this client the GM; a reload re-derives the
                        // identity and rejoins with the campaign/surface params intact.
                        p { class: "lobby-note", "No GM is here to start the campaign." }
                        button {
                            class: "lobby-btn primary",
                            onclick: move |_| {
                                set_params(&[("token", "gm")]);
                                if let Some(w) = web_sys::window() {
                                    let _ = w.location().reload();
                                }
                            },
                            "Start as host (become GM)"
                        }
                    }
                }

                if can_enter {
                    button { class: "lobby-btn primary", onclick: move |_| on_enter.call(()), "Enter the game →" }
                }

                div { class: "lobby-roster",
                    h2 { class: "lobby-subtitle", "In the sanctum" }
                    if seat_rows.is_empty() && players.is_empty() {
                        p { class: "lobby-note", "No one has taken a seat yet." }
                    }
                    for (name, owner, online) in seat_rows {
                        div { class: "lobby-seat",
                            span { class: "lobby-dot", class: if online { "on" } else { "off" } }
                            span { "{name}" }
                            span { class: "lobby-owner", { if owner.is_some() { "— joined" } else { "— open" } } }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn covenant() -> CampaignSnapshot {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../conformance/fixtures/covenant.genesis.json");
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn archetype_options_reads_the_campaign_catalogue() {
        let opts = archetype_options(&covenant());
        assert!(
            opts.iter().any(|a| a.id == "warden"),
            "covenant offers the warden archetype, got {opts:?}"
        );
    }

    #[test]
    fn build_joining_character_makes_a_bare_player_at_the_entry_room() {
        let snap = covenant();
        let c = build_joining_character(&snap, "Rowan", "player:rowan").expect("template exists");
        assert_eq!(c.kind, CharacterKind::Player);
        assert_eq!(c.id, CharacterId("player:rowan".into()));
        assert_eq!(c.name, "Rowan");
        assert!(
            c.archetype_id.is_none(),
            "no archetype until the player picks one"
        );
        assert!(
            c.inventory.item_ids.is_empty() && c.inventory.key_ids.is_empty(),
            "joiner carries no items"
        );
        // Spawns where the GM host stands — the campaign's entry room (Antechamber).
        let host_room = snap.characters[0].current_room_id.clone();
        assert_eq!(
            c.current_room_id, host_room,
            "joiner spawns at the entry room"
        );
    }

    #[test]
    fn join_commands_appends_select_archetype_only_when_chosen() {
        let snap = covenant();
        let c = build_joining_character(&snap, "Rowan", "player:rowan").unwrap();

        let with = join_commands(c.clone(), Some("warden"));
        assert!(matches!(with[0], Command::JoinCampaign { .. }));
        assert!(
            matches!(&with[1], Command::SelectArchetype { archetype_id, .. } if archetype_id == "warden")
        );
        assert_eq!(with.len(), 2);

        let without = join_commands(c, None);
        assert_eq!(without.len(), 1, "no archetype → just the join");
        let empty = join_commands(
            build_joining_character(&covenant(), "R", "player:r").unwrap(),
            Some(""),
        );
        assert_eq!(
            empty.len(),
            1,
            "an empty archetype id is treated as no choice"
        );
    }

    #[test]
    fn character_id_is_derived_from_the_identity() {
        assert_eq!(character_id_for("player-ab12cd"), "player:player-ab12cd");
    }
}
