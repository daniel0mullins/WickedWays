//! End-to-end proof that the Covenant campaign is WINNABLE by two players in two
//! different rooms — the whole point of a "true multiplayer" campaign.
//!
//! The golden gate (`goldens.rs`) proves the genesis assembles faithfully; this drives
//! the assembled genesis through the real `SyncAuthority` to confirm the co-op
//! `twin-wards-held` victory actually fires at round-end when one Warden holds the North
//! Ward and another holds the South Ward — and, as the negative control, that a single
//! Warden shuttling between the two wards alone never wins.

use std::path::{Path, PathBuf};

use wickedways_assemble::{assemble, description::CampaignDescription, Seat};
use wickedways_core::presentation::CampaignOutcome;
use wickedways_core::sync::{AuthorityOpts, Command, SubmitResult, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, RoomId};
use wickedways_core::world::snapshot::CampaignSnapshot;
use wickedways_core::world::World;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read_json<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let p = fixtures().join(name);
    let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

/// The four-Warden party the room server seeds (first seat = GM), matching the golden.
fn covenant_party() -> Vec<Seat> {
    ["Keeper", "Acolyte", "Pilgrim", "Seeker"]
        .into_iter()
        .map(|n| Seat { name: n.into(), archetype: Some("warden".into()) })
        .collect()
}

/// Assemble the Covenant genesis and wrap it in an authority whose GM is the first seat.
fn covenant_authority() -> (SyncAuthority, Catalog) {
    let desc: CampaignDescription = read_json("covenant.description.json");
    let catalog: Catalog = read_json("covenant.catalog.json");
    let snap: CampaignSnapshot =
        assemble(&desc, &catalog, &covenant_party()).expect("assemble covenant");
    let world = World::from_snapshot(snap);
    // snapshot_every: 1 so `snapshot()` always reflects the latest committed state.
    let auth = SyncAuthority::new(world, catalog.clone(), AuthorityOpts { snapshot_every: 1, start_seq: 0 });
    (auth, catalog)
}

fn cid(id: &str) -> CharacterId {
    CharacterId(id.into())
}
fn rid(id: &str) -> RoomId {
    RoomId(id.into())
}

/// Submit a command and assert it committed (a denial is a test failure with its reason).
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
fn two_wardens_holding_the_twin_wards_win() {
    let (mut auth, _cat) = covenant_authority();
    commit(&mut auth, "begin", Command::BeginCampaign);

    // Round 1. Keeper (active first) walks Antechamber -> Crossing -> North Ward.
    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:North Ward");
    commit(&mut auth, "next -> Acolyte", Command::NextPlayer);

    // Acolyte walks Antechamber -> Crossing -> South Ward.
    mv(&mut auth, "player:Acolyte", "room:Crossing");
    mv(&mut auth, "player:Acolyte", "room:South Ward");

    // The GM passes the remaining seats; the last NextPlayer wraps the round, and
    // `resolve_outcome` sees both wards held.
    assert_eq!(auth.snapshot().campaign.outcome, CampaignOutcome::Ongoing, "not won mid-round");
    commit(&mut auth, "next -> Pilgrim", Command::NextPlayer);
    commit(&mut auth, "next -> Seeker", Command::NextPlayer);
    commit(&mut auth, "next -> wrap/end round", Command::NextPlayer);

    let snap = auth.snapshot();
    assert_eq!(snap.campaign.outcome, CampaignOutcome::Won, "twin wards held should win");
    assert_eq!(snap.campaign.outcome_reason.as_deref(), Some("twin-wards-held"));
}

#[test]
fn one_warden_alone_cannot_hold_both_wards() {
    let (mut auth, _cat) = covenant_authority();
    commit(&mut auth, "begin", Command::BeginCampaign);

    // Keeper alone shuttles North Ward -> Crossing -> South Ward across two rounds. He is
    // only ever in ONE ward at a time, so the round-end check never sees both held.
    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:North Ward");
    for _ in 0..4 {
        commit(&mut auth, "next", Command::NextPlayer);
    }
    assert_eq!(auth.snapshot().campaign.outcome, CampaignOutcome::Ongoing, "one ward held is not a win");

    // Round 2: Keeper crosses to the South Ward, leaving the North Ward empty.
    mv(&mut auth, "player:Keeper", "room:Crossing");
    mv(&mut auth, "player:Keeper", "room:South Ward");
    for _ in 0..4 {
        commit(&mut auth, "next", Command::NextPlayer);
    }
    assert_eq!(
        auth.snapshot().campaign.outcome,
        CampaignOutcome::Ongoing,
        "a lone Warden between the wards never holds both",
    );
}
