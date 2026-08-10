//! The behavior editors — one shared surface parameterized by family, with raw
//! DSL text fields validated on change by the real compiler (the probe-doc
//! mechanism, [`crate::gate::validate_body`]), and the collapsible DSL reference.

use std::collections::BTreeMap;

use dioxus::prelude::*;

use crate::app::StudioStore;
use crate::gate::{validate_body, BodySlot};
use crate::ui::widgets::{ConfirmDelete, OptTextRow, OptTomlRow, TextRow};
use wickedways_author::author_doc::{
    CardBehaviorEntry, DialogueEntryToml, ExitBehaviorEntry, ItemBehaviorEntry, MatchToml,
    MechanicBehaviorEntry, NpcBehaviorEntry, SceneBehaviorEntry,
};

/// A required DSL body: monospace textarea + inline compiler verdict.
#[component]
pub fn BodyField(
    label: String,
    slot: BodySlot,
    value: String,
    on_change: EventHandler<String>,
) -> Element {
    let err = validate_body(slot, &value);
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            textarea {
                class: if err.is_some() { "studio-input studio-body invalid" } else { "studio-input studio-body" },
                value: "{value}",
                spellcheck: "false",
                oninput: move |e| on_change.call(e.value()),
            }
        }
        if let Some(msg) = err.clone() {
            p { class: "studio-field-err", "{msg}" }
        }
    }
}

/// An optional DSL body — empty ⇒ `None` (the hook stays native / a no-op).
#[component]
pub fn OptBodyField(
    label: String,
    slot: BodySlot,
    value: Option<String>,
    on_change: EventHandler<Option<String>>,
) -> Element {
    let shown = value.unwrap_or_default();
    let err = if shown.trim().is_empty() {
        None
    } else {
        validate_body(slot, &shown)
    };
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "{label}" }
            textarea {
                class: if err.is_some() { "studio-input studio-body invalid" } else { "studio-input studio-body" },
                value: "{shown}",
                spellcheck: "false",
                oninput: move |e| {
                    let v = e.value();
                    on_change.call(if v.trim().is_empty() { None } else { Some(v) });
                },
            }
        }
        if let Some(msg) = err.clone() {
            p { class: "studio-field-err", "{msg}" }
        }
    }
}

/// The collapsible DSL reference — the spec's embedded vocabulary, verbatim.
#[component]
pub fn DslReference() -> Element {
    rsx! {
        details { class: "studio-dsl",
            summary { "DSL reference" }
            div { class: "studio-dsl-body",
                p { b { "Subjects: " } "actor, party, round, maxRounds, damage (modifyDamage), action/element (storyteller hooks)" }
                p { b { "Calls: " }
                    "hasKey(x,'k') · hasItem(x,'k') · hasEquipped(x,'k') · stateGet('f', default) · stateGetIn('map', key, default) · mapLit(k,v,…) · lookup(map,key) · has(map,key) · some(list,pred) · every(list,pred) · includes(list,v) · str(x) · length(x) · first(x) · defined(x) · concat(…)"
                }
                p { b { "Operators (loosest→tightest): " } "?: — || — && — == != — < <= > >= — + - — * / — unary ! - — postfix .field [i]" }
                p { b { "Statements: " }
                    "guard <expr> · when <expr> {{ … }} · set state.<f> = <expr> · set state.<map>[<key>] = <expr> · emit <effect> · pass <expr> (exit runScript only)"
                }
                p { b { "Effects: " }
                    "cue('…') · adjustStat(target, stat, delta) · giveItem(from, to, item) · setVisible(target, bool) · status(field(label, value[, emphasis]), …) · damage · heal · grantImmunity"
                }
                p { b { "modifyDamage: " } "<cond> ? final <expr> : <expr> — `final` halts the transformer chain; reads damage.amount" }
                p { b { "Strings: " } "single or double quotes. Dialogue effects are emit-only." }
            }
        }
    }
}

const FAMILIES: &[&str] = &["exit", "scene", "item", "npc", "mechanic", "card"];

