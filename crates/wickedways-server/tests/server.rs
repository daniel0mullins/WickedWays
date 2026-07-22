//! Room-server connection-lifecycle tests (Phase 2c, sub-project C — slice 3).
//!
//! Ports the multiplayer cases of `packages/server/src/server.test.ts` by driving [`Connection`]
//! directly against a recording sink (the real two-client-over-a-socket proof is slice 4): auth
//! gating, seat ownership / anti-impersonation, GM control, presence/online, join backfill,
//! getSnapshot, and — with a store — persist + resume, load-failure, and schema fail-closed.
//!
//! Uses the committed `sync-move` genesis (a started two-player campaign): Ada (`ffc61507…`, active)
//! and Ben (`e6b4cedd…`), with Ada's legal first move to room `edcaeddd…`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::CampaignSnapshot;
use wickedways_server::server::{Connection, RoomServer, ServerOptions};
use wickedways_server::store::{CampaignRecord, CampaignStore, MembershipState, SqliteStore, StoreError};
use wickedways_server::table::{ConnId, Subscriber};
use wickedways_server::transport::{ClientMsg, ServerMsg};

const ADA: &str = "ffc61507-358f-496f-8d71-c2aafcfa5ade";
const ROOM: &str = "edcaeddd-18f8-4f25-9fbc-f99b00fbd2a0";

fn genesis() -> CampaignSnapshot {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("read genesis")).expect("parse genesis")
}

/// A room server whose only known campaign is `demo`; an empty token is rejected (`t || null`).
fn server(store: Option<Arc<dyn CampaignStore>>) -> Arc<RoomServer> {
    let g = genesis();
    RoomServer::new(ServerOptions {
        verify_token: Box::new(|t: &str| (!t.is_empty()).then(|| t.to_string())),
        gm_identity_for: Box::new(|_| "gm".to_string()),
        genesis_for: Box::new(move |id: &str| (id == "demo").then(|| g.clone())),
        catalog_for: None,
        display_name_for: None,
        catalog: Catalog::default(),
        store,
        rng_seed: None,
    })
}

fn recorder() -> (Subscriber, Arc<Mutex<Vec<ServerMsg>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    let sub: Subscriber = Arc::new(move |msg| sink.lock().unwrap().push(msg));
    (sub, log)
}

fn conn(server: &Arc<RoomServer>, id: ConnId) -> (Connection, Arc<Mutex<Vec<ServerMsg>>>) {
    let (send, log) = recorder();
    (Connection::new(server.clone(), send, id), log)
}

fn join(campaign: &str, token: &str, from_seq: u64) -> ClientMsg {
    ClientMsg::Join { campaign_id: campaign.into(), token: token.into(), from_seq }
}
fn submit(campaign: &str, command: Value) -> ClientMsg {
    ClientMsg::Submit { campaign_id: campaign.into(), command }
}
fn ada_move() -> Value {
    json!({ "kind": "move", "actorId": ADA, "roomId": ROOM })
}

fn has(log: &Arc<Mutex<Vec<ServerMsg>>>, pred: impl Fn(&ServerMsg) -> bool) -> bool {
    log.lock().unwrap().iter().any(pred)
}
fn denied_with(log: &Arc<Mutex<Vec<ServerMsg>>>, needle: &str) -> bool {
    has(log, |m| matches!(m, ServerMsg::Denied { reason } if reason.contains(needle)))
}
fn committed(log: &Arc<Mutex<Vec<ServerMsg>>>) -> bool {
    has(log, |m| matches!(m, ServerMsg::Committed { .. }))
}

// ── auth + join ───────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn join_acks_the_current_head() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "ada", 0)).await;
    assert!(has(&log, |m| matches!(m, ServerMsg::Joined { head: 0 })));
}

#[tokio::test]
async fn join_for_an_unknown_campaign_is_denied() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(join("nope", "ada", 0)).await;
    assert!(denied_with(&log, "unknown campaign"));
}

#[tokio::test]
async fn an_empty_token_is_denied_and_does_not_join() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "", 0)).await;
    assert!(denied_with(&log, "authentication failed"));
    assert!(!has(&log, |m| matches!(m, ServerMsg::Joined { .. })));
}

#[tokio::test]
async fn second_join_same_campaign_or_different_identity_is_rejected() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "ada", 0)).await; // ok
    c.handle(join("demo", "ada", 0)).await; // same campaign again
    assert!(denied_with(&log, "already joined this campaign"));
    c.handle(join("other", "ben", 0)).await; // different identity on the same connection
    assert!(denied_with(&log, "different identity on one connection"));
}

