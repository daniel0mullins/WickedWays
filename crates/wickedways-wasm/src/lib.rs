use wasm_bindgen::prelude::*;

/// Toolchain smoke test: proves Rust→WASM→Node loading works end-to-end.
#[wasm_bindgen]
pub fn ping() -> i32 {
    42
}
