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
    /// JS-`Number.prototype.toString`-faithful number-to-string (spec: strings).
    Str { num: Box<Expr> },
    Concat { parts: alloc::vec::Vec<Expr> },

    // ── Read-model subjects (Task 3) ────────────────────────────────────────
    /// Current campaign round (`Null` in exit contexts).
    Round,
    /// Campaign round limit (`Null` in exit contexts).
    MaxRounds,
    /// The party as a list of character subjects.
    Party,
    /// The bound actor subject (turn/action contexts).
    Actor,
    /// The action subject (action contexts).
    Action,
    /// The damage subject (`modify_damage` context).
    Damage,
    /// The bound quantifier element (Task 6).
    Element,
    /// List length (`Party`/`List`), else `Null`.
    Length { list: Box<Expr> },
    /// Element at `index` (trunc); OOB/ill-typed → `Null`.
    Index { list: Box<Expr>, index: Box<Expr> },
    /// Element at index 0.
    First { list: Box<Expr> },
    /// Membership over a `List` by strict equality; `false` otherwise.
    Includes { list: Box<Expr>, value: Box<Expr> },
    /// Bounded existential quantifier over a subject/value list: `true` iff
    /// `pred` holds for at least one element. `some([])` is `false` (JS
    /// `Array.prototype.some`). `pred` reads the current item via `Element`.
    Some { list: Box<Expr>, pred: Box<Expr> },
    /// Bounded universal quantifier over a subject/value list: `true` iff
    /// `pred` holds for every element. `every([])` is vacuously `true` (JS
    /// `Array.prototype.every`). `pred` reads the current item via `Element`.
    Every { list: Box<Expr>, pred: Box<Expr> },
    /// Field access on a subject; unknown field / non-subject → `Null`.
    Get { of: Box<Expr>, field: String },
    /// `of` (a character) has an item with this behavior key equipped.
    HasEquipped { of: Box<Expr>, item_key: String },
    /// `of` (a character) holds an item with this behavior key.
    HasItem { of: Box<Expr>, item_key: String },
    /// `of` (a character) holds a key with this key code.
    HasKey { of: Box<Expr>, key_code: String },

    // ── Script state reads + static tables (Task 5) ─────────────────────────
    /// Read `state[field]`, or `default` when the field is missing / `null`
    /// / the ctx has no state (mirrors TS `state.x ?? default`).
    StateGet { field: String, default: Value },
    /// Read `state[map_field][String(key)]`, with the same defaulting
    /// (dynamic string-keyed maps — e.g. the storyteller's `seen[roomName]`).
    StateGetIn { map_field: String, key: Box<Expr>, default: Value },
    /// Value at `String(key)` in a static `MapLit`, else `Null`. Requires a
    /// `MapLit` operand (enforced at load, Task 9); a non-`MapLit` yields `Null`.
    Lookup { map: Box<Expr>, key: Box<Expr> },
    /// Whether a static `MapLit` contains `String(key)`. Non-`MapLit` → `false`.
    Has { map: Box<Expr>, key: Box<Expr> },
}
