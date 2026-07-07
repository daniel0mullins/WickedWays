//! The closed expression/statement AST (serde + ts-rs). Grown across Tasks 1-9;
//! this task lands the pure-expression subset.
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use super::value::Value;

/// Binary operators — restricted to the IEEE-754 operations that are
/// bit-identical between Rust and JS, plus comparisons and boolean logic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum BinOp { Add, Sub, Mul, Div, Eq, Ne, Lt, Lte, Gt, Gte, And, Or }

/// The closed expression set. Tagged on `kind` (codebase discriminant convention).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Expr {
    Lit { value: Value },
    /// A literal static table (e.g. lore). Values are literals, not sub-exprs.
    /// Only legal as the `map` operand of `Lookup`/`Has` (enforced at load by
    /// `validate_behavior`, Task 9).
    MapLit { entries: BTreeMap<String, Value> },
    Bin { op: BinOp, left: Box<Expr>, right: Box<Expr> },
    Not { expr: Box<Expr> },
    IfElse { cond: Box<Expr>, then: Box<Expr>, r#else: Box<Expr> },
    /// Non-null check (mirrors TS `!== undefined`).
    Defined { expr: Box<Expr> },
}
