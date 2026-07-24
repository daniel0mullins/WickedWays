//! The byte-parity gate for the campaign author. THE AUTHORITY.
//!
//! Never edit a fixture to make this pass. If the compiler's output and the
//! committed oracle disagree, the compiler is wrong until proven otherwise, and
//! the fix goes in `lower.rs`.
//!
//! Both halves are gated: each fixture's DESCRIPTION (`*.description.json`) and
//! CATALOG (`*.catalog.json`) output is compared byte-for-byte against its
//! committed oracle, and `compile()` is checked for determinism.

use serde_json::Value;
use std::path::{Path, PathBuf};
use wickedways_author::compile;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}
fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

// ── The three comparison helpers are copied VERBATIM from
// crates/wickedways-assemble/tests/goldens.rs. Do not re-derive canonicalize.

/// Normalize numbers to JS/JSON value semantics before comparison.
///
/// The goldens are `JSON.stringify` output, where there is a single number type:
/// `10.0` and `10` are the SAME value and stringify identically to `10`. But the
/// Rust core types `Stats`/`PartialStats` are `f64`, so `serde_json` emits whole
/// stats as `10.0`, and `serde_json`'s `Number` equality is *stricter* than JSON
/// value equality — it distinguishes the int/float representations (`10.0 != 10`).
/// That strictness is a bug relative to `canonicalize()`'s semantics, which this
/// gate exists to mirror. Collapsing whole-valued floats to integers on BOTH sides
/// makes the comparator faithful to JSON value equality. It is not a relaxation:
/// every genuinely different value still differs (array order, keys, non-whole
/// numbers, strings, presence/absence are all unchanged).
fn canon_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && n.as_i64().is_none() && n.as_u64().is_none()
                {
                    // A float that is integer-valued: re-key it as an integer.
                    if f >= 0.0 && f <= u64::MAX as f64 {
                        return Value::Number((f as u64).into());
                    }
                    if f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                        return Value::Number((f as i64).into());
                    }
                }
            }
            v.clone()
        }
        Value::Array(a) => Value::Array(a.iter().map(canon_numbers).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, x)| (k.clone(), canon_numbers(x))).collect())
        }
        _ => v.clone(),
    }
}

/// Prints the first differing JSON pointer instead of dumping 200KB of diff.
fn assert_json_eq(got: &Value, want: &Value, fixture: &str) {
    let got = canon_numbers(got);
    let want = canon_numbers(want);
    if got == want {
        return;
    }
    let mut path = String::new();
    let (g, w) = first_diff(&got, &want, &mut path);
    panic!("byte-parity FAILED for {fixture}\n  at: {path}\n  rust: {g}\n  golden: {w}",);
}

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

/// The multiplayer Covenant campaign compiles from its TOML to the committed
/// description — the half that carries the `[[caches]]` lowering (a `Ward Slag`
/// material cache in the Crossing → `CacheDef { name, room, materials }`).
#[test]
fn covenant_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("covenant.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.description).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("covenant.description.json"))).expect("parse");
    assert_json_eq(&got, &want, "covenant.description.json");
}

#[test]
fn covenant_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("covenant.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.catalog).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("covenant.catalog.json"))).expect("parse");
    assert_json_eq(&got, &want, "covenant.catalog.json");
}

#[test]
fn g2_vault_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-vault.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.description).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("g2-vault.description.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-vault.description.json");
}

#[test]
fn g2_vault_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-vault.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.catalog).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("g2-vault.catalog.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-vault.catalog.json");
}

#[test]
fn g2_scene_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-scene.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.description).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("g2-scene.description.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-scene.description.json");
}

#[test]
fn g2_scene_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-scene.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.catalog).expect("to_value");
    let want: Value =
        serde_json::from_str(&read(&dir.join("g2-scene.catalog.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-scene.catalog.json");
}

#[test]
fn g2_item_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-item.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-item.description.json"))).unwrap(),
        "g2-item.description.json",
    );
}

#[test]
fn g2_item_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-item.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-item.catalog.json"))).unwrap(),
        "g2-item.catalog.json",
    );
}

#[test]
fn g2_npc_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-npc.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-npc.description.json"))).unwrap(),
        "g2-npc.description.json",
    );
}

#[test]
fn g2_npc_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-npc.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-npc.catalog.json"))).unwrap(),
        "g2-npc.catalog.json",
    );
}

#[test]
fn g2_mechanic_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic.description.json"))).unwrap(),
        "g2-mechanic.description.json",
    );
}

#[test]
fn g2_mechanic_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic.catalog.json"))).unwrap(),
        "g2-mechanic.catalog.json",
    );
}

#[test]
fn g2_mechanic_actions_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic-actions.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic-actions.description.json"))).unwrap(),
        "g2-mechanic-actions.description.json",
    );
}

#[test]
fn g2_mechanic_actions_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic-actions.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic-actions.catalog.json"))).unwrap(),
        "g2-mechanic-actions.catalog.json",
    );
}

