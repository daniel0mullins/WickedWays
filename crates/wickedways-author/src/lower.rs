//! Lower the parsed TOML surface (`AuthorDoc`) into the artifacts
//! `wickedways_assemble::assemble` consumes.
//!
//! Task 4 fills the DESCRIPTION (`CampaignDescription`); the CATALOG is stubbed
//! (`Catalog::default()`) and completed in Task 5. Panic-free on author input.

use serde_json::{Map, Value};
use wickedways_assemble::description::{
    CampaignDescription, CampaignOpts, ConditionEntry, ExitDef, LootDef, RoomDef,
};
use wickedways_core::world::descriptor::Catalog;

use crate::author_doc::{AuthorDoc, ConditionEntry as AuthorCondition};
use crate::error::CompileError;
use crate::CompiledCampaign;

/// The MVP surface exposes no `opts`; the canonical author fixes these bounds
/// (mirrors the TS twin's `authorTemplate(..., { maxRounds: 20, baseEncounterChance: 0 })`).
const MVP_MAX_ROUNDS: i64 = 20;
const MVP_BASE_ENCOUNTER_CHANCE: i64 = 0;

/// Lower a parsed author document. Infallible for the description half, but keeps
/// the fallible signature: the catalog half (Task 5) surfaces `CompileError`s.
pub(crate) fn lower(doc: &AuthorDoc) -> Result<CompiledCampaign, CompileError> {
    let description = lower_description(doc);
    Ok(CompiledCampaign { description, catalog: Catalog::default() })
}

fn lower_description(doc: &AuthorDoc) -> CampaignDescription {
    CampaignDescription {
        title: doc.title.clone(),
        opts: CampaignOpts {
            max_rounds: Some(MVP_MAX_ROUNDS),
            base_encounter_chance: Some(MVP_BASE_ENCOUNTER_CHANCE),
        },
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
