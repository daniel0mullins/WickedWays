//! The `conformance:dread` first-party op, gated behind `cfg(any(test, feature =
//! "conformance"))` (see `mod.rs`) so it is present for unit tests and the
//! differential conformance harness but absent from the default no_std/wasm
//! build. Placeholder behavior only — Task 7 fills in the real hooks.
use super::MechanicOp;

pub struct Dread;

impl MechanicOp for Dread {
    fn init_state(&self, _config: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({"ticks": 0})
    }
}

pub static DREAD: Dread = Dread;