#[component]
pub fn BehaviorsScreen() -> Element {
    let store = use_context::<StudioStore>();
    let mut family = use_signal(|| "exit".to_string());
    let mut selected = use_signal(|| None::<String>);
    let mut new_key = use_signal(String::new);
    let doc = (store.doc)();
    let fam = family();
    let keys: Vec<String> = match fam.as_str() {
        "exit" => doc.behaviors.exit.keys().cloned().collect(),
        "scene" => doc.behaviors.scene.keys().cloned().collect(),
        "item" => doc.behaviors.item.keys().cloned().collect(),
        "npc" => doc.behaviors.npc.keys().cloned().collect(),
        "mechanic" => doc.behaviors.mechanic.keys().cloned().collect(),
        _ => doc.behaviors.card.keys().cloned().collect(),
    };
    let sel = selected().filter(|k| keys.contains(k));
    rsx! {
        div { class: "studio-behaviors",
            div { class: "studio-tabs",
                for f in FAMILIES {
                    button {
                        key: "{f}",
                        class: if fam == *f { "studio-tab selected" } else { "studio-tab" },
                        onclick: move |_| { family.set((*f).to_string()); selected.set(None); },
                        "{f}"
                    }
                }
            }
            DslReference {}
            div { class: "studio-split",
                div { class: "studio-listpane",
                    div { class: "studio-addkey",
                        input {
                            class: "studio-input studio-mono",
                            value: "{new_key}",
                            placeholder: "new-key",
                            oninput: move |e| new_key.set(e.value()),
                        }
                        button {
                            class: "studio-btn small primary",
                            disabled: new_key().trim().is_empty(),
                            onclick: move |_| {
                                let key = new_key().trim().to_string();
                                let fam = family();
                                store.mutate(move |d| match fam.as_str() {
                                    "exit" => { d.behaviors.exit.entry(key).or_insert_with(|| ExitBehaviorEntry {
                                        can_pass: "true".into(), run_script: None, pass_message: None, fail_message: None }); }
                                    "scene" => { d.behaviors.scene.entry(key).or_insert_with(|| SceneBehaviorEntry {
                                        can_play: None, on_enter: None, on_exit: None }); }
                                    "item" => { d.behaviors.item.entry(key).or_insert_with(|| ItemBehaviorEntry {
                                        on_use: None, on_read: None }); }
                                    "npc" => { d.behaviors.npc.entry(key).or_insert_with(|| NpcBehaviorEntry {
                                        description: "…".into(),
                                        default: DialogueEntryToml {
                                            match_: MatchToml::Exact(String::new()),
                                            response: "…".into(), once: false, effects: None,
                                        },
                                        dialogue: Vec::new() }); }
                                    "mechanic" => { d.behaviors.mechanic.entry(key).or_insert_with(|| MechanicBehaviorEntry {
                                        init: None, on_round_start: None, on_round_end: None,
                                        on_turn_start: None, on_turn_end: None, on_action: None,
                                        modify_damage: None, actions: BTreeMap::new() }); }
                                    _ => { d.behaviors.card.entry(key).or_insert_with(|| CardBehaviorEntry { on_play: None }); }
                                });
                                selected.set(Some(new_key().trim().to_string()));
                                new_key.set(String::new());
                            },
                            "+"
                        }
                    }
                    for key in keys.clone() {
                        button {
                            key: "{key}",
                            class: if sel.as_deref() == Some(key.as_str()) { "studio-listitem selected" } else { "studio-listitem" },
                            onclick: {
                                let key = key.clone();
                                move |_| selected.set(Some(key.clone()))
                            },
                            "{key}"
                        }
                    }
                }
                div { class: "studio-form",
                    if let Some(key) = sel {
                        match fam.as_str() {
                            "exit" => rsx! { ExitBehaviorForm { key: "e-{key}", bkey: key.clone() } },
                            "scene" => rsx! { SceneBehaviorForm { key: "s-{key}", bkey: key.clone() } },
                            "item" => rsx! { ItemBehaviorForm { key: "i-{key}", bkey: key.clone() } },
                            "npc" => rsx! { NpcBehaviorForm { key: "n-{key}", bkey: key.clone() } },
                            "mechanic" => rsx! { MechanicBehaviorForm { key: "m-{key}", bkey: key.clone() } },
                            _ => rsx! { CardBehaviorForm { key: "c-{key}", bkey: key.clone() } },
                        }
                    } else {
                        p { class: "studio-empty", "Select a behavior key, or add one. Bodies are the DSL — validated by the real compiler as you type." }
                    }
                }
            }
        }
    }
}

