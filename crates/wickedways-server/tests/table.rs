//! `Table` behavioural tests.
//!
//! Covers ack/broadcast, deny-to-sender, flush-before-ack, and reload-on-persist-failure, plus the
//! two guarantees the actor adds: in-order submit serialization through the actor, and an atomic
//! seat-claim + commit.
//!
//! Uses the committed `sync-move` genesis (a started two-player campaign, so `nextPlayer` commits)
//! because core's snapshot builders are `#[cfg(test)]` private to that crate — and the committed
//! Solomon's Rest genesis (the `"@gm"` Villain campaign) for the per-recipient projection tests.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::json;
use wickedways_core::sync::{
    delta_villain, redact_delta, AuthorityOpts, Command, Delta, SyncAuthority, REDACTED_CARD_KEY,
};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::snapshot::VillainSnapshot;
use wickedways_core::{CampaignSnapshot, World};
use wickedways_server::membership::Membership;
use wickedways_server::store::{CampaignRecord, CampaignStore, StoreError};
use wickedways_server::table::{spawn_table, GmOp, SubmitOutcome, Subscriber, Table};
use wickedways_server::transport::ServerMsg;

fn genesis() -> CampaignSnapshot {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("read genesis"))
        .expect("parse genesis")
}

/// A `Table` over the genesis, with `store` installed (durable) or not (ephemeral).
fn table(store: Option<Arc<dyn CampaignStore>>) -> Table {
    let snapshot_every = if store.is_some() { 1 } else { 20 };
    let authority = SyncAuthority::new(
        World::from_snapshot(genesis()),
        Catalog::default(),
        AuthorityOpts {
            snapshot_every,
            start_seq: 0,
            solo: false,
            manage_turns: false,
        },
    );
    let mut t = Table::new(
        authority,
        Membership::new("gm"),
        "camp",
        Catalog::default(),
        snapshot_every,
    );
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
    log.lock()
        .unwrap()
        .iter()
        .any(|m| matches!(m, ServerMsg::Committed { seq: s, .. } if *s == seq))
}

fn has_entry(log: &Arc<Mutex<Vec<ServerMsg>>>) -> bool {
    log.lock()
        .unwrap()
        .iter()
        .any(|m| matches!(m, ServerMsg::Entry { .. }))
}

fn has_denied(log: &Arc<Mutex<Vec<ServerMsg>>>) -> bool {
    log.lock()
        .unwrap()
        .iter()
        .any(|m| matches!(m, ServerMsg::Denied { .. }))
}

// ── a mock store: records save order and can be made to fail ──────────────────────────────────

struct MockStore {
    order: Arc<Mutex<Vec<String>>>,
    fail: bool,
    saved: Arc<Mutex<Option<CampaignRecord>>>,
}

