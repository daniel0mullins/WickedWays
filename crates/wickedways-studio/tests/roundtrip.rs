//! The flagship round-trip gate (docs/campaign-studio-spec.md §Verification).
//!
//! For every TOML source in the conformance corpus: import → `EditorDoc` → export
//! TOML → compile BOTH the original and the exported text → the compiled
//! `description` + `catalog` JSON must be **equal**. Compiled equality is the
//! round-trip equivalence relation — comments and formatting are lossy by design.
//! This pins the studio's entire import/export path against the same corpus the
//! author gate pins `compile()` with.

use std::path::{Path, PathBuf};

use wickedways_author::compile;
use wickedways_studio::export::{import, to_toml};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures")
}

#[test]
fn every_fixture_round_trips_at_compiled_equality() {
    let mut names: Vec<String> = std::fs::read_dir(fixtures())
        .expect("fixtures dir")
        .filter_map(|e| {
            let p = e.ok()?.path();
            (p.extension()? == "toml")
                .then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    assert!(
        names.len() >= 22,
        "the corpus should hold the full fixture set, found {}: {names:?}",
        names.len()
    );

    for name in &names {
        let src = std::fs::read_to_string(fixtures().join(format!("{name}.toml")))
            .unwrap_or_else(|e| panic!("read {name}.toml: {e}"));

        let doc = import(&src).unwrap_or_else(|e| panic!("{name}: import failed: {e}"));
        let exported = to_toml(&doc).unwrap_or_else(|e| panic!("{name}: export failed: {e}"));

        let original = compile(&src).unwrap_or_else(|e| panic!("{name}: original compile: {e}"));
        let round = compile(&exported).unwrap_or_else(|e| {
            panic!("{name}: exported TOML no longer compiles: {e}\n{exported}")
        });

        let (od, rd) = (
            serde_json::to_value(&original.description).unwrap(),
            serde_json::to_value(&round.description).unwrap(),
        );
        assert_eq!(od, rd, "{name}: compiled descriptions diverge");
        let (oc, rc) = (
            serde_json::to_value(&original.catalog).unwrap(),
            serde_json::to_value(&round.catalog).unwrap(),
        );
        assert_eq!(oc, rc, "{name}: compiled catalogs diverge");

        // Export is deterministic: a second trip is byte-identical.
        let doc2 = import(&exported).unwrap_or_else(|e| panic!("{name}: re-import: {e}"));
        let exported2 = to_toml(&doc2).unwrap();
        assert_eq!(exported, exported2, "{name}: export is not a fixpoint");
    }
}