#[component]
fn ExitBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.exit.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    let k3 = bkey.clone();
    let k4 = bkey.clone();
    let k5 = bkey.clone();
    rsx! {
        h2 { "[behaviors.exit.{bkey}]" }
        BodyField {
            label: "canPass (required predicate)".to_string(),
            slot: BodySlot::ExitCanPass,
            value: entry.can_pass.clone(),
            on_change: move |v: String| { let k = k1.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.exit.get_mut(&k) { b.can_pass = v; }
            }); },
        }
        OptBodyField {
            label: "runScript (narration script — `pass <expr>` is legal here)".to_string(),
            slot: BodySlot::ExitRunScript,
            value: entry.run_script.clone(),
            on_change: move |v| { let k = k2.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.exit.get_mut(&k) { b.run_script = v; }
            }); },
        }
        OptTextRow {
            label: "Pass message".to_string(),
            value: entry.pass_message.clone(),
            placeholder: None,
            on_change: move |v| { let k = k3.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.exit.get_mut(&k) { b.pass_message = v; }
            }); },
        }
        OptTextRow {
            label: "Fail message".to_string(),
            value: entry.fail_message.clone(),
            placeholder: None,
            on_change: move |v| { let k = k4.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.exit.get_mut(&k) { b.fail_message = v; }
            }); },
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k5.clone(); store.mutate(move |d| { d.behaviors.exit.remove(&k); }); },
        }
    }
}

#[component]
fn SceneBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.scene.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    let k3 = bkey.clone();
    let k4 = bkey.clone();
    rsx! {
        h2 { "[behaviors.scene.{bkey}]" }
        OptBodyField {
            label: "canPlay (predicate)".to_string(),
            slot: BodySlot::SceneCanPlay,
            value: entry.can_play.clone(),
            on_change: move |v| { let k = k1.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.scene.get_mut(&k) { b.can_play = v; }
            }); },
        }
        OptBodyField {
            label: "onEnter (statements)".to_string(),
            slot: BodySlot::SceneBody,
            value: entry.on_enter.clone(),
            on_change: move |v| { let k = k2.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.scene.get_mut(&k) { b.on_enter = v; }
            }); },
        }
        OptBodyField {
            label: "onExit (statements)".to_string(),
            slot: BodySlot::SceneBody,
            value: entry.on_exit.clone(),
            on_change: move |v| { let k = k3.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.scene.get_mut(&k) { b.on_exit = v; }
            }); },
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k4.clone(); store.mutate(move |d| { d.behaviors.scene.remove(&k); }); },
        }
    }
}

#[component]
fn ItemBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.item.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    let k3 = bkey.clone();
    rsx! {
        h2 { "[behaviors.item.{bkey}]" }
        p { class: "studio-hint", "The key must match an [[items]] key — the item and its behavior share it." }
        OptBodyField {
            label: "onUse (statements)".to_string(),
            slot: BodySlot::ItemBody,
            value: entry.on_use.clone(),
            on_change: move |v| { let k = k1.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.item.get_mut(&k) { b.on_use = v; }
            }); },
        }
        OptBodyField {
            label: "onRead (statements)".to_string(),
            slot: BodySlot::ItemBody,
            value: entry.on_read.clone(),
            on_change: move |v| { let k = k2.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.item.get_mut(&k) { b.on_read = v; }
            }); },
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k3.clone(); store.mutate(move |d| { d.behaviors.item.remove(&k); }); },
        }
    }
}

