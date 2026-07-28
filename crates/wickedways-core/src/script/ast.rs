//! The closed expression/statement AST (serde + ts-rs).
use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

use super::value::Value;
use crate::stats::StatType;

/// Binary operators — restricted to the IEEE-754 operations that are
/// bit-identical between Rust and JS, plus comparisons and boolean logic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

/// The closed expression set. Tagged on `kind` (codebase discriminant convention).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Expr {
    Lit {
        value: Value,
    },
    /// A literal static table (e.g. lore). Values are literals, not sub-exprs.
    /// Only legal as the `map` operand of `Lookup`/`Has` (enforced at load by
    /// `validate_behavior`).
    MapLit {
        entries: BTreeMap<String, Value>,
    },
    Bin {
        op: BinOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Not {
        expr: Box<Expr>,
    },
    IfElse {
        cond: Box<Expr>,
        then: Box<Expr>,
        r#else: Box<Expr>,
    },
    /// Non-null check (JS `!== undefined` semantics).
    Defined {
        expr: Box<Expr>,
    },
    /// JS-`Number.prototype.toString`-faithful number-to-string.
    Str {
        num: Box<Expr>,
    },
    Concat {
        parts: alloc::vec::Vec<Expr>,
    },

    // ── Read-model subjects ─────────────────────────────────────────────────
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
    /// The bound quantifier element.
    Element,
    /// List length (`Party`/`List`), else `Null`.
    Length {
        list: Box<Expr>,
    },
    /// Element at `index` (trunc); OOB/ill-typed → `Null`.
    Index {
        list: Box<Expr>,
        index: Box<Expr>,
    },
    /// Element at index 0.
    First {
        list: Box<Expr>,
    },
    /// Membership over a `List` by strict equality; `false` otherwise.
    Includes {
        list: Box<Expr>,
        value: Box<Expr>,
    },
    /// Bounded existential quantifier over a subject/value list: `true` iff
    /// `pred` holds for at least one element. `some([])` is `false` (JS
    /// `Array.prototype.some`). `pred` reads the current item via `Element`.
    Some {
        list: Box<Expr>,
        pred: Box<Expr>,
    },
    /// Bounded universal quantifier over a subject/value list: `true` iff
    /// `pred` holds for every element. `every([])` is vacuously `true` (JS
    /// `Array.prototype.every`). `pred` reads the current item via `Element`.
    Every {
        list: Box<Expr>,
        pred: Box<Expr>,
    },
    /// Field access on a subject; unknown field / non-subject → `Null`.
    Get {
        of: Box<Expr>,
        field: String,
    },
    /// `of` (a character) has an item with this behavior key equipped.
    HasEquipped {
        of: Box<Expr>,
        item_key: String,
    },
    /// `of` (a character) holds an item with this behavior key.
    HasItem {
        of: Box<Expr>,
        item_key: String,
    },
    /// `of` (a character) holds a key with this key code.
    HasKey {
        of: Box<Expr>,
        key_code: String,
    },

    // ── Script state reads + static tables ──────────────────────────────────
    /// Read `state[field]`, or `default` when the field is missing / `null`
    /// / the ctx has no state (JS `state.x ?? default` semantics).
    StateGet {
        field: String,
        default: Value,
    },
    /// Read `state[map_field][String(key)]`, with the same defaulting
    /// (dynamic string-keyed maps — e.g. the storyteller's `seen[roomName]`).
    StateGetIn {
        map_field: String,
        key: Box<Expr>,
        default: Value,
    },
    /// Value at `String(key)` in a static `MapLit`, else `Null`. Requires a
    /// `MapLit` operand (enforced at load); a non-`MapLit` yields `Null`.
    Lookup {
        map: Box<Expr>,
        key: Box<Expr>,
    },
    /// Whether a static `MapLit` contains `String(key)`. Non-`MapLit` → `false`.
    Has {
        map: Box<Expr>,
        key: Box<Expr>,
    },
}

/// A statement in an effect/script body. Tagged on `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Stmt {
    /// Falsy `cond` halts the body, keeping the accumulated output
    /// (short-circuit, not rollback).
    Guard { cond: Expr },
    /// Conditional block; a nested `Guard` still halts the whole body.
    When { cond: Expr, then: Vec<Stmt> },
    /// `state[field] = value` (own state only).
    SetState { field: String, value: Expr },
    /// `state[map_field][String(key)] = value` (own state only).
    SetStateIn {
        map_field: String,
        key: Expr,
        value: Expr,
    },
    /// Emit an effect (effect bodies only).
    Emit { effect: EffectTemplate },
    /// Exit narration (script bodies only); the last `Pass` wins.
    Pass { value: Expr },
}

