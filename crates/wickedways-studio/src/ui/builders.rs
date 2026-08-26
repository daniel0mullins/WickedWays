//! Structured behavior builders (the spec's P3 item) — the HYBRID model the
//! original decisions settled on: small parameterized forms that GENERATE the
//! DSL for the common cases, inserted into the raw-text body which remains the
//! escape hatch for everything else.
//!
//! The catalog is data-driven and pure: every snippet is a label, a parameter
//! list, and a build function from parameter strings to DSL text. String
//! parameters are quoted by [`dsl_quote`], picker parameters draw their
//! vocabulary from the document, and the whole catalog is property-tested:
//! **every snippet, built with representative parameters, must validate under
//! its slot's real parser** — a builder can only ever emit valid DSL.

use dioxus::prelude::*;

use crate::app::StudioStore;
use crate::gate::BodySlot;
use crate::model::STAT_TYPES;

/// What a snippet parameter is, which decides its input widget and vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Param {
    /// An item key (picker over the document's items).
    Item,
    /// A key code (picker over the document's key items' codes; free text allowed).
    KeyCode,
    /// A stat name (picker: health/sanity/energy).
    Stat,
    /// An actor expression (picker: actor / party[0] / party[1]).
    Target,
    /// An integer.
    Number,
    /// Prose (quoted into a DSL string).
    Text,
    /// A bare state-field identifier.
    Ident,
}

/// One buildable snippet: a label, its parameters, and the generator.
pub struct Snippet {
    pub label: &'static str,
    pub params: &'static [(&'static str, Param)],
    /// `fn(…)` (lowercase) is a plain function POINTER — a callback that
    /// captures nothing, which is exactly what lets the catalogs below live in
    /// `const`s. A capturing closure would need a closure type and heap state.
    pub build: fn(&[String]) -> String,
}

/// Quote prose into a DSL string literal. Single quotes preferred; falls back to
/// double quotes, stripping the quote character that cannot be represented (the
/// grammar has no escape sequences).
#[must_use]
pub fn dsl_quote(s: &str) -> String {
    if !s.contains('\'') {
        format!("'{s}'")
    } else if !s.contains('"') {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\'', ""))
    }
}

// ---- parameter sanitizers -------------------------------------------------
// Each maps a raw input-field string to something the DSL grammar accepts.

fn num(raw: &str) -> String {
    let t = raw.trim();
    if t.parse::<i64>().is_ok() {
        t.to_string()
    } else {
        "0".to_string()
    }
}

fn ident(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if cleaned.is_empty() {
        "field".to_string()
    } else {
        cleaned
    }
}

fn stat(raw: &str) -> String {
    if STAT_TYPES.contains(&raw.trim()) {
        raw.trim().to_string()
    } else {
        "health".to_string()
    }
}

// ---- the snippet catalogs, one per body-slot grammar ----------------------

