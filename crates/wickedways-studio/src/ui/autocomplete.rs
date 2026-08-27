//! Context-aware autocomplete for DSL string literals — pure sugar, zero
//! authority: it suggests names already defined in the document while typing
//! inside a quoted string, and never complains about unknown ones (the
//! compiler + `check_refs`' info-tier literal lint keep that job).
//!
//! The analysis is a pure function over `(document, text, caret)` so the whole
//! feature is host-testable; the popover in `highlight.rs::DslEditor` is a thin
//! view over it. Context → pool mapping:
//!
//! | caret inside a string, and …                    | suggests            |
//! |-------------------------------------------------|---------------------|
//! | innermost call is `hasKey(…)`                   | item **key codes**  |
//! | innermost call is `hasItem`/`hasEquipped`       | item **keys**       |
//! | innermost call is `setVisible`/`giveItem`       | `npc:<Name>` refs   |
//! | innermost call is `stateGet`/`stateGetIn`       | state fields seen in this body |
//! | innermost call is `includes` over `….status`    | status keys         |
//! | otherwise text before the string ends `== / !=` after `room.name` | **room names** |

use crate::model::EditorDoc;

/// The status keys `includes(….status, '…')` matches (the engine's
/// `Status` serialization — see `wickedways-core`'s `eval.rs`).
const STATUSES: &[&str] = &["confused", "fear", "ko", "panic"];

/// Cap on rendered options — the popover is a nudge, not a browser.
const MAX_OPTIONS: usize = 8;

/// An active suggestion context: the typed span to replace and the options.
#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    /// Char index (Rust `chars()` count) just after the opening quote; the span
    /// `[start_chars, caret)` is the typed prefix acceptance replaces.
    pub start_chars: usize,
    /// The quote character that opened the string.
    pub quote: char,
    /// What the pool is, for the popover's header ("rooms", "item keys", …).
    pub label: &'static str,
    /// The matching options, prefix-filtered, at most [`MAX_OPTIONS`].
    pub options: Vec<String>,
}

/// Convert a JS `selectionStart` (UTF-16 code units) into a Rust char count.
/// Clamps past-the-end offsets to the full length.
#[must_use]
pub fn utf16_to_char_index(text: &str, caret_utf16: u32) -> usize {
    let mut units: u32 = 0;
    for (i, c) in text.chars().enumerate() {
        if units >= caret_utf16 {
            return i;
        }
        units += c.len_utf16() as u32;
    }
    text.chars().count()
}

/// The suggestion context at `caret` (UTF-16 units, as the DOM reports it), or
/// `None` when the caret isn't inside a single-line string literal with a
/// recognizable asset context and at least one matching option.
#[must_use]
pub fn suggest(doc: &EditorDoc, text: &str, caret_utf16: u32) -> Option<Suggestion> {
    let caret = utf16_to_char_index(text, caret_utf16);
    let head: Vec<char> = text.chars().take(caret).collect();

    // Find the string the caret sits in: track quote state over the head; an
    // open quote at the end means we're inside one.
    let mut open: Option<(usize, char)> = None;
    for (i, &c) in head.iter().enumerate() {
        match open {
            None if c == '\'' || c == '"' => open = Some((i, c)),
            Some((_, q)) if c == q => open = None,
            _ => {}
        }
    }
    let (quote_at, quote) = open?;
    let prefix: String = head[quote_at + 1..].iter().collect();
    if prefix.contains('\n') {
        return None; // strings don't span lines; this is prose or a mistake
    }
    let context: Vec<char> = head[..quote_at].to_vec();

    let (label, pool) = classify(doc, text, &context)?;
    let options = filter(pool, &prefix);
    if options.is_empty() {
        return None;
    }
    // Already-complete input needs no popover.
    if options.len() == 1 && options[0] == prefix {
        return None;
    }
    Some(Suggestion {
        start_chars: quote_at + 1,
        quote,
        label,
        options,
    })
}

/// Apply a chosen option: replace `[s.start_chars, caret)` with the choice and
/// make sure the string is closed. Returns the new text and the new caret
/// position (UTF-16 units, ready for `setSelectionRange`), placed after the
/// closing quote.
#[must_use]
pub fn accept(text: &str, s: &Suggestion, caret_utf16: u32, choice: &str) -> (String, u32) {
    let caret = utf16_to_char_index(text, caret_utf16);
    let chars: Vec<char> = text.chars().collect();
    let before: String = chars[..s.start_chars].iter().collect();
    let after: String = chars[caret.min(chars.len())..].iter().collect();
    // Reuse an existing closing quote right after the caret; else add one.
    let (after, close) = match after.strip_prefix(s.quote) {
        Some(rest) => (rest.to_string(), s.quote),
        None => (after, s.quote),
    };
    let new_text = format!("{before}{choice}{close}{after}");
    let caret_units =
        (before.encode_utf16().count() + choice.encode_utf16().count() + close.len_utf16()) as u32;
    (new_text, caret_units)
}

