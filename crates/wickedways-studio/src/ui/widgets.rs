//! Shared form widgets — the field-row vocabulary every screen speaks.
//!
//! Conventions: an empty text input maps to `None` for `Option<String>` fields
//! (absent-means-default is the TOML idiom); tri-state selects cover `Option<bool>`
//! (an explicit `false` differs from absent in the exported TOML); enum fields are
//! dropdowns, never free text (the compiler silently defaults unknown enum strings —
//! see the spec's silent-default hazard).

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
            select {
                class: "studio-input",
                value: "{current}",
                onchange: move |e| {
                    on_change.call(match e.value().as_str() {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    });
                },
                option { value: "unset", "(unset)" }
                option { value: "true", "true" }
                option { value: "false", "false" }
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
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            select {
                class: "studio-input",
                value: "{current}",
                onchange: move |e| {
                    let v = e.value();
                    on_change.call(if v.is_empty() { None } else { Some(v) });
                },
                if allow_unset {
                    option { value: "", "(unset)" }
                }
                for opt in options {
                    option { key: "{opt}", value: "{opt}", "{opt}" }
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
    let initial = value
        .as_ref()
        .map(|v| {
            toml::to_string(&WrapVal { v: v.clone() })
                .map_or_else(|_| String::new(), |s| unwrap_shown(&s))
        })
        .unwrap_or_default();
    let mut text = use_signal(|| initial.clone());
    let mut parse_err = use_signal(String::new);
    // Re-seed the local text when the underlying value changes identity (e.g. the
    // selected asset switched).
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

/// Serde vehicle for parsing/printing a bare TOML value as `v = <value>`.
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