/// Condition snippets (expression slots: `canPass`, `canPlay`, victory `test`).
const CONDITIONS: &[Snippet] = &[
    Snippet {
        label: "has key",
        params: &[("key code", Param::KeyCode)],
        build: |p| format!("hasKey(actor, {})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "carries item",
        params: &[("item", Param::Item)],
        build: |p| format!("hasItem(actor, {})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "has equipped",
        params: &[("item", Param::Item)],
        build: |p| format!("hasEquipped(actor, {})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "round before",
        params: &[("round", Param::Number)],
        build: |p| format!("round < {}", num(&p[0])),
    },
    Snippet {
        label: "state flag set",
        params: &[("field", Param::Ident)],
        build: |p| format!("stateGet({}, false)", dsl_quote(&ident(&p[0]))),
    },
];

/// Statement snippets (scene/item/mechanic/card bodies).
const STATEMENTS: &[Snippet] = &[
    Snippet {
        label: "narrate",
        params: &[("text", Param::Text)],
        build: |p| format!("emit cue({})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "adjust stat",
        params: &[
            ("who", Param::Target),
            ("stat", Param::Stat),
            ("delta", Param::Number),
        ],
        build: |p| format!("emit adjustStat({}, {}, {})", p[0], stat(&p[1]), num(&p[2])),
    },
    Snippet {
        label: "guard: has item",
        params: &[("item", Param::Item)],
        build: |p| format!("guard hasItem(actor, {})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "guard: not equipped",
        params: &[("item", Param::Item)],
        build: |p| format!("guard !hasEquipped(actor, {})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "set state flag",
        params: &[("field", Param::Ident)],
        build: |p| format!("set state.{} = true", ident(&p[0])),
    },
    Snippet {
        label: "once per campaign",
        params: &[("flag field", Param::Ident)],
        build: |p| {
            let f = ident(&p[0]);
            format!(
                "guard !stateGet({q}, false)\nset state.{f} = true",
                q = dsl_quote(&f)
            )
        },
    },
];

/// Emit-only snippets (npc dialogue `effects`).
const EFFECTS: &[Snippet] = &[
    Snippet {
        label: "narrate",
        params: &[("text", Param::Text)],
        build: |p| format!("emit cue({})", dsl_quote(&p[0])),
    },
    Snippet {
        label: "adjust stat",
        params: &[
            ("who", Param::Target),
            ("stat", Param::Stat),
            ("delta", Param::Number),
        ],
        build: |p| format!("emit adjustStat({}, {}, {})", p[0], stat(&p[1]), num(&p[2])),
    },
    Snippet {
        label: "vanish (hide me)",
        params: &[("npc id", Param::Text)],
        build: |p| format!("emit setVisible({}, false)", dsl_quote(&p[0])),
    },
];

/// Exit-script snippets (`runScript` — `pass` is legal here).
const SCRIPTS: &[Snippet] = &[Snippet {
    label: "pass narration",
    params: &[("text", Param::Text)],
    build: |p| format!("pass {}", dsl_quote(&p[0])),
}];

/// `modifyDamage` templates (replace the whole body — its grammar is one transform).
const TRANSFORMS: &[Snippet] = &[
    Snippet {
        label: "cap damage at N",
        params: &[("cap", Param::Number)],
        build: |p| {
            let n = num(&p[0]);
            format!("damage.amount > {n} ? final {n} : damage.amount")
        },
    },
    Snippet {
        label: "halve damage",
        params: &[],
        build: |_| "damage.amount / 2".to_string(),
    },
];

/// The snippet catalog for a body slot, plus how an insert combines with the
/// existing text.
#[must_use]
pub fn snippets_for(slot: BodySlot) -> &'static [Snippet] {
    match slot {
        BodySlot::ExitCanPass | BodySlot::SceneCanPlay | BodySlot::VictoryTest => CONDITIONS,
        BodySlot::NpcEffects => EFFECTS,
        BodySlot::ExitRunScript => SCRIPTS,
        BodySlot::ModifyDamage => TRANSFORMS,
        BodySlot::SceneBody
        | BodySlot::ItemBody
        | BodySlot::MechanicHook
        | BodySlot::MechanicAction
        | BodySlot::CardOnPlay => STATEMENTS,
    }
}

/// Merge a generated snippet into the existing body text, per the slot's grammar:
/// expressions AND-combine, transforms replace, statement-likes append a line.
#[must_use]
pub fn insert_snippet(slot: BodySlot, existing: &str, snippet: &str) -> String {
    match slot {
        BodySlot::ExitCanPass | BodySlot::SceneCanPlay | BodySlot::VictoryTest => {
            let old = existing.trim();
            if old.is_empty() || old == "true" || old == "false" {
                snippet.to_string()
            } else {
                format!("{old} && {snippet}")
            }
        }
        BodySlot::ModifyDamage => snippet.to_string(),
        _ => {
            let old = existing.trim_end();
            if old.is_empty() {
                snippet.to_string()
            } else {
                format!("{old}\n{snippet}")
            }
        }
    }
}

/// The builder bar under a body field: pick a snippet, fill its parameters,
/// insert. Vocabulary pickers draw from the live document.
#[component]
pub fn SnippetBar(slot: BodySlot, on_insert: EventHandler<String>) -> Element {
    let store = use_context::<StudioStore>();
    let mut open = use_signal(|| None::<usize>);
    let mut values = use_signal(Vec::<String>::new);
    let doc = (store.doc)();
    let item_keys = doc.item_keys();
    let key_codes: Vec<String> = doc
        .items
        .iter()
        .filter_map(|i| i.entry.key_code.clone())
        .collect();
    let snippets = snippets_for(slot);
    rsx! {
        div { class: "studio-snips",
            span { class: "studio-snips-label", "insert:" }
            for (i, s) in snippets.iter().enumerate() {
                button {
                    key: "{s.label}",
                    class: if open() == Some(i) { "studio-chip selected" } else { "studio-chip" },
                    onclick: move |_| {
                        let params = snippets[i].params;
                        values.set(vec![String::new(); params.len()]);
                        open.set(Some(i));
                        // Parameterless snippets insert immediately.
                        if params.is_empty() {
                            on_insert.call((snippets[i].build)(&[]));
                            open.set(None);
                        }
                    },
                    "{s.label}"
                }
            }
        }
        if let Some(i) = open() {
            div { class: "studio-snips-form",
                for (pi, (pname, pkind)) in snippets[i].params.iter().enumerate() {
                    label { key: "{pname}", class: "studio-field studio-snips-param",
                        span { class: "studio-field-label", "{pname}" }
                        match pkind {
                            Param::Item => rsx! {
                                select {
                                    class: "studio-input",
                                    // `write()` grants a scoped mutable borrow of the
                                    // Vec inside the signal — mutate in place, released
                                    // at the end of the statement.
                                    onchange: move |e| { values.write()[pi] = e.value(); },
                                    option { value: "", "(choose)" }
                                    for k in item_keys.clone() {
                                        option { key: "{k}", value: "{k}", "{k}" }
                                    }
                                }
                            },
                            Param::KeyCode => rsx! {
                                input {
                                    class: "studio-input studio-mono",
                                    list: "studio-keycodes",
                                    oninput: move |e| { values.write()[pi] = e.value(); },
                                }
                                datalist { id: "studio-keycodes",
                                    for c in key_codes.clone() {
                                        option { key: "{c}", value: "{c}" }
                                    }
                                }
                            },
                            Param::Stat => rsx! {
                                select {
                                    class: "studio-input",
                                    onchange: move |e| { values.write()[pi] = e.value(); },
                                    for s in STAT_TYPES {
                                        option { key: "{s}", value: "{s}", "{s}" }
                                    }
                                }
                            },
                            Param::Target => rsx! {
                                select {
                                    class: "studio-input",
                                    onchange: move |e| { values.write()[pi] = e.value(); },
                                    option { value: "actor", "actor (the current character)" }
                                    option { value: "party[0]", "party[0] (the first seat)" }
                                }
                            },
                            Param::Number => rsx! {
                                input {
                                    class: "studio-input studio-num",
                                    r#type: "number",
                                    oninput: move |e| { values.write()[pi] = e.value(); },
                                }
                            },
                            Param::Text | Param::Ident => rsx! {
                                input {
                                    class: "studio-input",
                                    oninput: move |e| { values.write()[pi] = e.value(); },
                                }
                            },
                        }
                    }
                }
                button {
                    class: "studio-btn small primary",
                    onclick: move |_| {
                        // Unchosen pickers fall back to their first option so the
                        // generated text always parses.
                        let mut vals = values();
                        for (pi, (_, pkind)) in snippets[i].params.iter().enumerate() {
                            if vals[pi].trim().is_empty() {
                                vals[pi] = match pkind {
                                    Param::Item => item_keys.first().cloned().unwrap_or_else(|| "item".into()),
                                    Param::KeyCode => key_codes.first().cloned().unwrap_or_else(|| "key".into()),
                                    Param::Stat => "health".into(),
                                    Param::Target => "actor".into(),
                                    Param::Number => "1".into(),
                                    Param::Text => "…".into(),
                                    Param::Ident => "field".into(),
                                };
                            }
                        }
                        on_insert.call((snippets[i].build)(&vals));
                        open.set(None);
                    },
                    "Insert"
                }
                button { class: "studio-btn small", onclick: move |_| open.set(None), "Cancel" }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gate::validate_body;

    /// Representative parameter values per kind — deliberately awkward (spaces,
    /// apostrophes) to prove the quoting holds.
    fn sample(p: Param) -> String {
        match p {
            Param::Item => "brass-key".into(),
            Param::KeyCode => "cellar".into(),
            Param::Stat => "sanity".into(),
            Param::Target => "party[0]".into(),
            Param::Number => "-2".into(),
            Param::Text => "The dark isn't empty.".into(),
            Param::Ident => "seen it".into(),
        }
    }

    /// The catalog's contract: EVERY snippet, in EVERY slot it is offered for,
    /// builds text that the slot's real parser accepts — both standalone and
    /// merged into existing text.
    #[test]
    fn every_snippet_validates_under_its_slot() {
        let slots = [
            BodySlot::ExitCanPass,
            BodySlot::ExitRunScript,
            BodySlot::SceneCanPlay,
            BodySlot::SceneBody,
            BodySlot::ItemBody,
            BodySlot::NpcEffects,
            BodySlot::MechanicHook,
            BodySlot::ModifyDamage,
            BodySlot::MechanicAction,
            BodySlot::CardOnPlay,
            BodySlot::VictoryTest,
        ];
        for slot in slots {
            for s in snippets_for(slot) {
                let params: Vec<String> = s.params.iter().map(|(_, k)| sample(*k)).collect();
                let built = (s.build)(&params);
                assert_eq!(
                    validate_body(slot, &built),
                    None,
                    "{:?}/{} generated invalid DSL: {built}",
                    slot,
                    s.label
                );
                // Merged into a representative existing body it must STILL parse.
                let existing = match slot {
                    BodySlot::ExitCanPass | BodySlot::SceneCanPlay | BodySlot::VictoryTest => {
                        "round < 10"
                    }
                    BodySlot::ModifyDamage => "damage.amount",
                    BodySlot::ExitRunScript => "pass 'through'",
                    _ => "emit cue('hello')",
                };
                let merged = insert_snippet(slot, existing, &built);
                assert_eq!(
                    validate_body(slot, &merged),
                    None,
                    "{:?}/{} merged invalid DSL: {merged}",
                    slot,
                    s.label
                );
            }
        }
    }

    #[test]
    fn quoting_survives_awkward_prose() {
        assert_eq!(dsl_quote("plain"), "'plain'");
        assert_eq!(dsl_quote("it's dark"), "\"it's dark\"");
        assert_eq!(dsl_quote("she said \"run\""), "'she said \"run\"'");
        // Both quote kinds present: the unrepresentable one is dropped.
        assert_eq!(dsl_quote("it's a \"trap\""), "'its a \"trap\"'");
    }

    #[test]
    fn expression_inserts_and_combine() {
        let merged = insert_snippet(BodySlot::ExitCanPass, "hasKey(actor, 'a')", "round < 3");
        assert_eq!(merged, "hasKey(actor, 'a') && round < 3");
        assert_eq!(
            insert_snippet(BodySlot::ExitCanPass, "true", "round < 3"),
            "round < 3",
            "the placeholder 'true' is replaced, not ANDed"
        );
        assert_eq!(
            insert_snippet(BodySlot::ModifyDamage, "damage.amount", "final 3"),
            "final 3",
            "transforms replace the whole body"
        );
    }
}
