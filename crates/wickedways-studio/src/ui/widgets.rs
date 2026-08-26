//! Shared form widgets — the field-row vocabulary every screen speaks.
//!
//! Conventions: an empty text input maps to `None` for `Option<String>` fields
//! (absent-means-default is the TOML idiom); tri-state selects cover `Option<bool>`
//! (an explicit `false` differs from absent in the exported TOML); enum fields are
//! dropdowns, never free text (the compiler silently defaults unknown enum strings —
//! see the spec's silent-default hazard).
//!
//! Every widget is the controlled-input pattern: the parent owns the value and
//! passes it down with an [`EventHandler`] callback (`value` + `onChange` in
//! React terms); the widget renders and reports, never stores — except
//! [`OptTomlRow`], which keeps local text state so half-typed TOML isn't
//! destroyed by the round trip through the document.

use std::collections::BTreeMap;

use dioxus::prelude::*;

/// A required text field.
#[component]
pub fn TextRow(label: String, value: String, on_change: EventHandler<String>) -> Element {
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input",
                value: "{value}",
                oninput: move |e| on_change.call(e.value()),
            }
        }
    }
}

/// An optional text field — empty ⇒ `None`.
#[component]
pub fn OptTextRow(
    label: String,
    value: Option<String>,
    placeholder: Option<String>,
    on_change: EventHandler<Option<String>>,
) -> Element {
    let shown = value.unwrap_or_default();
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input",
                value: "{shown}",
                placeholder: placeholder.unwrap_or_default(),
                oninput: move |e| {
                    let v = e.value();
                    on_change.call(if v.is_empty() { None } else { Some(v) });
                },
            }
        }
    }
}

/// An optional multi-line text field — empty ⇒ `None`.
#[component]
pub fn OptTextAreaRow(
    label: String,
    value: Option<String>,
    on_change: EventHandler<Option<String>>,
) -> Element {
    let shown = value.unwrap_or_default();
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            textarea {
                class: "studio-input studio-textarea",
                value: "{shown}",
                oninput: move |e| {
                    let v = e.value();
                    on_change.call(if v.is_empty() { None } else { Some(v) });
                },
            }
        }
    }
}

/// An optional integer field — empty/unparseable ⇒ `None`.
#[component]
pub fn NumRow(label: String, value: Option<i64>, on_change: EventHandler<Option<i64>>) -> Element {
    let shown = value.map(|v| v.to_string()).unwrap_or_default();
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input studio-num",
                r#type: "number",
                value: "{shown}",
                oninput: move |e| on_change.call(e.value().trim().parse().ok()),
            }
        }
    }
}

/// A required float field (stats) — unparseable input is ignored.
#[component]
pub fn FloatRow(label: String, value: f64, on_change: EventHandler<f64>) -> Element {
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input studio-num",
                r#type: "number",
                step: "any",
                value: "{value}",
                oninput: move |e| {
                    if let Ok(v) = e.value().trim().parse() {
                        on_change.call(v);
                    }
                },
            }
        }
    }
}

/// A tri-state `Option<bool>`: absent (the TOML default) / true / false.
#[component]
pub fn TriBoolRow(
    label: String,
    value: Option<bool>,
    on_change: EventHandler<Option<bool>>,
) -> Element {
    let current = match value {
        None => "unset",
        Some(true) => "true",
        Some(false) => "false",
    };
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            // The stored choice is marked per-option (`selected`) — a `value`
            // attribute on `<select>` does not reliably apply at mount.
            select {
                class: "studio-input",
                onchange: move |e| {
                    on_change.call(match e.value().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    });
                },
                option { value: "unset", selected: current == "unset", "(unset)" }
                option { value: "true", selected: current == "true", "true" }
                option { value: "false", selected: current == "false", "false" }
            }
        }
    }
}