/// One dialogue entry's editor (the polymorphic `match` gets a structured sub-form).
/// `index: None` edits the required `default` entry.
#[component]
fn DialogueEditor(bkey: String, index: Option<usize>, entry: DialogueEntryToml) -> Element {
    let store = use_context::<StudioStore>();
    let is_fuzzy = matches!(entry.match_, MatchToml::Fuzzy { .. });
    let match_shown = match &entry.match_ {
        MatchToml::Exact(s) => s.clone(),
        MatchToml::Fuzzy { fuzzy } => fuzzy.join(", "),
    };
    let title = index.map_or("default (the catch-all)".to_string(), |i| {
        format!("dialogue[{i}]")
    });
    // One helper closure-shape shared by all fields: edit this entry in place.
    fn edit_dialogue(
        store: StudioStore,
        bkey: String,
        index: Option<usize>,
        f: impl FnOnce(&mut DialogueEntryToml) + 'static,
    ) {
        store.mutate(move |d| {
            if let Some(b) = d.behaviors.npc.get_mut(&bkey) {
                let entry = match index {
                    None => Some(&mut b.default),
                    Some(i) => b.dialogue.get_mut(i),
                };
                if let Some(e) = entry {
                    f(e);
                }
            }
        });
    }
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    let k3 = bkey.clone();
    let k4 = bkey.clone();
    let k5 = bkey.clone();
    rsx! {
        div { class: "studio-card",
            h4 { "{title}" }
            label { class: "studio-field",
                span { class: "studio-field-label", "Match kind" }
                select {
                    class: "studio-input",
                    onchange: move |e| {
                        let fuzzy = e.value() == "fuzzy";
                        edit_dialogue(store, k1.clone(), index, move |d| {
                            d.match_ = if fuzzy {
                                MatchToml::Fuzzy { fuzzy: Vec::new() }
                            } else {
                                MatchToml::Exact(String::new())
                            };
                        });
                    },
                    option { value: "exact", selected: !is_fuzzy, "exact prompt" }
                    option { value: "fuzzy", selected: is_fuzzy, "fuzzy tokens" }
                }
            }
            label { class: "studio-field",
                span { class: "studio-field-label",
                    if is_fuzzy { "Fuzzy tokens (comma-separated)" } else { "Exact prompt (empty = catch-all)" }
                }
                input {
                    class: "studio-input",
                    value: "{match_shown}",
                    onchange: move |e| {
                        let v = e.value();
                        edit_dialogue(store, k2.clone(), index, move |d| {
                            d.match_ = if is_fuzzy {
                                MatchToml::Fuzzy {
                                    fuzzy: v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
                                }
                            } else {
                                MatchToml::Exact(v)
                            };
                        });
                    },
                }
            }
            TextRow {
                label: "Response",
                value: entry.response.clone(),
                on_change: move |v: String| edit_dialogue(store, k3.clone(), index, move |d| d.response = v),
            }
            label { class: "studio-field studio-checkrow",
                input {
                    r#type: "checkbox",
                    checked: entry.once,
                    onchange: move |e| {
                        let v = e.checked();
                        edit_dialogue(store, k4.clone(), index, move |d| d.once = v);
                    },
                }
                span { "once (this entry fires a single time)" }
            }
            OptBodyField {
                label: "Effects (emit-only)".to_string(),
                slot: BodySlot::NpcEffects,
                value: entry.effects.clone(),
                on_change: move |v| edit_dialogue(store, k5.clone(), index, move |d| d.effects = v),
            }
            if let Some(i) = index {
                button {
                    class: "studio-btn small danger",
                    onclick: {
                        let k = bkey.clone();
                        move |_| { let k = k.clone(); store.mutate(move |d| {
                            if let Some(b) = d.behaviors.npc.get_mut(&k) {
                                if i < b.dialogue.len() { b.dialogue.remove(i); }
                            }
                        }); }
                    },
                    "Remove entry"
                }
            }
        }
    }
}

#[component]
fn NpcBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.npc.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    let k3 = bkey.clone();
    rsx! {
        h2 { "[behaviors.npc.{bkey}]" }
        TextRow {
            label: "Description (returned by examine)",
            value: entry.description.clone(),
            on_change: move |v: String| { let k = k1.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.npc.get_mut(&k) { b.description = v; }
            }); },
        }
        DialogueEditor { key: "{bkey}-default", bkey: bkey.clone(), index: None, entry: entry.default.clone() }
        h3 { "Dialogue entries (ordered — first match wins)" }
        for (i, d) in entry.dialogue.iter().cloned().enumerate() {
            DialogueEditor { key: "{bkey}-{i}", bkey: bkey.clone(), index: Some(i), entry: d }
        }
        button {
            class: "studio-btn small",
            onclick: move |_| { let k = k2.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.npc.get_mut(&k) {
                    b.dialogue.push(DialogueEntryToml {
                        match_: MatchToml::Fuzzy { fuzzy: Vec::new() },
                        response: String::new(),
                        once: false,
                        effects: None,
                    });
                }
            }); },
            "+ Dialogue entry"
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k3.clone(); store.mutate(move |d| { d.behaviors.npc.remove(&k); }); },
        }
    }
}

type HookGetter = fn(&MechanicBehaviorEntry) -> Option<String>;
const HOOKS: &[(&str, HookGetter)] = &[
    ("onRoundStart", |e| e.on_round_start.clone()),
    ("onRoundEnd", |e| e.on_round_end.clone()),
    ("onTurnStart", |e| e.on_turn_start.clone()),
    ("onTurnEnd", |e| e.on_turn_end.clone()),
    ("onAction", |e| e.on_action.clone()),
];

