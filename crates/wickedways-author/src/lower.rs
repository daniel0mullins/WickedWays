//! Lower the parsed TOML surface (`AuthorDoc`) into the artifacts
//! `wickedways_assemble::assemble` consumes.
//!
//! `lower_description` builds the `CampaignDescription`; `lower_catalog` lowers
//! items plus the exit/victory/scene behavior families into the `Catalog`.
//! Panic-free on author input.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use wickedways_assemble::description::{
    ArchetypeDef, CacheDef, CampaignDescription, ConditionEntry, ExitDef, FormationDef, LootDef,
    MechanicEntry, MobDef, NpcDef, RoomDef, SceneDef,
};
use wickedways_core::script::ast::{
    BehaviorScript, ExitScript, ItemScript, SceneScript, VictoryScript,
};
use wickedways_core::stats::StatType;
use wickedways_core::world::descriptor::{
    Catalog, ItemDescriptor, ItemProperties, ItemType, RecipeMeta,
};
use wickedways_core::world::formation_descriptor::FormationDescriptor;

use crate::author_doc::{AuthorDoc, ConditionEntry as AuthorCondition, ItemEntry};
use crate::error::{CompileError, Span};
use crate::expr::parse_expr;
use crate::stmt::{parse_script, parse_stmts};
use crate::CompiledCampaign;

/// Base span for author expressions embedded in TOML. The TOML deserializer does
/// not surface per-value source positions, so parse errors from behavior/victory
/// expressions point at the file head rather than the exact line. Byte-parity is
/// unaffected (a well-formed fixture never errors); refining spans is future work.
const EXPR_BASE: Span = Span { line: 1, col: 1 };

/// Lower a parsed author document. Infallible for the description half, but keeps
/// the fallible signature: the catalog half (Task 5) surfaces `CompileError`s.
pub(crate) fn lower(doc: &AuthorDoc) -> Result<CompiledCampaign, CompileError> {
    let description = lower_description(doc);
    let catalog = lower_catalog(doc)?;
    Ok(CompiledCampaign { description, catalog })
}

