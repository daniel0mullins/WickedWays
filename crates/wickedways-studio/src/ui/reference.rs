//! The DSL reference panel — a comprehensive, readable reference for the
//! behavior DSL, replacing the old one-line-per-topic crib sheet. The content
//! is DATA (sections of `sig`/`desc` rows) so a test can hold it complete
//! against the highlighter's grammar vocabulary (`highlight::CALLS` etc. — the
//! closed lists mirrored from the real parser), and every signature renders
//! through the same tokenizer the editors highlight with, so the reference
//! looks exactly like the code the author is writing.

use dioxus::prelude::*;

use super::highlight::tokenize;

/// One reference row: a signature (rendered highlighted) and its explanation.
pub struct Entry {
    pub sig: &'static str,
    pub desc: &'static str,
}

/// One collapsible section of the reference.
pub struct Section {
    pub title: &'static str,
    /// Optional framing line under the title (empty = none).
    pub intro: &'static str,
    pub entries: &'static [Entry],
}

/// The whole reference, in reading order: where scripts run, what they can
/// read, the functions, the statements, the effects, the damage transform,
/// and the rules that trip people up.
pub const SECTIONS: &[Section] = &[
    Section {
        title: "Where scripts run",
        intro: "Each body slot accepts one of four grammars.",
        entries: &[
            Entry { sig: "canPass · canPlay · victory test", desc: "One expression, evaluated for truth. No statements." },
            Entry { sig: "onEnter · onExit · onUse · onRead · onPlay · mechanic hooks & actions", desc: "A statement block — one statement per line; blank lines are ignored." },
            Entry { sig: "dialogue effects", desc: "An emit-only statement block: every line must be `emit <effect>(…)`." },
            Entry { sig: "exit runScript", desc: "A statement block where `pass <expr>` is also legal — the success narration." },
            Entry { sig: "modifyDamage", desc: "A value transform with its own tiny grammar (see the last section)." },
        ],
    },
    Section {
        title: "Subjects — what an expression can read",
        intro: "Bare identifiers. Anything else is a compile error, never a variable.",
        entries: &[
            Entry { sig: "actor", desc: "The character acting right now." },
            Entry { sig: "party", desc: "The list of player characters. party[0] or first(party) is the first seat." },
            Entry { sig: "round", desc: "The current round number." },
            Entry { sig: "maxRounds", desc: "The campaign's round limit." },
            Entry { sig: "damage", desc: "The damage event — only inside a modifyDamage body." },
            Entry { sig: "action", desc: "The action event — only in action contexts (a mechanic's onAction)." },
            Entry { sig: "element", desc: "The current item inside a some(…)/every(…) predicate." },
        ],
    },
    Section {
        title: "Fields — what .field reads",
        intro: "",
        entries: &[
            Entry { sig: "actor.health · actor.sanity · actor.energy", desc: "A character's stats (numbers)." },
            Entry { sig: "actor.name · actor.id · actor.roomId", desc: "A character's display name and ids." },
            Entry { sig: "actor.status", desc: "The character's status keys, as a list — pair with includes(…)." },
            Entry { sig: "actor.room", desc: "The room object the character stands in." },
            Entry { sig: "actor.room.name · actor.room.id · actor.room.lit", desc: "That room's name, id, and whether it is lit." },
            Entry { sig: "actor.room.occupants", desc: "The characters in the room, as a list." },
            Entry { sig: "damage.amount · damage.target · damage.stat · damage.source", desc: "The damage event's magnitude, target id, stat, and source." },
            Entry { sig: "action.kind · action.room", desc: "The action event's kind and the room it happened in." },
        ],
    },
    Section {
        title: "Functions",
        intro: "The complete list — there are no user-defined functions.",
        entries: &[
            Entry { sig: "hasKey(actor, 'code')", desc: "True when the character holds an item whose keyCode matches. The code must be a quoted literal." },
            Entry { sig: "hasItem(actor, 'item-key')", desc: "True when the character holds the item." },
            Entry { sig: "hasEquipped(actor, 'item-key')", desc: "True when the character has the item equipped." },
            Entry { sig: "stateGet('field', false)", desc: "Read this behavior's own state field; the second argument is the literal default." },
            Entry { sig: "stateGetIn('map', keyExpr, false)", desc: "Read a string-keyed state map — the key may be any expression, the default a literal." },
            Entry { sig: "some(party, element.sanity <= 0)", desc: "True when ANY list item passes the predicate (which reads `element`)." },
            Entry { sig: "every(party, includes(element.status, 'ko'))", desc: "True when EVERY list item passes the predicate." },
            Entry { sig: "includes(actor.status, 'fear')", desc: "List membership." },
            Entry { sig: "length(party)", desc: "The list's length." },
            Entry { sig: "first(party)", desc: "The list's first item." },
            Entry { sig: "str(round)", desc: "A number as a string (JavaScript formatting)." },
            Entry { sig: "concat(str(round), '/', str(maxRounds))", desc: "Join strings — at least one argument." },
            Entry { sig: "defined(x)", desc: "True when the value is not null." },
            Entry { sig: "mapLit('k1', 1, 'k2', 2)", desc: "A literal string→value table — only legal as the map of has/lookup." },
            Entry { sig: "has(map, key)", desc: "Membership in a mapLit." },
            Entry { sig: "lookup(map, key)", desc: "The value at a key of a mapLit." },
        ],
    },
    Section {
        title: "Operators",
        intro: "Loosest to tightest; parentheses group as usual.",
        entries: &[
            Entry { sig: "cond ? a : b", desc: "Ternary choice (right-associative)." },
            Entry { sig: "|| · &&", desc: "Boolean or / and." },
            Entry { sig: "== · != · < · <= · > · >=", desc: "Equality and comparison." },
            Entry { sig: "+ · - · * · /", desc: "Arithmetic (the only float ops — determinism)." },
            Entry { sig: "!x", desc: "Boolean not." },
            Entry { sig: "list[0] · value.field", desc: "Subscript and field access." },
        ],
    },
    Section {
        title: "Statements",
        intro: "One per line. `state` persists per behavior key across the campaign.",
        entries: &[
            Entry { sig: "guard round > 0", desc: "Stop the whole body unless the condition holds." },
            Entry { sig: "when actor.sanity <= 3 { emit cue('It sees you.') }", desc: "Run the block only when the condition holds; blocks nest." },
            Entry { sig: "set state.seen = true", desc: "Write a field of this behavior's own state." },
            Entry { sig: "set state.seen[action.room.name] = true", desc: "Write into a string-keyed state map — the key is an expression." },
            Entry { sig: "emit cue('A cold draft.')", desc: "Queue an effect (the full effect list below)." },
            Entry { sig: "pass 'The hinge gives.'", desc: "Exit runScript only: the narration for a successful pass — last one wins." },
        ],
    },
    Section {
        title: "Effects — what emit can do",
        intro: "The complete family; anything else is a compile error.",
        entries: &[
            Entry { sig: "emit cue('The dark deepens.')", desc: "A narration line to the player." },
            Entry { sig: "emit adjustStat(actor, sanity, -1)", desc: "Adjust a stat. The stat is a bare keyword: sanity, health, or energy." },
            Entry { sig: "emit damage(actor, 5)", desc: "Health damage — mitigation applies." },
            Entry { sig: "emit heal(actor, 6)", desc: "Health healing." },
            Entry { sig: "emit grantImmunity(actor, 2)", desc: "All-status immunity for N turns." },
            Entry { sig: "emit giveItem('npc:The Keeper', actor, 'npc:The Keeper:item#0')", desc: "Hand an item over — the arguments resolve as character/item ids." },
            Entry { sig: "emit setVisible('npc:The Keeper', false)", desc: "Show or hide a character." },
            Entry { sig: "emit status(field('Sanity', str(actor.sanity), 'warn'), field('Round', str(round)))", desc: "Paint the HUD status bar — each field(label, value[, emphasis])." },
        ],
    },
    Section {
        title: "modifyDamage — the transform grammar",
        intro: "A value, not statements. Reads the damage subject.",
        entries: &[
            Entry { sig: "damage.amount > 3 ? final 3 : damage.amount", desc: "Cap damage at 3: `final` halts the transformer chain with that amount; a bare expression is the (possibly adjusted) amount; ternaries chain to the right." },
        ],
    },
    Section {
        title: "Rules worth knowing",
        intro: "",
        entries: &[
            Entry { sig: "state is scoped PER BEHAVIOR KEY", desc: "A scene's `set state.lit = true` is invisible to a victory test's stateGet. Write victory conditions as world predicates (position, items, stats) instead." },
            Entry { sig: "strings: 'single' or \"double\"", desc: "No escapes — the other quote kind is a literal character inside a string." },
            Entry { sig: "no loops, no randomness, no clocks", desc: "Scripts are deterministic; express chance through encounter tables and formation weights." },
        ],
    },
];

