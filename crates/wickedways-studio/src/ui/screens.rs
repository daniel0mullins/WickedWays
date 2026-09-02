//! The per-family CRUD screens: a master/detail list + form per asset family,
//! the room hub, and the rename-with-confirmation controls.

use std::collections::BTreeMap;

use dioxus::prelude::*;

use crate::app::StudioStore;
use crate::gate::BodySlot;
use crate::model::{
    EditorDoc, WithId, DIRECTIONS, ITEM_TYPES, SCENE_PHASES, SLOT_KINDS, STAT_TYPES,
};
use crate::refs::{count_item_refs, count_room_refs, rename_item_key, rename_room, reverse_exit};
use crate::ui::behaviors::BodyField;
use crate::ui::widgets::{
    ConfirmDelete, FloatRow, ListPane, ListRow, MaterialsRow, NumRow, OptTextAreaRow, OptTextRow,
    OptTomlRow, SelectRow, TextRow, TriBoolRow,
};
use wickedways_author::author_doc::{
    ArchetypeEntry, CacheEntry, CardEntryToml, ConditionEntry, ExitEntry, FormationEntry,
    ItemEntry, LootEntry, MechanicBehaviorEntry, MechanicEntryToml, MobEntry, NpcBehaviorEntry,
    NpcEntry, RecipeEntry, RoomEntry, SceneBehaviorEntry, SceneEntry, VillainEntry,
};
use wickedways_core::world::formation_descriptor::{MobSpec, NaturalAttack};
use wickedways_core::world::snapshot::Stats;

fn default_stats() -> Stats {
    Stats {
        energy: 1.0,
        sanity: 1.0,
        health: 1.0,
    }
}

/// Generate the per-family `edit_*` helpers: find the entry by editor id, apply the
/// mutation through the store (re-lint + write-through).
///
/// A `macro_rules!` macro writes these thirteen near-identical functions at
/// compile time — the Rust substitute for one runtime-generic version keyed by
/// field name (there is no reflection to reach `d[field]`).
macro_rules! edit_helper {
    ($name:ident, $field:ident, $ty:ty) => {
        fn $name(store: StudioStore, id: u64, f: impl FnOnce(&mut $ty) + 'static) {
            store.mutate(move |d| {
                if let Some(w) = d.$field.iter_mut().find(|w| w.id == id) {
                    f(&mut w.entry);
                }
            });
        }
    };
}
edit_helper!(edit_room, rooms, RoomEntry);
edit_helper!(edit_exit, exits, ExitEntry);
edit_helper!(edit_item, items, ItemEntry);
edit_helper!(edit_loot, loot, LootEntry);
edit_helper!(edit_cache, caches, CacheEntry);
edit_helper!(edit_recipe, recipes, RecipeEntry);
edit_helper!(edit_scene, scenes, SceneEntry);
edit_helper!(edit_npc, npcs, NpcEntry);
edit_helper!(edit_mob, mobs, MobEntry);
edit_helper!(edit_formation, formations, FormationEntry);
edit_helper!(edit_mechanic, mechanics, MechanicEntryToml);
edit_helper!(edit_card, cards, CardEntryToml);
edit_helper!(edit_archetype, archetypes, ArchetypeEntry);

fn find<T: Clone>(list: &[WithId<T>], id: Option<u64>) -> Option<WithId<T>> {
    id.and_then(|id| list.iter().find(|w| w.id == id).cloned())
}

/// Remove one entry from a family list by editor id.
fn remove_by_id<T>(list: &mut Vec<WithId<T>>, id: u64) {
    list.retain(|w| w.id != id);
}

// ── Settings ────────────────────────────────────────────────────────────────

#[component]
pub fn SettingsScreen() -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let rooms = doc.room_names();
    rsx! {
        div { class: "studio-form",
            h2 { "Campaign settings" }
            TextRow {
                label: "Title",
                value: doc.title.clone(),
                on_change: move |v: String| store.mutate(move |d| d.title = v),
            }
            SelectRow {
                label: "Start room",
                value: doc.start_room.clone(),
                options: rooms,
                allow_unset: true,
                on_change: move |v| store.mutate(move |d| d.start_room = v),
            }
            NumRow {
                label: "Max rounds (default 100)",
                value: doc.opts.max_rounds,
                on_change: move |v| store.mutate(move |d| d.opts.max_rounds = v),
            }
            NumRow {
                label: "Base encounter chance % (default 20)",
                value: doc.opts.base_encounter_chance,
                on_change: move |v| store.mutate(move |d| d.opts.base_encounter_chance = v),
            }
            OptTextAreaRow {
                label: "Timeout narration (shown at the round limit)",
                value: doc.timeout_narration.clone(),
                on_change: move |v| store.mutate(move |d| d.timeout_narration = v),
            }
        }
    }
}

// ── Rooms + the room hub ────────────────────────────────────────────────────

/// Rename a room or item key with the spec's confirmation step: type the new name,
/// see the touched-reference count, apply explicitly. Collisions are refused.
#[component]
fn RenameRoomControl(id: u64, current: String) -> Element {
    let store = use_context::<StudioStore>();
    let mut pending = use_signal(|| None::<String>);
    let doc = (store.doc)();
    let refs = count_room_refs(&doc, &current);
    let collision = pending()
        .as_deref()
        .is_some_and(|n| n != current && doc.rooms.iter().any(|r| r.entry.name == n));
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "Name" }
            input {
                class: "studio-input",
                value: pending().unwrap_or_else(|| current.clone()),
                oninput: move |e| pending.set(Some(e.value())),
            }
        }
        if let Some(new_name) = pending() {
            if new_name != current && !new_name.trim().is_empty() {
                if collision {
                    p { class: "studio-field-err", "A room named '{new_name}' already exists." }
                } else {
                    button {
                        class: "studio-btn small",
                        onclick: {
                            let current = current.clone();
                            move |_| {
                                let old = current.clone();
                                let new = new_name.clone();
                                store.mutate(move |d| {
                                    rename_room(d, &old, &new);
                                });
                                pending.set(None);
                            }
                        },
                        "Rename (updates {refs} reference(s))"
                    }
                }
            }
        }
        p { class: "studio-hint",
            "Renames rewrite every reference (exits, placements, startRoom). Behavior-body text is NOT rewritten — stale room.name comparisons and typed-call keys are flagged in the problems panel; prose mentions need a manual look."
        }
    }
}

#[component]
fn RenameItemKeyControl(id: u64, current: String) -> Element {
    let store = use_context::<StudioStore>();
    let mut pending = use_signal(|| None::<String>);
    let doc = (store.doc)();
    let refs = count_item_refs(&doc, &current);
    let collision = pending()
        .as_deref()
        .is_some_and(|n| n != current && doc.items.iter().any(|i| i.entry.key == n));
    rsx! {
        label { class: "studio-field",
            span { class: "studio-field-label", "Key" }
            input {
                class: "studio-input studio-mono",
                value: pending().unwrap_or_else(|| current.clone()),
                oninput: move |e| pending.set(Some(e.value())),
            }
        }
        if let Some(new_key) = pending() {
            if new_key != current && !new_key.trim().is_empty() {
                if collision {
                    p { class: "studio-field-err", "An item keyed '{new_key}' already exists." }
                } else {
                    button {
                        class: "studio-btn small",
                        onclick: {
                            let current = current.clone();
                            move |_| {
                                let old = current.clone();
                                let new = new_key.clone();
                                store.mutate(move |d| {
                                    rename_item_key(d, &old, &new);
                                });
                                pending.set(None);
                            }
                        },
                        "Rename key (updates {refs} reference(s), incl. its behavior)"
                    }
                }
            }
        }
    }
}