fn lower_description(doc: &AuthorDoc) -> CampaignDescription {
    CampaignDescription {
        title: doc.title.clone(),
        // Campaign bounds from the `[opts]` table (absent fields fall to the engine
        // defaults — maxRounds 100 / baseEncounterChance 20 — applied by `assemble`).
        opts: doc.opts.clone(),
        // Each `[[archetypes]]` entry → an `ArchetypeDef`. `base_stats` is the same
        // `PartialStats` (stat-name → f64) map on both surfaces (direct clone);
        // `inventory_slots`/`immunities` carry through.
        archetypes: doc
            .archetypes
            .iter()
            .map(|a| ArchetypeDef {
                id: a.id.clone(),
                name: a.name.clone(),
                base_stats: a.base_stats.clone(),
                inventory_slots: a.inventory_slots,
                immunities: a.immunities.clone(),
            })
            .collect(),
        rooms: doc
            .rooms
            .iter()
            .map(|r| RoomDef {
                name: r.name.clone(),
                description: r.description.clone(),
                dark: r.dark,
                spawn_modifier: r.spawn_modifier,
                lights: r.lights.clone(),
            })
            .collect(),
        start_room: doc.start_room.clone(),
        exits: doc
            .exits
            .iter()
            .map(|e| ExitDef {
                from: e.from.clone(),
                direction: e.direction.clone(),
                to: e.to.clone(),
                behavior_key: e.behavior.clone(),
                name: e.name.clone(),
                initial_state: e.initial_state.as_ref().and_then(|v| serde_json::to_value(v).ok()),
                one_way: e.one_way,
            })
            .collect(),
        // Each `[[mobs]]` entry → a `MobDef`. `stats` is the same core `Stats` type
        // on both surfaces (direct clone); `natural_attack`/`material_drops` are
        // inert author-data (toml → json; a conversion failure drops to `None`).
        mobs: doc
            .mobs
            .iter()
            .map(|m| MobDef {
                name: m.name.clone(),
                stats: m.stats.clone(),
                room: m.room.clone(),
                inventory_slots: m.inventory_slots,
                actions_per_round: m.actions_per_round,
                drops: m.drops.clone(),
                base_escape_chance: m.base_escape_chance,
                material_drops: m.material_drops.as_ref().and_then(|v| serde_json::to_value(v).ok()),
                light_averse: m.light_averse,
                natural_attack: m.natural_attack.as_ref().and_then(|v| serde_json::to_value(v).ok()),
            })
            .collect(),
        loot: doc
            .loot
            .iter()
            .map(|l| LootDef {
                name: l.name.clone(),
                room: l.room.clone(),
                items: l.items.clone(),
                description: l.description.clone(),
            })
            .collect(),
        // Each `[[caches]]` entry → a `CacheDef`. `materials` is the same
        // `BTreeMap<String, i64>` MaterialMap on both surfaces (direct clone);
        // `assemble` turns it into a `cache:<name>` MaterialCacheSnapshot in the room.
        caches: doc
            .caches
            .iter()
            .map(|c| CacheDef {
                name: c.name.clone(),
                room: c.room.clone(),
                materials: c.materials.clone(),
            })
            .collect(),
        // Each `[[npcs]]` entry → an `NpcDef`. `stats` is the same core `Stats`
        // type on both surfaces (direct clone); `room`/`holds` carry through; the
        // held item descriptor (e.g. `cellar-key`) comes from `[[items]]` via
        // `lower_item`. `behavior` names the `[behaviors.npc.<key>]` catalog script.
        npcs: doc
            .npcs
            .iter()
            .map(|n| NpcDef {
                name: n.name.clone(),
                stats: n.stats.clone(),
                room: n.room.clone(),
                behavior: n.behavior.clone(),
                holds: n.holds.clone(),
            })
            .collect(),
        // Each `[[formations]]` entry's description half → a `FormationDef` opt-in
        // (`{ key, weight }`); its `mobs` roster rides in the catalog (see
        // `lower_catalog`). Keyed the same.
        formations: doc
            .formations
            .iter()
            .map(|f| FormationDef { key: f.key.clone(), weight: f.weight })
            .collect(),
        scenes: doc
            .scenes
            .iter()
            .map(|s| SceneDef {
                room: s.room.clone(),
                key: s.key.clone(),
                phase: s.phase.clone(),
                // The scene surface seeds state via TOML; convert the author's
                // `toml::Value` to the description's `serde_json::Value`. A
                // conversion failure drops the seed (absent) rather than panicking.
                initial_state: s
                    .initial_state
                    .as_ref()
                    .and_then(|v| serde_json::to_value(v).ok()),
            })
            .collect(),
        // Each `[[recipes]]` id → the party's known-recipe set (the metadata rides
        // the catalog; see `lower_catalog`).
        recipes: doc.recipes.iter().map(|r| r.id.clone()).collect(),
        materials: Vec::new(),
        win_conditions: doc.victory.win.iter().map(lower_condition).collect(),
        lose_conditions: doc.victory.lose.iter().map(lower_condition).collect(),
        // Each `[[mechanics]]` opt-in → a `MechanicEntry { key, config }`. `config`
        // is inert author-data (mechanic-specific): the author's optional `toml::Value`
        // converts to the description's `serde_json::Value`; absent (dread) → None. A
        // conversion failure drops the config (absent) rather than panicking.
        mechanics: doc
            .mechanics
            .iter()
            .map(|m| MechanicEntry {
                key: m.key.clone(),
                config: m.config.as_ref().and_then(|v| serde_json::to_value(v).ok()),
            })
            .collect(),
        // A `timeoutNarration` string lowers to the cue shape `{ "text": … }` (the
        // same shape as a victory condition's narration).
        timeout_narration: doc.timeout_narration.as_ref().map(|text| {
            let mut obj = Map::new();
            obj.insert("text".to_string(), Value::String(text.clone()));
            Value::Object(obj)
        }),
        ended_narration: None,
        chat: None,
        av: None,
    }
}

