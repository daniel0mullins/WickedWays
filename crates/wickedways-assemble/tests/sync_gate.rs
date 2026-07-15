//! The sync differential gate (Phase 2c, sub-project B).
//!
//! Replays a committed command sequence through the native
//! [`SyncAuthority`](wickedways_core::sync::SyncAuthority) and asserts each authoritative
//! `{ seq, delta }` matches the TS sync `Authority` byte-for-byte. The goldens are emitted by
//! `conformance/fixtures/sync-move.gen.test.ts` (driving `src/lib/sync/authority.ts`).
//!
//! Lives in `wickedways-assemble`'s integration tests because CI already runs
//! `cargo test -p wickedways-assemble` (pure Rust, no wasm) — the same home as the assembler
//! genesis gate. This is B's acceptance mechanism: a command "matches the oracle" only when its
//! delta *content*, not just its serde shape, is identical. As A1/A2 land engine actions, each new
//! command extends this differential corpus.

use std::path::{Path, PathBuf};

use serde_json::Value;
use wickedways_core::sync::{AuthorityOpts, Command, SubmitResult, SyncAuthority};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::{CampaignSnapshot, World};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read(name: &str) -> String {
    let p = fixtures().join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

/// The `<name>.catalog.json` path if that fixture ships a catalog, else `None`.
fn catalog_path(name: &str) -> Option<PathBuf> {
    let p = fixtures().join(format!("{name}.catalog.json"));
    p.exists().then_some(p)
}

/// Collapse integer-valued floats to ints so a Rust `5.0` compares equal to a TS-emitted `5`.
fn canon_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && n.as_i64().is_none() && n.as_u64().is_none() {
                    if (0.0..=u64::MAX as f64).contains(&f) {
                        return Value::Number((f as u64).into());
                    }
                    if (i64::MIN as f64..=i64::MAX as f64).contains(&f) {
                        return Value::Number((f as i64).into());
                    }
                }
            }
            v.clone()
        }
        Value::Array(a) => Value::Array(a.iter().map(canon_numbers).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), canon_numbers(x))).collect()),
        _ => v.clone(),
    }
}

/// Canonicalize a `Delta`: `changed`/`created`/`removed` are id-keyed **sets** (element order is not
/// semantic — the applier writes each entity by id independently), so sort them, mirroring
/// `conformance/canonical-json.ts`'s treatment of the top-level entity arrays. Rust emits them in
/// BTreeMap (sorted-id) order and the TS oracle in reachable-walk order; both canonicalize equal.
fn canon_delta(v: &Value) -> Value {
    let mut d = canon_numbers(v);
    if let Some(obj) = d.as_object_mut() {
        for key in ["changed", "created"] {
            if let Some(Value::Array(arr)) = obj.get_mut(key) {
                arr.sort_by(|a, b| entity_id(a).cmp(entity_id(b)));
            }
        }
        if let Some(Value::Array(arr)) = obj.get_mut("removed") {
            arr.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
        }
    }
    d
}

fn entity_id(entity: &Value) -> &str {
    entity["data"]["id"].as_str().unwrap_or("")
}

/// Replay `<name>.genesis.json` + `<name>.golden.json` through the native `SyncAuthority`, asserting
/// each committed `{ seq, delta }` matches the TS oracle (canonicalized).
fn run_gate(name: &str) {
    let genesis: CampaignSnapshot =
        serde_json::from_str(&read(&format!("{name}.genesis.json"))).expect("parse genesis");
    let world = World::from_snapshot(genesis);
    // Load a per-fixture catalog when present (commands that resolve item behaviour/names need it);
    // otherwise a default catalog suffices (move/setup/lifecycle commands never touch it).
    let catalog: Catalog = catalog_path(name)
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).expect("parse catalog"))
        .unwrap_or_default();
    let mut auth = SyncAuthority::new(world, catalog, AuthorityOpts::default());

    let golden: Value =
        serde_json::from_str(&read(&format!("{name}.golden.json"))).expect("parse golden");
    let steps = golden["steps"].as_array().expect("golden.steps is an array");

    for (i, step) in steps.iter().enumerate() {
        let command: Command =
            serde_json::from_value(step["command"].clone()).expect("parse command");
        match auth.submit(command) {
            SubmitResult::Committed { seq, delta } => {
                assert_eq!(seq, step["seq"].as_u64().unwrap(), "{name} step {i}: seq");
                let got = canon_delta(&serde_json::to_value(&delta).unwrap());
                let want = canon_delta(&step["delta"]);
                assert_eq!(got, want, "{name} step {i}: delta must match the TS oracle");
            }
            SubmitResult::Denied { reason } => panic!("{name} step {i}: unexpectedly denied: {reason}"),
        }
    }
}

/// Move / nextPlayer over a started two-player campaign.
#[test]
fn sync_move_deltas_match_the_ts_oracle() {
    run_gate("sync-move");
}

/// `selectArchetype` over a pre-start single-player campaign (A1's first engine-action port).
#[test]
fn sync_archetype_delta_matches_the_ts_oracle() {
    run_gate("sync-archetype");
}

/// `transferGM` over a started two-player campaign (A2's first lifecycle-command port).
#[test]
fn sync_transfergm_delta_matches_the_ts_oracle() {
    run_gate("sync-transfergm");
}

/// `leaveCampaign` over a started two-player campaign — settles the departed-player reachability
/// question against the oracle.
#[test]
fn sync_leave_delta_matches_the_ts_oracle() {
    run_gate("sync-leave");
}

/// `putInLootBox` — the first loot-mechanic port and first fixture that ships a catalog (the moved
/// item's descriptor is resolved by behaviour key).
#[test]
fn sync_loot_delta_matches_the_ts_oracle() {
    run_gate("sync-loot");
}