#[component]
pub fn RoomsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .rooms
        .iter()
        .map(|r| (r.id, r.entry.name.clone()))
        .collect();
    let selected = find(&doc.rooms, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("rooms", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    let name = format!("New Room {id}");
                    d.rooms.push(WithId { id, entry: RoomEntry {
                        name,
                        description: String::new(),
                        dark: None,
                        spawn_modifier: None,
                        lights: Vec::new(),
                        image: None,
                    }});
                    id
                });
                store.select("rooms", Some(id));
            },
                add_label: "Room",
            }
            if let Some(room) = selected {
                RoomForm { key: "{room.id}", id: room.id, entry: room.entry }
            } else {
                p { class: "studio-empty", "Select a room, or add one." }
            }
        }
    }
}

#[component]
fn RoomForm(id: u64, entry: RoomEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let item_keys = doc.item_keys();
    let name = entry.name.clone();
    rsx! {
        div { class: "studio-form",
            h2 { "Room: {entry.name}" }
            RenameRoomControl { id, current: entry.name.clone() }
            label { class: "studio-field",
                span { class: "studio-field-label", "Description" }
                textarea {
                    class: "studio-input studio-textarea",
                    value: "{entry.description}",
                    oninput: move |e| edit_room(store, id, move |r| r.description = e.value()),
                }
            }
            TriBoolRow {
                label: "Dark (needs light)",
                value: entry.dark,
                on_change: move |v| edit_room(store, id, move |r| r.dark = v),
            }
            NumRow {
                label: "Spawn modifier (encounter bias, ±%)",
                value: entry.spawn_modifier,
                on_change: move |v| edit_room(store, id, move |r| r.spawn_modifier = v),
            }
            ListRow {
                label: "Lights (item keys that light this room)",
                values: entry.lights.clone(),
                hint: format!("known items: {}", item_keys.join(", ")),
                on_change: move |v| edit_room(store, id, move |r| r.lights = v),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_room(store, id, move |r| r.image = v),
            }
            ConfirmDelete {
                label: format!("Delete room ({} refs will dangle)", count_room_refs(&doc, &entry.name)),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.rooms, id));
                    store.select("rooms", None);
                },
            }
            RoomHub { room: name }
        }
    }
}

/// The room hub — everything attached to this room, with jump links and
/// "add here" shortcuts. Formations are deliberately absent: they are a global
/// encounter table (see the Formations screen); only this room's spawn bias lives
/// here.
#[component]
fn RoomHub(room: String) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let exits_out: Vec<(u64, String)> = doc
        .exits
        .iter()
        .filter(|e| e.entry.from == room)
        .map(|e| {
            (
                e.id,
                format!("{} → {} ({})", e.entry.from, e.entry.to, e.entry.direction),
            )
        })
        .collect();
    let exits_in: Vec<(u64, String)> = doc
        .exits
        .iter()
        .filter(|e| e.entry.to == room)
        .map(|e| {
            (
                e.id,
                format!("{} → {} ({})", e.entry.from, e.entry.to, e.entry.direction),
            )
        })
        .collect();
    let loot: Vec<(u64, String)> = doc
        .loot
        .iter()
        .filter(|l| l.entry.room == room)
        .map(|l| (l.id, l.entry.name.clone()))
        .collect();
    let caches: Vec<(u64, String)> = doc
        .caches
        .iter()
        .filter(|c| c.entry.room == room)
        .map(|c| (c.id, c.entry.name.clone()))
        .collect();
    let mobs: Vec<(u64, String)> = doc
        .mobs
        .iter()
        .filter(|m| m.entry.room.as_deref() == Some(room.as_str()))
        .map(|m| (m.id, m.entry.name.clone()))
        .collect();
    let npcs: Vec<(u64, String)> = doc
        .npcs
        .iter()
        .filter(|n| n.entry.room.as_deref() == Some(room.as_str()))
        .map(|n| (n.id, n.entry.name.clone()))
        .collect();
    let scenes: Vec<(u64, String)> = doc
        .scenes
        .iter()
        .filter(|s| s.entry.room == room)
        .map(|s| (s.id, s.entry.key.clone()))
        .collect();
    type HubRow = (&'static str, &'static str, Vec<(u64, String)>);
    let hub_rows: Vec<HubRow> = vec![
        ("Exits out", "exits", exits_out),
        ("Exits in", "exits", exits_in),
        ("Loot", "loot", loot),
        ("Caches", "caches", caches),
        ("Mobs", "mobs", mobs),
        ("NPCs", "npcs", npcs),
        ("Scenes", "scenes", scenes),
    ];
    let room_add_exit = room.clone();
    let room_add_loot = room.clone();
    let room_add_mob = room.clone();
    rsx! {
        div { class: "studio-hub",
            h3 { "In this room" }
            for (label, section, entries) in hub_rows {
                div { class: "studio-hub-row",
                    span { class: "studio-hub-label", "{label}:" }
                    if entries.is_empty() {
                        span { class: "studio-hub-none", "—" }
                    }
                    for (id, name) in entries {
                        button {
                            key: "{id}",
                            class: "studio-chip",
                            onclick: move |_| store.select(section, Some(id)),
                            "{name}"
                        }
                    }
                }
            }
            div { class: "studio-hub-adds",
                button { class: "studio-btn small", onclick: move |_| {
                    let room = room_add_exit.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        d.exits.push(WithId { id, entry: ExitEntry {
                            from: room, to: String::new(), direction: "north".into(),
                            behavior: None, name: None, initial_state: None, one_way: None,
                        }});
                        id
                    });
                    store.select("exits", Some(id));
                }, "+ Exit from here" }
                button { class: "studio-btn small", onclick: move |_| {
                    let room = room_add_loot.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        d.loot.push(WithId { id, entry: LootEntry {
                            name: format!("container-{id}"), room, items: Vec::new(), description: None, image: None,
                        }});
                        id
                    });
                    store.select("loot", Some(id));
                }, "+ Loot here" }
                button { class: "studio-btn small", onclick: move |_| {
                    let room = room_add_mob.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        d.mobs.push(WithId { id, entry: MobEntry {
                            name: format!("New Mob {id}"), stats: default_stats(), room: Some(room),
                            drops: Vec::new(), natural_attack: None, inventory_slots: None,
                            actions_per_round: None, base_escape_chance: None,
                            material_drops: None, light_averse: None, image: None,
                        }});
                        id
                    });
                    store.select("mobs", Some(id));
                }, "+ Mob here" }
            }
        }
    }
}

// ── Exits ───────────────────────────────────────────────────────────────────