/// The reference panel: collapsible, sectioned, every signature rendered
/// through the editors' own highlighter.
#[component]
pub fn DslReference() -> Element {
    rsx! {
        details { class: "studio-dsl",
            summary { "DSL reference" }
            div { class: "studio-dsl-body",
                for section in SECTIONS {
                    section { key: "{section.title}", class: "studio-ref-section",
                        h4 { "{section.title}" }
                        if !section.intro.is_empty() {
                            p { class: "studio-ref-intro", "{section.intro}" }
                        }
                        div { class: "studio-ref-grid",
                            for entry in section.entries {
                                code { key: "{entry.sig}", class: "studio-ref-sig",
                                    for (i, (tok, text)) in tokenize(entry.sig).into_iter().enumerate() {
                                        span { key: "{i}", class: "{tok.css()}", "{text}" }
                                    }
                                }
                                span { key: "d-{entry.sig}", class: "studio-ref-desc", "{entry.desc}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every name in the highlighter's grammar vocabulary (mirrored from the
    /// real parser) appears in the reference — the panel stays COMPREHENSIVE
    /// as the grammar grows, or this fails.
    #[test]
    fn the_reference_covers_the_whole_grammar_vocabulary() {
        let all: String = SECTIONS
            .iter()
            .flat_map(|s| s.entries.iter())
            .map(|e| format!("{} {}", e.sig, e.desc))
            .collect::<Vec<_>>()
            .join("\n");
        let mut missing: Vec<&str> = Vec::new();
        for name in crate::ui::highlight::KEYWORDS
            .iter()
            .chain(crate::ui::highlight::EFFECTS)
            .chain(crate::ui::highlight::CALLS)
            .chain(crate::ui::highlight::SUBJECTS)
        {
            if !all.contains(name) {
                missing.push(name);
            }
        }
        assert!(
            missing.is_empty(),
            "grammar vocabulary missing from the DSL reference panel: {missing:?}"
        );
    }

    /// Signatures render through the real tokenizer losslessly — the panel
    /// shows exactly what it claims.
    #[test]
    fn every_signature_tokenizes_losslessly() {
        for section in SECTIONS {
            for entry in section.entries {
                let joined: String = tokenize(entry.sig).into_iter().map(|(_, s)| s).collect();
                assert_eq!(joined, entry.sig, "lossy signature render");
            }
        }
    }
}
