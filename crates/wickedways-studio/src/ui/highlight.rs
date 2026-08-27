//! Syntax highlighting for DSL body editors — a LOSSLESS tokenizer (the
//! concatenation of the emitted tokens is byte-identical to the input, pinned by
//! a corpus property test) feeding the overlay editor in `behaviors.rs`: a
//! transparent-text `<textarea>` stacked on a `<pre>` of colored spans.
//!
//! Classification is cosmetic — the compiler (`gate::validate_body`) stays the
//! authority on validity — but the vocabulary below mirrors the real grammar
//! (`wickedways-author`'s `stmt.rs` / `expr/parser.rs`): statement keywords, the
//! closed effect family, the closed call-name list, and the read-model subjects.
//! An unknown word is `Plain`, never a guess.

/// A token's display class → the `hl-*` CSS class the overlay renders it with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tok {
    /// Statement keywords (`guard`/`when`/`set`/`emit`/`pass`) + `final`.
    Keyword,
    /// The emittable effect family (`cue`, `adjustStat`, …) and `field`.
    Effect,
    /// The expression call names (`hasKey`, `stateGet`, `some`, …).
    Call,
    /// Read-model subjects (`actor`, `party`, `round`, …) + `state` + booleans.
    Subject,
    /// String literals (either quote kind; an unterminated one runs to the end).
    Str,
    /// Numeric literals.
    Num,
    /// Operator characters (`? : ! < > = & | + - * /`).
    Op,
    /// Everything else — whitespace, punctuation, unknown identifiers.
    Plain,
}

impl Tok {
    /// The CSS class the overlay tags this token's span with.
    #[must_use]
    pub fn css(self) -> &'static str {
        match self {
            Tok::Keyword => "hl-kw",
            Tok::Effect => "hl-eff",
            Tok::Call => "hl-fn",
            Tok::Subject => "hl-sub",
            Tok::Str => "hl-str",
            Tok::Num => "hl-num",
            Tok::Op => "hl-op",
            Tok::Plain => "hl-plain",
        }
    }
}

/// Statement-body keywords, plus `modifyDamage`'s `final`.
const KEYWORDS: &[&str] = &["guard", "when", "set", "emit", "pass", "final"];

/// The closed effect family (`stmt.rs::parse_emit`) + `status`'s `field(...)`.
/// `damage` is here AND in [`SUBJECTS`] — the call/lookahead rule disambiguates.
const EFFECTS: &[&str] = &[
    "cue",
    "adjustStat",
    "giveItem",
    "setVisible",
    "status",
    "field",
    "damage",
    "heal",
    "grantImmunity",
];

/// The closed expression call names (`expr/parser.rs`).
const CALLS: &[&str] = &[
    "hasKey",
    "hasItem",
    "hasEquipped",
    "stateGet",
    "stateGetIn",
    "mapLit",
    "has",
    "lookup",
    "some",
    "every",
    "includes",
    "str",
    "length",
    "first",
    "defined",
    "concat",
];

/// Read-model subjects (`expr/parser.rs::resolve_subject`) + the `state` write
/// target + boolean literals.
const SUBJECTS: &[&str] = &[
    "actor",
    "party",
    "round",
    "maxRounds",
    "damage",
    "action",
    "element",
    "state",
    "true",
    "false",
];

/// Classify a word given whether a `(` follows it (after optional spaces):
/// call position prefers the effect/call vocabularies; subject position prefers
/// the subjects (so bare `damage` reads as the damage subject, `damage(...)` as
/// the effect).
fn classify(word: &str, called: bool) -> Tok {
    if KEYWORDS.contains(&word) {
        return Tok::Keyword;
    }
    if called {
        if EFFECTS.contains(&word) {
            return Tok::Effect;
        }
        if CALLS.contains(&word) {
            return Tok::Call;
        }
    }
    if SUBJECTS.contains(&word) {
        return Tok::Subject;
    }
    // Not-called effect/call names still tint (e.g. mid-typing `adjustSta…`
    // stays plain, but a complete `cue` before its paren arrives colors late —
    // acceptable; completeness beats flicker-accuracy here).
    if EFFECTS.contains(&word) {
        return Tok::Effect;
    }
    if CALLS.contains(&word) {
        return Tok::Call;
    }
    Tok::Plain
}