#[component]
pub fn ExitsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .exits
        .iter()
        .map(|e| {
            (
                e.id,
                format!("{} → {} ({})", e.entry.from, e.entry.to, e.entry.direction),
            )
        })
        .collect();
    let selected = find(&doc.exits, asset);
    let first_room = doc.room_names().first().cloned().unwrap_or_default();
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("exits", Some(id)),
                on_add: move |()| {
                    let from = first_room.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        let to = from.clone();
                        d.exits.push(WithId { id, entry: ExitEntry {
                            from, to, direction: "north".into(),
                            behavior: None, name: None, initial_state: None, one_way: None,
                        }});
                        id
                    });
                    store.select("exits", Some(id));
                },
                add_label: "Exit",
            }
            if let Some(exit) = selected {
                ExitForm { key: "{exit.id}", id: exit.id, entry: exit.entry }
            } else {
                p { class: "studio-empty",
                    "Select an exit, or add one. Exits are directional edges — a two-way passage is two exits (use the return-exit button)."
                }
            }
        }
    }
}

#[component]
fn ExitForm(id: u64, entry: ExitEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let rooms = doc.room_names();
    let behavior_keys: Vec<String> = doc.behaviors.exit.keys().cloned().collect();
    let has_return = doc
        .exits
        .iter()
        .any(|o| o.entry.from == entry.to && o.entry.to == entry.from);
    let reverse = reverse_exit(&entry);
    rsx! {
        div { class: "studio-form",
            h2 { "Exit: {entry.from} → {entry.to}" }
            SelectRow {
                label: "From room",
                value: Some(entry.from.clone()),
                options: rooms.clone(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_exit(store, id, move |e| e.from = v.unwrap_or_default()),
            }
            SelectRow {
                label: "To room",
                value: Some(entry.to.clone()),
                options: rooms,
                allow_unset: false,
                on_change: move |v: Option<String>| edit_exit(store, id, move |e| e.to = v.unwrap_or_default()),
            }
            SelectRow {
                label: "Direction",
                value: Some(entry.direction.clone()),
                options: DIRECTIONS.iter().map(|s| (*s).to_string()).collect(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_exit(store, id, move |e| e.direction = v.unwrap_or_default()),
            }
            OptTextRow {
                label: "Display name (e.g. \"cellar door\")",
                value: entry.name.clone(),
                placeholder: None,
                on_change: move |v| edit_exit(store, id, move |e| e.name = v),
            }
            SelectRow {
                label: "Behavior key (a [behaviors.exit] entry)",
                value: entry.behavior.clone(),
                options: behavior_keys,
                allow_unset: true,
                on_change: move |v| edit_exit(store, id, move |e| e.behavior = v),
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit exit behaviors →"
            }
            OptTomlRow {
                label: "Initial state (e.g. {{ unlocked = false }})",
                value: entry.initial_state.clone(),
                on_change: move |v| edit_exit(store, id, move |e| e.initial_state = v),
            }
            TriBoolRow {
                label: "One-way (suppresses the missing-return lint)",
                value: entry.one_way,
                on_change: move |v| edit_exit(store, id, move |e| e.one_way = v),
            }
            if !has_return {
                if let Some(rev) = reverse {
                    button {
                        class: "studio-btn",
                        onclick: move |_| {
                            let rev = rev.clone();
                            store.mutate(move |d| {
                                let id = d.mint();
                                d.exits.push(WithId { id, entry: rev });
                            });
                        },
                        "Create return exit ({entry.to} → {entry.from})"
                    }
                }
            }
            ConfirmDelete {
                label: "Delete exit".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.exits, id));
                    store.select("exits", None);
                },
            }
        }
    }
}

// ── Items ───────────────────────────────────────────────────────────────────

#[component]
pub fn ItemsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .items
        .iter()
        .map(|i| (i.id, format!("{} ({})", i.entry.name, i.entry.key)))
        .collect();
    let selected = find(&doc.items, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("items", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.items.push(WithId { id, entry: ItemEntry {
                        key: format!("item-{id}"), name: format!("New Item {id}"),
                        key_code: None, type_: None, stat: None, modifier: None,
                        usable: None, destroyable: None, recipe: None, equippable: None,
                        droppable: None, slot: None, two_handed: None, emits_light: None,
                        max_durability: None, lore: None, aliases: Vec::new(), image: None,
                    }});
                    id
                });
                store.select("items", Some(id));
            },
                add_label: "Item",
            }
            if let Some(item) = selected {
                ItemForm { key: "{item.id}", id: item.id, entry: item.entry }
            } else {
                p { class: "studio-empty", "Select an item, or add one." }
            }
        }
    }
}

#[component]
fn ItemForm(id: u64, entry: ItemEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let ty = entry.type_.clone().unwrap_or_default();
    rsx! {
        div { class: "studio-form",
            h2 { "Item: {entry.name}" }
            RenameItemKeyControl { id, current: entry.key.clone() }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_item(store, id, move |i| i.name = v),
            }
            SelectRow {
                label: "Type",
                value: entry.type_.clone(),
                options: ITEM_TYPES.iter().map(|s| (*s).to_string()).collect(),
                allow_unset: true,
                on_change: move |v| edit_item(store, id, move |i| i.type_ = v),
            }
            if ty == "key" || entry.key_code.is_some() {
                OptTextRow {
                    label: "Key code (what locks this key opens)",
                    value: entry.key_code.clone(),
                    placeholder: Some("e.g. cellar".into()),
                    on_change: move |v| edit_item(store, id, move |i| i.key_code = v),
                }
            }
            if ty == "consumable" || ty == "weapon" || ty == "armor" || ty == "throwable" || ty == "accessory" {
                SelectRow {
                    label: "Stat",
                    value: entry.stat.clone(),
                    options: STAT_TYPES.iter().map(|s| (*s).to_string()).collect(),
                    allow_unset: true,
                    on_change: move |v| edit_item(store, id, move |i| i.stat = v),
                }
                NumRow {
                    label: "Modifier",
                    value: entry.modifier,
                    on_change: move |v| edit_item(store, id, move |i| i.modifier = v),
                }
            }
            if ty == "consumable" {
                TriBoolRow {
                    label: "Usable",
                    value: entry.usable,
                    on_change: move |v| edit_item(store, id, move |i| i.usable = v),
                }
                TriBoolRow {
                    label: "Destroyable (consumed on use)",
                    value: entry.destroyable,
                    on_change: move |v| edit_item(store, id, move |i| i.destroyable = v),
                }
                OptTomlRow {
                    label: "Recipe (inert crafting map, e.g. {{ healing = 1 }})",
                    value: entry.recipe.clone(),
                    on_change: move |v| edit_item(store, id, move |i| i.recipe = v),
                }
            }
            h3 { "Equipment" }
            TriBoolRow {
                label: "Equippable",
                value: entry.equippable,
                on_change: move |v| edit_item(store, id, move |i| i.equippable = v),
            }
            SelectRow {
                label: "Slot",
                value: entry.slot.clone(),
                options: SLOT_KINDS.iter().map(|s| (*s).to_string()).collect(),
                allow_unset: true,
                on_change: move |v| edit_item(store, id, move |i| i.slot = v),
            }
            TriBoolRow {
                label: "Two-handed",
                value: entry.two_handed,
                on_change: move |v| edit_item(store, id, move |i| i.two_handed = v),
            }
            TriBoolRow {
                label: "Emits light",
                value: entry.emits_light,
                on_change: move |v| edit_item(store, id, move |i| i.emits_light = v),
            }
            NumRow {
                label: "Max durability",
                value: entry.max_durability,
                on_change: move |v| edit_item(store, id, move |i| i.max_durability = v),
            }
            TriBoolRow {
                label: "Droppable",
                value: entry.droppable,
                on_change: move |v| edit_item(store, id, move |i| i.droppable = v),
            }
            OptTextAreaRow {
                label: "Lore (read text)",
                value: entry.lore.clone(),
                on_change: move |v| edit_item(store, id, move |i| i.lore = v),
            }
            ListRow {
                label: "Aliases",
                values: entry.aliases.clone(),
                hint: Some("names the play surface also resolves this item by".into()),
                on_change: move |v| edit_item(store, id, move |i| i.aliases = v),
            }
            p { class: "studio-hint",
                "An item's behavior (onUse/onRead) lives under [behaviors.item] with THIS key — a missing behavior is legal (plain items)."
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit item behaviors →"
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_item(store, id, move |i| i.image = v),
            }
            ConfirmDelete {
                label: format!("Delete item ({} refs will dangle)", count_item_refs(&doc, &entry.key)),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.items, id));
                    store.select("items", None);
                },
            }
        }
    }
}