fn set_hook(entry: &mut MechanicBehaviorEntry, hook: &str, v: Option<String>) {
    match hook {
        "onRoundStart" => entry.on_round_start = v,
        "onRoundEnd" => entry.on_round_end = v,
        "onTurnStart" => entry.on_turn_start = v,
        "onTurnEnd" => entry.on_turn_end = v,
        _ => entry.on_action = v,
    }
}

#[component]
fn MechanicBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let mut new_action = use_signal(String::new);
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.mechanic.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k_init = bkey.clone();
    let k_md = bkey.clone();
    let k_add = bkey.clone();
    let k_del = bkey.clone();
    rsx! {
        h2 { "[behaviors.mechanic.{bkey}]" }
        OptTomlRow {
            label: "init (state seed, e.g. {{ turns = 0 }} — an omitted init lowers to {{}})".to_string(),
            value: entry.init.clone(),
            on_change: move |v| { let k = k_init.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.mechanic.get_mut(&k) { b.init = v; }
            }); },
        }
        for (hook, get) in HOOKS {
            OptBodyField {
                key: "{bkey}-{hook}",
                label: format!("{hook} (statements)"),
                slot: BodySlot::MechanicHook,
                value: get(&entry),
                on_change: {
                    let k = bkey.clone();
                    move |v| { let k = k.clone(); store.mutate(move |d| {
                        if let Some(b) = d.behaviors.mechanic.get_mut(&k) { set_hook(b, hook, v); }
                    }); }
                },
            }
        }
        OptBodyField {
            label: "modifyDamage (transform: <cond> ? final <e> : <e>)".to_string(),
            slot: BodySlot::ModifyDamage,
            value: entry.modify_damage.clone(),
            on_change: move |v| { let k = k_md.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.mechanic.get_mut(&k) { b.modify_damage = v; }
            }); },
        }
        h3 { "Custom actions (budgeted; a PC invokes via useMechanicAction)" }
        for (action, body) in entry.actions.clone() {
            div { class: "studio-card", key: "{bkey}-a-{action}",
                BodyField {
                    label: format!("actions.{action}"),
                    slot: BodySlot::MechanicAction,
                    value: body,
                    on_change: {
                        let k = bkey.clone();
                        let action = action.clone();
                        move |v: String| {
                            let (k, action) = (k.clone(), action.clone());
                            store.mutate(move |d| {
                                if let Some(b) = d.behaviors.mechanic.get_mut(&k) {
                                    b.actions.insert(action, v);
                                }
                            });
                        }
                    },
                }
                button {
                    class: "studio-btn small danger",
                    onclick: {
                        let k = bkey.clone();
                        let action = action.clone();
                        move |_| {
                            let (k, action) = (k.clone(), action.clone());
                            store.mutate(move |d| {
                                if let Some(b) = d.behaviors.mechanic.get_mut(&k) {
                                    b.actions.remove(&action);
                                }
                            });
                        }
                    },
                    "Remove action"
                }
            }
        }
        div { class: "studio-addkey",
            input {
                class: "studio-input studio-mono",
                value: "{new_action}",
                placeholder: "action-key",
                oninput: move |e| new_action.set(e.value()),
            }
            button {
                class: "studio-btn small",
                disabled: new_action().trim().is_empty(),
                onclick: move |_| {
                    let k = k_add.clone();
                    let action = new_action().trim().to_string();
                    store.mutate(move |d| {
                        if let Some(b) = d.behaviors.mechanic.get_mut(&k) {
                            b.actions.entry(action).or_insert_with(|| "emit cue('…')".to_string());
                        }
                    });
                    new_action.set(String::new());
                },
                "+ Action"
            }
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k_del.clone(); store.mutate(move |d| { d.behaviors.mechanic.remove(&k); }); },
        }
    }
}

#[component]
fn CardBehaviorForm(bkey: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let Some(entry) = doc.behaviors.card.get(&bkey).cloned() else {
        return rsx! {};
    };
    let k1 = bkey.clone();
    let k2 = bkey.clone();
    rsx! {
        h2 { "[behaviors.card.{bkey}]" }
        OptBodyField {
            label: "onPlay (statements)".to_string(),
            slot: BodySlot::CardOnPlay,
            value: entry.on_play.clone(),
            on_change: move |v| { let k = k1.clone(); store.mutate(move |d| {
                if let Some(b) = d.behaviors.card.get_mut(&k) { b.on_play = v; }
            }); },
        }
        ConfirmDelete {
            label: "Delete behavior".to_string(),
            on_delete: move |()| { let k = k2.clone(); store.mutate(move |d| { d.behaviors.card.remove(&k); }); },
        }
    }
}
