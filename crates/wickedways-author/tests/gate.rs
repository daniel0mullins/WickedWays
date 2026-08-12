//! The campaign author's golden gate.
//!
//! Rust + TOML are the source of truth: each committed TOML compiles to a
//! committed `{name}.description.json` + `{name}.catalog.json` pair, and this
//! gate pins `compile()`'s output against those files (plus a determinism
//! check). The goldens are regression pins of the compiler's own output — when
//! a change intentionally alters compilation, regenerate deliberately with
//! `UPDATE_GOLDENS=1 cargo test -p wickedways-author --test gate`, review the
//! diff, and commit it. Run the regeneration twice: the second run must
//! produce a zero git diff.

use serde_json::Value;
use std::path::{Path, PathBuf};
use wickedways_author::compile;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn updating() -> bool {
    std::env::var_os("UPDATE_GOLDENS").is_some_and(|v| v == "1")
}

/// Write a regenerated golden: 2-space pretty JSON + trailing newline (the
/// committed format).
fn write_golden(p: &Path, v: &Value) {
    let mut s = serde_json::to_string_pretty(v).expect("serialize golden");
    s.push('\n');
    std::fs::write(p, s).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
}

/// Prints the first differing JSON pointer instead of dumping 200KB of diff.
fn assert_json_eq(got: &Value, want: &Value, fixture: &str) {
    if got == want {
        return;
    }
    let mut path = String::new();
    let (g, w) = first_diff(got, want, &mut path);
    panic!("golden mismatch for {fixture}\n  at: {path}\n  rust: {g}\n  golden: {w}",);
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

/// Compile `{name}.toml`; pin (or, under `UPDATE_GOLDENS=1`, rewrite) both
/// output halves and check compile() determinism.
fn check(name: &str) {
    let dir = fixtures();
    let src = read(&dir.join(format!("{name}.toml")));
    let compiled = compile(&src).expect("compile");

    let desc = serde_json::to_value(&compiled.description).expect("to_value description");
    let cat = serde_json::to_value(&compiled.catalog).expect("to_value catalog");

    let desc_path = dir.join(format!("{name}.description.json"));
    let cat_path = dir.join(format!("{name}.catalog.json"));

    if updating() {
        write_golden(&desc_path, &desc);
        write_golden(&cat_path, &cat);
    } else {
        let want_desc: Value = serde_json::from_str(&read(&desc_path)).expect("parse");
        let want_cat: Value = serde_json::from_str(&read(&cat_path)).expect("parse");
        assert_json_eq(&desc, &want_desc, &format!("{name}.description.json"));
        assert_json_eq(&cat, &want_cat, &format!("{name}.catalog.json"));
    }

    // Determinism: a second compile of the same source is identical.
    let again = serde_json::to_value(compile(&src).expect("recompile")).unwrap();
    let first = serde_json::to_value(&compiled).unwrap();
    assert_eq!(first, again, "{name}: compile() is not deterministic");
}

macro_rules! gate {
    ($($test:ident => $fixture:literal),+ $(,)?) => {
        $(
            #[test]
            fn $test() {
                check($fixture);
            }
        )+
    };
}

gate! {
    covenant => "covenant",
    hollow_house => "hollow-house",
    g2_vault => "g2-vault",
    g2_scene => "g2-scene",
    g2_item => "g2-item",
    g2_npc => "g2-npc",
    g2_mechanic => "g2-mechanic",
    g2_mechanic_actions => "g2-mechanic-actions",
    g2_archetype => "g2-archetype",
    g2_timeout => "g2-timeout",
    g2_opts => "g2-opts",
    g2_formations => "g2-formations",
    g2_exit_state => "g2-exit-state",
    g2_dark_rooms => "g2-dark-rooms",
    g2_mobs => "g2-mobs",
    g2_equipment => "g2-equipment",
    g2_door => "g2-door",
    g2_storyteller => "g2-storyteller",
    g2_status_bar => "g2-status-bar",
    g2_victory => "g2-victory",
    g2_effects => "g2-effects",
    g2_villain => "g2-villain",
}