// ── Loot / Caches / Recipes ─────────────────────────────────────────────────

#[component]
pub fn LootScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .loot
        .iter()
        .map(|l| (l.id, format!("{} — {}", l.entry.name, l.entry.room)))
        .collect();
    let selected = find(&doc.loot, asset);
    let first_room = doc.room_names().first().cloned().unwrap_or_default();
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("loot", Some(id)),
                on_add: move |()| {
                    let room = first_room.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        d.loot.push(WithId { id, entry: LootEntry {
                            name: format!("container-{id}"), room, items: Vec::new(), description: None, image: None,
                        }});
                        id
                    });
                    store.select("loot", Some(id));
                },
                add_label: "Loot container",
            }
            if let Some(l) = selected {
                LootForm { key: "{l.id}", id: l.id, entry: l.entry }
            } else {
                p { class: "studio-empty", "A loot container is a named stash of items placed in a room." }
            }
        }
    }
}

#[component]
fn LootForm(id: u64, entry: LootEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    rsx! {
        div { class: "studio-form",
            h2 { "Loot: {entry.name}" }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_loot(store, id, move |l| l.name = v),
            }
            SelectRow {
                label: "Room",
                value: Some(entry.room.clone()),
                options: doc.room_names(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_loot(store, id, move |l| l.room = v.unwrap_or_default()),
            }
            ListRow {
                label: "Items (keys)",
                values: entry.items.clone(),
                hint: format!("known items: {}", doc.item_keys().join(", ")),
                on_change: move |v| edit_loot(store, id, move |l| l.items = v),
            }
            OptTextRow {
                label: "Description",
                value: entry.description.clone(),
                placeholder: None,
                on_change: move |v| edit_loot(store, id, move |l| l.description = v),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_loot(store, id, move |l| l.image = v),
            }
            ConfirmDelete {
                label: "Delete loot container".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.loot, id));
                    store.select("loot", None);
                },
            }
        }
    }
}

#[component]
pub fn CachesScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .caches
        .iter()
        .map(|c| (c.id, format!("{} — {}", c.entry.name, c.entry.room)))
        .collect();
    let selected = find(&doc.caches, asset);
    let first_room = doc.room_names().first().cloned().unwrap_or_default();
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("caches", Some(id)),
                on_add: move |()| {
                    let room = first_room.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        d.caches.push(WithId { id, entry: CacheEntry {
                            name: format!("cache-{id}"), room, materials: BTreeMap::new(),
                        }});
                        id
                    });
                    store.select("caches", Some(id));
                },
                add_label: "Material cache",
            }
            if let Some(c) = selected {
                CacheForm { key: "{c.id}", id: c.id, entry: c.entry }
            } else {
                p { class: "studio-empty", "A cache is a single-use pile of crafting materials in a room. Component names are free-form by design." }
            }
        }
    }
}

#[component]
fn CacheForm(id: u64, entry: CacheEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    rsx! {
        div { class: "studio-form",
            h2 { "Cache: {entry.name}" }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_cache(store, id, move |c| c.name = v),
            }
            SelectRow {
                label: "Room",
                value: Some(entry.room.clone()),
                options: doc.room_names(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_cache(store, id, move |c| c.room = v.unwrap_or_default()),
            }
            MaterialsRow {
                label: "Materials",
                values: entry.materials.clone(),
                on_change: move |v| edit_cache(store, id, move |c| c.materials = v),
            }
            ConfirmDelete {
                label: "Delete cache".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.caches, id));
                    store.select("caches", None);
                },
            }
        }
    }
}

#[component]
pub fn RecipesScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .recipes
        .iter()
        .map(|r| (r.id, r.entry.id.clone()))
        .collect();
    let selected = find(&doc.recipes, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("recipes", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.recipes.push(WithId { id, entry: RecipeEntry {
                        id: format!("recipe-{id}"), output_name: String::new(),
                        output_item: String::new(), materials: BTreeMap::new(),
                    }});
                    id
                });
                store.select("recipes", Some(id));
            },
                add_label: "Recipe",
            }
            if let Some(r) = selected {
                RecipeForm { key: "{r.id}", id: r.id, entry: r.entry }
            } else {
                p { class: "studio-empty", "A recipe the party knows from the start." }
            }
        }
    }
}

#[component]
fn RecipeForm(id: u64, entry: RecipeEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    rsx! {
        div { class: "studio-form",
            h2 { "Recipe: {entry.id}" }
            TextRow {
                label: "Recipe id",
                value: entry.id.clone(),
                on_change: move |v: String| edit_recipe(store, id, move |r| r.id = v),
            }
            TextRow {
                label: "Output name",
                value: entry.output_name.clone(),
                on_change: move |v: String| edit_recipe(store, id, move |r| r.output_name = v),
            }
            SelectRow {
                label: "Output item (key)",
                value: (!entry.output_item.is_empty()).then(|| entry.output_item.clone()),
                options: doc.item_keys(),
                allow_unset: true,
                on_change: move |v: Option<String>| edit_recipe(store, id, move |r| r.output_item = v.unwrap_or_default()),
            }
            MaterialsRow {
                label: "Materials cost",
                values: entry.materials.clone(),
                on_change: move |v| edit_recipe(store, id, move |r| r.materials = v),
            }
            ConfirmDelete {
                label: "Delete recipe".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.recipes, id));
                    store.select("recipes", None);
                },
            }
        }
    }
}

// ── Mobs / NPCs / Archetypes ────────────────────────────────────────────────

#[component]
fn StatsFields(stats: Stats, on_change: EventHandler<Stats>) -> Element {
    let s1 = stats.clone();
    let s2 = stats.clone();
    let s3 = stats.clone();
    rsx! {
        div { class: "studio-statsrow",
            FloatRow {
                label: "Health",
                value: stats.health,
                on_change: move |v| { let mut s = s1.clone(); s.health = v; on_change.call(s); },
            }
            FloatRow {
                label: "Sanity",
                value: stats.sanity,
                on_change: move |v| { let mut s = s2.clone(); s.sanity = v; on_change.call(s); },
            }
            FloatRow {
                label: "Energy",
                value: stats.energy,
                on_change: move |v| { let mut s = s3.clone(); s.energy = v; on_change.call(s); },
            }
        }
    }
}