/// Lower the CATALOG half: the item descriptors and the scripted behaviors
/// (exit predicates + victory tests). Aliases/formations/recipes are empty for
/// the MVP surface, matching the oracle catalog.
fn lower_catalog(doc: &AuthorDoc) -> Result<Catalog, CompileError> {
    let mut items = BTreeMap::new();
    // Each item's `aliases` (if any) → a `catalog.aliases[<key>]` entry.
    let mut aliases = BTreeMap::new();
    for item in &doc.items {
        items.insert(item.key.clone(), lower_item(item));
        if !item.aliases.is_empty() {
            aliases.insert(item.key.clone(), item.aliases.clone());
        }
    }

    let mut behaviors = BTreeMap::new();

    // Exit behaviors: `can_pass` is a parsed predicate; `run_script` is an optional
    // narration SCRIPT body (`pass <expr>` legal — parsed via `parse_script`),
    // empty when absent. Keyed by behavior key.
    for (key, entry) in &doc.behaviors.exit {
        let script = ExitScript {
            can_pass: parse_expr(&entry.can_pass, EXPR_BASE)?,
            run_script: entry
                .run_script
                .as_deref()
                .map(|s| parse_script(s, EXPR_BASE))
                .transpose()?
                .unwrap_or_default(),
            pass_message: entry.pass_message.clone(),
            fail_message: entry.fail_message.clone(),
        };
        behaviors.insert(key.clone(), BehaviorScript::Exit { script });
    }

    // Scene behaviors: `can_play` is an optional predicate (serialized as `null`
    // when absent — the catalog always carries a `canPlay` key); `on_enter`/
    // `on_exit` are optional statement bodies (skipped when absent). Keyed by the
    // scene behavior key (shared with the description's SceneDef.key).
    for (key, entry) in &doc.behaviors.scene {
        let script = SceneScript {
            can_play: entry
                .can_play
                .as_deref()
                .map(|s| parse_expr(s, EXPR_BASE))
                .transpose()?,
            on_enter: entry
                .on_enter
                .as_deref()
                .map(|s| parse_stmts(s, EXPR_BASE))
                .transpose()?,
            on_exit: entry
                .on_exit
                .as_deref()
                .map(|s| parse_stmts(s, EXPR_BASE))
                .transpose()?,
        };
        behaviors.insert(key.clone(), BehaviorScript::Scene { script });
    }

    // Item behaviors: each `[behaviors.item.<key>]` lowers to an `ItemScript`
    // with optional `on_use`/`on_read` effect bodies (skipped when absent). Keyed
    // by `<key>` — shared with the `[[items]]` entry (the engine resolves an item's
    // onUse via `catalog.behaviors[item_key]`).
    for (key, entry) in &doc.behaviors.item {
        let script = ItemScript {
            on_use: entry
                .on_use
                .as_deref()
                .map(|s| parse_stmts(s, EXPR_BASE))
                .transpose()?,
            on_read: entry
                .on_read
                .as_deref()
                .map(|s| parse_stmts(s, EXPR_BASE))
                .transpose()?,
        };
        behaviors.insert(key.clone(), BehaviorScript::Item { script });
    }

    // Npc behaviors: each `[behaviors.npc.<key>]` lowers to an `NpcScript` (the
    // description + default + ordered dialogue) via the `npc` converter. Keyed by
    // `<key>` — shared with the `[[npcs]]` entry's `behavior`.
    for (key, entry) in &doc.behaviors.npc {
        let script = crate::npc::to_npc_script(entry)?;
        behaviors.insert(key.clone(), BehaviorScript::Npc { script });
    }

    // Mechanic behaviors: each `[behaviors.mechanic.<key>]` lowers to a
    // `MechanicScript` (literal `init` seed + the five parsed hook bodies) via the
    // `mechanic` converter. Keyed by `<key>` — shared with the `[[mechanics]]`
    // opt-in's `key` (the engine resolves a mechanic's hooks via
    // `catalog.behaviors[mechanic_key]`).
    for (key, entry) in &doc.behaviors.mechanic {
        let script = crate::mechanic::to_mechanic_script(entry)?;
        behaviors.insert(key.clone(), BehaviorScript::Mechanic { script });
    }

    // Victory behaviors: each win/lose condition's `test` is a parsed predicate,
    // keyed by the condition key (shared with the description's condition entry).
    for cond in doc.victory.win.iter().chain(doc.victory.lose.iter()) {
        let script = VictoryScript { test: parse_expr(&cond.test, EXPR_BASE)? };
        behaviors.insert(cond.key.clone(), BehaviorScript::Victory { script });
    }

    // Every exit's `behavior` must name a defined `behaviors.exit` entry.
    for exit in &doc.exits {
        if let Some(key) = &exit.behavior {
            if !doc.behaviors.exit.contains_key(key) {
                return Err(CompileError::UnresolvedKey { kind: "exit", key: key.clone() });
            }
        }
    }

    // Each `[[formations]]` entry's catalog half → a `FormationDescriptor` (its
    // `mobs` roster), keyed the same as the description opt-in.
    let mut formations = BTreeMap::new();
    for f in &doc.formations {
        formations.insert(f.key.clone(), FormationDescriptor { mobs: f.mobs.clone() });
    }

    // Each `[[recipes]]` entry's catalog half → a `RecipeMeta` carrying the cost +
    // the `outputItemKey` that `World::craft` instantiates. Keyed by recipe id (the
    // same id the description's known-recipe set holds).
    let mut recipes = BTreeMap::new();
    for r in &doc.recipes {
        recipes.insert(
            r.id.clone(),
            RecipeMeta {
                id: r.id.clone(),
                output_name: r.output_name.clone(),
                materials: r.materials.clone(),
                output_item_key: Some(r.output_item.clone()),
            },
        );
    }

    Ok(Catalog {
        items,
        aliases,
        behaviors,
        formations,
        recipes,
    })
}

