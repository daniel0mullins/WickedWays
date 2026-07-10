//! The differential conformance gate. THE AUTHORITY.
//!
//! Never edit a golden to make this pass. If Rust and the golden disagree, Rust is
//! wrong until proven otherwise, and the fix goes in the assembler.
//!
//! Only PRE-BEGIN goldens are valid oracles: `started: false`. The 31 `started: true`
//! snapshots encode `Authority::begin_campaign`'s work, not the assembler's.

use std::path::{Path, PathBuf};
use serde_json::Value;
use wickedways_assemble::{assemble, description::CampaignDescription, Seat};
use wickedways_core::world::descriptor::Catalog;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> T {
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

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
    if got == want { return; }
    let mut path = String::new();
    let (g, w) = first_diff(&got, &want, &mut path);
    panic!(
        "byte-parity FAILED for {fixture}\n  at: {path}\n  rust: {g}\n  golden: {w}",
    );
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

/// Assemble `<name>.description.json` + `<name>.catalog.json` with `party`,
/// and compare to `<golden>`.
fn gate(name: &str, golden: &str, catalog_name: Option<&str>, party: &[Seat]) {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join(format!("{name}.description.json")));
    let catalog: Catalog = catalog_name
        .map(|c| read_json::<Catalog>(&dir.join(format!("{c}.catalog.json"))))
        .unwrap_or_default();
    let want: Value = read_json(&dir.join(golden));
    let got = serde_json::to_value(assemble(&desc, &catalog, party).expect("assemble")).expect("to_value");
    assert_json_eq(&got, &want, golden);
}

#[test]
fn hollow_house_pristine() {
    gate("hollow-house", "hollow-house.snapshot.json", Some("hollow-house"), &[]);
}

/// BLOCKED (input-completeness gap, NOT a construct bug). First diff is at
/// exactly `/codex`: the seed golden's codex carries a recipe entry
/// `{id:"widget", outputName:"Widget", materials:{metal:2}}`, produced by the
/// live TS engine's `discoverRecipe`. But `outputName`/`materials` live in the
/// registry closures (`makeWidgetRecipe`/`makeWidgetItem`, packages/seed) and are
/// NOT exported by `catalogFromRegistry` — the catalog has no `recipes` map, only
/// `widget-item.recipe = {item:1}` (a different value), and the description carries
/// only the recipe KEY `"widget"`. So the assembler cannot reconstruct the codex
/// from (description + catalog). Un-ignore once the catalog carries recipe metadata
/// (needs `catalogFromRegistry` + `Catalog` extension — Task 3/4 territory).
/// Everything else in this fixture is byte-exact. See task-5-6-report.md.
#[test]
#[ignore = "BLOCKED at /codex: seed recipe metadata (outputName/materials) is not in description+catalog; see task-5-6-report.md"]
fn seed_pristine() {
    gate("seed", "seed.snapshot.json", Some("seed"), &[]);
}

/// Byte-parity depends on stable iteration order. A stray `HashMap` reaching
/// serialization would make this flap.
#[test]
fn assembly_is_deterministic() {
    let dir = fixtures();
    let desc: CampaignDescription = read_json(&dir.join("hollow-house.description.json"));
    let catalog: Catalog = read_json(&dir.join("hollow-house.catalog.json"));
    let a = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("a")).expect("va");
    let b = serde_json::to_value(assemble(&desc, &catalog, &[]).expect("b")).expect("vb");
    assert_eq!(a, b, "assemble() is not deterministic");
}
