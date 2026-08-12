//! TOML interchange — import a campaign file, export the editor document.
//!
//! Export is `EditorDoc → AuthorDoc → toml::to_string`: arrays serialize in editor
//! order (victory order is meaningful), and the author crate's
//! `skip_serializing_if` attributes keep absent-means-default fields omitted, close
//! to the hand-authored idiom. Comments/formatting of an imported file are lost by
//! design — round-trip equivalence is **compiled equality** (tests/roundtrip.rs).

use crate::model::EditorDoc;
use wickedways_author::author_doc::AuthorDoc;

/// Serialize the document to campaign TOML.
pub fn to_toml(doc: &EditorDoc) -> Result<String, String> {
    toml::to_string(&doc.to_author()).map_err(|e| format!("serialize TOML: {e}"))
}

/// Parse campaign TOML into a fresh editor document. The serde layer's errors
/// (`deny_unknown_fields`, missing required fields, line/col text) are surfaced
/// verbatim — they are the import dialog's content.
pub fn import(toml_src: &str) -> Result<EditorDoc, String> {
    let author: AuthorDoc = toml::from_str(toml_src).map_err(|e| e.to_string())?;
    Ok(EditorDoc::from_author(author))
}

/// A download filename from the campaign title: `<title-slug>.toml`.
#[must_use]
pub fn export_filename(title: &str) -> String {
    let slug: String = title
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    let mut collapsed = String::with_capacity(slug.len());
    for c in slug.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    if collapsed.is_empty() {
        "campaign.toml".to_string()
    } else {
        format!("{collapsed}.toml")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_rejects_unknown_keys_with_the_serde_message() {
        let err = import("title = \"T\"\nbogus = 1\n").unwrap_err();
        assert!(err.contains("bogus"), "error names the stray key: {err}");
    }

    #[test]
    fn import_export_import_is_stable() {
        let src = r#"
            title = "Vault"
            startRoom = "Hall"
            [[rooms]]
            name = "Hall"
            description = "A cold stone hall."
            [[rooms]]
            name = "Vault"
            description = "The vault."
            [[exits]]
            from = "Hall"
            to = "Vault"
            direction = "north"
            behavior = "vault-door"
            [behaviors.exit.vault-door]
            canPass = "hasKey(actor, 'vault')"
            failMessage = "Locked."
            [[victory.win]]
            key = "reached-vault"
            test = "party[0].room.name == 'Vault'"
        "#;
        let doc = import(src).expect("import");
        let out = to_toml(&doc).expect("export");
        let doc2 = import(&out).expect("re-import");
        assert_eq!(
            doc2.to_author(),
            doc.to_author(),
            "author surface is stable"
        );
    }

    #[test]
    fn filenames_slugify() {
        assert_eq!(export_filename("The Hollow House"), "the-hollow-house.toml");
        assert_eq!(export_filename("  !!  "), "campaign.toml");
        assert_eq!(export_filename("A -- B"), "a-b.toml");
    }
}