// ── submit gating ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn submit_before_any_join_is_not_authenticated() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(submit("demo", json!({ "kind": "nextPlayer" }))).await;
    assert!(denied_with(&log, "not authenticated"));
}

#[tokio::test]
async fn a_commit_acks_the_sender_and_broadcasts_entry_to_others() {
    let s = server(None);
    let (mut ada, ada_log) = conn(&s, 1);
    let (mut gm, gm_log) = conn(&s, 2);
    ada.handle(join("demo", "ada", 0)).await;
    gm.handle(join("demo", "gm", 0)).await;
    ada_log.lock().unwrap().clear();
    gm_log.lock().unwrap().clear();

    // The GM's nextPlayer commits; the GM sees `committed`, Ada (the other participant) sees `entry`.
    gm.handle(submit("demo", json!({ "kind": "nextPlayer" }))).await;
    assert!(committed(&gm_log), "submitter gets committed");
    assert!(has(&ada_log, |m| matches!(m, ServerMsg::Entry { .. })), "other participant gets entry");
}

#[tokio::test]
async fn a_non_gm_submitting_a_gm_command_is_denied() {
    let s = server(None);
    let (mut ada, log) = conn(&s, 1);
    ada.handle(join("demo", "ada", 0)).await;
    // nextPlayer is a GM command; Ada is not the GM.
    ada.handle(submit("demo", json!({ "kind": "nextPlayer" }))).await;
    assert!(denied_with(&log, "not authorized for this seat"));
}

#[tokio::test]
async fn character_seat_anti_impersonation() {
    let s = server(None);
    let (mut ben, log) = conn(&s, 1);
    ben.handle(join("demo", "ben", 0)).await;
    // Ben submits a command tagged as Ada's seat — denied before the authority ever sees it.
    ben.handle(submit("demo", ada_move())).await;
    assert!(denied_with(&log, "not authorized for this seat"));
}

// ── GM control ────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gm_control_requires_the_gm_identity() {
    let s = server(None);
    let (mut ada, log) = conn(&s, 1);
    ada.handle(join("demo", "ada", 0)).await;
    ada.handle(ClientMsg::AssignSeat {
        campaign_id: "demo".into(),
        character_id: ADA.into(),
        identity: "ada".into(),
    })
    .await;
    assert!(denied_with(&log, "GM only"));
}

#[tokio::test]
async fn gm_assign_lets_the_assigned_identity_act_and_unassign_revokes() {
    let s = server(None);
    let (mut gm, _gm_log) = conn(&s, 1);
    gm.handle(join("demo", "gm", 0)).await;

    // Before assignment, the p2 identity cannot act as Ada.
    let (mut p2, p2_log) = conn(&s, 2);
    p2.handle(join("demo", "p2", 0)).await;
    p2.handle(submit("demo", ada_move())).await;
    assert!(denied_with(&p2_log, "not authorized for this seat"));
    p2_log.lock().unwrap().clear();

    // GM assigns Ada's seat to p2; now p2's move as Ada commits.
    gm.handle(ClientMsg::AssignSeat {
        campaign_id: "demo".into(),
        character_id: ADA.into(),
        identity: "p2".into(),
    })
    .await;
    p2.handle(submit("demo", ada_move())).await;
    assert!(committed(&p2_log), "the assigned identity may act as Ada");
    p2_log.lock().unwrap().clear();

    // GM unassigns; p2 can no longer act as Ada (seat check fails before the authority).
    gm.handle(ClientMsg::UnassignSeat { campaign_id: "demo".into(), character_id: ADA.into() }).await;
    p2.handle(submit("demo", ada_move())).await;
    assert!(denied_with(&p2_log, "not authorized for this seat"));
}

#[tokio::test]
async fn transfer_gm_moves_the_gm_role() {
    let s = server(None);
    let (mut gm, _) = conn(&s, 1);
    gm.handle(join("demo", "gm", 0)).await;
    gm.handle(ClientMsg::TransferGm { campaign_id: "demo".into(), identity: "ada".into() }).await;

    // Ada is now GM: her GM command is authorized; the old GM's is denied.
    let (mut ada, ada_log) = conn(&s, 2);
    ada.handle(join("demo", "ada", 0)).await;
    ada.handle(submit("demo", json!({ "kind": "nextPlayer" }))).await;
    assert!(committed(&ada_log), "the new GM may issue GM commands");

    let (mut old, old_log) = conn(&s, 3);
    old.handle(join("demo", "gm", 0)).await;
    old.handle(submit("demo", json!({ "kind": "nextPlayer" }))).await;
    assert!(denied_with(&old_log, "not authorized for this seat"), "the old GM is no longer GM");
}