impl MockStore {
    fn new(order: Arc<Mutex<Vec<String>>>, fail: bool) -> Self {
        Self {
            order,
            fail,
            saved: Arc::new(Mutex::new(None)),
        }
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

// ── core Table behaviour ──────────────────────────────────────────────────────────────────────

// `#[tokio::test]` spins up a fresh tokio runtime per test — each test gets its own private event
// loop, so nothing leaks between them.
#[tokio::test]
async fn acks_the_submitter_with_committed_and_broadcasts_entry_to_others() {
    let mut t = table(None);
    let (sender, sender_log) = recorder();
    let (other, other_log) = recorder();
    t.join(1, "ben", other.clone(), 0);
    t.join(2, "gm", sender.clone(), 0);
    other_log.lock().unwrap().clear(); // drop the joined ack

    let out = t.submit(next_player(), &sender, "gm", None).await;
    assert_eq!(out, SubmitOutcome::Committed { seq: 1 });
    assert!(
        has_committed(&sender_log, 1),
        "submitter must get committed{{seq:1}}"
    );
    assert!(has_entry(&other_log), "other participant must get an entry");
    assert!(
        !has_entry(&sender_log),
        "submitter must NOT also get an entry"
    );
}

#[tokio::test]
async fn denies_an_illegal_command_to_the_sender_only() {
    let mut t = table(None);
    let (sender, sender_log) = recorder();
    let bogus: Command =
        serde_json::from_value(json!({ "kind": "move", "actorId": "nobody", "roomId": "nowhere" }))
            .unwrap();

    let out = t.submit(bogus, &sender, "gm", None).await;
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

    t.submit(next_player(), &sender, "gm", None).await;
    assert_eq!(
        *order.lock().unwrap(),
        vec!["persist", "ack"],
        "persisted before the committed ack"
    );
}

#[tokio::test]
async fn rolls_back_and_denies_when_persist_fails() {
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let store: Arc<dyn CampaignStore> = Arc::new(MockStore::new(order, true)); // save always fails
    let mut t = table(Some(store));

    let (other, other_log) = recorder();
    t.join(1, "ben", other.clone(), 0);
    other_log.lock().unwrap().clear(); // drop the joined ack
    let (sender, sender_log) = recorder();

    let out = t.submit(next_player(), &sender, "gm", None).await;
    assert_eq!(out, SubmitOutcome::NotCommitted);
    assert!(has_denied(&sender_log), "submitter gets denied");
    assert!(
        !has_committed(&sender_log, 1),
        "submitter must NOT get committed"
    );
    assert!(
        !has_entry(&other_log),
        "no entry broadcast on persist failure"
    );
    assert_eq!(
        t.head(),
        0,
        "reload reverts the head to the last durable record (none → 0)"
    );
}

// ── guarantees the actor adds ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_actor_serializes_concurrent_submits() {
    let handle = spawn_table(table(None));
    let noop: Subscriber = Arc::new(|_msg| {});

    // Two submits raced through the handle; the single actor task processes them in arrival order.
    let (a, b) = tokio::join!(
        handle.submit(next_player(), noop.clone(), "gm".into(), None),
        handle.submit(next_player(), noop.clone(), "gm".into(), None),
    );

    let seqs = match (a, b) {
        (SubmitOutcome::Committed { seq: x }, SubmitOutcome::Committed { seq: y }) => {
            let mut v = [x, y];
            v.sort_unstable();
            v
        }
        other => panic!("both submits must commit, got {other:?}"),
    };
    assert_eq!(
        seqs,
        [1, 2],
        "the two commits get distinct, consecutive seqs — no interleave"
    );
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
    let out = t
        .submit(next_player(), &sender, "gm", Some(on_commit))
        .await;
    assert_eq!(out, SubmitOutcome::Committed { seq: 1 });

    // The persisted record carries both the committed seq and the claimed seat.
    let rec = store.load("camp").expect("load").expect("present");
    assert_eq!(rec.seq, 1);
    assert_eq!(
        rec.membership.seats,
        vec![("player:Ada".to_string(), "ada".to_string())]
    );
}

// ── the Villain's hidden information ──────────────────────────────────────────────────────────
//
// Solomon's Rest is the `"@gm"` Villain campaign: the GM hosts as the Sexton, whose Wicked Ways
// hand/deck/discard are hidden information. The table projects every outbound payload for its
// recipient — the villain's seat sees the cards, everyone else sees blinded piles of the same size.

fn solomons_rest() -> (CampaignSnapshot, Catalog) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures");
    let genesis = serde_json::from_str(
        &std::fs::read_to_string(dir.join("solomons-rest.genesis.json")).expect("read genesis"),
    )
    .expect("parse genesis");
    let catalog = serde_json::from_str(
        &std::fs::read_to_string(dir.join("solomons-rest.catalog.json")).expect("read catalog"),
    )
    .expect("parse catalog");
    (genesis, catalog)
}

/// A `Table` over Solomon's Rest with the GM identity `gm` seated as the Sexton — exactly how the
/// room server seats a hosting GM (`ensure_loaded` assigns the genesis `gmId` seat to the GM).
/// Returns the table and the Sexton's character id.
fn villain_table() -> (Table, String) {
    let (genesis, catalog) = solomons_rest();
    let sexton = genesis.campaign.gm_id.clone().expect("a GM seat").0;
    assert_eq!(
        genesis
            .campaign
            .villain
            .as_ref()
            .map(|v| v.character_id.0.as_str()),
        Some(sexton.as_str()),
        "Solomon's Rest designates the GM's own character as the Villain"
    );
    let authority = SyncAuthority::new(
        World::from_snapshot(genesis),
        catalog.clone(),
        AuthorityOpts {
            snapshot_every: 1,
            start_seq: 0,
            solo: false,
            manage_turns: true,
        },
    );
    let mut membership = Membership::new("gm");
    membership.assign(&sexton, "gm");
    (
        Table::new(authority, membership, "rest", catalog, 1),
        sexton,
    )
}

