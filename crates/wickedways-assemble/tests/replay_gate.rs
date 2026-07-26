//! The native conformance replay gate: every committed replay golden is
//! re-driven through the Rust engine and compared step-by-step.
//!
//! Two golden families, distinguished by shape:
//!
//! - **Command goldens** `{ seed, commands, steps: [{command, cues, snapshot,
//!   view}] }` — replayed from `{name}.start.snapshot.json` (or
//!   `{name}.genesis.json`) via `apply_command`, exactly like the shipped wasm
//!   `replay_commands` entry point.
//! - **Facade goldens** `{ seed, startupCues, ops, steps: [{op, result,
//!   snapshot, view}] }` — replayed from `{name}.genesis.json` through the same
//!   flow the wasm `Authority` handle drives: `from_snapshot` →
//!   `validate_mechanics` → `seed_rng` → `begin_campaign` (buffering startup
//!   cues), then per op: `submit` / `read_item` / `examine` / host-side undo
//!   (stash the snapshot before a successful time-advancing submit; undo =
//!   restore the stash, rng stream continuing, opened-loot set cleared).
//!
//! Lives here (not in wickedways-core) so the `conformance` natives are
//! compiled in via this crate's dev-dependency — several fixtures reference
//! `conformance:` behavior keys.
//!
//! `UPDATE_GOLDENS=1` rewrites each golden's outputs (startup cues, per-step
//! results/snapshots/views) from the Rust engine, preserving the recorded
//! inputs (seed, command/op streams). Run twice: the second run must produce a
//! zero git diff.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use wickedways_core::presentation::PresentationCue;
use wickedways_core::world::command::{apply_command, Command};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::{CampaignSnapshot, World};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read(name: &str) -> String {
    let p = fixtures().join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn read_value(name: &str) -> Value {
    serde_json::from_str(&read(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"))
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

/// The 6 top-level snapshot entity arrays are id-keyed **sets** — element order
/// is not semantic (the world stores them id-keyed), so canonicalization sorts
/// them by id before comparing. `equippedNames` is likewise an unordered
/// display set.
const ENTITY_SET_KEYS: [&str; 6] = [
    "rooms",
    "exits",
    "characters",
    "items",
    "loot",
    "materialCaches",
];

/// Canonicalize for comparison: collapse integer-valued floats to ints (so a
/// Rust `5.0` compares equal to a legacy `5`), and sort the non-semantic
/// entity-set arrays by id. After a full `UPDATE_GOLDENS=1` regeneration the
/// number half is an identity transform; the set sorting keeps the gate
/// insensitive to storage-order changes.
fn canonicalize(v: &Value, key_hint: Option<&str>) -> Value {
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
        Value::Array(a) => {
            let mut mapped: Vec<Value> = a.iter().map(|x| canonicalize(x, None)).collect();
            match key_hint {
                Some(k) if ENTITY_SET_KEYS.contains(&k) => {
                    mapped.sort_by(|a, b| {
                        let ai = a.get("id").and_then(Value::as_str).unwrap_or("");
                        let bi = b.get("id").and_then(Value::as_str).unwrap_or("");
                        ai.cmp(bi)
                    });
                }
                Some("equippedNames") => {
                    mapped.sort_by(|a, b| a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")));
                }
                _ => {}
            }
            Value::Array(mapped)
        }
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), canonicalize(x, Some(k))))
                .collect(),
        ),
        _ => v.clone(),
    }
}

fn assert_step_eq(got: &Value, want: &Value, what: &str) {
    let got = canonicalize(got, None);
    let want = canonicalize(want, None);
    if got == want {
        return;
    }
    let mut path = String::new();
    let (g, w) = first_diff(&got, &want, &mut path);
    panic!("{what}: replay diverged from the golden\n  at: {path}\n  rust: {g}\n  golden: {w}");
}

/// Prints the first differing JSON pointer instead of dumping the whole tree.
fn first_diff(a: &Value, b: &Value, path: &mut String) -> (String, String) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, xv) in x {
                match y.get(k) {
                    None => return (format!("<present: {xv}>"), "<absent>".into()),
                    Some(yv) if xv != yv => {
                        path.push('/');
                        path.push_str(k);
                        return first_diff(xv, yv, path);
                    }
                    _ => {}
                }
            }
            for k in y.keys() {
                if !x.contains_key(k) {
                    path.push('/');
                    path.push_str(k);
                    return ("<absent>".into(), format!("<present: {}>", y[k]));
                }
            }
            (a.to_string(), b.to_string())
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return (format!("<len {}>", x.len()), format!("<len {}>", y.len()));
            }
            for (i, (xv, yv)) in x.iter().zip(y).enumerate() {
                if xv != yv {
                    path.push_str(&format!("/{i}"));
                    return first_diff(xv, yv, path);
                }
            }
            (a.to_string(), b.to_string())
        }
        _ => (a.to_string(), b.to_string()),
    }
}

