//! Drift guard for the `author-campaign` skill's format reference.
//!
//! The skill (`.claude/skills/author-campaign/`) teaches campaign generation from
//! the schema in `references/format.md`. The schema's source of truth is
//! `src/author_doc.rs` (`deny_unknown_fields` — the reference must be complete or
//! generated TOML breaks). This test scans the struct fields of `author_doc.rs`
//! and asserts every TOML-visible key appears in the reference, so a schema
//! change that forgets the skill fails CI instead of silently rotting it.

use std::path::Path;

/// snake_case → the camelCase surface `#[serde(rename_all = "camelCase")]`
/// exposes. A trailing `_` (a reserved-word escape: `type_`, `match_`) is the
/// `rename = "…"` idiom — strip it first.
fn toml_key(field: &str) -> String {
    let field = field.trim_end_matches('_');
    let mut out = String::new();
    let mut upper_next = false;
    for c in field.chars() {
        if c == '_' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn every_author_doc_field_is_documented_in_the_skill_reference() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let schema =
        std::fs::read_to_string(root.join("src/author_doc.rs")).expect("read author_doc.rs");
    let reference = std::fs::read_to_string(
        root.join("../../.claude/skills/author-campaign/references/format.md"),
    )
    .expect(
        "read the skill's format.md (moved or deleted? update the skill together with the schema)",
    );

    let mut missing: Vec<String> = Vec::new();
    for line in schema.lines() {
        // Struct fields only: `pub <snake_ident>: …` (struct/enum/fn declarations
        // don't match — their name isn't followed by `:`).
        let Some(rest) = line.trim_start().strip_prefix("pub ") else {
            continue;
        };
        let Some((ident, _)) = rest.split_once(':') else {
            continue;
        };
        let ident = ident.trim();
        if ident.is_empty()
            || !ident
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let key = toml_key(ident);
        if !reference.contains(&key) {
            missing.push(format!("{ident} (TOML key `{key}`)"));
        }
    }
    missing.sort();
    missing.dedup();
    assert!(
        missing.is_empty(),
        "author_doc.rs fields missing from .claude/skills/author-campaign/references/format.md \
         — document them there so generated campaigns keep compiling:\n  {}",
        missing.join("\n  ")
    );
}
