use wasm_bindgen::prelude::*;
use wickedways_core::{compute_mitigated_damage, DamageInput};

mod authority;
pub use authority::Authority;

/// One conversion for every host-visible error: anything Display becomes a JS string.
pub(crate) fn js_err<E: core::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Toolchain smoke test: proves Rust→WASM→Node loading works end-to-end.
#[wasm_bindgen]
pub fn ping() -> i32 {
    42
}

/// Pure dice roll from a pre-drawn uniform `unit` in `[0, 1)`.
#[wasm_bindgen]
pub fn roll(sides: u32, unit: f64) -> u32 {
    wickedways_core::roll(sides, unit)
}

/// Mitigation formula over the serde boundary. Proves struct marshalling
/// (serde-wasm-bindgen) end-to-end.
#[wasm_bindgen]
pub fn mitigated_damage(input: JsValue) -> Result<f64, JsValue> {
    let parsed: DamageInput = serde_wasm_bindgen::from_value(input)?;
    Ok(compute_mitigated_damage(parsed))
}

/// Conformance-gate-only entry points. Compiled ONLY under `--features
/// conformance` (the `wasm:build:conformance` build); the shipped default
/// build must not carry them (asserted by scripts/assert-no-conformance.mjs).
#[cfg(feature = "conformance")]
mod conformance_api {
    use std::collections::BTreeSet;
    use wasm_bindgen::prelude::*;
    use wickedways_core::world::descriptor::Catalog;
    use wickedways_core::{CampaignSnapshot, StatType, World};

    /// Returns the mitigating stat for `stat`, as serde strings, for the
    /// conformance harness.
    #[wasm_bindgen]
    pub fn mitigator(stat: &str) -> Result<String, JsValue> {
        let parsed: StatType = serde_json::from_value(serde_json::Value::String(stat.to_string()))
            .map_err(crate::js_err)?;
        let out = serde_json::to_value(parsed.mitigator()).map_err(crate::js_err)?;
        let s = out
            .as_str()
            .ok_or_else(|| JsValue::from_str("expected string stat"))?;
        Ok(s.to_string())
    }

    /// Parse a CampaignSnapshot JSON, fold into the id-keyed World, and re-emit.
    /// Used by the conformance harness to prove the round-trip is byte-faithful.
    #[wasm_bindgen]
    pub fn roundtrip_snapshot(json: &str) -> Result<String, JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(json).map_err(crate::js_err)?;
        let out = World::from_snapshot(snap).to_snapshot();
        serde_json::to_string(&out).map_err(crate::js_err)
    }

    /// Build the widened ViewModel from a snapshot, a catalog, and the set of opened
    /// loot container IDs.
    ///
    /// - `snapshot_json`    — JSON-serialized `CampaignSnapshot`
    /// - `catalog_json`     — JSON object `{ items: {...}, aliases: {...} }` (the `Catalog`)
    /// - `opened_loot_json` — JSON array of loot-container ID strings currently opened
    #[wasm_bindgen]
    pub fn view_model(
        snapshot_json: &str,
        catalog_json: &str,
        opened_loot_json: &str,
    ) -> Result<String, JsValue> {
        let snap: CampaignSnapshot = serde_json::from_str(snapshot_json).map_err(crate::js_err)?;
        let world = World::from_snapshot(snap);

        let catalog: Catalog = serde_json::from_str(catalog_json).map_err(crate::js_err)?;

        let opened_vec: Vec<String> =
            serde_json::from_str(opened_loot_json).map_err(crate::js_err)?;
        let opened_loot: BTreeSet<String> = opened_vec.into_iter().collect();

        let vm = world.view(&catalog, &opened_loot).map_err(crate::js_err)?;
        serde_json::to_string(&vm).map_err(crate::js_err)
    }

    /// Replay a sequence of commands against a starting snapshot, returning a JSON
    /// array of `{ command, cues, snapshot, view }` — one entry per command.
    /// Used by the conformance harness to validate command dispatch against the
    /// widened ViewModel.
    #[wasm_bindgen]
    pub fn replay_commands(
        start_snapshot_json: &str,
        commands_json: &str,
        catalog_json: &str,
        seed: u32,
    ) -> Result<String, JsValue> {
        use wickedways_core::presentation::PresentationCue;
        use wickedways_core::world::command::{apply_command, Command};
        use wickedways_core::world::World;
        let snap: CampaignSnapshot =
            serde_json::from_str(start_snapshot_json).map_err(crate::js_err)?;
        let mut world = World::from_snapshot(snap);
        let cat: Catalog = serde_json::from_str(catalog_json).map_err(crate::js_err)?;
        world.validate_mechanics(&cat).map_err(crate::js_err)?;
        world.seed_rng(seed);
        let commands: Vec<Command> = serde_json::from_str(commands_json).map_err(crate::js_err)?;
        let mut opened: BTreeSet<String> = BTreeSet::new();
        let mut steps = Vec::new();
        for cmd in commands {
            let mut cues: Vec<PresentationCue> = Vec::new();
            apply_command(&mut world, cmd.clone(), &cat, &mut opened, &mut cues)
                .map_err(crate::js_err)?;
            let vm = world.view(&cat, &opened).map_err(crate::js_err)?;
            steps.push(serde_json::json!({
                "command": cmd,
                "cues": cues,
                "snapshot": world.to_snapshot(),
                "view": vm,
            }));
        }
        serde_json::to_string(&steps).map_err(crate::js_err)
    }
}