/// Lower one author item to its catalog descriptor. Two shapes:
///
/// - A `keyCode`-bearing entry is a KEY item: it reproduces the TS `createKey`
///   descriptor exactly — `type: key`, `stat: health`, `modifier: 0`, the
///   non-equippable/non-destroyable property quadruple, `recipe: { item: 1 }`,
///   and `consumeOnUse: false` (the MVP surface carries no `consumeOnUse`, so it
///   defaults off).
/// - Otherwise a CONSUMABLE: `type`/`stat`/`modifier` come from the surface, the
///   `properties` quadruple is `equippable:false, equipped:false, destroyable,
///   usable` (the latter two from the surface), and `recipe` is READ from the
///   surface `ItemEntry.recipe` (author-data — consumables vary in recipe, so it
///   is not kind-derived; a `toml::Value` converted to `serde_json::Value`). The
///   consumable carries no `consumeOnUse`/`keyCode` (both skipped when `None`).
///
/// The inert `teaches`/`immunities`/`grantsImmunity` fields are always emitted as
/// `null`.
fn lower_item(item: &ItemEntry) -> ItemDescriptor {
    if item.key_code.is_some() {
        // KEY item — the existing `createKey` descriptor, unchanged.
        let mut recipe = Map::new();
        recipe.insert("item".to_string(), Value::Number(1.into()));
        return ItemDescriptor {
            name: item.name.clone(),
            r#type: ItemType::Key,
            stat: StatType::Health,
            modifier: 0,
            properties: ItemProperties {
                equippable: false,
                equipped: false,
                destroyable: false,
                usable: false,
                droppable: None,
            },
            slot: None,
            two_handed: None,
            emits_light: None,
            max_durability: None,
            lore: None,
            presentation: None,
            key_code: item.key_code.clone(),
            consume_on_use: Some(false),
            recipe: Value::Object(recipe),
            teaches: Value::Null,
            immunities: Value::Null,
            grants_immunity: Value::Null,
        };
    }

    // CONSUMABLE item — built from the surface fields. Enum strings deserialize
    // via serde (both `ItemType` and `StatType` are `rename_all = "lowercase"`);
    // a malformed/absent value falls back to the consumable default rather than
    // panicking (a well-formed fixture always carries valid values).
    let r#type = item
        .type_
        .as_deref()
        .and_then(|s| serde_json::from_value::<ItemType>(Value::String(s.to_string())).ok())
        .unwrap_or(ItemType::Consumable);
    let stat = item
        .stat
        .as_deref()
        .and_then(|s| serde_json::from_value::<StatType>(Value::String(s.to_string())).ok())
        .unwrap_or(StatType::Health);
    // `recipe` is author-data: read it from the surface (toml → json). Absent or
    // unconvertible falls to an empty map rather than panicking.
    let recipe = item
        .recipe
        .as_ref()
        .and_then(|v| serde_json::to_value(v).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    ItemDescriptor {
        name: item.name.clone(),
        r#type,
        stat,
        modifier: item.modifier.unwrap_or(0),
        properties: ItemProperties {
            equippable: item.equippable.unwrap_or(false),
            // Descriptors are templates: nothing starts equipped (runtime state).
            equipped: false,
            destroyable: item.destroyable.unwrap_or(false),
            usable: item.usable.unwrap_or(false),
            droppable: item.droppable,
        },
        // `slot` is a lowercase `SlotKind` string ("hand", …); an unknown value
        // falls to `None` rather than panicking (a well-formed fixture is valid).
        slot: item
            .slot
            .as_deref()
            .and_then(|s| serde_json::from_value(Value::String(s.to_string())).ok()),
        two_handed: item.two_handed,
        emits_light: item.emits_light,
        max_durability: item.max_durability,
        lore: item.lore.clone(),
        presentation: None,
        key_code: None,
        consume_on_use: None,
        recipe,
        teaches: Value::Null,
        immunities: Value::Null,
        grants_immunity: Value::Null,
    }
}

/// The description victory entry carries only the condition KEY + optional
/// narration. The `test` expression lives in the catalog behaviors. A narration
/// string lowers to the object shape `{ "text": "..." }`.
fn lower_condition(cond: &AuthorCondition) -> ConditionEntry {
    ConditionEntry {
        key: cond.key.clone(),
        narration: cond.narration.as_ref().map(|text| {
            let mut obj = Map::new();
            obj.insert("text".to_string(), Value::String(text.clone()));
            Value::Object(obj)
        }),
    }
}