/// Map the text before the opening quote to a suggestion pool.
fn classify(doc: &EditorDoc, whole: &str, context: &[char]) -> Option<(&'static str, Vec<String>)> {
    // Innermost unbalanced call: scan backwards counting parens; the identifier
    // before the unmatched '(' names the call, and the text after it is the
    // arguments-so-far (for `includes`'s `.status` sniff).
    if let Some((call, args)) = innermost_call(context) {
        match call.as_str() {
            "hasKey" => {
                let keys: Vec<String> = doc
                    .items
                    .iter()
                    .filter_map(|i| i.entry.key_code.clone())
                    .collect();
                return Some(("key codes", keys));
            }
            "hasItem" | "hasEquipped" => {
                return Some((
                    "item keys",
                    doc.items.iter().map(|i| i.entry.key.clone()).collect(),
                ));
            }
            "setVisible" | "giveItem" => {
                return Some((
                    "characters",
                    doc.npcs
                        .iter()
                        .map(|n| format!("npc:{}", n.entry.name))
                        .collect(),
                ));
            }
            "stateGet" | "stateGetIn" => {
                return Some(("state fields", state_fields(whole)));
            }
            "includes" if args.contains(".status") => {
                return Some((
                    "statuses",
                    STATUSES.iter().map(|s| (*s).to_string()).collect(),
                ));
            }
            _ => {} // an unrecognized call falls through to the comparison rule
        }
    }
    // Comparison against a room name: `… room.name == '` / `!=`.
    let ctx: String = context.iter().collect();
    let trimmed = ctx.trim_end();
    for op in ["==", "!="] {
        if let Some(lhs) = trimmed.strip_suffix(op) {
            if lhs.trim_end().ends_with("room.name") {
                return Some((
                    "rooms",
                    doc.rooms.iter().map(|r| r.entry.name.clone()).collect(),
                ));
            }
        }
    }
    None
}

/// The innermost call still open at the end of `context`:
/// `(name, args-so-far)`, or `None` when every paren is balanced.
fn innermost_call(context: &[char]) -> Option<(String, String)> {
    let mut depth: i32 = 0;
    for i in (0..context.len()).rev() {
        match context[i] {
            ')' => depth += 1,
            '(' => {
                depth -= 1;
                if depth < 0 {
                    // Identifier directly before the paren (spaces allowed).
                    let mut j = i;
                    while j > 0 && context[j - 1] == ' ' {
                        j -= 1;
                    }
                    let mut k = j;
                    while k > 0 && (context[k - 1].is_ascii_alphanumeric() || context[k - 1] == '_')
                    {
                        k -= 1;
                    }
                    if k == j {
                        return None; // a bare grouping paren, not a call
                    }
                    let name: String = context[k..j].iter().collect();
                    let args: String = context[i + 1..].iter().collect();
                    return Some((name, args));
                }
            }
            _ => {}
        }
    }
    None
}