/// A dropdown over a fixed vocabulary, optionally with an "(unset)" arm for
/// `Option<String>` fields.
#[component]
pub fn SelectRow(
    label: String,
    value: Option<String>,
    options: Vec<String>,
    allow_unset: bool,
    on_change: EventHandler<Option<String>>,
) -> Element {
    let current = value.clone().unwrap_or_default();
    // A stored value missing from the vocabulary (a dangling reference after a
    // delete, or an imported free-form value) must stay visible as the selection —
    // otherwise the browser silently displays the first option while the model
    // still holds the dangling value.
    let dangling = value
        .clone()
        .filter(|v| !v.is_empty() && !options.contains(v));
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            // The stored choice is marked per-option (`selected`) — a `value`
            // attribute on `<select>` does not reliably apply at mount.
            select {
                class: "studio-input",
                onchange: move |e| {
                    let v = e.value();
                    on_change.call(if v.is_empty() { None } else { Some(v) });
                },
                if allow_unset {
                    option { value: "", selected: current.is_empty(), "(unset)" }
                }
                if let Some(d) = dangling {
                    option { value: "{d}", selected: true, "{d} (missing)" }
                }
                for opt in options {
                    {
                        let is_current = opt == current;
                        rsx! { option { key: "{opt}", value: "{opt}", selected: is_current, "{opt}" } }
                    }
                }
            }
        }
    }
}

/// A `Vec<String>` field edited as a comma-separated line (item keys, aliases,
/// deck lists). The hint names the valid vocabulary; dangling entries surface in
/// the problems panel rather than being blocked here.
#[component]
pub fn ListRow(
    label: String,
    values: Vec<String>,
    hint: Option<String>,
    on_change: EventHandler<Vec<String>>,
) -> Element {
    let shown = values.join(", ");
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input",
                value: "{shown}",
                placeholder: "comma-separated",
                title: hint.clone().unwrap_or_default(),
                onchange: move |e| {
                    on_change.call(
                        e.value()
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .collect(),
                    );
                },
            }
        }
    }
}

/// A `{ component = qty }` materials map edited as `iron=3, salt=2`.
#[component]
pub fn MaterialsRow(
    label: String,
    values: BTreeMap<String, i64>,
    on_change: EventHandler<BTreeMap<String, i64>>,
) -> Element {
    let shown = values
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(", ");
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input",
                value: "{shown}",
                placeholder: "component=qty, component=qty",
                onchange: move |e| {
                    let map: BTreeMap<String, i64> = e
                        .value()
                        .split(',')
                        .filter_map(|pair| {
                            let (k, v) = pair.split_once('=')?;
                            Some((k.trim().to_string(), v.trim().parse().ok()?))
                        })
                        .filter(|(k, _)| !k.is_empty())
                        .collect();
                    on_change.call(map);
                },
            }
        }
    }
}

/// An optional inert-TOML value (`initialState`, `config`, `recipe`, …) edited as
/// inline TOML (e.g. `{ unlocked = false }`). Unparseable input shows an error and
/// leaves the stored value untouched.
#[component]
pub fn OptTomlRow(
    label: String,
    value: Option<toml::Value>,
    on_change: EventHandler<Option<toml::Value>>,
) -> Element {
    let initial = value.as_ref().map(inline_toml).unwrap_or_default();
    let mut text = use_signal(|| initial.clone());
    let mut parse_err = use_signal(String::new);
    // Re-seed the local text when the underlying value changes identity (e.g. the
    // selected asset switched) — the React "sync local state when a prop changes"
    // pattern, done inline because Dioxus re-runs the whole function per render
    // just as React does.
    let mut seeded_for = use_signal(|| initial.clone());
    if seeded_for() != initial {
        seeded_for.set(initial.clone());
        text.set(initial.clone());
        parse_err.set(String::new());
    }
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            input {
                class: "studio-input studio-mono",
                value: "{text}",
                placeholder: "{{ key = value }} (leave empty to unset)",
                onchange: move |e| {
                    let raw = e.value();
                    text.set(raw.clone());
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        parse_err.set(String::new());
                        on_change.call(None);
                        return;
                    }
                    match toml::from_str::<WrapVal>(&format!("v = {trimmed}")) {
                        Ok(w) => {
                            parse_err.set(String::new());
                            on_change.call(Some(w.v));
                        }
                        Err(e) => parse_err.set(format!("not valid TOML: {e}")),
                    }
                },
            }
        }
        if !parse_err().is_empty() {
            p { class: "studio-field-err", "{parse_err}" }
        }
    }
}

