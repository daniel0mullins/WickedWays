//! The sync replay gate.
//!
//! Replays a committed command sequence through the native
//! [`SyncAuthority`](wickedways_core::sync::SyncAuthority) and asserts each authoritative
//! `{ seq, delta }` matches the committed golden. The goldens are regression pins of the
//! authority's own deltas — regenerate deliberately with
//! `UPDATE_GOLDENS=1 cargo test -p wickedways-assemble --test sync_gate`, review the diff,
//! and commit it (second regeneration run = zero git diff).
//!
//! Lives in `wickedways-assemble`'s integration tests because CI already runs
//! `cargo test -p wickedways-assemble` (pure Rust, no wasm) — the same home as the assembler
//! genesis gate. The acceptance bar: a command "matches" only when its delta *content*,
//! not just its serde shape, is identical. Each newly supported engine command extends
//! this corpus.

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

fn updating() -> bool {
    std::env::var_os("UPDATE_GOLDENS").is_some_and(|v| v == "1")
}

/// Write a regenerated golden: 2-space pretty JSON + trailing newline (the
/// committed format).
fn write_golden(name: &str, v: &Value) {
    let p = fixtures().join(name);
    let mut s = serde_json::to_string_pretty(v).expect("serialize golden");
    s.push('\n');
    std::fs::write(&p, s).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
}

/// The `<name>.catalog.json` path if that fixture ships a catalog, else `None`.
fn catalog_path(name: &str) -> Option<PathBuf> {
    let p = fixtures().join(format!("{name}.catalog.json"));
    p.exists().then_some(p)
}

/// Collapse integer-valued floats to ints so a Rust `5.0` compares equal to a legacy `5`.
/// After a full regeneration this is an identity transform.
fn canon_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && n.as_i64().is_none() && n.as_u64().is_none()
                {
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
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), canon_numbers(x)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

/// Canonicalize a `Delta`: `changed`/`created`/`removed` are id-keyed **sets** (element order is not
/// semantic — the applier writes each entity by id independently), so sort them — the same
/// treatment the conformance canonicalizer gives the top-level entity arrays. Rust emits them in
/// BTreeMap (sorted-id) order and the TS oracle in reachable-walk order; both canonicalize equal.
fn canon_delta(v: &Value) -> Value {
    let mut d = canon_numbers(v);
    if let Some(obj) = d.as_object_mut() {
        // `cues` is a Rust-side extension of `Delta` (presentation cues ride the delta so surfaces
        // can render campaign `Status` readouts the delta model otherwise discards). It is NOT state
        // and the TS oracle has no such field — this gate asserts *state*-delta parity, so drop it
        // before comparing.
        obj.remove("cues");
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
    let mut world = World::from_snapshot(genesis);

    let golden: Value =
        serde_json::from_str(&read(&format!("{name}.golden.json"))).expect("parse golden");

    // A rng-drawing fixture (e.g. combat) records the `seed` the oracle fed its rng as
    // `mulberry32(seed)`; seed the Rust World's rng with the same value so both draw the identical
    // stream. Rust's `Rng::seeded` is the verified mulberry32 twin.
    if let Some(seed) = golden.get("seed").and_then(Value::as_u64) {
        world.rng = wickedways_core::world::rng::Rng::seeded(seed as u32);
    }

    // Load a per-fixture catalog when present (commands that resolve item behaviour/names need it);
    // otherwise a default catalog suffices (move/setup/lifecycle commands never touch it).
    let catalog: Catalog = catalog_path(name)
        .map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).expect("parse catalog"))
        .unwrap_or_default();
    let mut auth = SyncAuthority::new(world, catalog, AuthorityOpts::default());

    let steps = golden["steps"]
        .as_array()
        .expect("golden.steps is an array")
        .clone();

    let mut steps_out: Vec<Value> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let command: Command =
            serde_json::from_value(step["command"].clone()).expect("parse command");
        match auth.submit(command) {
            SubmitResult::Committed { seq, delta } => {
                // The stored delta is canonical: state-only (no `cues`),
                // entity/removal sets sorted.
                let got = canon_delta(&serde_json::to_value(&delta).unwrap());
                if updating() {
                    // The recorded command is the INPUT — echoed verbatim.
                    steps_out.push(serde_json::json!({
                        "command": step["command"],
                        "seq": seq,
                        "delta": got,
                    }));
                } else {
                    assert_eq!(seq, step["seq"].as_u64().unwrap(), "{name} step {i}: seq");
                    let want = canon_delta(&step["delta"]);
                    assert_eq!(got, want, "{name} step {i}: delta must match the golden");
                }
            }
            SubmitResult::Denied { reason } => {
                panic!("{name} step {i}: unexpectedly denied: {reason}")
            }
        }
    }
    if updating() {
        let mut out = golden.clone();
        out["steps"] = Value::Array(steps_out);
        write_golden(&format!("{name}.golden.json"), &out);
    }
}

/// Move / nextPlayer over a started two-player campaign.
#[test]
fn sync_move_deltas_match_the_ts_oracle() {
    run_gate("sync-move");
}

/// `selectArchetype` over a pre-start single-player campaign.
#[test]
fn sync_archetype_delta_matches_the_ts_oracle() {
    run_gate("sync-archetype");
}

/// `transferGM` over a started two-player campaign.
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

/// `putInLootBox` — the first fixture that ships a catalog (the moved item's descriptor is
/// resolved by behaviour key).
#[test]
fn sync_loot_delta_matches_the_ts_oracle() {
    run_gate("sync-loot");
}

/// `mobAttack` — the first rng-drawing sync fixture; combat mitigation must land identically once
/// both sides seed the same mulberry32 stream.
#[test]
fn sync_mobattack_delta_matches_the_ts_oracle() {
    run_gate("sync-mobattack");
}

/// `mobEscape` — an escape roll → flee through an exit. Exercises the full success path: two rng
/// draws + relocation + the `escape` history.
#[test]
fn sync_mobescape_delta_matches_the_ts_oracle() {
    run_gate("sync-mobescape");
}