/// State fields referenced anywhere in this body: every `state.<ident>` write
/// target plus every string literal already passed to `stateGet`/`stateGetIn`.
fn state_fields(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if text[find_byte(&chars, i)..].starts_with("state.") {
            let mut j = i + "state.".chars().count();
            let mut field = String::new();
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                field.push(chars[j]);
                j += 1;
            }
            if !field.is_empty() && !out.contains(&field) {
                out.push(field);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Byte offset of char index `i` (the chars vec re-encoded up to `i`).
fn find_byte(chars: &[char], i: usize) -> usize {
    chars[..i].iter().map(|c| c.len_utf8()).sum()
}

/// Prefix-filter (case-insensitive); when nothing prefix-matches a non-empty
/// prefix, fall back to contains-matching. Deduped, capped.
fn filter(pool: Vec<String>, prefix: &str) -> Vec<String> {
    let lower = prefix.to_lowercase();
    let mut seen = std::collections::BTreeSet::new();
    let mut starts: Vec<String> = Vec::new();
    let mut contains: Vec<String> = Vec::new();
    for opt in pool {
        if opt.is_empty() || !seen.insert(opt.clone()) {
            continue;
        }
        let ol = opt.to_lowercase();
        if ol.starts_with(&lower) {
            starts.push(opt);
        } else if !lower.is_empty() && ol.contains(&lower) {
            contains.push(opt);
        }
    }
    let mut out = starts;
    if out.is_empty() {
        out = contains;
    }
    out.truncate(MAX_OPTIONS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EditorDoc;

    /// A doc with two rooms, two items (one a key), and an npc — authored TOML
    /// through the real import path, so the shapes stay honest.
    fn doc() -> EditorDoc {
        crate::export::import(
            r#"
            title = "T"
            [[rooms]]
            name = "Hall"
            description = "d"
            [[rooms]]
            name = "Cellar"
            description = "d"
            [[items]]
            key = "storm-lantern"
            name = "Storm Lantern"
            [[items]]
            key = "brass-key"
            name = "Brass Key"
            keyCode = "lamp-room"
            [[npcs]]
            name = "The Keeper"
            stats = { health = 1.0, sanity = 1.0, energy = 1.0 }
            behavior = "keeper"
            [behaviors.npc.keeper]
            description = "d"
            [behaviors.npc.keeper.default]
            match = ""
            response = "r"
            "#,
        )
        .expect("test doc imports")
    }

    fn caret_at_end(text: &str) -> u32 {
        text.encode_utf16().count() as u32
    }

    #[test]
    fn room_names_after_a_room_name_comparison() {
        let text = "first(party).room.name == '";
        let s = suggest(&doc(), text, caret_at_end(text)).expect("suggests");
        assert_eq!(s.label, "rooms");
        assert_eq!(s.options, vec!["Hall".to_string(), "Cellar".to_string()]);
        // A typed prefix filters (case-insensitive).
        let text = "first(party).room.name == 'ce";
        let s = suggest(&doc(), text, caret_at_end(text)).expect("suggests");
        assert_eq!(s.options, vec!["Cellar".to_string()]);
    }

    #[test]
    fn call_contexts_pick_their_pools() {
        let d = doc();
        let t = "hasKey(actor, '";
        assert_eq!(
            suggest(&d, t, caret_at_end(t)).unwrap().options,
            vec!["lamp-room".to_string()]
        );
        let t = "guard hasItem(actor, '";
        assert_eq!(
            suggest(&d, t, caret_at_end(t)).unwrap().options,
            vec!["storm-lantern".to_string(), "brass-key".to_string()] // authored order
        );
        let t = "emit setVisible('";
        assert_eq!(
            suggest(&d, t, caret_at_end(t)).unwrap().options,
            vec!["npc:The Keeper".to_string()]
        );
        let t = "includes(element.status, '";
        assert_eq!(suggest(&d, t, caret_at_end(t)).unwrap().label, "statuses");
        // Nested: the INNERMOST call wins even inside some(...).
        let t = "some(party, hasItem(element, 'sto";
        assert_eq!(
            suggest(&d, t, caret_at_end(t)).unwrap().options,
            vec!["storm-lantern".to_string()]
        );
    }

    #[test]
    fn state_fields_come_from_the_body_itself() {
        let d = doc();
        let t = "guard !stateGet('";
        let body_tail = "\nset state.lit = true\nset state.seen_once = true";
        let full = format!("{t}{body_tail}");
        // Caret right after the opening quote, fields defined later in the body.
        let s = suggest(&d, &full, caret_at_end(t)).expect("suggests");
        assert_eq!(s.label, "state fields");
        assert_eq!(s.options, vec!["lit".to_string(), "seen_once".to_string()]);
    }

    #[test]
    fn silent_when_out_of_context() {
        let d = doc();
        for t in [
            "first(party).room.name == 'Cellar'", // caret after CLOSED string
            "emit cue('The dark ",                // cue has no asset pool
            "round == ",                          // no string at all
            "hasKey(actor, 'zzz",                 // prefix matches nothing
        ] {
            assert_eq!(suggest(&d, t, caret_at_end(t)), None, "{t:?}");
        }
        // Exactly-complete input: the lone remaining match equals the typed
        // prefix, so the popover stays away.
        let t = "first(party).room.name == 'Cellar";
        assert_eq!(suggest(&d, t, caret_at_end(t)), None);
    }

    #[test]
    fn accept_replaces_the_prefix_and_closes_the_string() {
        let d = doc();
        let t = "first(party).room.name == 'ce";
        let s = suggest(&d, t, caret_at_end(t)).unwrap();
        let (new_text, caret) = accept(t, &s, caret_at_end(t), "Cellar");
        assert_eq!(new_text, "first(party).room.name == 'Cellar'");
        assert_eq!(caret, new_text.encode_utf16().count() as u32);
        // An existing closing quote is reused, not doubled.
        let t2 = "hasKey(actor, '')";
        let caret2 = "hasKey(actor, '".encode_utf16().count() as u32;
        let s2 = suggest(&d, t2, caret2).unwrap();
        let (new2, c2) = accept(t2, &s2, caret2, "lamp-room");
        assert_eq!(new2, "hasKey(actor, 'lamp-room')");
        assert_eq!(
            c2,
            "hasKey(actor, 'lamp-room'".encode_utf16().count() as u32
        );
        // Unicode before the string: caret math is UTF-16-correct.
        let t3 = "emit cue('🜏') && first(party).room.name == 'Ha";
        let s3 = suggest(&d, t3, caret_at_end(t3)).unwrap();
        let (new3, c3) = accept(t3, &s3, caret_at_end(t3), "Hall");
        assert_eq!(new3, "emit cue('🜏') && first(party).room.name == 'Hall'");
        assert_eq!(c3, new3.encode_utf16().count() as u32);
    }
}
