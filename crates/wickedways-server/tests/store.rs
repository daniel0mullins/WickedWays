//! `SqliteStore` behavioural tests (Phase 2c, sub-project C — slice 1).
//!
//! Round-trip and upsert against a **real** `CampaignSnapshot`. The snapshot is loaded from a
//! committed genesis fixture (`conformance/fixtures/sync-move.genesis.json`) because core's snapshot
//! builders are `#[cfg(test)]`-private to that crate and a full snapshot is impractical to
//! hand-write — the same fixture the sync differential gate replays.

use std::path::{Path, PathBuf};

use wickedways_core::CampaignSnapshot;
use wickedways_server::store::{CampaignRecord, CampaignStore, MembershipState, SqliteStore};

fn genesis_snapshot() -> CampaignSnapshot {
    let p: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/sync-move.genesis.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&text).expect("parse genesis snapshot")
}

fn sample_record(seq: u64, seats: Vec<(String, String)>) -> CampaignRecord {
    CampaignRecord {
        seq,
        snapshot: genesis_snapshot(),
        membership: MembershipState { gm_identity: "gm".into(), seats },
    }
}

#[test]
fn load_of_absent_campaign_is_none() {
    let store = SqliteStore::open(":memory:").expect("open");
    assert!(store.load("nope").expect("load").is_none());
}

#[test]
fn save_then_load_round_trips_the_record() {
    let store = SqliteStore::open(":memory:").expect("open");
    let rec = sample_record(7, vec![("player:Ada".into(), "ada".into())]);
    store.save("camp", &rec).expect("save");
    let got = store.load("camp").expect("load").expect("present");
    assert_eq!(got, rec, "the loaded record must equal what was saved");
}

#[test]
fn save_is_an_upsert_keeping_one_row_per_campaign() {
    let store = SqliteStore::open(":memory:").expect("open");
    store.save("camp", &sample_record(1, vec![])).expect("save 1");
    let second = sample_record(2, vec![("player:Ada".into(), "ada".into())]);
    store.save("camp", &second).expect("save 2");
    // The later save wins (same row upserted), not appended — load returns exactly `second`.
    assert_eq!(store.load("camp").expect("load").expect("present"), second);
}
