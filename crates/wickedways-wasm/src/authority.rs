//! The stateful single-player WASM handle. All game state lives inside;
//! only JSON strings cross the seam — the host never holds engine objects.
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;
use wickedways_core::presentation::{CampaignOutcome, PresentationCue};
use wickedways_core::world::descriptor::Catalog;
use wickedways_core::world::ids::{CharacterId, ItemId};
use wickedways_core::world::intent::Intent;
use wickedways_core::{CampaignSnapshot, World};

use crate::js_err;

#[wasm_bindgen]
pub struct Authority {
    world: World,
    catalog: Catalog,
    /// Loot containers revealed this session.
    opened: BTreeSet<String>,
    /// Cues emitted during begin_campaign (the round-0 onRoundStart readout).
    startup: Vec<PresentationCue>,
}

#[wasm_bindgen]
impl Authority {
    /// `genesis_json` = a PRE-begin CampaignSnapshot (assembled + PC placed,
    /// not yet begun). Runs: from_snapshot → validate_mechanics → seed_rng(seed)
    /// → begin_campaign, buffering the startup cues.
    #[wasm_bindgen(constructor)]
    pub fn new(genesis_json: &str, catalog_json: &str, seed: u32) -> Result<Authority, JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(genesis_json).map_err(js_err)?;
        let catalog: Catalog = serde_json::from_str(catalog_json).map_err(js_err)?;
        let mut world = World::from_snapshot(snap);
        world.validate_mechanics(&catalog).map_err(js_err)?;
        world.seed_rng(seed);
        let mut startup: Vec<PresentationCue> = Vec::new();
        world
            .begin_campaign(&catalog, &mut startup)
            .map_err(js_err)?;
        Ok(Authority {
            world,
            catalog,
            opened: BTreeSet::new(),
            startup,
        })
    }

    /// Opening cues emitted during begin_campaign; returns and clears the buffer
    /// (PresentationCue[] JSON).
    #[wasm_bindgen(js_name = takeStartupCues)]
    pub fn take_startup_cues(&mut self) -> Result<String, JsValue> {
        let out = serde_json::to_string(&self.startup).map_err(js_err)?;
        self.startup.clear();
        Ok(out)
    }

    /// Submit one intent. Returns ExecuteResult JSON { cues, mobAttacks?, error? }.
    pub fn submit(&mut self, intent_json: &str) -> Result<String, JsValue> {
        // Untaken startup cues are discarded on the first action rather than
        // leaking into its cue stream.
        self.startup.clear();
        let intent: Intent = serde_json::from_str(intent_json).map_err(js_err)?;
        let result = self.world.submit(intent, &self.catalog, &mut self.opened);
        serde_json::to_string(&result).map_err(js_err)
    }

    /// The widened ViewModel JSON.
    pub fn view(&self) -> Result<String, JsValue> {
        let vm = self
            .world
            .view(&self.catalog, &self.opened)
            .map_err(js_err)?;
        serde_json::to_string(&vm).map_err(js_err)
    }

    /// Free, non-time-advancing read of a held item's lore.
    /// Returns PresentationCue[] JSON (empty when not held / no lore).
    pub fn read(&mut self, item_id: &str) -> Result<String, JsValue> {
        let actor = self.world.active_character_id().map_err(js_err)?;
        let mut cues: Vec<PresentationCue> = Vec::new();
        self.world
            .read_item(&actor, &ItemId(item_id.into()), &self.catalog, &mut cues)
            .map_err(js_err)?;
        serde_json::to_string(&cues).map_err(js_err)
    }

    /// Free, non-time-advancing examine of a co-located, visible NPC: emits the
    /// NPC's `description` blurb. Returns PresentationCue[] JSON (empty for any
    /// non-NPC / hidden / not-co-located target — a quiet no-op).
    pub fn examine(&self, target_id: &str) -> Result<String, JsValue> {
        let actor = self.world.active_character_id().map_err(js_err)?;
        let mut cues: Vec<PresentationCue> = Vec::new();
        self.world
            .examine(
                &actor,
                &CharacterId(target_id.into()),
                &self.catalog,
                &mut cues,
            )
            .map_err(js_err)?;
        serde_json::to_string(&cues).map_err(js_err)
    }

    /// CampaignSnapshot JSON of the current world state.
    pub fn snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.world.to_snapshot()).map_err(js_err)
    }

    /// Rehydrate in place from a CampaignSnapshot JSON. The rng stream
    /// CONTINUES across restore — loading a save must not reset the dice —
    /// while the opened-loot set clears.
    pub fn restore(&mut self, snapshot_json: &str) -> Result<(), JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(snapshot_json).map_err(js_err)?;
        let rng = self.world.rng.clone();
        let mut world = World::from_snapshot(snap);
        world.validate_mechanics(&self.catalog).map_err(js_err)?;
        world.rng = rng;
        self.world = world;
        self.opened.clear();
        Ok(())
    }

    #[wasm_bindgen(getter)]
    pub fn finished(&self) -> bool {
        self.world.campaign.outcome != CampaignOutcome::Ongoing
    }

    #[wasm_bindgen(getter)]
    pub fn outcome(&self) -> String {
        match serde_json::to_value(self.world.campaign.outcome) {
            Ok(serde_json::Value::String(s)) => s,
            _ => String::from("ongoing"),
        }
    }
}
