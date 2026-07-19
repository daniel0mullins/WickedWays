//! `Table` behavioural tests (Phase 2c, sub-project C — slice 2).
//!
//! Ports `packages/server/src/table.test.ts` (ack/broadcast, deny-to-sender, flush-before-ack,
//! reload-on-persist-failure) and adds the two guarantees the Rust actor makes that the TS class
//! could not: in-order submit serialization through the actor, and an atomic seat-claim + commit.
//!
//! Uses the committed `sync-move` genesis (a started two-player campaign, so `nextPlayer` commits) —
//! the same fixture the sync gate replays — because core's snapshot builders are `#[cfg(test)]`
//! private to that crate.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;
use wickedways_core::sync::{AuthorityOpts, Command, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::{CampaignSnapshot, World};
use wickedways_server::membership::Membership;
use wickedways_server::store::{CampaignRecord, CampaignStore, StoreError};
use wickedways_server::table::{spawn_table, SubmitOutcome, Subscriber, Table};
use wickedways_server::transport::ServerMsg;

fn genesis() -> CampaignSnapshot {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("read genesis")).expect("parse genesis")
}

/// A `Table` over the genesis, with `store` installed (durable) or not (ephemeral).
fn table(store: Option<Arc<dyn CampaignStore>>) -> Table {
    let snapshot_every = if store.is_some() { 1 } else { 20 };
    let authority = SyncAuthority::new(
        World::from_snapshot(genesis()),
        Catalog::default(),
        AuthorityOpts { snapshot_every, start_seq: 0 },
    );
    let mut t = Table::new(authority, Membership::new("gm"), "camp", Catalog::default(), snapshot_every);
    if let Some(s) = store {
        t.set_store(s);
    }
    t
}

/// A subscriber that records every message it receives into a shared buffer.
fn recorder() -> (Subscriber, Arc<Mutex<Vec<ServerMsg>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let sink = log.clone();
    let sub: Subscriber = Arc::new(move |msg| sink.lock().unwrap().push(msg));
    (sub, log)
}

fn next_player() -> Command {
    serde_json::from_value(json!({ "kind": "nextPlayer" })).unwrap()
}

fn has_committed(log: &Arc<Mutex<Vec<ServerMsg>>>, seq: u64) -> bool {
    log.lock().unwrap().iter().any(|m| matches!(m, ServerMsg::Committed { seq: s, .. } if *s == seq))
}

fn has_entry(log: &Arc<Mutex<Vec<ServerMsg>>>) -> bool {
    log.lock().unwrap().iter().any(|m| matches!(m, ServerMsg::Entry { .. }))
}

fn has_denied(log: &Arc<Mutex<Vec<ServerMsg>>>) -> bool {
    log.lock().unwrap().iter().any(|m| matches!(m, ServerMsg::Denied { .. }))
}

// ── a mock store: records save order and can be made to fail ──────────────────────────────────

struct MockStore {
    order: Arc<Mutex<Vec<String>>>,
    fail: bool,
    saved: Arc<Mutex<Option<CampaignRecord>>>,
}

impl MockStore {
    fn new(order: Arc<Mutex<Vec<String>>>, fail: bool) -> Self {
        Self { order, fail, saved: Arc::new(Mutex::new(None)) }
    }
}

impl CampaignStore for MockStore {
    fn load(&self, _campaign_id: &str) -> Result<Option<CampaignRecord>, StoreError> {
        Ok(self.saved.lock().unwrap().clone())
    }
    fn save(&self, _campaign_id: &str, record: &CampaignRecord) -> Result<(), StoreError> {
        self.order.lock().unwrap().push("persist".into());
        if self.fail {
            return Err(StoreError::Task("disk full".into()));
        }
        *self.saved.lock().unwrap() = Some(record.clone());
        Ok(())
    }
}

// ── ported from table.test.ts ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn acks_the_submitter_with_committed_and_broadcasts_entry_to_others() {
    let mut t = table(None);
    let (sender, sender_log) = recorder();
    let (other, other_log) = recorder();
    t.join(1, other.clone(), 0);
    t.join(2, sender.clone(), 0);
    other_log.lock().unwrap().clear(); // drop the joined ack

    let out = t.submit(next_player(), &sender, None).await;
    assert_eq!(out, SubmitOutcome::Committed { seq: 1 });
    assert!(has_committed(&sender_log, 1), "submitter must get committed{{seq:1}}");
    assert!(has_entry(&other_log), "other participant must get an entry");
    assert!(!has_entry(&sender_log), "submitter must NOT also get an entry");
}