#[component]
pub fn MobsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .mobs
        .iter()
        .map(|m| {
            let place = m.entry.room.clone().unwrap_or_else(|| "unplaced".into());
            (m.id, format!("{} — {place}", m.entry.name))
        })
        .collect();
    let selected = find(&doc.mobs, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("mobs", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.mobs.push(WithId { id, entry: MobEntry {
                        name: format!("New Mob {id}"), stats: default_stats(), room: None,
                        drops: Vec::new(), natural_attack: None, inventory_slots: None,
                        actions_per_round: None, base_escape_chance: None,
                        material_drops: None, light_averse: None, image: None,
                    }});
                    id
                });
                store.select("mobs", Some(id));
            },
                add_label: "Mob",
            }
            if let Some(m) = selected {
                MobForm { key: "{m.id}", id: m.id, entry: m.entry }
            } else {
                p { class: "studio-empty", "A placed enemy. A mob with no room is declared but unplaced." }
            }
        }
    }
}

#[component]
fn MobForm(id: u64, entry: MobEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    rsx! {
        div { class: "studio-form",
            h2 { "Mob: {entry.name}" }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_mob(store, id, move |m| m.name = v),
            }
            StatsFields {
                stats: entry.stats.clone(),
                on_change: move |s| edit_mob(store, id, move |m| m.stats = s),
            }
            SelectRow {
                label: "Room",
                value: entry.room.clone(),
                options: doc.room_names(),
                allow_unset: true,
                on_change: move |v| edit_mob(store, id, move |m| m.room = v),
            }
            ListRow {
                label: "Drops (item keys, on defeat)",
                values: entry.drops.clone(),
                hint: format!("known items: {}", doc.item_keys().join(", ")),
                on_change: move |v| edit_mob(store, id, move |m| m.drops = v),
            }
            OptTomlRow {
                label: "Natural attack (e.g. {{ stat = \"health\", power = 2 }})",
                value: entry.natural_attack.clone(),
                on_change: move |v| edit_mob(store, id, move |m| m.natural_attack = v),
            }
            NumRow {
                label: "Actions per round",
                value: entry.actions_per_round,
                on_change: move |v| edit_mob(store, id, move |m| m.actions_per_round = v),
            }
            NumRow {
                label: "Base escape chance %",
                value: entry.base_escape_chance,
                on_change: move |v| edit_mob(store, id, move |m| m.base_escape_chance = v),
            }
            NumRow {
                label: "Inventory slots",
                value: entry.inventory_slots,
                on_change: move |v| edit_mob(store, id, move |m| m.inventory_slots = v),
            }
            TriBoolRow {
                label: "Light-averse",
                value: entry.light_averse,
                on_change: move |v| edit_mob(store, id, move |m| m.light_averse = v),
            }
            OptTomlRow {
                label: "Material drops (e.g. {{ bone = 1 }})",
                value: entry.material_drops.clone(),
                on_change: move |v| edit_mob(store, id, move |m| m.material_drops = v),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_mob(store, id, move |m| m.image = v),
            }
            ConfirmDelete {
                label: "Delete mob".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.mobs, id));
                    store.select("mobs", None);
                },
            }
        }
    }
}

#[component]
pub fn NpcsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .npcs
        .iter()
        .map(|n| (n.id, n.entry.name.clone()))
        .collect();
    let selected = find(&doc.npcs, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("npcs", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    let behavior = format!("npc-{id}");
                    // Creating an NPC also seeds its behavior body — the shared-key
                    // link means an NPC without one never validates.
                    d.behaviors.npc.entry(behavior.clone()).or_insert_with(|| NpcBehaviorEntry {
                        description: "…".into(),
                        default: wickedways_author::author_doc::DialogueEntryToml {
                            match_: wickedways_author::author_doc::MatchToml::Exact(String::new()),
                            response: "…".into(),
                            once: false,
                            effects: None,
                        },
                        dialogue: Vec::new(),
                    });
                    d.npcs.push(WithId { id, entry: NpcEntry {
                        name: format!("New NPC {id}"), stats: default_stats(),
                        room: None, behavior, holds: Vec::new(), image: None,
                    }});
                    id
                });
                store.select("npcs", Some(id));
            },
                add_label: "NPC",
            }
            if let Some(n) = selected {
                NpcForm { key: "{n.id}", id: n.id, entry: n.entry }
            } else {
                p { class: "studio-empty", "A placed character with a dialogue behavior." }
            }
        }
    }
}

#[component]
fn NpcForm(id: u64, entry: NpcEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let behavior_keys: Vec<String> = doc.behaviors.npc.keys().cloned().collect();
    rsx! {
        div { class: "studio-form",
            h2 { "NPC: {entry.name}" }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_npc(store, id, move |n| n.name = v),
            }
            StatsFields {
                stats: entry.stats.clone(),
                on_change: move |s| edit_npc(store, id, move |n| n.stats = s),
            }
            SelectRow {
                label: "Room",
                value: entry.room.clone(),
                options: doc.room_names(),
                allow_unset: true,
                on_change: move |v| edit_npc(store, id, move |n| n.room = v),
            }
            SelectRow {
                label: "Behavior key (a [behaviors.npc] dialogue body)",
                value: Some(entry.behavior.clone()),
                options: behavior_keys,
                allow_unset: false,
                on_change: move |v: Option<String>| edit_npc(store, id, move |n| n.behavior = v.unwrap_or_default()),
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit npc behaviors →"
            }
            ListRow {
                label: "Holds (item keys)",
                values: entry.holds.clone(),
                hint: format!("known items: {}", doc.item_keys().join(", ")),
                on_change: move |v| edit_npc(store, id, move |n| n.holds = v),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_npc(store, id, move |n| n.image = v),
            }
            ConfirmDelete {
                label: "Delete NPC".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.npcs, id));
                    store.select("npcs", None);
                },
            }
        }
    }
}

#[component]
pub fn ArchetypesScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .archetypes
        .iter()
        .map(|a| (a.id, format!("{} ({})", a.entry.name, a.entry.id)))
        .collect();
    let selected = find(&doc.archetypes, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("archetypes", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.archetypes.push(WithId { id, entry: ArchetypeEntry {
                        id: format!("archetype-{id}"), name: format!("New Archetype {id}"),
                        base_stats: None, inventory_slots: None, immunities: Vec::new(), image: None,
                    }});
                    id
                });
                store.select("archetypes", Some(id));
            },
                add_label: "Archetype",
            }
            if let Some(a) = selected {
                ArchetypeForm { key: "{a.id}", id: a.id, entry: a.entry }
            } else {
                p { class: "studio-empty", "A player-character template. The id is referenced only at seating time (free-form by design)." }
            }
        }
    }
}

