use wasm_bindgen::prelude::*;
use wickedways_core::{compute_mitigated_damage, CampaignSnapshot, DamageInput, StatType, World};

/// Toolchain smoke test: proves Rust→WASM→Node loading works end-to-end.
#[wasm_bindgen]
pub fn ping() -> i32 {
    42
}

/// Returns the mitigating stat for `stat`, as serde strings, for the
/// conformance harness to diff against the TS `MitigatorStatType`.
#[wasm_bindgen]
pub fn mitigator(stat: &str) -> Result<String, JsValue> {
    let parsed: StatType = serde_json::from_value(serde_json::Value::String(stat.to_string()))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = serde_json::to_value(parsed.mitigator())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let s = out.as_str().ok_or_else(|| JsValue::from_str("expected string stat"))?;
    Ok(s.to_string())
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

/// Parse a CampaignSnapshot JSON, fold into the id-keyed World, and re-emit.
/// Used by the conformance harness to prove byte-faithful round-trip vs TS.
#[wasm_bindgen]
pub fn roundtrip_snapshot(json: &str) -> Result<String, JsValue> {
    let snap: CampaignSnapshot =
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let out = World::from_snapshot(snap).to_snapshot();
    serde_json::to_string(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Replay a sequence of commands against a starting snapshot, returning a JSON
/// array of `{ command, cues, snapshot, viewThin }` — one entry per command.
/// Used by the conformance harness (sub-plan 2) to validate Rust command dispatch.
#[wasm_bindgen]
pub fn replay_commands(start_snapshot_json: &str, commands_json: &str) -> Result<String, JsValue> {
    use wickedways_core::presentation::PresentationCue;
    use wickedways_core::world::command::{apply_command, Command};
    use wickedways_core::world::World;
    let snap: CampaignSnapshot =
        serde_json::from_str(start_snapshot_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut world = World::from_snapshot(snap);
    let commands: Vec<Command> =
        serde_json::from_str(commands_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let mut steps = Vec::new();
    for cmd in commands {
        let mut cues: Vec<PresentationCue> = Vec::new();
        apply_command(&mut world, cmd.clone(), &mut cues)
            .map_err(|e| JsValue::from_str(&e.0))?;
        let view = world.view_thin().map_err(|e| JsValue::from_str(&e.0))?;
        steps.push(serde_json::json!({
            "command": cmd,
            "cues": cues,
            "snapshot": world.to_snapshot(),
            "viewThin": view,
        }));
    }
    serde_json::to_string(&steps).map_err(|e| JsValue::from_str(&e.to_string()))
}