/// The per-fixture catalog when one is committed, else an empty default
/// (fixtures whose commands never resolve item/behavior state ship none).
fn catalog_for(name: &str) -> Catalog {
    let p = fixtures().join(format!("{name}.catalog.json"));
    if p.exists() {
        serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).expect("parse catalog")
    } else {
        Catalog::default()
    }
}

/// The command-family start state: `{name}.start.snapshot.json` when committed
/// (a started campaign), else the pre-begin `{name}.genesis.json`.
fn start_snapshot(name: &str) -> CampaignSnapshot {
    let started = fixtures().join(format!("{name}.start.snapshot.json"));
    let raw = if started.exists() {
        std::fs::read_to_string(&started).unwrap()
    } else {
        read(&format!("{name}.genesis.json"))
    };
    serde_json::from_str(&raw).expect("parse start snapshot")
}

// ── command goldens ─────────────────────────────────────────────────────────

/// Replay `{name}.golden.json`'s command stream and compare (or, under
/// `UPDATE_GOLDENS=1`, rewrite) each step's `{cues, snapshot, view}`.
fn run_command_gate(name: &str) {
    let golden_name = format!("{name}.golden.json");
    let mut golden = read_value(&golden_name);
    let cat = catalog_for(name);

    let mut world = World::from_snapshot(start_snapshot(name));
    world.validate_mechanics(&cat).expect("validate_mechanics");
    // A fixture whose replay draws no rng carries no seed; the seed key is
    // preserved as-is (present or absent) on regeneration.
    if let Some(seed) = golden["seed"].as_u64() {
        world.seed_rng(seed as u32);
    }

    let commands_json = golden["commands"]
        .as_array()
        .expect("golden.commands")
        .clone();
    let mut opened: BTreeSet<String> = BTreeSet::new();

    let mut steps_out: Vec<Value> = Vec::new();
    let steps_want = golden["steps"].as_array().expect("golden.steps").clone();
    assert_eq!(
        commands_json.len(),
        steps_want.len(),
        "{name}: command/step count"
    );

    for (i, cmd_json) in commands_json.iter().enumerate() {
        // The recorded command is the INPUT — echoed verbatim into the step on
        // regeneration, parsed fresh for the replay.
        let cmd: Command = serde_json::from_value(cmd_json.clone()).expect("parse command");
        let mut cues: Vec<PresentationCue> = Vec::new();
        apply_command(&mut world, cmd, &cat, &mut opened, &mut cues)
            .unwrap_or_else(|e| panic!("{name} step {i}: {}", e.0));
        let step = json!({
            "command": cmd_json,
            "cues": cues,
            "snapshot": world.to_snapshot(),
            "view": world.view(&cat, &opened).expect("view"),
        });
        if updating() {
            steps_out.push(step);
        } else {
            assert_step_eq(&step, &steps_want[i], &format!("{name} step {i}"));
        }
    }

    if updating() {
        golden["steps"] = Value::Array(steps_out);
        write_golden(&golden_name, &golden);
    }
}

// ── facade goldens ──────────────────────────────────────────────────────────

/// Intents that advance time — a successful submit of one of these becomes the
/// undo stash point (the same host-side rule the shipped session applies).
const TIME_ADVANCING: [&str; 6] = ["move", "take", "drop", "use", "attack", "wait"];