#[component]
fn ArchetypeForm(id: u64, entry: ArchetypeEntry) -> Element {
    let store = use_context::<StudioStore>();
    let base = entry.base_stats.clone().unwrap_or_default();
    let shown = base
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(", ");
    rsx! {
        div { class: "studio-form",
            h2 { "Archetype: {entry.name}" }
            TextRow {
                label: "Id (seating-time reference)",
                value: entry.id.clone(),
                on_change: move |v: String| edit_archetype(store, id, move |a| a.id = v),
            }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_archetype(store, id, move |a| a.name = v),
            }
            label { class: "studio-field",
                span { class: "studio-field-label", "Base stats (stat=value, e.g. health=12, sanity=8)" }
                input {
                    class: "studio-input",
                    value: "{shown}",
                    onchange: move |e| {
                        let map: BTreeMap<String, f64> = e.value()
                            .split(',')
                            .filter_map(|pair| {
                                let (k, v) = pair.split_once('=')?;
                                Some((k.trim().to_string(), v.trim().parse().ok()?))
                            })
                            .filter(|(k, _)| !k.is_empty())
                            .collect();
                        edit_archetype(store, id, move |a| {
                            a.base_stats = (!map.is_empty()).then_some(map);
                        });
                    },
                }
            }
            NumRow {
                label: "Inventory slots",
                value: entry.inventory_slots,
                on_change: move |v| edit_archetype(store, id, move |a| a.inventory_slots = v),
            }
            ListRow {
                label: "Immunities (status keys)",
                values: entry.immunities.clone(),
                hint: None,
                on_change: move |v| edit_archetype(store, id, move |a| a.immunities = v),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_archetype(store, id, move |a| a.image = v),
            }
            ConfirmDelete {
                label: "Delete archetype".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.archetypes, id));
                    store.select("archetypes", None);
                },
            }
        }
    }
}

// ── Formations (the global encounter table) ─────────────────────────────────

#[component]
pub fn FormationsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .formations
        .iter()
        .map(|f| {
            let w = f
                .entry
                .weight
                .map_or_else(String::new, |w| format!(" (weight {w})"));
            (f.id, format!("{}{w}", f.entry.key))
        })
        .collect();
    let selected = find(&doc.formations, asset);
    let base = doc.opts.base_encounter_chance.unwrap_or(20);
    let biased: Vec<(String, i64)> = doc
        .rooms
        .iter()
        .filter_map(|r| r.entry.spawn_modifier.map(|m| (r.entry.name.clone(), m)))
        .collect();
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("formations", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.formations.push(WithId { id, entry: FormationEntry {
                        key: format!("formation-{id}"), weight: None, mobs: Vec::new(),
                    }});
                    id
                });
                store.select("formations", Some(id));
            },
                add_label: "Formation",
            }
            div { class: "studio-form",
                p { class: "studio-hint",
                    "Formations are a GLOBAL weighted encounter table — they do not attach to rooms. Room-level bias is each room's spawnModifier against the campaign's baseEncounterChance ({base}%)."
                }
                if !biased.is_empty() {
                    div { class: "studio-bias",
                        h3 { "Room encounter bias (read-only — edit on the room)" }
                        for (room, modifier) in biased {
                            p { key: "{room}", class: "studio-bias-row", "{room}: {base}% + {modifier}" }
                        }
                    }
                }
                if let Some(f) = selected {
                    FormationForm { key: "{f.id}", id: f.id, entry: f.entry }
                } else {
                    p { class: "studio-empty", "Select a formation, or add one." }
                }
            }
        }
    }
}

#[component]
fn FormationForm(id: u64, entry: FormationEntry) -> Element {
    let store = use_context::<StudioStore>();
    rsx! {
        h2 { "Formation: {entry.key}" }
        TextRow {
            label: "Key",
            value: entry.key.clone(),
            on_change: move |v: String| edit_formation(store, id, move |f| f.key = v),
        }
        NumRow {
            label: "Weight (encounter-table share)",
            value: entry.weight,
            on_change: move |v| edit_formation(store, id, move |f| f.weight = v),
        }
        h3 { "Mob roster" }
        p { class: "studio-hint",
            "Roster mobs are stricter than [[mobs]]: natural attack, escape chance, and actions per round are required."
        }
        for (i, spec) in entry.mobs.iter().cloned().enumerate() {
            MobSpecCard { key: "{id}-{i}", formation: id, index: i, spec }
        }
        button {
            class: "studio-btn small",
            onclick: move |_| edit_formation(store, id, move |f| {
                f.mobs.push(MobSpec {
                    image: None,
                    name: "Mob".into(),
                    stats: default_stats(),
                    natural_attack: NaturalAttack {
                        stat: wickedways_core::StatType::Health,
                        power: 1.0,
                    },
                    drops: Vec::new(),
                    base_escape_chance: 50,
                    light_averse: false,
                    material_drops: serde_json::json!({}),
                    actions_per_round: 1,
                });
            }),
            "+ Roster mob"
        }
        ConfirmDelete {
            label: "Delete formation".to_string(),
            on_delete: move |()| {
                store.mutate(move |d| remove_by_id(&mut d.formations, id));
                store.select("formations", None);
            },
        }
    }
}

#[component]
fn MobSpecCard(formation: u64, index: usize, spec: MobSpec) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let stat_shown = serde_json::to_value(spec.natural_attack.stat)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "health".into());
    rsx! {
        div { class: "studio-card",
            TextRow {
                label: "Name",
                value: spec.name.clone(),
                on_change: move |v: String| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.name = v; }
                }),
            }
            StatsFields {
                stats: spec.stats.clone(),
                on_change: move |s| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.stats = s; }
                }),
            }
            SelectRow {
                label: "Attack stat",
                value: Some(stat_shown),
                options: STAT_TYPES.iter().map(|s| (*s).to_string()).collect(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_formation(store, formation, move |f| {
                    if let (Some(m), Some(v)) = (f.mobs.get_mut(index), v) {
                        if let Ok(stat) = serde_json::from_value(serde_json::Value::String(v)) {
                            m.natural_attack.stat = stat;
                        }
                    }
                }),
            }
            FloatRow {
                label: "Attack power",
                value: spec.natural_attack.power,
                on_change: move |v| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.natural_attack.power = v; }
                }),
            }
            NumRow {
                label: "Base escape chance % (required)",
                value: Some(spec.base_escape_chance),
                on_change: move |v| edit_formation(store, formation, move |f| {
                    if let (Some(m), Some(v)) = (f.mobs.get_mut(index), v) { m.base_escape_chance = v; }
                }),
            }
            NumRow {
                label: "Actions per round (required)",
                value: Some(spec.actions_per_round),
                on_change: move |v| edit_formation(store, formation, move |f| {
                    if let (Some(m), Some(v)) = (f.mobs.get_mut(index), v) { m.actions_per_round = v; }
                }),
            }
            ListRow {
                label: "Drops (item keys)",
                values: spec.drops.clone(),
                hint: format!("known items: {}", doc.item_keys().join(", ")),
                on_change: move |v| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.drops = v; }
                }),
            }
            TriBoolRow {
                label: "Light-averse",
                value: Some(spec.light_averse),
                on_change: move |v: Option<bool>| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.light_averse = v.unwrap_or(false); }
                }),
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: spec.image.clone(),
                placeholder: Some("e.g. solomons-rest/cemetery-rat.png".to_string()),
                on_change: move |v: Option<String>| edit_formation(store, formation, move |f| {
                    if let Some(m) = f.mobs.get_mut(index) { m.image = v; }
                }),
            }
            button {
                class: "studio-btn small danger",
                onclick: move |_| edit_formation(store, formation, move |f| {
                    if index < f.mobs.len() { f.mobs.remove(index); }
                }),
                "Remove roster mob"
            }
        }
    }
}

// ── Scenes / Mechanics / Cards ──────────────────────────────────────────────

