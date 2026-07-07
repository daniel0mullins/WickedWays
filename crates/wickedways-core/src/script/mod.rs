//! Scripted-ops DSL (spec: 2026-07-06-rust-engine-scripted-ops-dsl-design.md).
//! A closed, serde-serializable AST + a pure, total, deterministic interpreter.
//! `alloc`-only — this module must build under `--no-default-features`.
pub mod ast;
pub mod eval;
pub mod value;