/// Tokenize `src` losslessly: `tokens.concat() == src`, always — including
/// unterminated strings and arbitrary garbage (the editor holds mid-typing
/// text most of the time).
#[must_use]
pub fn tokenize(src: &str) -> Vec<(Tok, String)> {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<(Tok, String)> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;

    // Fold consecutive plain chars into one token to keep the span count low.
    fn flush(out: &mut Vec<(Tok, String)>, plain: &mut String) {
        if !plain.is_empty() {
            out.push((Tok::Plain, std::mem::take(plain)));
        }
    }

    while i < chars.len() {
        let c = chars[i];
        // String literal: runs to the matching quote (the other quote kind is a
        // literal char inside it — the grammar has no escapes), or to the end.
        if c == '\'' || c == '"' {
            flush(&mut out, &mut plain);
            let quote = c;
            let mut s = String::from(c);
            i += 1;
            while i < chars.len() {
                let d = chars[i];
                s.push(d);
                i += 1;
                if d == quote {
                    break;
                }
            }
            out.push((Tok::Str, s));
            continue;
        }
        // Number: digits, one optional dot run.
        if c.is_ascii_digit() {
            flush(&mut out, &mut plain);
            let mut s = String::new();
            let mut seen_dot = false;
            while i < chars.len() {
                let d = chars[i];
                if d.is_ascii_digit()
                    || (d == '.'
                        && !seen_dot
                        && matches!(chars.get(i + 1), Some(n) if n.is_ascii_digit()))
                {
                    seen_dot |= d == '.';
                    s.push(d);
                    i += 1;
                } else {
                    break;
                }
            }
            out.push((Tok::Num, s));
            continue;
        }
        // Word: identifier chars, classified by vocabulary + call lookahead.
        if c.is_ascii_alphabetic() || c == '_' {
            flush(&mut out, &mut plain);
            let mut s = String::new();
            while i < chars.len() {
                let d = chars[i];
                if d.is_ascii_alphanumeric() || d == '_' {
                    s.push(d);
                    i += 1;
                } else {
                    break;
                }
            }
            let mut j = i;
            while matches!(chars.get(j), Some(' ')) {
                j += 1;
            }
            let called = matches!(chars.get(j), Some('('));
            let tok = classify(&s, called);
            out.push((tok, s));
            continue;
        }
        // Operator characters get their own class; everything else is plain.
        if matches!(
            c,
            '?' | ':' | '!' | '<' | '>' | '=' | '&' | '|' | '+' | '-' | '*' | '/'
        ) {
            flush(&mut out, &mut plain);
            out.push((Tok::Op, c.to_string()));
            i += 1;
            continue;
        }
        plain.push(c);
        i += 1;
    }
    flush(&mut out, &mut plain);
    out
}

use dioxus::prelude::*;