/// Replay `{name}.golden.json`'s op stream through the Authority flow and
/// compare (or rewrite) startup cues and each step's `{result, snapshot, view}`.
fn run_facade_gate(name: &str) {
    let golden_name = format!("{name}.golden.json");
    let mut golden = read_value(&golden_name);
    let cat = catalog_for(name);

    let genesis: CampaignSnapshot =
        serde_json::from_str(&read(&format!("{name}.genesis.json"))).expect("parse genesis");
    let mut world = World::from_snapshot(genesis);
    world.validate_mechanics(&cat).expect("validate_mechanics");
    let seed = golden["seed"].as_u64().expect("golden.seed") as u32;
    world.seed_rng(seed);

    let mut startup: Vec<PresentationCue> = Vec::new();
    world
        .begin_campaign(&cat, &mut startup)
        .expect("begin_campaign");
    let startup_json = serde_json::to_value(&startup).unwrap();
    if !updating() {
        assert_step_eq(
            &startup_json,
            &golden["startupCues"],
            &format!("{name} startup cues"),
        );
    }

    let ops = golden["ops"].as_array().expect("golden.ops").clone();
    let steps_want = golden["steps"].as_array().expect("golden.steps").clone();
    assert_eq!(ops.len(), steps_want.len(), "{name}: op/step count");

    let mut opened: BTreeSet<String> = BTreeSet::new();
    let mut undo_stash: Option<CampaignSnapshot> = None;
    let mut steps_out: Vec<Value> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        let result: Value = match op["kind"].as_str().expect("op.kind") {
            "submit" => {
                let intent_kind = op["intent"]["kind"].as_str().expect("intent.kind");
                let advancing = TIME_ADVANCING.contains(&intent_kind);
                let pre = advancing.then(|| world.to_snapshot());
                let intent: Intent =
                    serde_json::from_value(op["intent"].clone()).expect("parse intent");
                let result = world.submit(intent, &cat, &mut opened);
                if advancing && result.error.is_none() {
                    undo_stash = pre;
                }
                serde_json::to_value(&result).unwrap()
            }
            "read" => {
                let actor = world.active_character_id().expect("active character");
                let item = ItemId::from(op["itemId"].as_str().expect("op.itemId"));
                let mut cues: Vec<PresentationCue> = Vec::new();
                world
                    .read_item(&actor, &item, &cat, &mut cues)
                    .unwrap_or_else(|e| panic!("{name} step {i} read: {}", e.0));
                serde_json::to_value(&cues).unwrap()
            }
            "examine" => {
                let actor = world.active_character_id().expect("active character");
                let target = CharacterId::from(op["targetId"].as_str().expect("op.targetId"));
                let mut cues: Vec<PresentationCue> = Vec::new();
                world
                    .examine(&actor, &target, &cat, &mut cues)
                    .unwrap_or_else(|e| panic!("{name} step {i} examine: {}", e.0));
                serde_json::to_value(&cues).unwrap()
            }
            "undo" => {
                let ok = undo_stash.is_some();
                if let Some(stash) = undo_stash.take() {
                    // Restore semantics: the rng stream CONTINUES across a
                    // restore; the opened-loot set clears.
                    let rng = world.rng.clone();
                    let mut restored = World::from_snapshot(stash);
                    restored.validate_mechanics(&cat).expect("validate");
                    restored.rng = rng;
                    world = restored;
                    opened.clear();
                }
                json!({ "ok": ok })
            }
            other => panic!("{name} step {i}: unknown op kind '{other}'"),
        };

        let step = json!({
            "op": op,
            "result": result,
            "snapshot": world.to_snapshot(),
            "view": world.view(&cat, &opened).expect("view"),
        });
        if updating() {
            steps_out.push(step);
        } else {
            assert_step_eq(&step, &steps_want[i], &format!("{name} step {i}"));
        }
    }

    if updating() {
        golden["startupCues"] = startup_json;
        golden["steps"] = Value::Array(steps_out);
        write_golden(&golden_name, &golden);
    }
}

// ── the corpus ──────────────────────────────────────────────────────────────

/// Every command-family replay golden (shape `{seed?, commands, steps}`).
/// The `sync-*` goldens are NOT here — their steps pin `{seq, delta}` and are
/// replayed by `sync_gate.rs`.
#[test]
fn command_replay_goldens() {
    for name in [
        "affliction-shakeoff",
        "afflictions",
        "combat",
        "formation-descriptor-pair",
        "formation-descriptor-single",
        "items-actions",
        "keyed-exit",
        "lantern-dark-combat",
        "laudanum-use",
        "material-drop",
        "mechanics",
        "mechanics-action",
        "mechanics-turnend",
        "mob-defeat",
        "mob-drop",
        "rat-tail",
        "read-effects",
        "scene",
        "scripted-doors",
        "scripted-mechanics",
        "scripted-victory-partydown",
        "scripted-victory-sanity",
        "scripted-victory-won",
        "sees-in-dark",
        "spawn",
        "turn-movement",
        "victory-ended",
        "victory-lost",
        "victory-timeout",
        "victory-won",
    ] {
        run_command_gate(name);
    }
}

/// `items-projection.golden.json` pins a single widened-ViewModel projection
/// (shape `{view}`) over its start snapshot — no commands, no rng.
#[test]
fn items_projection_view_golden() {
    let mut golden = read_value("items-projection.golden.json");
    let cat = catalog_for("items-projection");
    let world = World::from_snapshot(start_snapshot("items-projection"));
    let view = serde_json::to_value(world.view(&cat, &BTreeSet::new()).expect("view")).unwrap();
    if updating() {
        golden["view"] = view;
        write_golden("items-projection.golden.json", &golden);
    } else {
        assert_step_eq(&view, &golden["view"], "items-projection view");
    }
}

/// Every facade replay golden (shape `{seed, startupCues, ops, steps}`).
#[test]
fn facade_replay_goldens() {
    for name in [
        "caretaker",
        "facade-afflicted-mob",
        "facade-free-vs-advancing",
        "facade-ko-piling",
        "facade-legality",
        "facade-lit-entry",
        "facade-loot",
        "facade-mob-combat",
        "facade-open-fail",
        "facade-talk",
        "facade-undo",
        "npc-dialogue",
        "npc-foundation",
        "scripted-scene",
    ] {
        run_facade_gate(name);
    }
}
