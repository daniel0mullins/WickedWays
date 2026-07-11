//! NPC dialogue lowering: `author_doc::NpcBehaviorEntry` → `NpcScript`. Each
//! authored dialogue entry lowers its polymorphic `match` (string → `Exact`,
//! `{ fuzzy = [...] }` → `Fuzzy`), its plain-string `response` (a `Str`
//! literal `Expr`), and its optional `effects` statement-block body (via
//! `parse_effects`). Panic-free on author input.
use wickedways_core::script::ast::{DialogueEntry, DialogueMatch, Expr, NpcScript};
use wickedways_core::script::value::Value;

use crate::author_doc::{DialogueEntryToml, MatchToml, NpcBehaviorEntry};
use crate::error::{CompileError, Span};
use crate::stmt::parse_effects;

pub(crate) fn to_npc_script(entry: &NpcBehaviorEntry) -> Result<NpcScript, CompileError> {
    Ok(NpcScript {
        description: entry.description.clone(),
        default: to_entry(&entry.default)?,
        dialogue: entry.dialogue.iter().map(to_entry).collect::<Result<_, _>>()?,
    })
}

fn to_entry(e: &DialogueEntryToml) -> Result<DialogueEntry, CompileError> {
    Ok(DialogueEntry {
        match_: match &e.match_ {
            MatchToml::Exact(text) => DialogueMatch::Exact { text: text.clone() },
            MatchToml::Fuzzy { fuzzy } => DialogueMatch::Fuzzy { tokens: fuzzy.clone() },
        },
        response: Expr::Lit { value: Value::Str(e.response.clone()) },
        effects: match &e.effects {
            Some(src) => parse_effects(src, Span { line: 1, col: 1 })?,
            None => Vec::new(),
        },
        once: e.once,
    })
}

#[cfg(test)]
mod tests {
    use super::to_npc_script;
    use crate::author_doc::NpcBehaviorEntry;
    use serde_json::json;

    fn script_json(toml_src: &str) -> serde_json::Value {
        let entry: NpcBehaviorEntry = toml::from_str(toml_src).expect("toml");
        serde_json::to_value(to_npc_script(&entry).expect("convert")).expect("json")
    }

    #[test]
    fn default_exact_and_a_fuzzy_entry() {
        let v = script_json(r#"
            description = "A stooped caretaker."
            [default]
            match = ""
            response = "Take the key."
            once = true
            effects = "emit setVisible('npc:C', false)"
            [[dialogue]]
            match = { fuzzy = ["key", "cellar"] }
            response = "It opens the cellar."
        "#);
        assert_eq!(v, json!({
            "description":"A stooped caretaker.",
            "default":{
                "match":{"kind":"exact","text":""},
                "response":{"kind":"lit","value":"Take the key."},
                "effects":[{"kind":"setVisible","target":{"kind":"lit","value":"npc:C"},"visible":{"kind":"lit","value":false}}],
                "once":true},
            "dialogue":[{
                "match":{"kind":"fuzzy","tokens":["key","cellar"]},
                "response":{"kind":"lit","value":"It opens the cellar."},
                "effects":[],"once":false}]
        }));
    }
}
