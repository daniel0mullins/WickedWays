//! End-to-end proof that the Covenant campaign is WINNABLE — the whole point of a "true multiplayer"
//! campaign — driven through the real `SyncAuthority` on the self-join model.
//!
//! The golden gate (`goldens.rs`) proves the genesis assembles faithfully (a lone GM host, `Keeper`).
//! This drives the authored flow the way real players do it:
//!   1. a player self-joins their own Warden (`JoinCampaign`) and picks the `warden` archetype
//!      (`SelectArchetype`) — the "name your character + choose an archetype + join" path;
//!   2. the GM begins the campaign;
//!   3. the GM and the joiner take the twin wards, and the co-op `twin-wards-held` victory fires —
//!      two players (one of them the GM) in two different rooms.
//!
//! The negative control confirms a lone Warden shuttling between the wards never wins.

use std::path::{Path, PathBuf};

use wickedways_assemble::{assemble, description::CampaignDescription, Seat};
use wickedways_core::presentation::CampaignOutcome;
use wickedways_core::sync::{AuthorityOpts, Command, SubmitResult, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, RoomId};
use wickedways_core::world::snapshot::{CampaignSnapshot, CharacterSnapshot, Stats};
use wickedways_core::world::World;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read_json<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let p = fixtures().join(name);
    let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

/// Assemble the Covenant genesis (lone GM host) and wrap it in an authority.
fn covenant_authority() -> SyncAuthority {
    let desc: CampaignDescription = read_json("covenant.description.json");
    let catalog: Catalog = read_json("covenant.catalog.json");
    let party = vec![Seat { name: "Keeper".into(), archetype: Some("warden".into()) }];
    let snap: CampaignSnapshot = assemble(&desc, &catalog, &party).expect("assemble covenant");
    let world = World::from_snapshot(snap);
    // snapshot_every: 1 so `snapshot()` always reflects the latest committed state.
    SyncAuthority::new(world, catalog, AuthorityOpts { snapshot_every: 1, start_seq: 0, solo: false, manage_turns: false })
}

/// A bare joining Warden derived from the GM host's snapshot as a field template: a player-kind
/// character with a fresh id/name, NO archetype yet (placeholder stats the archetype overrides via
/// `SelectArchetype`), spawning in the Antechamber. Cloning a real character keeps every tail field
/// valid without hand-enumerating the whole snapshot shape.
fn joining_warden(template: &CharacterSnapshot, id: &str, name: &str) -> CharacterSnapshot {
    let mut c = template.clone();
    c.id = CharacterId(id.into());
    c.name = name.into();
    c.archetype_id = None;
    c.archetype_immunities = vec![];
    c.stats = Stats { health: 1.0, sanity: 1.0, energy: 1.0 };
    c.current_room_id = Some(RoomId("room:Antechamber".into()));
    c
}

fn cid(id: &str) -> CharacterId {
    CharacterId(id.into())
}
fn rid(id: &str) -> RoomId {
    RoomId(id.into())
}

fn commit(auth: &mut SyncAuthority, label: &str, cmd: Command) {
    match auth.submit(cmd) {
        SubmitResult::Committed { .. } => {}
        SubmitResult::Denied { reason } => panic!("{label} denied: {reason}"),
    }
}

fn mv(auth: &mut SyncAuthority, actor: &str, to: &str) {
    commit(auth, &format!("move {actor} -> {to}"), Command::Move { actor_id: cid(actor), room_id: rid(to) });
}

#[test]
fn a_joiner_names_a_warden_picks_the_archetype_and_wins_with_the_gm() {
    let mut auth = covenant_authority();

    // 1. A player joins with their own named Warden, then picks the `warden` archetype (both are
    //    pre-begin setup). The archetype applies the Warden statline on top of the bare snapshot.
    let template = auth.snapshot().characters.iter().find(|c| c.id == cid("player:Keeper")).expect("gm host").clone();
    commit(&mut auth, "join", Command::JoinCampaign { character: Box::new(joining_warden(&template, "player:Rowan", "Rowan")) });
    commit(&mut auth, "select archetype", Command::SelectArchetype { actor_id: cid("player:Rowan"), archetype_id: "warden".into() });
    let after_pick = auth.snapshot();
    let rowan = after_pick.characters.iter().find(|c| c.id == cid("player:Rowan")).expect("rowan joined");
    assert_eq!(rowan.stats.energy, 12.0, "the warden archetype set Rowan's stats");
    assert_eq!(rowan.archetype_id.as_deref(), Some("warden"));
    assert!(after_pick.campaign.party_ids.contains(&cid("player:Rowan")), "joiner is in the party");

    // 2. The GM (Keeper) begins. Party order is [Keeper, Rowan]; active starts at Keeper.
    commit(&mut auth, "begin", Command::BeginCampaign);

    // 3. Keeper takes the North Ward; Rowan takes the South. Two players — one the GM — in two rooms.
    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:North Ward");
    commit(&mut auth, "next -> Rowan", Command::NextPlayer);
    mv(&mut auth, "player:Rowan", "room:Crossing");
    mv(&mut auth, "player:Rowan", "room:South Ward");
    assert_eq!(auth.snapshot().campaign.outcome, CampaignOutcome::Ongoing, "not won mid-round");
    commit(&mut auth, "next -> wrap/end round", Command::NextPlayer);

    let snap = auth.snapshot();
    assert_eq!(snap.campaign.outcome, CampaignOutcome::Won, "twin wards held should win");
    assert_eq!(snap.campaign.outcome_reason.as_deref(), Some("twin-wards-held"));
}

#[test]
fn one_warden_alone_cannot_hold_both_wards() {
    let mut auth = covenant_authority();
    commit(&mut auth, "begin", Command::BeginCampaign);

    // The lone GM host shuttles North Ward -> Crossing -> South Ward across two rounds. Only ever in
    // one ward at a time, so the round-end check never sees both held.
    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:North Ward");
    commit(&mut auth, "next/end round 1", Command::NextPlayer);
    assert_eq!(auth.snapshot().campaign.outcome, CampaignOutcome::Ongoing, "one ward held is not a win");

    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:South Ward");
    commit(&mut auth, "next/end round 2", Command::NextPlayer);
    assert_eq!(
        auth.snapshot().campaign.outcome,
        CampaignOutcome::Ongoing,
        "a lone Warden between the wards never holds both",
    );
}
