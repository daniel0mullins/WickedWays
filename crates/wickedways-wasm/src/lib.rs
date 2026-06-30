use wasm_bindgen::prelude::*;
use wickedways_core::StatType;

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
    Ok(out.as_str().unwrap().to_string())
}