/// The overlay editor: a transparent-text `<textarea>` (the real input — caret,
/// selection, events) stacked on an `aria-hidden` `<pre>` rendering the same
/// text as colored token spans. The two share font metrics via CSS
/// (`.studio-hl` mirrors `.studio-body`), wrap is off on both, and the
/// textarea's `onscroll` copies its offsets onto the highlight layer.
#[component]
pub fn DslEditor(value: String, invalid: bool, on_input: EventHandler<String>) -> Element {
    // A stable per-instance element-id pair for the scroll sync (ids because the
    // sync goes through `document` — no per-node handles in dioxus html).
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let (ta_id, hl_id) = use_hook(|| {
        let n = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (format!("studio-ed-ta-{n}"), format!("studio-ed-hl-{n}"))
    });
    let scroll_ids = (ta_id.clone(), hl_id.clone());
    let store = use_context::<crate::app::StudioStore>();
    // The active autocomplete context (suggestion + highlighted row), refreshed
    // from the caret on input/click, dismissed on accept/Escape/out-of-context.
    let mut ac = use_signal(|| None::<(autocomplete::Suggestion, usize)>);

    // Recompute the suggestion from the live caret. Sugar only: any failure to
    // read the DOM (host tests, the native webview) just means no popover.
    let refresh = {
        let ta_id = ta_id.clone();
        move |text: &str,
              mut ac: Signal<Option<(autocomplete::Suggestion, usize)>>,
              store: &crate::app::StudioStore| {
            let next = caret_of(&ta_id)
                .and_then(|caret| autocomplete::suggest(&(store.doc)(), text, caret))
                .map(|s| (s, 0));
            ac.set(next);
        }
    };
    let refresh_input = refresh.clone();
    let store_input = store;
    let ta_accept = ta_id.clone();
    // Accept the active row: pure text surgery (autocomplete::accept), the DOM
    // caret restored right where the closing quote ends.
    let accept = move |choice: String, current: String| {
        let Some(caret) = caret_of(&ta_accept) else {
            return;
        };
        let Some((s, _)) = (ac)() else { return };
        let (new_text, new_caret) = autocomplete::accept(&current, &s, caret, &choice);
        set_textarea(&ta_accept, &new_text, new_caret);
        on_input.call(new_text);
        ac.set(None);
    };
    let mut accept_key = accept.clone();

    let toks = tokenize(&value);
    let value_for_key = value.clone();
    let value_for_click = value.clone();
    let popover = (ac)();
    rsx! {
        div { class: "studio-editor",
            pre { id: "{hl_id}", class: "studio-hl", aria_hidden: "true",
                code {
                    for (i, (tok, text)) in toks.into_iter().enumerate() {
                        span { key: "{i}", class: "{tok.css()}", "{text}" }
                    }
                    // Trailing line so a body ending in '\n' keeps the layers'
                    // scroll heights equal (a bare newline renders no row).
                    "\u{200b}"
                }
            }
            textarea {
                id: "{ta_id}",
                class: if invalid { "studio-input studio-body invalid" } else { "studio-input studio-body" },
                value: "{value}",
                spellcheck: "false",
                wrap: "off",
                autocomplete: "off",
                oninput: move |e| {
                    let v = e.value();
                    on_input.call(v.clone());
                    refresh_input(&v, ac, &store_input);
                },
                onclick: {
                    let refresh = refresh.clone();
                    move |_| refresh(&value_for_click, ac, &store)
                },
                onkeydown: move |e| {
                    let Some((s, active)) = (ac)() else { return };
                    match e.key() {
                        Key::ArrowDown => {
                            e.prevent_default();
                            ac.set(Some((s.clone(), (active + 1) % s.options.len())));
                        }
                        Key::ArrowUp => {
                            e.prevent_default();
                            let n = s.options.len();
                            ac.set(Some((s.clone(), (active + n - 1) % n)));
                        }
                        Key::Enter | Key::Tab => {
                            e.prevent_default();
                            accept_key(s.options[active].clone(), value_for_key.clone());
                        }
                        Key::Escape => {
                            e.prevent_default();
                            ac.set(None);
                        }
                        _ => {}
                    }
                },
                onblur: move |_| {
                    // The popover buttons use onmousedown (fires BEFORE blur),
                    // so dismissing here never races an accept.
                    ac.set(None);
                },
                onscroll: move |_| sync_scroll(&scroll_ids.0, &scroll_ids.1),
            }
            if let Some((s, active)) = popover {
                div { class: "studio-ac",
                    span { class: "studio-ac-label", "{s.label}" }
                    for (i, opt) in s.options.clone().into_iter().enumerate() {
                        {
                            let shown = opt.clone();
                            let mut accept = accept.clone();
                            let current = value.clone();
                            rsx! {
                                button {
                                    key: "{shown}",
                                    class: if i == active { "studio-ac-item active" } else { "studio-ac-item" },
                                    // mousedown (not click): it fires before the
                                    // textarea's blur, keeping the caret math valid.
                                    onmousedown: move |e: Event<MouseData>| {
                                        e.prevent_default();
                                        accept(opt.clone(), current.clone());
                                    },
                                    "{shown}"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

use super::autocomplete;

/// The textarea's caret (`selectionStart`, UTF-16 units). Browser-only.
fn caret_of(ta_id: &str) -> Option<u32> {
    if cfg!(not(target_arch = "wasm32")) {
        return None;
    }
    use wasm_bindgen::JsCast;
    let ta = web_sys::window()?
        .document()?
        .get_element_by_id(ta_id)?
        .dyn_into::<web_sys::HtmlTextAreaElement>()
        .ok()?;
    ta.selection_start().ok().flatten()
}

/// Write `text` into the textarea and park the caret at `caret` — done directly
/// on the DOM so the caret survives the subsequent (same-value) dioxus render.
fn set_textarea(ta_id: &str, text: &str, caret: u32) {
    if cfg!(not(target_arch = "wasm32")) {
        return;
    }
    use wasm_bindgen::JsCast;
    let Some(ta) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id(ta_id))
        .and_then(|e| e.dyn_into::<web_sys::HtmlTextAreaElement>().ok())
    else {
        return;
    };
    ta.set_value(text);
    let _ = ta.set_selection_range(caret, caret);
}

/// Copy the textarea's scroll offsets onto the highlight layer. Browser-only:
/// off-wasm (host tests, the desktop shell's native process) `web_sys::window()`
/// PANICS rather than returning `None`, so bail first — the desktop webview
/// still renders the highlight, it just doesn't scroll-sync long bodies.
fn sync_scroll(ta_id: &str, hl_id: &str) {
    if cfg!(not(target_arch = "wasm32")) {
        return;
    }
    let Some(doc) = web_sys::window().and_then(|w| w.document()) else {
        return;
    };
    let (Some(ta), Some(hl)) = (doc.get_element_by_id(ta_id), doc.get_element_by_id(hl_id)) else {
        return;
    };
    hl.set_scroll_top(ta.scroll_top());
    hl.set_scroll_left(ta.scroll_left());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(src: &str) -> String {
        tokenize(src).into_iter().map(|(_, s)| s).collect()
    }

    /// Lossless over every DSL body in the shipped campaign corpus: behaviors,
    /// victory tests, dialogue effects — everything the overlay will render.
    #[test]
    fn tokenize_is_lossless_over_the_corpus() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../campaigns");
        let mut bodies = 0usize;
        for entry in std::fs::read_dir(dir).expect("campaigns dir") {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            let src = std::fs::read_to_string(&path).expect("read toml");
            let doc = crate::export::import(&src)
                .unwrap_or_else(|e| panic!("{}: import: {e}", path.display()));
            for body in crate::export::to_toml(&doc)
                .expect("export")
                .lines()
                .filter(|l| !l.trim().is_empty())
            {
                // Every exported line (not just bodies) must round-trip — the
                // tokenizer sees arbitrary mid-typing text, so pin it broadly.
                assert_eq!(joined(body), body, "lossy tokenize: {body:?}");
                bodies += 1;
            }
        }
        assert!(bodies > 100, "corpus should exercise plenty of lines");
    }

    #[test]
    fn lossless_on_awkward_input() {
        for src in [
            "",
            "guard !hasEquipped(actor, 'lantern')\nemit adjustStat(actor, sanity, -1)",
            "when x { emit cue('unterminated…",
            "'lone quote",
            "\"double \" and 'single'",
            "damage.amount > 3 ? final 3 : damage.amount",
            "set state.seen[action.room.name] = true",
            "🜏 unicode ⚝ survives\n\ttabs too",
            "1.5 + 2 . 3 .. 4.",
        ] {
            assert_eq!(joined(src), src, "lossy tokenize: {src:?}");
        }
    }

    #[test]
    fn classification_follows_the_grammar() {
        let toks = tokenize("guard hasKey(actor, 'cellar')");
        assert_eq!(toks[0], (Tok::Keyword, "guard".into()));
        assert_eq!(toks[2], (Tok::Call, "hasKey".into()));
        assert!(toks.contains(&(Tok::Subject, "actor".into())));
        assert!(toks.contains(&(Tok::Str, "'cellar'".into())));

        // `damage` the SUBJECT vs `damage` the EFFECT — the call lookahead.
        let subject = tokenize("damage.amount > 3");
        assert_eq!(subject[0], (Tok::Subject, "damage".into()));
        let effect = tokenize("emit damage(actor, 5)");
        assert_eq!(effect[2], (Tok::Effect, "damage".into()));

        // Unknown words stay plain — no guessing.
        assert_eq!(tokenize("frobnicate(x)")[0].0, Tok::Plain);
    }
}