// ── presence / online ─────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn presence_is_broadcast_on_join() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "gm", 0)).await;
    // The joiner is a participant, so it receives the presence broadcast; the GM shows online.
    assert!(has(&log, |m| matches!(m, ServerMsg::Presence { gm, .. } if gm.identity == "gm" && gm.online)));
}

#[tokio::test]
async fn an_identity_stays_online_while_any_connection_is_live() {
    let s = server(None);
    let (mut a, _) = conn(&s, 1);
    let (mut b, _) = conn(&s, 2);
    a.handle(join("demo", "gm", 0)).await;
    b.handle(join("demo", "gm", 0)).await; // same identity, two connections

    a.on_close().await; // one connection drops
    let (mut probe, log) = conn(&s, 3);
    probe.handle(join("demo", "ada", 0)).await; // triggers a fresh presence broadcast
    assert!(
        has(&log, |m| matches!(m, ServerMsg::Presence { gm, .. } if gm.online)),
        "the GM is still online via its second connection"
    );

    b.on_close().await; // last connection drops
    let (mut probe2, log2) = conn(&s, 4);
    probe2.handle(join("demo", "ada", 0)).await;
    assert!(
        has(&log2, |m| matches!(m, ServerMsg::Presence { gm, .. } if !gm.online)),
        "the GM is offline once all its connections are gone"
    );
}

// ── getSnapshot ───────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn get_snapshot_returns_a_snapshot_and_null_for_unknown() {
    let s = server(None);
    let (mut c, log) = conn(&s, 1);
    c.handle(ClientMsg::GetSnapshot { campaign_id: "demo".into() }).await;
    assert!(has(&log, |m| matches!(m, ServerMsg::Snapshot { snapshot, .. } if !snapshot.is_null())));

    c.handle(ClientMsg::GetSnapshot { campaign_id: "nope".into() }).await;
    assert!(has(&log, |m| matches!(m, ServerMsg::Snapshot { seq: 0, snapshot } if snapshot.is_null())));
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn persists_and_resumes_a_campaign_and_its_seats_across_a_restart() {
    let store: Arc<dyn CampaignStore> = Arc::new(SqliteStore::open(":memory:").expect("open"));

    // Server 1: the GM assigns Ada's seat to p2 (persisted).
    let s1 = server(Some(store.clone()));
    let (mut gm, _) = conn(&s1, 1);
    gm.handle(join("demo", "gm", 0)).await;
    gm.handle(ClientMsg::AssignSeat {
        campaign_id: "demo".into(),
        character_id: ADA.into(),
        identity: "p2".into(),
    })
    .await;

    // Server 2 (a "restart"): a fresh RoomServer over the SAME store resumes the seat, so p2 can act.
    let s2 = server(Some(store.clone()));
    let (mut p2, p2_log) = conn(&s2, 1);
    p2.handle(join("demo", "p2", 0)).await;
    p2.handle(submit("demo", ada_move())).await;
    assert!(committed(&p2_log), "the resumed seat lets p2 act as Ada after a restart");
}

#[tokio::test]
async fn a_store_load_failure_denies_the_join() {
    struct FailingStore;
    impl CampaignStore for FailingStore {
        fn load(&self, _id: &str) -> Result<Option<CampaignRecord>, StoreError> {
            Err(StoreError::Task("boom".into()))
        }
        fn save(&self, _id: &str, _rec: &CampaignRecord) -> Result<(), StoreError> {
            Ok(())
        }
    }
    let s = server(Some(Arc::new(FailingStore)));
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "ada", 0)).await;
    assert!(denied_with(&log, "unknown campaign"), "a load failure reads as not-found, not a hang");
}

#[tokio::test]
async fn fails_closed_when_a_persisted_snapshot_schema_does_not_match() {
    // Seed the store with a record whose snapshot carries a wrong schemaVersion.
    let store = Arc::new(SqliteStore::open(":memory:").expect("open"));
    let mut snap = genesis();
    snap.schema_version = 999;
    store
        .save(
            "demo",
            &CampaignRecord {
                seq: 0,
                snapshot: snap,
                membership: MembershipState { gm_identity: "gm".into(), seats: vec![] },
            },
        )
        .expect("seed");

    let s = server(Some(store as Arc<dyn CampaignStore>));
    let (mut c, log) = conn(&s, 1);
    c.handle(join("demo", "ada", 0)).await;
    assert!(denied_with(&log, "unknown campaign"), "a schema mismatch refuses to resume (fail-closed)");
}
