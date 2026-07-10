//! Lower the parsed TOML surface (`AuthorDoc`) into the artifacts
//! `wickedways_assemble::assemble` consumes.
//!
//! Task 4 fills the DESCRIPTION (`CampaignDescription`); the CATALOG is stubbed
//! (`Catalog::default()`) and completed in Task 5. Panic-free on author input.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use wickedways_assemble::description::{
    CampaignDescription, CampaignOpts, ConditionEntry, ExitDef, LootDef, RoomDef,
};
use wickedways_core::script::ast::{BehaviorScript, ExitScript, VictoryScript};
use wickedways_core::stats::StatType;
use wickedways_core::world::descriptor::{
    Catalog, ItemDescriptor, ItemProperties, ItemType,
};

use crate::author_doc::{AuthorDoc, ConditionEntry as AuthorCondition, ItemEntry};
use crate::error::{CompileError, Span};
use crate::expr::parse_expr;
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
        // The MVP surface exposes no `opts`; both bounds fall to the engine
        // defaults (maxRounds 100, baseEncounterChance 20) applied by `assemble`.
        opts: CampaignOpts::default(),
        archetypes: Vec::new(),
        rooms: doc
            .rooms
            .iter()
            .map(|r| RoomDef {
                name: r.name.clone(),
                description: r.description.clone(),
                dark: None,
                spawn_modifier: None,
                lights: Vec::new(),
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
                name: None,
                initial_state: None,
                one_way: e.one_way,
            })
            .collect(),
        mobs: Vec::new(),
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
        caches: Vec::new(),
        npcs: Vec::new(),
        formations: Vec::new(),
        scenes: Vec::new(),
        recipes: Vec::new(),
        materials: Vec::new(),
        win_conditions: doc
            .victory
            .win
            .iter()
            .map(|(key, cond)| lower_condition(key, cond))
            .collect(),
        lose_conditions: doc
            .victory
            .lose
            .iter()
            .map(|(key, cond)| lower_condition(key, cond))
            .collect(),
        mechanics: Vec::new(),
        timeout_narration: None,
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
    for item in &doc.items {
        items.insert(item.key.clone(), lower_item(item));
    }

    let mut behaviors = BTreeMap::new();

    // Exit behaviors: `can_pass` is a parsed predicate; `run_script` is empty for
    // the MVP surface (no narration statements). Keyed by behavior key.
    for (key, entry) in &doc.behaviors.exit {
        let script = ExitScript {
            can_pass: parse_expr(&entry.can_pass, EXPR_BASE)?,
            run_script: Vec::new(),
            pass_message: entry.pass_message.clone(),
            fail_message: entry.fail_message.clone(),
        };
        behaviors.insert(key.clone(), BehaviorScript::Exit { script });
    }

    // Victory behaviors: each win/lose condition's `test` is a parsed predicate,
    // keyed by the condition key (shared with the description's condition entry).
    for (key, cond) in doc.victory.win.iter().chain(doc.victory.lose.iter()) {
        let script = VictoryScript { test: parse_expr(&cond.test, EXPR_BASE)? };
        behaviors.insert(key.clone(), BehaviorScript::Victory { script });
    }

    // Every exit's `behavior` must name a defined `behaviors.exit` entry.
    for exit in &doc.exits {
        if let Some(key) = &exit.behavior {
            if !doc.behaviors.exit.contains_key(key) {
                return Err(CompileError::UnresolvedKey { kind: "exit", key: key.clone() });
            }
        }
    }

    Ok(Catalog {
        items,
        aliases: BTreeMap::new(),
        behaviors,
        formations: BTreeMap::new(),
        recipes: BTreeMap::new(),
    })
}

/// Lower one author item to its catalog descriptor. A `keyCode`-bearing entry is
/// a KEY item: it reproduces the TS `createKey` descriptor exactly — `type: key`,
/// `stat: health`, `modifier: 0`, the non-equippable/non-destroyable property
/// quadruple, `recipe: { item: 1 }`, and `consumeOnUse: false` (the MVP surface
/// carries no `consumeOnUse`, so it defaults off). The inert `teaches`/
/// `immunities`/`grantsImmunity` fields are always emitted as `null`.
fn lower_item(item: &ItemEntry) -> ItemDescriptor {
    // The MVP surface only authors key items (`keyCode` present). Non-key items
    // are not yet expressible in the TOML surface; a `keyCode`-less entry still
    // lowers to the key-shaped descriptor here, which is the only shape the
    // oracle produces for the G2 fixture.
    let mut recipe = Map::new();
    recipe.insert("item".to_string(), Value::Number(1.into()));
    ItemDescriptor {
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
    }
}

/// The description victory entry carries only the condition KEY + optional
/// narration. The `test` expression lives in the catalog behaviors (Task 5).
/// A narration string lowers to the object shape `{ "text": "..." }`.
fn lower_condition(key: &str, cond: &AuthorCondition) -> ConditionEntry {
    ConditionEntry {
        key: key.to_string(),
        narration: cond.narration.as_ref().map(|text| {
            let mut obj = Map::new();
            obj.insert("text".to_string(), Value::String(text.clone()));
            Value::Object(obj)
        }),
    }
}