#[component]
pub fn ScenesScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .scenes
        .iter()
        .map(|s| (s.id, format!("{} — {}", s.entry.key, s.entry.room)))
        .collect();
    let selected = find(&doc.scenes, asset);
    let first_room = doc.room_names().first().cloned().unwrap_or_default();
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("scenes", Some(id)),
                on_add: move |()| {
                    let room = first_room.clone();
                    let id = store.mutate(move |d| {
                        let id = d.mint();
                        let key = format!("scene-{id}");
                        // The shared-key link: a placement without a body never
                        // validates, so seed an empty behavior alongside.
                        d.behaviors.scene.entry(key.clone()).or_insert_with(|| SceneBehaviorEntry {
                            can_play: None,
                            on_enter: None,
                            on_exit: None,
                        });
                        d.scenes.push(WithId { id, entry: SceneEntry {
                            room, key, phase: None, initial_state: None,
                        }});
                        id
                    });
                    store.select("scenes", Some(id));
                },
                add_label: "Scene",
            }
            if let Some(s) = selected {
                SceneForm { key: "{s.id}", id: s.id, entry: s.entry }
            } else {
                p { class: "studio-empty", "A scene plays when the party enters (or exits) a room; its body lives under [behaviors.scene] with the same key." }
            }
        }
    }
}

#[component]
fn SceneForm(id: u64, entry: SceneEntry) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let old_key = entry.key.clone();
    rsx! {
        div { class: "studio-form",
            h2 { "Scene: {entry.key}" }
            label { class: "studio-field",
                span { class: "studio-field-label", "Key (shared with its behavior body)" }
                input {
                    class: "studio-input studio-mono",
                    value: "{entry.key}",
                    onchange: move |e| {
                        let new = e.value();
                        let old = old_key.clone();
                        store.mutate(move |d| {
                            // A rename must never overwrite another key's behavior
                            // body — collisions are refused (the input snaps back).
                            if new.trim().is_empty()
                                || new == old
                                || d.scenes.iter().any(|w| w.id != id && w.entry.key == new)
                                || d.behaviors.scene.contains_key(&new)
                            {
                                return;
                            }
                            // The behavior follows the key (shared-key identity).
                            if let Some(body) = d.behaviors.scene.remove(&old) {
                                d.behaviors.scene.insert(new.clone(), body);
                            }
                            if let Some(w) = d.scenes.iter_mut().find(|w| w.id == id) {
                                w.entry.key = new;
                            }
                        });
                    },
                }
            }
            SelectRow {
                label: "Room",
                value: Some(entry.room.clone()),
                options: doc.room_names(),
                allow_unset: false,
                on_change: move |v: Option<String>| edit_scene(store, id, move |s| s.room = v.unwrap_or_default()),
            }
            SelectRow {
                label: "Phase",
                value: entry.phase.clone(),
                options: SCENE_PHASES.iter().map(|s| (*s).to_string()).collect(),
                allow_unset: true,
                on_change: move |v| edit_scene(store, id, move |s| s.phase = v),
            }
            OptTomlRow {
                label: "Initial state",
                value: entry.initial_state.clone(),
                on_change: move |v| edit_scene(store, id, move |s| s.initial_state = v),
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit scene behaviors →"
            }
            ConfirmDelete {
                label: "Delete scene (its behavior body stays)".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.scenes, id));
                    store.select("scenes", None);
                },
            }
        }
    }
}

#[component]
pub fn MechanicsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .mechanics
        .iter()
        .map(|m| (m.id, m.entry.key.clone()))
        .collect();
    let selected = find(&doc.mechanics, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("mechanics", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    let key = format!("mechanic-{id}");
                    d.behaviors.mechanic.entry(key.clone()).or_insert_with(|| MechanicBehaviorEntry {
                        init: None, on_round_start: None, on_round_end: None,
                        on_turn_start: None, on_turn_end: None, on_action: None,
                        modify_damage: None, actions: BTreeMap::new(),
                    });
                    d.mechanics.push(WithId { id, entry: MechanicEntryToml { key, config: None } });
                    id
                });
                store.select("mechanics", Some(id));
            },
                add_label: "Mechanic",
            }
            if let Some(m) = selected {
                MechanicForm { key: "{m.id}", id: m.id, entry: m.entry }
            } else {
                p { class: "studio-empty", "A long-lived tick-driven system (a dread meter, a curse). The opt-in lives here; its hooks live under [behaviors.mechanic] with the same key." }
            }
        }
    }
}

#[component]
fn MechanicForm(id: u64, entry: MechanicEntryToml) -> Element {
    let store = use_context::<StudioStore>();
    let old_key = entry.key.clone();
    rsx! {
        div { class: "studio-form",
            h2 { "Mechanic: {entry.key}" }
            label { class: "studio-field",
                span { class: "studio-field-label", "Key (shared with its behavior body; native keys need no body)" }
                input {
                    class: "studio-input studio-mono",
                    value: "{entry.key}",
                    onchange: move |e| {
                        let new = e.value();
                        let old = old_key.clone();
                        store.mutate(move |d| {
                            if new.trim().is_empty()
                                || new == old
                                || d.mechanics.iter().any(|w| w.id != id && w.entry.key == new)
                                || d.behaviors.mechanic.contains_key(&new)
                            {
                                return;
                            }
                            if let Some(body) = d.behaviors.mechanic.remove(&old) {
                                d.behaviors.mechanic.insert(new.clone(), body);
                            }
                            if let Some(w) = d.mechanics.iter_mut().find(|w| w.id == id) {
                                w.entry.key = new;
                            }
                        });
                    },
                }
            }
            OptTomlRow {
                label: "Config (inert author-data, e.g. {{ threshold = 3 }})",
                value: entry.config.clone(),
                on_change: move |v| edit_mechanic(store, id, move |m| m.config = v),
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit mechanic behaviors →"
            }
            ConfirmDelete {
                label: "Delete mechanic opt-in (its behavior body stays)".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.mechanics, id));
                    store.select("mechanics", None);
                },
            }
        }
    }
}

#[component]
pub fn CardsScreen(asset: Option<u64>) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let items: Vec<(u64, String)> = doc
        .cards
        .iter()
        .map(|c| (c.id, format!("{} ({})", c.entry.name, c.entry.key)))
        .collect();
    let selected = find(&doc.cards, asset);
    rsx! {
        div { class: "studio-split",
            ListPane {
                items,
                selected: asset,
                on_select: move |id| store.select("cards", Some(id)),
                on_add: move |()| {
                let id = store.mutate(move |d| {
                    let id = d.mint();
                    d.cards.push(WithId { id, entry: CardEntryToml {
                        key: format!("card-{id}"), name: format!("New Card {id}"),
                        text: None, config: None, image: None,
                    }});
                    id
                });
                store.select("cards", Some(id));
            },
                add_label: "Card",
            }
            if let Some(c) = selected {
                CardForm { key: "{c.id}", id: c.id, entry: c.entry }
            } else {
                p { class: "studio-empty", "A Wicked Ways card face. Native `wicked:*` keys need no [[cards]] entry at all — declare here only authored cards." }
            }
        }
    }
}