#[test]
fn g2_door_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-door.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-door.description.json"))).unwrap(),
        "g2-door.description.json",
    );
}

#[test]
fn g2_door_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-door.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-door.catalog.json"))).unwrap(),
        "g2-door.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_door() {
    let src = read(&fixtures().join("g2-door.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_storyteller_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-storyteller.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-storyteller.description.json"))).unwrap(),
        "g2-storyteller.description.json",
    );
}

#[test]
fn g2_storyteller_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-storyteller.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-storyteller.catalog.json"))).unwrap(),
        "g2-storyteller.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_storyteller() {
    let src = read(&fixtures().join("g2-storyteller.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_status_bar_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-status-bar.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-status-bar.description.json"))).unwrap(),
        "g2-status-bar.description.json",
    );
}

#[test]
fn g2_status_bar_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-status-bar.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-status-bar.catalog.json"))).unwrap(),
        "g2-status-bar.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_status_bar() {
    let src = read(&fixtures().join("g2-status-bar.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_victory_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-victory.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-victory.description.json"))).unwrap(),
        "g2-victory.description.json",
    );
}

#[test]
fn g2_victory_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-victory.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-victory.catalog.json"))).unwrap(),
        "g2-victory.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_victory() {
    let src = read(&fixtures().join("g2-victory.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_effects_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-effects.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-effects.description.json"))).unwrap(),
        "g2-effects.description.json",
    );
}

#[test]
fn g2_effects_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-effects.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-effects.catalog.json"))).unwrap(),
        "g2-effects.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_effects() {
    let src = read(&fixtures().join("g2-effects.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_archetype_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-archetype.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-archetype.description.json"))).unwrap(),
        "g2-archetype.description.json",
    );
}

#[test]
fn g2_archetype_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-archetype.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-archetype.catalog.json"))).unwrap(),
        "g2-archetype.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_archetype() {
    let src = read(&fixtures().join("g2-archetype.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_equipment_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-equipment.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-equipment.description.json"))).unwrap(),
        "g2-equipment.description.json",
    );
}

#[test]
fn g2_equipment_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-equipment.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-equipment.catalog.json"))).unwrap(),
        "g2-equipment.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_equipment() {
    let src = read(&fixtures().join("g2-equipment.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_mobs_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mobs.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mobs.description.json"))).unwrap(),
        "g2-mobs.description.json",
    );
}

#[test]
fn g2_mobs_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mobs.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mobs.catalog.json"))).unwrap(),
        "g2-mobs.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_mobs() {
    let src = read(&fixtures().join("g2-mobs.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_dark_rooms_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-dark-rooms.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-dark-rooms.description.json"))).unwrap(),
        "g2-dark-rooms.description.json",
    );
}

#[test]
fn compile_is_deterministic_dark_rooms() {
    let src = read(&fixtures().join("g2-dark-rooms.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_exit_state_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-exit-state.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-exit-state.description.json"))).unwrap(),
        "g2-exit-state.description.json",
    );
}

#[test]
fn g2_exit_state_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-exit-state.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-exit-state.catalog.json"))).unwrap(),
        "g2-exit-state.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_exit_state() {
    let src = read(&fixtures().join("g2-exit-state.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_formations_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-formations.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-formations.description.json"))).unwrap(),
        "g2-formations.description.json",
    );
}

#[test]
fn g2_formations_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-formations.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-formations.catalog.json"))).unwrap(),
        "g2-formations.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_formations() {
    let src = read(&fixtures().join("g2-formations.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_opts_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-opts.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-opts.description.json"))).unwrap(),
        "g2-opts.description.json",
    );
}

#[test]
fn compile_is_deterministic_opts() {
    let src = read(&fixtures().join("g2-opts.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn g2_timeout_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-timeout.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-timeout.description.json"))).unwrap(),
        "g2-timeout.description.json",
    );
}

#[test]
fn compile_is_deterministic_timeout() {
    let src = read(&fixtures().join("g2-timeout.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn hollow_house_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("hollow-house.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("hollow-house.description.json"))).unwrap(),
        "hollow-house.description.json",
    );
}

#[test]
fn hollow_house_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("hollow-house.toml"))).expect("compile");
    assert_json_eq(
        &serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("hollow-house.catalog.json"))).unwrap(),
        "hollow-house.catalog.json",
    );
}

#[test]
fn compile_is_deterministic_hollow_house() {
    let src = read(&fixtures().join("hollow-house.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic() {
    let src = read(&fixtures().join("g2-vault.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic_scene() {
    let src = read(&fixtures().join("g2-scene.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic_item() {
    let src = read(&fixtures().join("g2-item.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic_npc() {
    let src = read(&fixtures().join("g2-npc.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic_mechanic() {
    let src = read(&fixtures().join("g2-mechanic.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}

#[test]
fn compile_is_deterministic_mechanic_actions() {
    let src = read(&fixtures().join("g2-mechanic-actions.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}