/// Serde vehicle for parsing a bare TOML value as `v = <value>`.
#[derive(serde::Serialize, serde::Deserialize)]
struct WrapVal {
    v: toml::Value,
}

/// Strip the `v = ` prefix `WrapVal` printing adds (single-line values only).
fn unwrap_shown(s: &str) -> String {
    s.trim()
        .strip_prefix("v = ")
        .unwrap_or(s.trim())
        .to_string()
}

/// Render a TOML value in INLINE form (`{ unlocked = false }`, `[1, 2]`, `"x"`) —
/// the shape `OptTomlRow` parses back via `v = <text>`. `toml::to_string` cannot do
/// this: a table serializes as a `[v]` header block, which neither displays nor
/// re-parses as an inline value.
fn inline_toml(v: &toml::Value) -> String {
    match v {
        toml::Value::Table(t) => {
            if t.is_empty() {
                return "{}".to_string();
            }
            let inner = t
                .iter()
                .map(|(k, val)| format!("{} = {}", inline_key(k), inline_toml(val)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{ {inner} }}")
        }
        toml::Value::Array(a) => {
            let inner = a.iter().map(inline_toml).collect::<Vec<_>>().join(", ");
            format!("[{inner}]")
        }
        // Scalars round-trip through the `v = <scalar>` form (always single-line).
        _ => toml::to_string(&WrapVal { v: v.clone() })
            .map_or_else(|_| String::new(), |s| unwrap_shown(&s)),
    }
}

/// A table key, bare when TOML allows it, else quoted via the scalar printer.
fn inline_key(k: &str) -> String {
    if !k.is_empty()
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        k.to_string()
    } else {
        inline_toml(&toml::Value::String(k.to_string()))
    }
}

/// The master/detail list pane: one row per entry, a selected highlight, an add
/// button.
#[component]
pub fn ListPane(
    items: Vec<(u64, String)>,
    selected: Option<u64>,
    on_select: EventHandler<u64>,
    on_add: EventHandler<()>,
    add_label: String,
) -> Element {
    rsx! {
        div { class: "studio-listpane",
            button { class: "studio-btn primary wide", onclick: move |_| on_add.call(()), "+ {add_label}" }
            for (id, label) in items {
                button {
                    key: "{id}",
                    class: if selected == Some(id) { "studio-listitem selected" } else { "studio-listitem" },
                    onclick: move |_| on_select.call(id),
                    "{label}"
                }
            }
        }
    }
}

/// A two-step destructive button: first click arms, second fires. The label can
/// carry a dangling-reference count (the spec's delete confirm).
#[component]
pub fn ConfirmDelete(label: String, on_delete: EventHandler<()>) -> Element {
    let mut armed = use_signal(|| false);
    rsx! {
        if armed() {
            span { class: "studio-confirm",
                button { class: "studio-btn small danger", onclick: move |_| on_delete.call(()), "{label}" }
                button { class: "studio-btn small", onclick: move |_| armed.set(false), "Keep" }
            }
        } else {
            button { class: "studio-btn small danger", onclick: move |_| armed.set(true), "Delete…" }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{inline_toml, WrapVal};

    fn parse(s: &str) -> toml::Value {
        toml::from_str::<WrapVal>(&format!("v = {s}"))
            .expect("parses")
            .v
    }

    /// The display form must re-parse to the same value — the `OptTomlRow`
    /// contract (a table used to render as a `[v]` header block, which neither
    /// displayed nor re-parsed).
    #[test]
    fn inline_toml_round_trips_through_the_input_form() {
        for src in [
            "{ unlocked = false }",
            "{}",
            "{ rounds = 3, deep = { a = [1, 2], b = \"x\" } }",
            "[1, 2, 3]",
            "\"a 'quoted' string\"",
            "-4",
            "2.5",
            "true",
            "{ \"key with spaces\" = 1 }",
        ] {
            let v = parse(src);
            let shown = inline_toml(&v);
            assert_eq!(parse(&shown), v, "{src} → {shown} must re-parse equal");
            assert!(!shown.contains('\n'), "{shown} must be single-line");
        }
    }
}