#[component]
fn CardForm(id: u64, entry: CardEntryToml) -> Element {
    let store = use_context::<StudioStore>();
    let old_key = entry.key.clone();
    rsx! {
        div { class: "studio-form",
            h2 { "Card: {entry.name}" }
            label { class: "studio-field",
                span { class: "studio-field-label", "Key (shared with its behavior body)" }
                input {
                    class: "studio-input studio-mono",
                    value: "{entry.key}",
                    onchange: move |e| {
                        let new = e.value();
                        let old = old_key.clone();
                        store.mutate(move |d| {
                            if new.trim().is_empty()
                                || new == old
                                || d.cards.iter().any(|w| w.id != id && w.entry.key == new)
                                || d.behaviors.card.contains_key(&new)
                            {
                                return;
                            }
                            if let Some(body) = d.behaviors.card.remove(&old) {
                                d.behaviors.card.insert(new.clone(), body);
                            }
                            if let Some(w) = d.cards.iter_mut().find(|w| w.id == id) {
                                w.entry.key = new;
                            }
                        });
                    },
                }
            }
            TextRow {
                label: "Name",
                value: entry.name.clone(),
                on_change: move |v: String| edit_card(store, id, move |c| c.name = v),
            }
            OptTextAreaRow {
                label: "Card text",
                value: entry.text.clone(),
                on_change: move |v| edit_card(store, id, move |c| c.text = v),
            }
            OptTomlRow {
                label: "Config (inert author-data)",
                value: entry.config.clone(),
                on_change: move |v| edit_card(store, id, move |c| c.config = v),
            }
            button {
                class: "studio-btn small",
                onclick: move |_| store.select("behaviors", None),
                "Edit card behaviors →"
            }
            OptTextRow {
                label: "Image (asset path under campaigns/assets/)",
                value: entry.image.clone(),
                placeholder: Some("e.g. solomons-rest/lychgate.png".to_string()),
                on_change: move |v| edit_card(store, id, move |c| c.image = v),
            }
            ConfirmDelete {
                label: "Delete card".to_string(),
                on_delete: move |()| {
                    store.mutate(move |d| remove_by_id(&mut d.cards, id));
                    store.select("cards", None);
                },
            }
        }
    }
}

// ── Villain ─────────────────────────────────────────────────────────────────

#[component]
pub fn VillainScreen() -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let mut characters: Vec<String> = vec!["@gm".to_string()];
    characters.extend(doc.mobs.iter().map(|m| m.entry.name.clone()));
    characters.extend(doc.npcs.iter().map(|n| n.entry.name.clone()));
    let card_hint = format!(
        "authored cards: {} — native wicked:* keys are also legal",
        doc.cards
            .iter()
            .map(|c| c.entry.key.clone())
            .collect::<Vec<_>>()
            .join(", ")
    );
    rsx! {
        div { class: "studio-form",
            h2 { "Villain" }
            if let Some(v) = doc.villain.clone() {
                SelectRow {
                    label: "Character (a mob/npc name, or @gm)",
                    value: Some(v.character.clone()),
                    options: characters,
                    allow_unset: false,
                    on_change: move |c: Option<String>| store.mutate(move |d| {
                        if let Some(v) = d.villain.as_mut() {
                            v.character = c.unwrap_or_default();
                        }
                    }),
                }
                ListRow {
                    label: "Deck (card keys, authored order — the engine shuffles)",
                    values: v.deck.clone(),
                    hint: card_hint,
                    on_change: move |deck| store.mutate(move |d| {
                        if let Some(v) = d.villain.as_mut() {
                            v.deck = deck;
                        }
                    }),
                }
                button {
                    class: "studio-btn small danger",
                    onclick: move |_| store.mutate(move |d| d.villain = None),
                    "Remove the villain"
                }
            } else {
                p { class: "studio-empty", "No villain — this campaign has no Wicked Ways deck." }
                button {
                    class: "studio-btn primary",
                    onclick: move |_| store.mutate(move |d| d.villain = Some(VillainEntry {
                        character: "@gm".into(),
                        deck: Vec::new(),
                    })),
                    "Add a villain"
                }
            }
        }
    }
}

// ── Victory ─────────────────────────────────────────────────────────────────

#[component]
pub fn VictoryScreen() -> Element {
    rsx! {
        div { class: "studio-victory",
            p { class: "studio-hint",
                "Win/lose conditions are ORDERED — the first passing condition ends the campaign. The test is a predicate expression."
            }
            ConditionList { win: true }
            ConditionList { win: false }
            crate::ui::reference::DslReference {}
        }
    }
}

#[component]
fn ConditionList(win: bool) -> Element {
    let store = use_context::<StudioStore>();
    let doc = (store.doc)();
    let list: Vec<WithId<ConditionEntry>> = if win {
        doc.victory_win.clone()
    } else {
        doc.victory_lose.clone()
    };
    let title = if win {
        "Win conditions"
    } else {
        "Lose conditions"
    };
    let len = list.len();
    // One mutable-list helper both arms share — a nested `fn` rather than a
    // closure: it captures nothing, so every `move` handler below can call it
    // freely (a capturing closure could be moved into at most one of them).
    fn with_list(d: &mut EditorDoc, win: bool) -> &mut Vec<WithId<ConditionEntry>> {
        if win {
            &mut d.victory_win
        } else {
            &mut d.victory_lose
        }
    }
    rsx! {
        div { class: "studio-form",
            h2 { "{title}" }
            for (i, cond) in list.into_iter().enumerate() {
                div { class: "studio-card", key: "{cond.id}",
                    TextRow {
                        label: "Key",
                        value: cond.entry.key.clone(),
                        on_change: {
                            let id = cond.id;
                            move |v: String| store.mutate(move |d| {
                                if let Some(w) = with_list(d, win).iter_mut().find(|w| w.id == id) {
                                    w.entry.key = v;
                                }
                            })
                        },
                    }
                    BodyField {
                        label: "Test (predicate expression)".to_string(),
                        slot: BodySlot::VictoryTest,
                        value: cond.entry.test.clone(),
                        on_change: {
                            let id = cond.id;
                            move |v: String| store.mutate(move |d| {
                                if let Some(w) = with_list(d, win).iter_mut().find(|w| w.id == id) {
                                    w.entry.test = v;
                                }
                            })
                        },
                    }
                    OptTextRow {
                        label: "Narration",
                        value: cond.entry.narration.clone(),
                        placeholder: None,
                        on_change: {
                            let id = cond.id;
                            move |v| store.mutate(move |d| {
                                if let Some(w) = with_list(d, win).iter_mut().find(|w| w.id == id) {
                                    w.entry.narration = v;
                                }
                            })
                        },
                    }
                    div { class: "studio-rowbtns",
                        button {
                            class: "studio-btn small",
                            disabled: i == 0,
                            onclick: move |_| store.mutate(move |d| {
                                let l = with_list(d, win);
                                if i > 0 { l.swap(i, i - 1); }
                            }),
                            "↑"
                        }
                        button {
                            class: "studio-btn small",
                            disabled: i + 1 >= len,
                            onclick: move |_| store.mutate(move |d| {
                                let l = with_list(d, win);
                                if i + 1 < l.len() { l.swap(i, i + 1); }
                            }),
                            "↓"
                        }
                        ConfirmDelete {
                            label: "Delete condition".to_string(),
                            on_delete: {
                                let id = cond.id;
                                move |()| store.mutate(move |d| with_list(d, win).retain(|w| w.id != id))
                            },
                        }
                    }
                }
            }
            button {
                class: "studio-btn",
                onclick: move |_| store.mutate(move |d| {
                    let id = d.mint();
                    let prefix = if win { "win" } else { "lose" };
                    with_list(d, win).push(WithId { id, entry: ConditionEntry {
                        key: format!("{prefix}-{id}"),
                        test: "false".into(),
                        narration: None,
                    }});
                }),
                "+ Condition"
            }
        }
    }
}