#[tokio::test]
async fn denies_an_illegal_command_to_the_sender_only() {
    let mut t = table(None);
    let (sender, sender_log) = recorder();
    let bogus: Command =
        serde_json::from_value(json!({ "kind": "move", "actorId": "nobody", "roomId": "nowhere" })).unwrap();

    let out = t.submit(bogus, &sender, None).await;
    assert_eq!(out, SubmitOutcome::NotCommitted);
    assert!(has_denied(&sender_log), "sender must be denied");
    assert_eq!(t.head(), 0, "an illegal command must not advance the head");
}

#[tokio::test]
async fn persists_before_acking_then_broadcasts() {
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let store: Arc<dyn CampaignStore> = Arc::new(MockStore::new(order.clone(), false));
    let mut t = table(Some(store));

    // A sender that records "ack" the moment it receives its committed message.
    let ack_order = order.clone();
    let sender: Subscriber = Arc::new(move |_msg| ack_order.lock().unwrap().push("ack".into()));

    t.submit(next_player(), &sender, None).await;
    assert_eq!(*order.lock().unwrap(), vec!["persist", "ack"], "persisted before the committed ack");
}

#[tokio::test]
async fn rolls_back_and_denies_when_persist_fails() {
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let store: Arc<dyn CampaignStore> = Arc::new(MockStore::new(order, true)); // save always fails
    let mut t = table(Some(store));

    let (other, other_log) = recorder();
    t.join(1, other.clone(), 0);
    other_log.lock().unwrap().clear(); // drop the joined ack
    let (sender, sender_log) = recorder();

    let out = t.submit(next_player(), &sender, None).await;
    assert_eq!(out, SubmitOutcome::NotCommitted);
    assert!(has_denied(&sender_log), "submitter gets denied");
    assert!(!has_committed(&sender_log, 1), "submitter must NOT get committed");
    assert!(!has_entry(&other_log), "no entry broadcast on persist failure");
    assert_eq!(t.head(), 0, "reload reverts the head to the last durable record (none → 0)");
}

// ── guarantees the Rust actor adds ────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_actor_serializes_concurrent_submits() {
    let handle = spawn_table(table(None));
    let noop: Subscriber = Arc::new(|_msg| {});

    // Two submits raced through the handle; the single actor task processes them in arrival order.
    let (a, b) = tokio::join!(
        handle.submit(next_player(), noop.clone(), None),
        handle.submit(next_player(), noop.clone(), None),
    );

    let seqs = match (a, b) {
        (SubmitOutcome::Committed { seq: x }, SubmitOutcome::Committed { seq: y }) => {
            let mut v = [x, y];
            v.sort_unstable();
            v
        }
        other => panic!("both submits must commit, got {other:?}"),
    };
    assert_eq!(seqs, [1, 2], "the two commits get distinct, consecutive seqs — no interleave");
    assert_eq!(handle.head().await, 2);
}

#[tokio::test]
async fn seat_claim_in_on_commit_persists_atomically_with_the_commit() {
    let store = Arc::new(wickedways_server::store::SqliteStore::open(":memory:").expect("open"));
    let store_dyn: Arc<dyn CampaignStore> = store.clone();
    let mut t = table(Some(store_dyn));
    let (sender, _log) = recorder();

    // on_commit claims a seat; it must land in the SAME save as the commit.
    let on_commit = Box::new(|m: &mut Membership| m.claim("player:Ada", "ada"));
    let out = t.submit(next_player(), &sender, Some(on_commit)).await;
    assert_eq!(out, SubmitOutcome::Committed { seq: 1 });

    // The persisted record carries both the committed seq and the claimed seat.
    let rec = store.load("camp").expect("load").expect("present");
    assert_eq!(rec.seq, 1);
    assert_eq!(rec.membership.seats, vec![("player:Ada".to_string(), "ada".to_string())]);
}