fn begin_campaign() -> Command {
    serde_json::from_value(json!({ "kind": "beginCampaign" })).unwrap()
}

/// The villain state a wire `delta` value carries (deserialized back through the typed `Delta`).
fn delta_villain_of(delta: &serde_json::Value) -> VillainSnapshot {
    let delta: Delta = serde_json::from_value(delta.clone()).expect("a wire delta");
    delta_villain(&delta)
        .cloned()
        .expect("a villain-carrying delta")
}

/// The one `committed` delta in a log.
fn committed_delta(log: &Arc<Mutex<Vec<ServerMsg>>>) -> serde_json::Value {
    log.lock()
        .unwrap()
        .iter()
        .find_map(|m| match m {
            ServerMsg::Committed { delta, .. } => Some(delta.clone()),
            _ => None,
        })
        .expect("a committed ack")
}

/// The one `entry` delta in a log.
fn entry_delta(log: &Arc<Mutex<Vec<ServerMsg>>>) -> serde_json::Value {
    log.lock()
        .unwrap()
        .iter()
        .find_map(|m| match m {
            ServerMsg::Entry { entry } => Some(entry.delta.clone()),
            _ => None,
        })
        .expect("a broadcast entry")
}

/// The one `snapshot` in a log.
fn snapshot_of(log: &Arc<Mutex<Vec<ServerMsg>>>) -> CampaignSnapshot {
    log.lock()
        .unwrap()
        .iter()
        .find_map(|m| match m {
            ServerMsg::Snapshot { snapshot, .. } => Some(snapshot.clone()),
            _ => None,
        })
        .map(|v| serde_json::from_value(v).expect("a campaign snapshot"))
        .expect("a snapshot")
}

fn all_blinded(pile: &[String]) -> bool {
    pile.iter().all(|k| k == REDACTED_CARD_KEY)
}

fn none_blinded(pile: &[String]) -> bool {
    !pile.is_empty() && pile.iter().all(|k| k != REDACTED_CARD_KEY)
}

#[tokio::test]
async fn a_villain_delta_is_dealt_face_up_only_to_the_villains_seat() {
    let (mut t, sexton) = villain_table();
    let (gm, gm_log) = recorder();
    let (ada, ada_log) = recorder();
    t.join(1, "gm", gm.clone(), 0);
    t.join(2, "ada", ada.clone(), 0);

    // `beginCampaign` shuffles the deck and deals the Sexton's opening hand — the first delta that
    // carries real hidden information.
    let out = t.submit(begin_campaign(), &gm, "gm", None).await;
    assert_eq!(out, SubmitOutcome::Committed { seq: 1 });

    let face_up = delta_villain_of(&committed_delta(&gm_log));
    let blinded = delta_villain_of(&entry_delta(&ada_log));

    assert_eq!(face_up.hand.len(), 5, "the opening hand was dealt");
    assert!(
        none_blinded(&face_up.hand),
        "the villain's own seat sees its hand"
    );
    assert!(none_blinded(&face_up.deck), "…and its draw pile");

    assert!(
        all_blinded(&blinded.hand),
        "a hero sees only face-down cards"
    );
    assert!(all_blinded(&blinded.deck), "…and no draw order");
    assert_eq!(
        blinded.hand.len(),
        face_up.hand.len(),
        "hand size stays public"
    );
    assert_eq!(
        blinded.deck.len(),
        face_up.deck.len(),
        "deck size stays public"
    );
    assert_eq!(blinded.discard.len(), face_up.discard.len());
    assert_eq!(
        blinded.character_id.0, sexton,
        "who the villain is stays public"
    );

    // Only the villain differs: the rest of the delta (entities, the rest of the core) is verbatim.
    let mut full: Delta = serde_json::from_value(committed_delta(&gm_log)).unwrap();
    let redacted: Delta = serde_json::from_value(entry_delta(&ada_log)).unwrap();
    redact_delta(&mut full);
    assert_eq!(
        full, redacted,
        "everything but the card piles replicates verbatim"
    );
}