/// A template producing one closed `Effect`. Tagged on `kind`; mirrors the
/// `Effect` set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EffectTemplate {
    Damage {
        target: Expr,
        amount: Expr,
    },
    Heal {
        target: Expr,
        amount: Expr,
    },
    AdjustStat {
        target: Expr,
        stat: StatType,
        delta: Expr,
    },
    GrantImmunity {
        target: Expr,
        turns: Expr,
    },
    Cue {
        text: Expr,
    },
    Status {
        fields: Vec<FieldTemplate>,
    },
    /// Hand `item` from `from` to `to` (`Effect::GiveItem`). `from`/`to` resolve as
    /// character ids, `item` as an item id.
    GiveItem {
        from: Expr,
        to: Expr,
        item: Expr,
    },
    /// Flip `target`'s `visible` flag (`Effect::SetVisible`). `visible` is evaluated
    /// for JS truthiness.
    SetVisible {
        target: Expr,
        visible: Expr,
    },
}

/// One `StatusField` template.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldTemplate {
    pub label: String,
    pub value: Expr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<Expr>,
}

/// The body of a `modify_damage` transform. Tagged on `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DamageBody {
    Value {
        expr: Expr,
    },
    /// Halts the fold — no later transform applies.
    Final {
        expr: Expr,
    },
    IfElse {
        cond: Expr,
        then: Box<DamageBody>,
        r#else: Box<DamageBody>,
    },
}

/// The six mechanic hook bodies. Each is optional; a missing hook is a no-op
/// at dispatch.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicHooks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_round_start: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_round_end: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_turn_start: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_turn_end: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_action: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modify_damage: Option<DamageBody>,
}

/// A campaign-authored mechanic behavior: a literal state seed, the six hooks,
/// and custom actions keyed by action key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MechanicScript {
    /// Literal JSON state seed. Deliberately plain data, NOT an Expr.
    pub init: serde_json::Value,
    #[serde(default)]
    pub hooks: MechanicHooks,
    /// Custom actions, keyed by action key. Always emitted (even when empty):
    /// the checked-in goldens always write `actions: {}`, and the ts-rs binding
    /// marks it required (not `ts(optional)`); `default` keeps older catalogs
    /// that lack `actions` deserializable.
    #[serde(default)]
    pub actions: BTreeMap<String, Vec<Stmt>>,
}

/// A campaign-authored exit behavior: a `can_pass` predicate plus an optional
/// narration script and pass/fail messages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitScript {
    pub can_pass: Expr,
    #[serde(default)]
    pub run_script: Vec<Stmt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_message: Option<String>,
}

/// A campaign-authored victory condition: a boolean `test` expression.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VictoryScript {
    pub test: Expr,
}

/// An item's author-defined behavior: effect bodies fired when the item is
/// used or read. Both are effect bodies (`Vec<Stmt>`, `allow_pass=false`),
/// identical in shape to mechanic hook bodies. Absent hook = no-op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemScript {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_use: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_read: Option<Vec<Stmt>>,
}

/// How a dialogue entry matches a player prompt. Tagged on `kind`; `Exact` is
/// full lowercased-string equality, `Fuzzy` is a token subset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DialogueMatch {
    Exact { text: String },
    Fuzzy { tokens: Vec<String> },
}

/// One prompt→response dialogue entry in an NPC behavior: a match rule, a text
/// `response` (a DSL `Expr`), optional emitted effects, and a `once` latch.
/// `match_` serializes as `"match"` (`match` is a Rust keyword).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueEntry {
    #[serde(rename = "match")]
    pub match_: DialogueMatch,
    pub response: Expr,
    #[serde(default)]
    pub effects: Vec<EffectTemplate>,
    #[serde(default)]
    pub once: bool,
}

/// A campaign-authored NPC dialogue behavior: a `description` (returned by
/// `examine`), a `default` entry (bare `talk`), and ordered prompt→response
/// `dialogue` entries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcScript {
    pub description: String,
    pub default: DialogueEntry,
    #[serde(default)]
    pub dialogue: Vec<DialogueEntry>,
}

/// A campaign-authored scene behavior: an optional `can_play` predicate gating
/// whether the scene may play, plus optional `on_enter`/`on_exit`
/// effect bodies. Mirrors the `MechanicScript`/`ItemScript` hook-body shape: the
/// bodies are effect bodies (`Vec<Stmt>`, `allow_pass=false`, `allow_emit=true`),
/// and `can_play` is a predicate `Expr`. Absent hook = no-op.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneScript {
    /// Predicate gating whether the scene may play; absent = always playable.
    #[serde(default)]
    pub can_play: Option<Expr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_enter: Option<Vec<Stmt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_exit: Option<Vec<Stmt>>,
}

/// A scripted behavior, tagged on `family` (mechanic / exit / victory / item / npc / scene).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "camelCase")]
pub enum BehaviorScript {
    Mechanic { script: MechanicScript },
    Exit { script: ExitScript },
    Victory { script: VictoryScript },
    Item { script: ItemScript },
    Npc { script: NpcScript },
    Scene { script: SceneScript },
}