#[tokio::test]
async fn a_late_joiners_backfill_and_checkpoint_are_projected_for_the_joiner() {
    let (mut t, _sexton) = villain_table();
    let (host, _host_log) = recorder();
    // The GM begins the campaign before anyone else is in the room.
    assert_eq!(
        t.submit(begin_campaign(), &host, "gm", None).await,
        SubmitOutcome::Committed { seq: 1 }
    );

    // A hero joining late is backfilled from seq 0 — blinded.
    let (ada, ada_log) = recorder();
    t.join(2, "ada", ada.clone(), 0);
    let blinded = delta_villain_of(&entry_delta(&ada_log));
    assert!(all_blinded(&blinded.hand) && all_blinded(&blinded.deck));
    assert_eq!(blinded.hand.len(), 5);

    // The GM reconnecting (a second tab, a reload) is backfilled face-up.
    let (gm, gm_log) = recorder();
    t.join(3, "gm", gm.clone(), 0);
    let face_up = delta_villain_of(&entry_delta(&gm_log));
    assert!(none_blinded(&face_up.hand) && none_blinded(&face_up.deck));

    // The checkpoint (snapshot_every = 1, so it is at seq 1) follows the same rule, and an
    // anonymous (pre-auth) requester is treated like a hero.
    let (anon, anon_log) = recorder();
    t.send_snapshot(&ada, Some("ada"));
    t.send_snapshot(&gm, Some("gm"));
    t.send_snapshot(&anon, None);
    let for_ada = snapshot_of(&ada_log).campaign.villain.expect("villain");
    let for_gm = snapshot_of(&gm_log).campaign.villain.expect("villain");
    let for_anon = snapshot_of(&anon_log).campaign.villain.expect("villain");
    assert!(all_blinded(&for_ada.hand) && all_blinded(&for_ada.deck));
    assert!(none_blinded(&for_gm.hand) && none_blinded(&for_gm.deck));
    assert!(all_blinded(&for_anon.hand) && all_blinded(&for_anon.deck));
    assert_eq!(for_ada.hand.len(), for_gm.hand.len());
    assert_eq!(for_anon.deck.len(), for_gm.deck.len());
}

#[tokio::test]
async fn the_hand_follows_the_seat_not_the_gm_role() {
    // Visibility is control: whoever owns the villain's seat sees the cards. Reassigning the
    // Sexton to Ada (a GM `assignSeat`) moves the face-up view to her and blinds the GM's.
    let (mut t, sexton) = villain_table();
    let (gm, gm_log) = recorder();
    let (ada, ada_log) = recorder();
    t.join(1, "gm", gm.clone(), 0);
    t.join(2, "ada", ada.clone(), 0);
    assert_eq!(
        t.submit(begin_campaign(), &gm, "gm", None).await,
        SubmitOutcome::Committed { seq: 1 }
    );
    t.gm_mutate(GmOp::Assign {
        character_id: sexton,
        identity: "ada".into(),
    })
    .await
    .expect("assign persists (ephemeral)");
    gm_log.lock().unwrap().clear();
    ada_log.lock().unwrap().clear();

    // The GM's `nextPlayer` carries the core (and so the villain) again.
    assert_eq!(
        t.submit(next_player(), &gm, "gm", None).await,
        SubmitOutcome::Committed { seq: 2 }
    );
    let gm_view = delta_villain_of(&committed_delta(&gm_log));
    let ada_view = delta_villain_of(&entry_delta(&ada_log));
    assert!(
        all_blinded(&gm_view.hand),
        "the GM no longer controls the villain"
    );
    assert!(
        none_blinded(&ada_view.hand),
        "the seat's new owner sees the hand"
    );
}

#[tokio::test]
async fn a_villain_less_campaign_replicates_verbatim_to_everyone() {
    // The projection is a no-op without a villain: the submitter's `committed` delta and the other
    // participant's `entry` delta are the identical bytes (the sync-move genesis has no villain).
    let mut t = table(None);
    let (sender, sender_log) = recorder();
    let (other, other_log) = recorder();
    t.join(1, "ben", other.clone(), 0);
    t.join(2, "gm", sender.clone(), 0);
    t.submit(next_player(), &sender, "gm", None).await;
    assert_eq!(committed_delta(&sender_log), entry_delta(&other_log));
}
