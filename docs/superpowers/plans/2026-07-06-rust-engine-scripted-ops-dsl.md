# Rust Engine — Scripted-Ops DSL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `wickedways-core` a closed, deterministic data-AST scripting language (value + expression + statement model, pure interpreter, three adapter ops), re-author all eight Hollow House ops (3 mechanics, 2 exits, 3 victory conditions) as scripts stored in `Catalog.behaviors`, and gate them byte-for-byte against the existing hand-written TS closures — so Hollow House can boot on the Rust core.

**Architecture:** A new `alloc`-only module `crates/wickedways-core/src/script/` holds the serde/ts-rs AST (`value.rs`, `ast.rs`), a total pure interpreter (`eval.rs`), and adapter ops (`ops.rs`) that implement the existing Phase-1 traits (`MechanicOp`, `ExitBehavior`, victory predicate) by interpreting a stored AST. The dispatch sites gain a native-then-scripted resolution seam over `Catalog.behaviors: BTreeMap<String, BehaviorScript>`; effect application, the 64-effect cap, and the `modify_damage` fold are untouched. TS authors write scripts through typed builders that emit the ts-rs-generated AST types; differential fixtures diff each scripted op against its TS-closure oracle.

**Tech Stack:** Rust (`no_std` + `alloc`, serde, serde_json, ts-rs 10), wasm-pack/wasm-bindgen (existing `replay_commands` harness), TypeScript + Vitest (builders, fixture generators, differential replay tests), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-06-rust-engine-scripted-ops-dsl-design.md` (master: `2026-06-30-rust-engine-core-design.md`). The text DSL + VS Code plugin are an explicit follow-on — OUT of scope here.

## Global Constraints

- The `no_std` core stays `alloc`-only and `cargo build -p wickedways-core --no-default-features` must pass.
- The `script/` module is `alloc`-only.
- The differential gate is the authority — fix divergences in the AST/interpreter, NEVER edit goldens or `conformance/canonical-json.ts`.
- Every new `.gen.test.ts` must be registered in `conformance/fixtures/vitest.config.ts` (it is an EXPLICIT include list).
- TS boundary/AST types are generated via ts-rs, not hand-edited (`bindings:check` fails on drift).
- The interpreter is pure: only the injected rng, no clock, f64 restricted to + − × ÷ and comparisons, deterministic `BTreeMap`/ordered iteration.
- `Str(number)` must match JS `Number.prototype.toString` byte-for-byte.
- Scripts return effects / bool / `Option<String>` and never mutate engine state directly (the engine applies returned effects; scripts may only touch their own JSON state through `SetState`/`SetStateIn`).
- Ops re-authored must reproduce the existing hand-written TS Hollow House closures (`packages/campaigns/src/hollow-house/{mechanics,status,content,index}.ts`) exactly — those closures are the oracle.
- Illegal load-time states throw `ProceduralViolation` (existing message shapes preserved: `"Mechanic '{key}' is not registered."`, `"Exit behavior '{key}' is not registered."`, `"No condition registered for key '{key}'."`).

---

## File Structure

**Create — Rust (`crates/wickedways-core/src/`):**

| File | Responsibility |
|---|---|
| `script/mod.rs` | Module root (`value`, `ast`, `eval`, `ops`) + `validate_behavior` (load-time AST shape check). |
| `script/value.rs` | `Value` (Number/Bool/Str/List/Null, serde-untagged, ts-rs name `ScriptValue`), JS `ToBoolean` truthiness, `format_js_number` (JS `Number.prototype.toString` parity), `value_to_json`/`json_to_value`. |
| `script/ast.rs` | Closed serde/ts-rs AST: `BinOp`, `Expr`, `Stmt`, `EffectTemplate`, `FieldTemplate`, `DamageBody`, `MechanicHooks`, `MechanicScript`, `ExitScript`, `VictoryScript`, `BehaviorScript`. |
| `script/eval.rs` | Interpreter: `Ev` (runtime result incl. character/room subjects), `Ctx`/`CtxState`/`RoomSource`, `eval_expr`, `eval_predicate`, `eval_effects`, `eval_script`, `eval_damage`. |
| `script/ops.rs` | `ScriptedMechanic` (impl `MechanicOp`), `ScriptedExit` (impl `ExitBehavior`), `ScriptedVictory` (victory predicate evaluated with a lazy World-backed room resolver). |

**Modify — Rust:**

| File | Change |
|---|---|
| `src/lib.rs` | `pub mod script;` |
| `world/descriptor.rs` | `Catalog.behaviors: BTreeMap<String, BehaviorScript>` (`#[serde(default, skip_serializing_if = ...)]`). |
| `world/mechanics/mod.rs` | Widen `ActionView` with `room: Option<RoomRef>`; add `ResolvedMechanicOp` + `resolve_mechanic_op(key, cat)`. |
| `world/mechanics/view.rs` | `CharacterView` gains `key_codes` + `has_key(code)` (built from inventory `key_ids` → `ItemSnapshot::Key.key_code`). |
| `world/mechanics/dispatch.rs` | All 5 `mechanic_op(..)` sites (`dispatch_round`, `dispatch_turn`, `dispatch_action`, `run_damage_transformers`, `use_mechanic_action`) resolve native-then-scripted; `validate_mechanics(&self, cat: &Catalog)` widened (mechanics + exits + victory keys, plus scripted shape checks). |
| `world/exits.rs` | `ResolvedExitBehavior` + `resolve_exit_behavior(key, cat)`. |
| `world/victory.rs` | `ResolvedVictory` + `resolve_victory(key, cat)`. |
| `world/movement.rs` | `go` uses `resolve_exit_behavior`; `move_to` passes a move-payload `ActionView` to `record_action`. |
| `world/turn.rs` | `record_action` takes `ActionView` (was `&str`); `resolve_outcome` uses `resolve_victory` and evaluates scripted conditions with the World-backed room resolver. |
| `world/combat.rs`, `world/items_actions.rs`, `world/gate.rs` | `record_action` call sites pass `ActionView::of(..)`. |
| `stats.rs` | `export_typescript_bindings` exports the new script AST types. |
| `crates/wickedways-wasm/src/lib.rs` | Parse the catalog BEFORE `validate_mechanics` and pass `&cat`. |

**Create — TypeScript:**

| File | Responsibility |
|---|---|
| `packages/campaigns/src/scripted/builders.ts` | Typed builder helpers emitting the ts-rs-generated AST (`Expr`/`Stmt`/`EffectTemplate`/`BehaviorScript`). |
| `packages/campaigns/src/scripted/index.ts` | Re-export surface (`@wickedways/campaigns/scripted`). |
| `packages/campaigns/src/scripted/builders.test.ts` | Builder output === expected AST JSON. |
| `packages/campaigns/src/hollow-house/scripted.ts` | The eight Hollow House ops re-authored as `BehaviorScript`s (`hollowHouseBehaviors()`). |
| `packages/campaigns/src/hollow-house/scripted.test.ts` | Scripted ASTs match their oracle shapes (spot checks). |
| `conformance/fixtures/scripted-helpers.ts` | Shared catalog exporter (`itemToCatalogEntry`/`buildCatalog` with a `behaviors` slot). |
| `conformance/fixtures/scripted-mechanics.gen.test.ts` (+ `.catalog/.start.snapshot/.golden.json`) | Differential generator: dread + storyteller + status-bar. |
| `conformance/fixtures/scripted-doors.gen.test.ts` (+ json) | Differential generator: study-door / attic-door. |
| `conformance/fixtures/scripted-victory-won.gen.test.ts`, `scripted-victory-sanity.gen.test.ts`, `scripted-victory-partydown.gen.test.ts` (+ json) | Differential generators: the three victory conditions. |
| `conformance/fixtures/hollow-victory-shadow.ts` | TS shadows of the three HH victory lambdas (byte-same as `packages/campaigns/src/hollow-house/index.ts:23-28`). |
| `conformance/scripted-mechanics.test.ts`, `scripted-doors.test.ts`, `scripted-victory-won.test.ts`, `scripted-victory-sanity.test.ts`, `scripted-victory-partydown.test.ts` | Differential replay tests (Rust wasm vs goldens). |

**Modify — TypeScript/config:** `conformance/fixtures/vitest.config.ts` (register 5 generators), `README.md` (living docs, final task).

### Noted deviations from the spec (forced by file reads)

1. **`MechanicScript.init` is plain `serde_json::Value`, not an `Expr`.** The spec's own value model has no map value, so `initialState: () => ({ seen: {} })` (`packages/campaigns/src/hollow-house/mechanics.ts:15`) — a nested empty object — is unrepresentable as a `Value` literal. `init` is authored as literal JSON and `init_state` returns a clone (trivially "evaluated once"). Replay never calls `init_state` (state hydrates from the snapshot), so the gate is unaffected.
2. **`ScriptedVictory` does not implement the `VictoryConditionBehavior` trait.** `test(&self, campaign: &CampaignView)` (`world/victory.rs:10-12`) cannot reach the `World` that the lazy `character.room` resolver needs. The seam in `resolve_outcome` matches on `ResolvedVictory` and evaluates scripted conditions via `World::eval_victory` with a memoizing `RoomSource::World`. Native conditions go through the trait unchanged.
3. **The room resolver is wired only where the oracle can see rooms.** TS mechanic hooks receive a `CharacterView` with `roomId` only — no room object (`src/lib/mechanics/mechanic.ts:26-38`) — and the HH exits never read rooms; only victory reads the live campaign (`pc.currentRoom`). So mechanic/exit contexts use `RoomSource::None` (→ `Get(char,"room")` = Null) and victory uses `RoomSource::World`. This is faithful, not a restriction.
4. **Serde tag for `Expr`/`Stmt`/`EffectTemplate` is `"kind"`** (the codebase-wide discriminant convention — `Effect`, `PresentationCue`, `Command`, `ItemSnapshot` all tag on `kind`); the spec's `Bin(op,…)` field would collide with a tag named `op`.

Task order honors the mandated dependencies: `ActionView` widening (Task 8) lands before the storyteller fixture (Task 12); `character.room` (Task 4) lands before victory (Task 14).

---

### Task 1: Value model + pure-expression eval

**Files:**
- Create: `crates/wickedways-core/src/script/mod.rs`
- Create: `crates/wickedways-core/src/script/value.rs`
- Create: `crates/wickedways-core/src/script/ast.rs`
- Create: `crates/wickedways-core/src/script/eval.rs`
- Modify: `crates/wickedways-core/src/lib.rs`
- Test: inline `#[cfg(test)]` modules in `value.rs` / `eval.rs`

**Interfaces:**
- Produces: `script::value::Value` (`Bool`/`Number(f64)`/`Str(String)`/`List(Vec<Value>)`/`Null`, serde-untagged) with `Value::truthy() -> bool`; `script::ast::{BinOp, Expr}` with variants `Lit`, `MapLit`, `Bin`, `Not`, `IfElse`, `Defined`; `script::eval::eval_expr(&Expr, &mut Ctx) -> Value` with a placeholder `pub struct Ctx;` (replaced by the real context in Task 3 — later tasks change this signature deliberately).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-core/src/script/mod.rs`:

```rust
//! Scripted-ops DSL (spec: 2026-07-06-rust-engine-scripted-ops-dsl-design.md).
//! A closed, serde-serializable AST + a pure, total, deterministic interpreter.
//! `alloc`-only — this module must build under `--no-default-features`.
pub mod ast;
pub mod eval;
pub mod value;
```

Create `crates/wickedways-core/src/script/value.rs` with ONLY the enum + truthy stub so the tests compile-fail meaningfully (or write tests first inside the final file — either way run them before implementing eval). The tests to land in `eval.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::ast::{BinOp, Expr};
    use crate::script::value::Value;

    fn lit(v: Value) -> Box<Expr> { Box::new(Expr::Lit { value: v }) }
    fn n(x: f64) -> Box<Expr> { lit(Value::Number(x)) }
    fn ev(e: &Expr) -> Value { eval_expr(e, &mut Ctx) }

    #[test]
    fn arithmetic_is_ieee_f64() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::Add, left: n(0.1), right: n(0.2) }),
                   Value::Number(0.1 + 0.2)); // bit-identical to JS 0.1+0.2
        assert_eq!(ev(&Expr::Bin { op: BinOp::Mul, left: n(3.0), right: n(1.2) }),
                   Value::Number(3.0 * 1.2));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Div, left: n(1.0), right: n(0.0) }),
                   Value::Number(f64::INFINITY)); // JS 1/0
        // non-number operand -> Null (total, defined)
        assert_eq!(ev(&Expr::Bin { op: BinOp::Add, left: n(1.0), right: lit(Value::Null) }),
                   Value::Null);
    }

    #[test]
    fn comparisons_and_equality() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::Lt,  left: n(2.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Lte, left: n(3.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Gt,  left: n(2.0), right: n(3.0) }), Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Gte, left: n(3.0), right: n(3.0) }), Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq,
            left: lit(Value::Str("move".into())), right: lit(Value::Str("move".into())) }),
            Value::Bool(true));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Ne,
            left: lit(Value::Str("move".into())), right: lit(Value::Str("take".into())) }),
            Value::Bool(true));
        // mixed types are never equal; Null == Null is true (JS null === null)
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq, left: n(1.0), right: lit(Value::Str("1".into())) }),
                   Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Eq, left: lit(Value::Null), right: lit(Value::Null) }),
                   Value::Bool(true));
    }

    #[test]
    fn boolean_logic_uses_js_truthiness() {
        assert_eq!(ev(&Expr::Bin { op: BinOp::And,
            left: lit(Value::Bool(true)), right: lit(Value::Bool(false)) }), Value::Bool(false));
        assert_eq!(ev(&Expr::Bin { op: BinOp::Or,
            left: lit(Value::Bool(false)), right: n(5.0) }), Value::Bool(true)); // 5 is truthy
        assert_eq!(ev(&Expr::Not { expr: lit(Value::Str(String::new())) }), Value::Bool(true)); // "" falsy
        assert_eq!(ev(&Expr::Not { expr: lit(Value::Null) }), Value::Bool(true));
    }

    #[test]
    fn if_else_and_defined() {
        assert_eq!(ev(&Expr::IfElse {
            cond: lit(Value::Bool(true)), then: n(1.0), r#else: n(2.0) }), Value::Number(1.0));
        assert_eq!(ev(&Expr::IfElse {
            cond: lit(Value::Null), then: n(1.0), r#else: n(2.0) }), Value::Number(2.0));
        assert_eq!(ev(&Expr::Defined { expr: n(0.0) }), Value::Bool(true)); // 0 is defined
        assert_eq!(ev(&Expr::Defined { expr: lit(Value::Null) }), Value::Bool(false));
    }
}
```

And in `value.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_matches_js_to_boolean() {
        assert!(Value::Bool(true).truthy());
        assert!(!Value::Bool(false).truthy());
        assert!(Value::Number(5.0).truthy());
        assert!(!Value::Number(0.0).truthy());
        assert!(!Value::Number(f64::NAN).truthy());
        assert!(Value::Str("x".into()).truthy());
        assert!(!Value::Str(String::new()).truthy());
        assert!(Value::List(alloc::vec![]).truthy()); // JS: [] is truthy
        assert!(!Value::Null.truthy());
    }

    #[test]
    fn value_serializes_untagged_as_plain_json() {
        assert_eq!(serde_json::to_value(Value::Number(2.5)).unwrap(), serde_json::json!(2.5));
        assert_eq!(serde_json::to_value(Value::Str("x".into())).unwrap(), serde_json::json!("x"));
        assert_eq!(serde_json::to_value(Value::Bool(true)).unwrap(), serde_json::json!(true));
        assert_eq!(serde_json::to_value(Value::Null).unwrap(), serde_json::json!(null));
        assert_eq!(
            serde_json::to_value(Value::List(alloc::vec![Value::Number(1.0), Value::Str("a".into())])).unwrap(),
            serde_json::json!([1.0, "a"]));
        let v: Value = serde_json::from_value(serde_json::json!(["a", 2.0, null])).unwrap();
        assert_eq!(v, Value::List(alloc::vec![Value::Str("a".into()), Value::Number(2.0), Value::Null]));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p wickedways-core script`
Expected: compile error (`eval_expr`/`Value` not defined) — a compile failure IS the failing state here.

- [ ] **Step 3: Write the implementation**

`crates/wickedways-core/src/script/value.rs`:

```rust
//! Closed runtime value type for the scripted-ops DSL. `alloc`-only.
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// The closed set of first-class script values (spec: value model). Serialized
/// UNTAGGED so authored literals read as plain JSON (`5`, `"x"`, `true`, `[..]`,
/// `null`). Numbers are f64 to match TS `number`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export, rename = "ScriptValue"))]
#[serde(untagged)]
pub enum Value {
    Bool(bool),
    Number(f64),
    Str(String),
    List(Vec<Value>),
    Null,
}

impl Value {
    /// JS `ToBoolean`: `false`, `0`, `-0`, `NaN`, `""` and `null` are falsy;
    /// everything else (including empty lists — JS objects) is truthy.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::List(_) => true,
            Value::Null => false,
        }
    }
}
```

`crates/wickedways-core/src/script/ast.rs`:

```rust
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
```

`crates/wickedways-core/src/script/eval.rs` (Task-1 form — `Ctx` is a placeholder replaced in Task 3):

```rust
//! The interpreter. Pure and TOTAL: no panics, no clock, no io; missing/ill-typed
//! reads resolve to `Null`/defaults. `alloc`-only.
use super::ast::{BinOp, Expr};
use super::value::Value;

/// Evaluation context. Task-1 placeholder — Task 3 replaces this with the real
/// borrowing context (view/state/actor/action/damage/rooms/rng).
pub struct Ctx;

pub fn eval_expr(e: &Expr, cx: &mut Ctx) -> Value {
    match e {
        Expr::Lit { value } => value.clone(),
        // A bare MapLit is only legal under Lookup/Has (load-time check, Task 9).
        Expr::MapLit { .. } => Value::Null,
        Expr::Not { expr } => Value::Bool(!eval_expr(expr, cx).truthy()),
        Expr::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() { eval_expr(then, cx) } else { eval_expr(r#else, cx) }
        }
        Expr::Defined { expr } => Value::Bool(!matches!(eval_expr(expr, cx), Value::Null)),
        Expr::Bin { op, left, right } => {
            let l = eval_expr(left, cx);
            let r = eval_expr(right, cx);
            eval_bin(*op, &l, &r)
        }
    }
}

fn eval_bin(op: BinOp, l: &Value, r: &Value) -> Value {
    use BinOp::*;
    match op {
        And => Value::Bool(l.truthy() && r.truthy()),
        Or => Value::Bool(l.truthy() || r.truthy()),
        Eq => Value::Bool(vals_eq(l, r)),
        Ne => Value::Bool(!vals_eq(l, r)),
        Add | Sub | Mul | Div => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Number(match op {
                Add => a + b, Sub => a - b, Mul => a * b, Div => a / b,
                _ => unreachable!(),
            }),
            _ => Value::Null, // non-numeric arithmetic: total, defined
        },
        Lt | Lte | Gt | Gte => match (l, r) {
            (Value::Number(a), Value::Number(b)) => Value::Bool(match op {
                Lt => a < b, Lte => a <= b, Gt => a > b, Gte => a >= b,
                _ => unreachable!(),
            }),
            _ => Value::Bool(false),
        },
    }
}

/// Strict same-type equality (mirrors the oracle's `===` uses). Mixed types are
/// never equal; `Null == Null` is true.
fn vals_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Str(a), Value::Str(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Null, Value::Null) => true,
        (Value::List(a), Value::List(b)) => a == b,
        _ => false,
    }
}
```

Wire the module in `crates/wickedways-core/src/lib.rs` — after `pub mod world;` add:

```rust
pub mod script;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: all `script::` tests PASS; the no-default-features build compiles (proves `alloc`-only).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/lib.rs crates/wickedways-core/src/script/
git commit -m "feat(script): value model + pure-expression interpreter (scripted-ops T1)"
```

---

### Task 2: `Str(number)` (JS-faithful) + Concat

**Files:**
- Modify: `crates/wickedways-core/src/script/value.rs` (add `format_js_number`, `coerce_str`)
- Modify: `crates/wickedways-core/src/script/ast.rs` (add `Expr::Str`, `Expr::Concat`)
- Modify: `crates/wickedways-core/src/script/eval.rs` (eval arms)

**Interfaces:**
- Produces: `pub fn format_js_number(n: f64) -> String` (byte-for-byte JS `Number.prototype.toString`); `pub fn coerce_str(v: &Value) -> String` (JS `String()` coercion); `Expr::Str { num: Box<Expr> }`, `Expr::Concat { parts: Vec<Expr> }`.
- Consumes: `Value`, `eval_expr` from Task 1.

**Implementation choice (the design's top risk):** hand-rolled, `alloc`-only. Rust's `{:e}` (LowerExp) already emits the unique shortest round-trip digit string — the same digits JS computes — so the formatter extracts `digits`/`exponent` from `format!("{:e}")` and re-assembles per the ECMA-262 §6.1.6.1.20 notation rules (fixed notation for `1e-6 ≤ |x| < 1e21`, exponential outside). No new crate, no `std`. This is additionally gate-validated end-to-end in Task 12 (status-bar's `Status` fields cross the comparator as strings).

- [ ] **Step 1: Write the failing tests** (in `value.rs` tests module)

```rust
    #[test]
    fn format_js_number_matches_number_prototype_tostring() {
        // Oracle values produced with: node -e 'for (const x of [16,2.5,0.1,3.6,-1.5,0,-0,15,7,3.2,
        //   0.30000000000000004,1/3,1e21,1e-7,0.000001,123456789.123]) console.log(String(x))'
        let cases: &[(f64, &str)] = &[
            (16.0, "16"),
            (2.5, "2.5"),
            (0.1, "0.1"),
            (3.6, "3.6"),                       // the dread pre-cap damage value
            (-1.5, "-1.5"),
            (0.0, "0"),
            (-0.0, "0"),                        // JS String(-0) === "0"
            (15.0, "15"),
            (7.0, "7"),
            (3.2, "3.2"),                       // a darkness-multiplier-shaped fraction
            (0.1 + 0.2, "0.30000000000000004"), // shortest-roundtrip 17 digits
            (1.0 / 3.0, "0.3333333333333333"),
            (1e21, "1e+21"),                    // exponential at the 1e21 boundary
            (1e-7, "1e-7"),                     // exponential below 1e-6
            (0.000001, "0.000001"),             // fixed AT the 1e-6 boundary
            (123456789.123, "123456789.123"),
        ];
        for (n, want) in cases {
            assert_eq!(format_js_number(*n), *want, "for {n:?}");
        }
        assert_eq!(format_js_number(f64::NAN), "NaN");
        assert_eq!(format_js_number(f64::INFINITY), "Infinity");
        assert_eq!(format_js_number(f64::NEG_INFINITY), "-Infinity");
    }
```

And in `eval.rs` tests:

```rust
    #[test]
    fn str_and_concat_build_js_strings() {
        assert_eq!(ev(&Expr::Str { num: n(16.0) }), Value::Str("16".into()));
        assert_eq!(ev(&Expr::Str { num: lit(Value::Str("x".into())) }), Value::Str("x".into()));
        // `${round}/${maxRounds}` shape:
        assert_eq!(ev(&Expr::Concat { parts: alloc::vec![
            Expr::Str { num: n(3.0) },
            Expr::Lit { value: Value::Str("/".into()) },
            Expr::Str { num: n(150.0) },
        ]}), Value::Str("3/150".into()));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script`
Expected: compile error (`format_js_number`, `Expr::Str` undefined).

- [ ] **Step 3: Implement**

In `value.rs`:

```rust
use alloc::format;
use alloc::string::ToString;

/// Byte-for-byte JS `Number.prototype.toString` (ECMA-262 §6.1.6.1.20, base 10).
/// Digits come from Rust's `{:e}` (shortest round-trip — the same unique digit
/// string V8 computes); this function only re-assembles the NOTATION, since JS
/// switches to exponential form outside [1e-6, 1e21) while Rust never does.
pub fn format_js_number(n: f64) -> String {
    if n.is_nan() { return "NaN".to_string(); }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if n == 0.0 { return "0".to_string(); } // covers -0.0: JS String(-0) === "0"
    let neg = n < 0.0;
    let a = if neg { -n } else { n };
    // "d.dddde<exp>" or "d e<exp>"; mantissa digits are ASCII.
    let exp_str = format!("{a:e}");
    let (mant, exp) = exp_str.split_once('e').expect("LowerExp always contains 'e'");
    let exp: i32 = exp.parse().expect("LowerExp exponent is an integer");
    let all: String = mant.chars().filter(|c| *c != '.').collect();
    let trimmed = all.trim_end_matches('0');
    let digits = if trimmed.is_empty() { "0" } else { trimmed };
    let k = digits.len() as i32; // significant digit count
    let pos = exp + 1;           // ECMA "n": value = digits × 10^(pos − k)
    let mut s = String::new();
    if neg { s.push('-'); }
    if k <= pos && pos <= 21 {
        // integer, zero-padded: e.g. 1e2 -> "100"
        s.push_str(digits);
        for _ in 0..(pos - k) { s.push('0'); }
    } else if 0 < pos && pos <= 21 {
        // decimal point inside the digits: e.g. "2.5", "123456789.123"
        s.push_str(&digits[..pos as usize]);
        s.push('.');
        s.push_str(&digits[pos as usize..]);
    } else if -6 < pos && pos <= 0 {
        // leading zeros: e.g. "0.000001"
        s.push_str("0.");
        for _ in 0..(-pos) { s.push('0'); }
        s.push_str(digits);
    } else {
        // exponential: e.g. "1e+21", "1e-7", "1.5e+22"
        s.push_str(&digits[..1]);
        if digits.len() > 1 { s.push('.'); s.push_str(&digits[1..]); }
        s.push('e');
        let e = pos - 1;
        if e >= 0 { s.push('+'); }
        s.push_str(&format!("{e}"));
    }
    s
}

/// JS `String()` coercion over the closed value set (used by `Str`, `Concat`,
/// and cue-text coercion).
pub fn coerce_str(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Number(n) => format_js_number(*n),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Null => "null".to_string(),
        Value::List(items) => {
            // JS Array.prototype.toString: comma-joined elements (null -> "").
            let mut out = String::new();
            for (i, it) in items.iter().enumerate() {
                if i > 0 { out.push(','); }
                if !matches!(it, Value::Null) { out.push_str(&coerce_str(it)); }
            }
            out
        }
    }
}
```

In `ast.rs`, add to `Expr`:

```rust
    /// JS-`Number.prototype.toString`-faithful number-to-string (spec: strings).
    Str { num: Box<Expr> },
    Concat { parts: alloc::vec::Vec<Expr> },
```

In `eval.rs`, add arms (and `use super::value::coerce_str;`):

```rust
        Expr::Str { num } => Value::Str(coerce_str(&eval_expr(num, cx))),
        Expr::Concat { parts } => {
            let mut out = alloc::string::String::new();
            for p in parts {
                out.push_str(&coerce_str(&eval_expr(p, cx)));
            }
            Value::Str(out)
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: PASS (all cases byte-equal to the node oracle values embedded in the test).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/
git commit -m "feat(script): JS-faithful num->string + Concat (scripted-ops T2)"
```

---

### Task 3: Eval Ctx + campaign/character reads

**Files:**
- Modify: `crates/wickedways-core/src/script/eval.rs` (real `Ctx`, `Ev`, subject reads)
- Modify: `crates/wickedways-core/src/script/ast.rs` (read exprs)
- Modify: `crates/wickedways-core/src/world/mechanics/view.rs` (`CharacterView.key_codes` + `has_key`)

**Interfaces:**
- Produces:
  - `view.rs`: `CharacterView::has_key(&self, code: &str) -> bool` (matches inventory keys by `key_code`, built from `inventory.key_ids` → `ItemSnapshot::Key.key_code`).
  - `eval.rs`:
    ```rust
    pub enum Ev { Val(Value), Char(CharacterView), Room(RoomView), RoomRef(RoomRef), Chars(Vec<CharacterView>), Action(ActionView), Damage(DamageView) }
    pub enum CtxState<'a> { None, Read(&'a serde_json::Value), Write(&'a mut serde_json::Value) }
    pub enum RoomSource<'a> { None, World { world: &'a World, cat: &'a Catalog, cache: BTreeMap<String, Option<RoomView>> } }
    pub struct Ctx<'a> {
        pub view: Option<&'a CampaignView>,
        pub state: CtxState<'a>,
        pub actor: Option<&'a CharacterView>,
        pub action: Option<&'a ActionView>,
        pub damage: Option<&'a DamageView>,
        pub element: Option<Ev>,
        pub rng: Option<&'a mut crate::world::rng::Rng>,
        pub rooms: RoomSource<'a>,
    }
    impl<'a> Ctx<'a> { pub fn empty() -> Ctx<'a>; }  // all None / CtxState::None / RoomSource::None
    pub fn eval_expr(e: &Expr, cx: &mut Ctx) -> Ev
    impl Ev { pub fn truthy(&self) -> bool; pub fn into_value(self) -> Value; }
    ```
    `eval_expr` now returns `Ev`; `Ev::Val` wraps plain values; subject variants are truthy (JS objects) and `into_value()` maps non-`Val` subjects to `Value::Null`. Task-1/2 tests are updated mechanically: `ev()` helper becomes `eval_expr(e, &mut Ctx::empty()).into_value()`.
  - `ast.rs` new `Expr` variants: `Round`, `MaxRounds`, `Party`, `Actor`, `Action`, `Damage`, `Element`, `Length { list }`, `Index { list, index }`, `First { list }`, `Includes { list, value }`, `Get { of: Box<Expr>, field: String }`, `HasEquipped { of: Box<Expr>, item_key: String }`, `HasItem { of: Box<Expr>, item_key: String }`, `HasKey { of: Box<Expr>, key_code: String }`.
- Consumes: `CampaignView`/`CharacterView`/`RoomView`/`DamageView` (`world/mechanics/view.rs`), `ActionView` (`world/mechanics/mod.rs` — pre-widening `{ kind }`; `Get(Action,"room")` returns Null until Task 8), `RoomRef` (`world/history.rs`), `Rng` (`world/rng.rs`).

**Read semantics (total; ill-typed → `Null`/`false`):**

| Read | Result |
|---|---|
| `Round` / `MaxRounds` | `Number(view.round as f64)` / `Number(view.max_rounds as f64)`; `Null` when `view` is `None` (exit contexts). |
| `Party` | `Ev::Chars(view.party.clone())`; empty list when `view` is `None`. |
| `Actor` / `Action` / `Damage` / `Element` | the corresponding ctx subject, else `Null`. |
| `Length(list)` | `Chars`/`Val(List)` length as `Number`, else `Null`. |
| `Index(list, i)` | element at trunc(`i`) (`Ev::Char` for `Chars`); OOB/ill-typed → `Null`. `First(list)` = index 0. |
| `Includes(list, v)` | membership by `vals_eq` over `Val(List)`; `false` otherwise. |
| `Get(char, f)` | `"sanity"`/`"energy"`/`"health"` → `Number`; `"name"` → `Str`; `"id"` → `Str(id.0)`; `"status"` → `Val(List[Str])` via `status_name` (`Confused→"confused"`, `Fear→"fear"`, `Ko→"ko"`, `Panic→"panic"`); `"roomId"` → `Str`/`Null`; `"room"` → Task 4. Unknown field → `Null`. |
| `HasEquipped/HasItem/HasKey(of, key)` | `of` must eval to `Ev::Char`; else `false`. Delegates to `CharacterView::{has_equipped, has_item, has_key}`. |
| `Get` on non-subject | `Null`. |

- [ ] **Step 1: Write the failing tests**

In `view.rs` tests, add:

```rust
    #[test]
    fn character_view_has_key_matches_inventory_key_code() {
        use crate::world::ids::ItemId;
        use crate::world::snapshot::ItemSnapshot;
        let mut w = world_with_party(&["pc"], 10);
        w.items.insert(ItemId("k1".into()), ItemSnapshot::Key {
            id: ItemId("k1".into()), name: "Brass Key".into(),
            key_code: "brass".into(), consume_on_use: false,
        });
        w.characters.get_mut(&cid("pc")).unwrap().inventory.key_ids.push(ItemId("k1".into()));
        let v = w.character_view(&cid("pc"), &Catalog::default()).unwrap();
        assert!(v.has_key("brass"));
        assert!(!v.has_key("iron"));
    }
```

In `eval.rs` tests, add (helpers shared with later tasks):

```rust
    use crate::world::descriptor::Catalog;
    use crate::world::ids::{CharacterId, ItemId};
    use crate::world::snapshot::ItemSnapshot;
    use crate::world::test_support::world_with_party;

    fn cid(s: &str) -> CharacterId { CharacterId(s.into()) }

    /// Seed a catalog-backed Item snapshot into the world (mirrors the
    /// items_actions.rs test helpers).
    fn seed_item(w: &mut crate::world::World, id: &str, behavior_key: &str) {
        w.items.insert(ItemId(id.into()), ItemSnapshot::Item {
            id: ItemId(id.into()), behavior_key: behavior_key.into(),
            durability: None, modifier: 0,
        });
    }

    #[test]
    fn campaign_and_character_reads() {
        let mut w = world_with_party(&["pc", "npc"], 10); // stats 5/5/5 each
        seed_item(&mut w, "lamp1", "lantern");
        // equip the lantern on pc; hold a journal item
        w.characters.get_mut(&cid("pc")).unwrap()
            .equipment.insert("hand".into(), ItemId("lamp1".into()));
        seed_item(&mut w, "j1", "journal");
        w.characters.get_mut(&cid("pc")).unwrap().inventory.item_ids.push(ItemId("j1".into()));
        let view = w.build_campaign_view(&Catalog::default());

        let mut cx = Ctx { view: Some(&view), ..Ctx::empty() };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();

        assert_eq!(val(&Expr::Round, &mut cx), Value::Number(0.0));
        assert_eq!(val(&Expr::MaxRounds, &mut cx), Value::Number(10.0));
        assert_eq!(val(&Expr::Length { list: Box::new(Expr::Party) }, &mut cx), Value::Number(2.0));

        let first = Expr::First { list: Box::new(Expr::Party) };
        assert_eq!(val(&Expr::Get { of: Box::new(first.clone()), field: "sanity".into() }, &mut cx),
                   Value::Number(5.0));
        assert_eq!(val(&Expr::Get { of: Box::new(first.clone()), field: "name".into() }, &mut cx),
                   Value::Str("pc".into()));
        assert_eq!(val(&Expr::HasEquipped { of: Box::new(first.clone()), item_key: "lantern".into() }, &mut cx),
                   Value::Bool(true));
        assert_eq!(val(&Expr::HasItem { of: Box::new(first.clone()), item_key: "journal".into() }, &mut cx),
                   Value::Bool(true));
        assert_eq!(val(&Expr::HasItem { of: Box::new(first.clone()), item_key: "poker".into() }, &mut cx),
                   Value::Bool(false));
        // status list is empty (healthy) — Includes over it is false
        assert_eq!(val(&Expr::Includes {
            list: Box::new(Expr::Get { of: Box::new(first.clone()), field: "status".into() }),
            value: Box::new(Expr::Lit { value: Value::Str("ko".into()) }),
        }, &mut cx), Value::Bool(false));
        // Index OOB -> Null; Get on Null -> Null (total)
        assert_eq!(val(&Expr::Get {
            of: Box::new(Expr::Index { list: Box::new(Expr::Party),
                                       index: Box::new(Expr::Lit { value: Value::Number(9.0) }) }),
            field: "sanity".into(),
        }, &mut cx), Value::Null);
    }

    #[test]
    fn actor_and_missing_view_reads_are_total() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut cx = Ctx { view: Some(&view), actor: Some(&actor), ..Ctx::empty() };
        assert_eq!(eval_expr(&Expr::Get { of: Box::new(Expr::Actor), field: "energy".into() }, &mut cx)
                   .into_value(), Value::Number(5.0));
        // no view at all (exit-context shape): Round -> Null, Party -> empty list
        let mut bare = Ctx { actor: Some(&actor), ..Ctx::empty() };
        assert_eq!(eval_expr(&Expr::Round, &mut bare).into_value(), Value::Null);
        assert_eq!(eval_expr(&Expr::Length { list: Box::new(Expr::Party) }, &mut bare).into_value(),
                   Value::Number(0.0));
    }
```

Note: `Ctx { view: Some(&view), ..Ctx::empty() }` requires `Ctx::empty()` — the struct-update syntax works because all other fields are owned `Option`s/enums.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script`
Expected: compile errors (new variants, `Ev`, `Ctx::empty` missing).

- [ ] **Step 3: Implement**

`view.rs` — add the private field and getter to `CharacterView` (after `held_keys`):

```rust
    key_codes: BTreeSet<String>,
```

```rust
    /// True if the character's keyring holds a key with this `keyCode`
    /// (TS `c.inventory.keys.some((k) => k.keyCode === code)`).
    pub fn has_key(&self, code: &str) -> bool { self.key_codes.contains(code) }
```

and in `World::character_view`, before the `Some(CharacterView { .. })`:

```rust
        let key_codes = c
            .inventory
            .key_ids
            .iter()
            .filter_map(|iid| match self.items.get(iid) {
                Some(ItemSnapshot::Key { key_code, .. }) => Some(key_code.clone()),
                _ => None,
            })
            .collect();
```

(add `key_codes` to the struct literal.)

`ast.rs` — add the variants listed under Interfaces (unit variants `Round`, `MaxRounds`, `Party`, `Actor`, `Action`, `Damage`, `Element` and the struct variants shown).

`eval.rs` — replace the placeholder `Ctx` with the real context and switch `eval_expr` to `Ev`:

```rust
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;

use crate::world::descriptor::Catalog;
use crate::world::history::RoomRef;
use crate::world::mechanics::{ActionView, CampaignView, CharacterView, DamageView, RoomView};
use crate::world::World;

/// Runtime evaluation result: plain values, plus the read-model SUBJECTS
/// (characters/rooms/action/damage) which flow through expressions but are
/// never first-class serialized values (spec: read model).
#[derive(Clone, Debug)]
pub enum Ev {
    Val(Value),
    Char(CharacterView),
    Room(RoomView),
    RoomRef(RoomRef),
    Chars(Vec<CharacterView>),
    Action(ActionView),
    Damage(DamageView),
}

impl Ev {
    /// JS truthiness: subjects are objects, hence truthy.
    pub fn truthy(&self) -> bool {
        match self {
            Ev::Val(v) => v.truthy(),
            _ => true,
        }
    }
    /// Collapse to a plain `Value` (subjects have no value form -> Null).
    pub fn into_value(self) -> Value {
        match self {
            Ev::Val(v) => v,
            _ => Value::Null,
        }
    }
}

/// The mechanic/exit/victory state a script may read (and, for statement
/// bodies, write). `Read` supports predicate contexts (`can_pass` borrows
/// `&exit.state`); `Write` supports hook/script bodies.
pub enum CtxState<'a> {
    None,
    Read(&'a serde_json::Value),
    Write(&'a mut serde_json::Value),
}

/// Lazy, memoizing `character.room` resolver. `None` in mechanic/exit contexts
/// (the TS oracle cannot see rooms there); `World` in victory contexts.
pub enum RoomSource<'a> {
    None,
    World { world: &'a World, cat: &'a Catalog, cache: BTreeMap<String, Option<RoomView>> },
}

impl RoomSource<'_> {
    fn resolve(&mut self, room_id: &str) -> Option<RoomView> {
        match self {
            RoomSource::None => None,
            RoomSource::World { world, cat, cache } => {
                if !cache.contains_key(room_id) {
                    let v = world.room_view(&crate::world::ids::RoomId(room_id.into()), cat);
                    cache.insert(String::from(room_id), v);
                }
                cache.get(room_id).cloned().flatten()
            }
        }
    }
}

pub struct Ctx<'a> {
    pub view: Option<&'a CampaignView>,
    pub state: CtxState<'a>,
    pub actor: Option<&'a CharacterView>,
    pub action: Option<&'a ActionView>,
    pub damage: Option<&'a DamageView>,
    /// The bound quantifier element (Task 6). The language's ONLY binding.
    pub element: Option<Ev>,
    /// Injected rng stream. No v1 node draws from it; plumbed so a future
    /// `Roll` node keeps the determinism contract without a signature change.
    pub rng: Option<&'a mut crate::world::rng::Rng>,
    pub rooms: RoomSource<'a>,
}

impl<'a> Ctx<'a> {
    pub fn empty() -> Ctx<'a> {
        Ctx { view: None, state: CtxState::None, actor: None, action: None,
              damage: None, element: None, rng: None, rooms: RoomSource::None }
    }
}
```

`eval_expr` (returning `Ev`; existing Task-1/2 arms wrap results in `Ev::Val`):

```rust
pub fn eval_expr(e: &Expr, cx: &mut Ctx) -> Ev {
    match e {
        Expr::Lit { value } => Ev::Val(value.clone()),
        Expr::MapLit { .. } => Ev::Val(Value::Null),
        Expr::Not { expr } => Ev::Val(Value::Bool(!eval_expr(expr, cx).truthy())),
        Expr::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() { eval_expr(then, cx) } else { eval_expr(r#else, cx) }
        }
        Expr::Defined { expr } => {
            let d = !matches!(eval_expr(expr, cx), Ev::Val(Value::Null));
            Ev::Val(Value::Bool(d))
        }
        Expr::Bin { op, left, right } => {
            let l = eval_expr(left, cx).into_value();
            let r = eval_expr(right, cx).into_value();
            Ev::Val(eval_bin(*op, &l, &r))
        }
        Expr::Str { num } => Ev::Val(Value::Str(coerce_str(&eval_expr(num, cx).into_value()))),
        Expr::Concat { parts } => {
            let mut out = String::new();
            for p in parts {
                out.push_str(&coerce_str(&eval_expr(p, cx).into_value()));
            }
            Ev::Val(Value::Str(out))
        }

        Expr::Round => match cx.view {
            Some(v) => Ev::Val(Value::Number(v.round as f64)),
            None => Ev::Val(Value::Null),
        },
        Expr::MaxRounds => match cx.view {
            Some(v) => Ev::Val(Value::Number(v.max_rounds as f64)),
            None => Ev::Val(Value::Null),
        },
        Expr::Party => Ev::Chars(cx.view.map(|v| v.party.clone()).unwrap_or_default()),
        Expr::Actor => match cx.actor {
            Some(a) => Ev::Char(a.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Action => match cx.action {
            Some(a) => Ev::Action(a.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Damage => match cx.damage {
            Some(d) => Ev::Damage(d.clone()),
            None => Ev::Val(Value::Null),
        },
        Expr::Element => cx.element.clone().unwrap_or(Ev::Val(Value::Null)),

        Expr::Length { list } => match eval_expr(list, cx) {
            Ev::Chars(cs) => Ev::Val(Value::Number(cs.len() as f64)),
            Ev::Val(Value::List(vs)) => Ev::Val(Value::Number(vs.len() as f64)),
            _ => Ev::Val(Value::Null),
        },
        Expr::First { list } => index_list(eval_expr(list, cx), 0),
        Expr::Index { list, index } => {
            let l = eval_expr(list, cx);
            match eval_expr(index, cx).into_value() {
                Value::Number(i) if i >= 0.0 => index_list(l, i as usize),
                _ => Ev::Val(Value::Null),
            }
        }
        Expr::Includes { list, value } => {
            let v = eval_expr(value, cx).into_value();
            match eval_expr(list, cx) {
                Ev::Val(Value::List(items)) => Ev::Val(Value::Bool(items.iter().any(|it| vals_eq(it, &v)))),
                _ => Ev::Val(Value::Bool(false)),
            }
        }

        Expr::Get { of, field } => {
            let subject = eval_expr(of, cx);
            get_field(subject, field, cx)
        }
        Expr::HasEquipped { of, item_key } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_equipped(item_key)))),
        Expr::HasItem { of, item_key } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_item(item_key)))),
        Expr::HasKey { of, key_code } => Ev::Val(Value::Bool(
            matches!(eval_expr(of, cx), Ev::Char(c) if c.has_key(key_code)))),
    }
}

fn index_list(l: Ev, i: usize) -> Ev {
    match l {
        Ev::Chars(cs) => cs.get(i).cloned().map(Ev::Char).unwrap_or(Ev::Val(Value::Null)),
        Ev::Val(Value::List(vs)) => vs.get(i).cloned().map(|v| Ev::Val(v)).unwrap_or(Ev::Val(Value::Null)),
        _ => Ev::Val(Value::Null),
    }
}

fn status_name(s: crate::world::afflictions::Status) -> &'static str {
    use crate::world::afflictions::Status;
    match s { Status::Confused => "confused", Status::Fear => "fear",
              Status::Ko => "ko", Status::Panic => "panic" }
}

/// Field access on a subject. Total: unknown field / non-subject -> Null.
/// `char.room` resolves lazily in Task 4; `Action` fields widen in Task 8.
fn get_field(subject: Ev, field: &str, cx: &mut Ctx) -> Ev {
    match subject {
        Ev::Char(c) => match field {
            "sanity" => Ev::Val(Value::Number(c.sanity)),
            "energy" => Ev::Val(Value::Number(c.energy)),
            "health" => Ev::Val(Value::Number(c.health)),
            "name" => Ev::Val(Value::Str(c.name.clone())),
            "id" => Ev::Val(Value::Str(c.id.0.clone())),
            "roomId" => match &c.room_id {
                Some(r) => Ev::Val(Value::Str(r.clone())),
                None => Ev::Val(Value::Null),
            },
            "status" => Ev::Val(Value::List(
                c.status.iter().map(|s| Value::Str(status_name(*s).into())).collect())),
            "room" => match &c.room_id {
                Some(rid) => match cx.rooms.resolve(rid) {
                    Some(rv) => Ev::Room(rv),
                    None => Ev::Val(Value::Null),
                },
                None => Ev::Val(Value::Null),
            },
            _ => Ev::Val(Value::Null),
        },
        Ev::Damage(d) => match field {
            "amount" => Ev::Val(Value::Number(d.amount)),
            "target" => Ev::Val(Value::Str(d.target.0.clone())),
            "stat" => Ev::Val(Value::Str(match d.stat {
                crate::stats::StatType::Energy => "energy",
                crate::stats::StatType::Sanity => "sanity",
                crate::stats::StatType::Health => "health",
            }.into())),
            "source" => match &d.source {
                Some(s) => Ev::Val(Value::Str(s.0.clone())),
                None => Ev::Val(Value::Null),
            },
            _ => Ev::Val(Value::Null),
        },
        // Room / RoomRef / Action fields: Tasks 4 and 8.
        Ev::Action(a) => match field {
            "kind" => Ev::Val(Value::Str(a.kind.clone())),
            _ => Ev::Val(Value::Null),
        },
        _ => Ev::Val(Value::Null),
    }
}
```

Update the Task-1/2 test helper: `fn ev(e: &Expr) -> Value { eval_expr(e, &mut Ctx::empty()).into_value() }`.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo test -p wickedways-core view && cargo build -p wickedways-core --no-default-features`
Expected: PASS (including the new `has_key` view test; existing view tests unaffected because `key_codes` is built from world state).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/ crates/wickedways-core/src/world/mechanics/view.rs
git commit -m "feat(script): eval ctx + campaign/character reads + CharacterView.has_key (scripted-ops T3)"
```

---

### Task 4: lazy `character.room` + room reads

**Files:**
- Modify: `crates/wickedways-core/src/script/eval.rs` (room-field arms; `RoomSource` already landed in Task 3)
- Test: `eval.rs` tests

**Interfaces:**
- Produces: `Get(char, "room") -> Ev::Room(RoomView)` resolved lazily+memoized from `room_id` via `World::room_view` (`world/mechanics/view.rs:84-99` — the gate-faithful `RoomView { id, name, lit, occupant_ids, occupants }`); room reads `Get(room, "name"|"id") -> Str`, `Get(room, "lit") -> Bool`, `Get(room, "occupants") -> Ev::Chars`.
- Consumes: `RoomSource::World` (Task 3), `world_two_rooms` test world (`world/test_support.rs`).

- [ ] **Step 1: Write the failing tests** (in `eval.rs` tests)

```rust
    #[test]
    fn character_room_resolves_lazily_with_room_reads() {
        // world_two_rooms seats "pc" in "start" (lit); "next" is dark.
        let w = crate::world::test_support::world_two_rooms(/*next_dark=*/true);
        let cat = Catalog::default();
        let view = w.build_campaign_view(&cat);
        let actor = view.party[0].clone();
        let mut cx = Ctx {
            view: Some(&view), actor: Some(&actor),
            rooms: RoomSource::World { world: &w, cat: &cat, cache: BTreeMap::new() },
            ..Ctx::empty()
        };
        let room = Expr::Get { of: Box::new(Expr::Actor), field: "room".into() };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();

        assert_eq!(val(&Expr::Get { of: Box::new(room.clone()), field: "name".into() }, &mut cx),
                   Value::Str("Start".into()));
        assert_eq!(val(&Expr::Get { of: Box::new(room.clone()), field: "id".into() }, &mut cx),
                   Value::Str("start".into()));
        assert_eq!(val(&Expr::Get { of: Box::new(room.clone()), field: "lit".into() }, &mut cx),
                   Value::Bool(true));
        // occupants -> Chars; nested occupant.room resolves again by id —
        // ID-indirection means NO cyclic data and NO infinite recursion.
        let nested = Expr::Get {
            of: Box::new(Expr::Get {
                of: Box::new(Expr::First {
                    list: Box::new(Expr::Get { of: Box::new(room.clone()), field: "occupants".into() }),
                }),
                field: "room".into(),
            }),
            field: "name".into(),
        };
        assert_eq!(val(&nested, &mut cx), Value::Str("Start".into()));
        // memoization: the cache now holds "start" exactly once
        match &cx.rooms {
            RoomSource::World { cache, .. } => assert_eq!(cache.len(), 1),
            _ => panic!("expected World room source"),
        }
    }

    #[test]
    fn room_reads_without_a_source_are_null() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut cx = Ctx { view: Some(&view), actor: Some(&actor), ..Ctx::empty() };
        let e = Expr::Get {
            of: Box::new(Expr::Get { of: Box::new(Expr::Actor), field: "room".into() }),
            field: "name".into(),
        };
        assert_eq!(eval_expr(&e, &mut cx).into_value(), Value::Null);
    }
```

Note: `world_two_rooms` names its rooms `Start`/`Next` with ids `start`/`next` (`view.rs:177-194` shows ids `"start"`/`"next"` and the test at `view.rs:182` uses names via `room_view`). If the actual name of the start room differs, read `world/test_support.rs` and use the real name — do NOT change test_support.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script::eval`
Expected: FAIL — `character_room_resolves_lazily_with_room_reads` gets `Null` for room fields (arms missing).

- [ ] **Step 3: Implement** — extend `get_field` in `eval.rs` with the `Ev::Room` arm (the `"room"` arm on `Ev::Char` already landed in Task 3):

```rust
        Ev::Room(r) => match field {
            "name" => Ev::Val(Value::Str(r.name.clone())),
            "id" => Ev::Val(Value::Str(r.id.clone())),
            "lit" => Ev::Val(Value::Bool(r.lit)),
            "occupants" => Ev::Chars(r.occupants.clone()),
            _ => Ev::Val(Value::Null),
        },
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/eval.rs
git commit -m "feat(script): lazy memoized character.room + room reads (scripted-ops T4)"
```

---

### Task 5: state reads/writes + static maps

**Files:**
- Modify: `crates/wickedways-core/src/script/ast.rs` (`Expr::StateGet`, `Expr::StateGetIn`, `Expr::Lookup`, `Expr::Has`)
- Modify: `crates/wickedways-core/src/script/value.rs` (`json_to_value`, `value_to_json`)
- Modify: `crates/wickedways-core/src/script/eval.rs` (eval arms + the write helpers `state_set` / `state_set_in` that Task 7's `Stmt::SetState`/`Stmt::SetStateIn` will call)

**Interfaces:**
- Produces:
  - `ast.rs`: `StateGet { field: String, default: Value }`, `StateGetIn { map_field: String, key: Box<Expr>, default: Value }`, `Lookup { map: Box<Expr>, key: Box<Expr> }`, `Has { map: Box<Expr>, key: Box<Expr> }`. (`Lookup`/`Has` require a `MapLit` operand — enforced at load in Task 9; at runtime a non-`MapLit` operand yields `Null`/`false`.)
  - `value.rs`: `pub fn json_to_value(j: &serde_json::Value) -> Value` (null→Null, bool, number→f64, string, array→List; objects→Null — nested objects are reached only via `StateGetIn`), `pub fn value_to_json(v: &Value) -> serde_json::Value`.
  - `eval.rs`: `pub(crate) fn state_set(state: &mut serde_json::Value, field: &str, v: serde_json::Value)` (auto-converts a non-object state to `{}` first) and `pub(crate) fn state_set_in(state: &mut serde_json::Value, map_field: &str, key: &str, v: serde_json::Value)` (auto-vivifies `state[map_field]` as `{}` — mirrors TS `(ctx.state.seen ??= {})`, `packages/campaigns/src/hollow-house/mechanics.ts:22`).
- Consumes: `CtxState` (Task 3).

**Read semantics:** `StateGet(field, default)` → `json_to_value(state[field])`, or `default` when the field is missing or the ctx has no state (mirrors `??`/`unwrap_or`; a stored JSON `null` also yields the default). `StateGetIn(map, key, default)` → `state[map][coerce_str(key)]` with the same defaulting. `Lookup(MapLit, key)` → the literal value or `Null`; `Has(MapLit, key)` → `Bool`.

- [ ] **Step 1: Write the failing tests** (in `eval.rs` tests)

```rust
    #[test]
    fn state_reads_default_and_read_write_roundtrip() {
        let mut state = serde_json::json!({ "unlocked": false, "seen": { "Parlor": true } });
        {
            let mut cx = Ctx { state: CtxState::Read(&state), ..Ctx::empty() };
            let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();
            assert_eq!(val(&Expr::StateGet { field: "unlocked".into(), default: Value::Bool(true) }, &mut cx),
                       Value::Bool(false)); // present value wins over default
            assert_eq!(val(&Expr::StateGet { field: "missing".into(), default: Value::Number(7.0) }, &mut cx),
                       Value::Number(7.0)); // missing -> default
            let key = |s: &str| Box::new(Expr::Lit { value: Value::Str(s.into()) });
            assert_eq!(val(&Expr::StateGetIn { map_field: "seen".into(), key: key("Parlor"),
                                               default: Value::Bool(false) }, &mut cx),
                       Value::Bool(true));
            assert_eq!(val(&Expr::StateGetIn { map_field: "seen".into(), key: key("Attic"),
                                               default: Value::Bool(false) }, &mut cx),
                       Value::Bool(false));
            // no-state ctx -> default (total)
            let mut none = Ctx::empty();
            assert_eq!(eval_expr(&Expr::StateGet { field: "x".into(), default: Value::Null }, &mut none)
                       .into_value(), Value::Null);
        }
        // write helpers: set + auto-vivify (the storyteller `??=` shape)
        state_set(&mut state, "unlocked", serde_json::json!(true));
        assert_eq!(state["unlocked"], serde_json::json!(true));
        let mut fresh = serde_json::json!({});
        state_set_in(&mut fresh, "seen", "Nursery", serde_json::json!(true));
        assert_eq!(fresh, serde_json::json!({ "seen": { "Nursery": true } }));
    }

    #[test]
    fn static_map_lookup_and_has() {
        let mut entries = BTreeMap::new();
        entries.insert(String::from("Parlor"), Value::Str("lilies".into()));
        entries.insert(String::from("Study"), Value::Str("iron key".into()));
        let lore = Box::new(Expr::MapLit { entries });
        let key = |s: &str| Box::new(Expr::Lit { value: Value::Str(s.into()) });
        let mut cx = Ctx::empty();
        assert_eq!(eval_expr(&Expr::Lookup { map: lore.clone(), key: key("Parlor") }, &mut cx)
                   .into_value(), Value::Str("lilies".into()));
        assert_eq!(eval_expr(&Expr::Lookup { map: lore.clone(), key: key("Foyer") }, &mut cx)
                   .into_value(), Value::Null);
        assert_eq!(eval_expr(&Expr::Has { map: lore.clone(), key: key("Study") }, &mut cx)
                   .into_value(), Value::Bool(true));
        assert_eq!(eval_expr(&Expr::Has { map: lore.clone(), key: key("Foyer") }, &mut cx)
                   .into_value(), Value::Bool(false));
        // key coerces via JS String(): Has(map, Null) looks up "null" -> false
        assert_eq!(eval_expr(&Expr::Has { map: lore, key: Box::new(Expr::Lit { value: Value::Null }) },
                   &mut cx).into_value(), Value::Bool(false));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script::eval`
Expected: compile error (variants/helpers missing).

- [ ] **Step 3: Implement**

`value.rs`:

```rust
/// JSON -> script value. Objects collapse to `Null` (nested objects are only
/// reachable through `StateGetIn`, which indexes them directly).
pub fn json_to_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(items) => Value::List(items.iter().map(json_to_value).collect()),
        serde_json::Value::Object(_) => Value::Null,
    }
}

pub fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::json!(b),
        Value::Number(n) => serde_json::json!(n),
        Value::Str(s) => serde_json::json!(s),
        Value::List(items) => serde_json::Value::Array(items.iter().map(value_to_json).collect()),
    }
}
```

`ast.rs` — add the four variants from Interfaces.

`eval.rs` — add arms + helpers:

```rust
        Expr::StateGet { field, default } => {
            let read = match &cx.state {
                CtxState::Read(s) => s.get(field).cloned(),
                CtxState::Write(s) => s.get(field).cloned(),
                CtxState::None => None,
            };
            match read {
                Some(j) if !j.is_null() => Ev::Val(json_to_value(&j)),
                _ => Ev::Val(default.clone()),
            }
        }
        Expr::StateGetIn { map_field, key, default } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            let read = match &cx.state {
                CtxState::Read(s) => s.get(map_field).and_then(|m| m.get(&k)).cloned(),
                CtxState::Write(s) => s.get(map_field).and_then(|m| m.get(&k)).cloned(),
                CtxState::None => None,
            };
            match read {
                Some(j) if !j.is_null() => Ev::Val(json_to_value(&j)),
                _ => Ev::Val(default.clone()),
            }
        }
        Expr::Lookup { map, key } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            match map.as_ref() {
                Expr::MapLit { entries } => match entries.get(&k) {
                    Some(v) => Ev::Val(v.clone()),
                    None => Ev::Val(Value::Null),
                },
                _ => Ev::Val(Value::Null), // load-time-rejected shape; total anyway
            }
        }
        Expr::Has { map, key } => {
            let k = coerce_str(&eval_expr(key, cx).into_value());
            match map.as_ref() {
                Expr::MapLit { entries } => Ev::Val(Value::Bool(entries.contains_key(&k))),
                _ => Ev::Val(Value::Bool(false)),
            }
        }
```

```rust
/// `state[field] = v`, converting a non-object state to `{}` first (total).
pub(crate) fn state_set(state: &mut serde_json::Value, field: &str, v: serde_json::Value) {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    state[field] = v;
}

/// `state[map_field][key] = v`, auto-vivifying the map (TS `??=`).
pub(crate) fn state_set_in(state: &mut serde_json::Value, map_field: &str, key: &str, v: serde_json::Value) {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    if !state.get(map_field).map(|m| m.is_object()).unwrap_or(false) {
        state[map_field] = serde_json::json!({});
    }
    state[map_field][key] = v;
}
```

(add `use super::value::{json_to_value};` etc. to the imports.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/
git commit -m "feat(script): state reads/writes + static-map lookup (scripted-ops T5)"
```

---

### Task 6: bounded quantifiers

**Files:**
- Modify: `crates/wickedways-core/src/script/ast.rs` (`Expr::Some`, `Expr::Every`)
- Modify: `crates/wickedways-core/src/script/eval.rs`

**Interfaces:**
- Produces: `Some { list: Box<Expr>, pred: Box<Expr> }`, `Every { list: Box<Expr>, pred: Box<Expr> }`. The predicate references the current element via `Expr::Element` (Task 3) — the language's ONLY binding, bounded by list length. Nested quantifiers shadow and restore the outer element.
- Consumes: `Ev`, `Ctx.element`, `index_list` (Task 3).

- [ ] **Step 1: Write the failing tests** (in `eval.rs` tests)

```rust
    #[test]
    fn some_and_every_bind_element_over_party() {
        let mut w = world_with_party(&["a", "b"], 10); // sanity 5 each
        w.characters.get_mut(&cid("b")).unwrap().stats.sanity = 0.0;
        let view = w.build_campaign_view(&Catalog::default());
        let mut cx = Ctx { view: Some(&view), ..Ctx::empty() };
        let sanity_lte0 = Box::new(Expr::Bin {
            op: BinOp::Lte,
            left: Box::new(Expr::Get { of: Box::new(Expr::Element), field: "sanity".into() }),
            right: Box::new(Expr::Lit { value: Value::Number(0.0) }),
        });
        // some(party, sanity <= 0): b qualifies -> true
        assert_eq!(eval_expr(&Expr::Some { list: Box::new(Expr::Party), pred: sanity_lte0.clone() },
                   &mut cx).into_value(), Value::Bool(true));
        // every(party, sanity <= 0): a does not -> false
        assert_eq!(eval_expr(&Expr::Every { list: Box::new(Expr::Party), pred: sanity_lte0.clone() },
                   &mut cx).into_value(), Value::Bool(false));
        // JS vacuous truth: every([]) -> true, some([]) -> false
        let empty = Box::new(Expr::Lit { value: Value::List(alloc::vec![]) });
        assert_eq!(eval_expr(&Expr::Every { list: empty.clone(), pred: sanity_lte0.clone() }, &mut cx)
                   .into_value(), Value::Bool(true));
        assert_eq!(eval_expr(&Expr::Some { list: empty, pred: sanity_lte0 }, &mut cx)
                   .into_value(), Value::Bool(false));
        // the binding is restored after the quantifier
        assert!(cx.element.is_none());
    }

    #[test]
    fn quantifiers_over_value_lists_and_status_includes() {
        let mut w = world_with_party(&["a", "b"], 10);
        // KO both: health 0 + reconcile latches KO via afflictions.set_active
        for id in ["a", "b"] {
            let c = w.characters.get_mut(&cid(id)).unwrap();
            c.stats.health = 0.0;
            c.afflictions.set_active(crate::world::afflictions::Status::Ko, true);
        }
        let view = w.build_campaign_view(&Catalog::default());
        let mut cx = Ctx { view: Some(&view), ..Ctx::empty() };
        // the party-down oracle shape: every(party, status.includes("ko"))
        let pred = Box::new(Expr::Includes {
            list: Box::new(Expr::Get { of: Box::new(Expr::Element), field: "status".into() }),
            value: Box::new(Expr::Lit { value: Value::Str("ko".into()) }),
        });
        assert_eq!(eval_expr(&Expr::Every { list: Box::new(Expr::Party), pred }, &mut cx)
                   .into_value(), Value::Bool(true));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script::eval`
Expected: compile error (variants missing).

- [ ] **Step 3: Implement** — in `eval_expr`:

```rust
        Expr::Some { list, pred } => Ev::Val(Value::Bool(quantify(list, pred, cx, /*every=*/false))),
        Expr::Every { list, pred } => Ev::Val(Value::Bool(quantify(list, pred, cx, /*every=*/true))),
```

and the helper:

```rust
/// Bounded quantification. Binds `Ctx.element` per iteration (saving/restoring
/// any outer binding, so nesting shadows correctly). `every([])` is vacuously
/// true, `some([])` false — JS Array semantics.
fn quantify(list: &Expr, pred: &Expr, cx: &mut Ctx, every: bool) -> bool {
    let items: Vec<Ev> = match eval_expr(list, cx) {
        Ev::Chars(cs) => cs.into_iter().map(Ev::Char).collect(),
        Ev::Val(Value::List(vs)) => vs.into_iter().map(Ev::Val).collect(),
        _ => Vec::new(),
    };
    let saved = cx.element.take();
    let mut result = every;
    for item in items {
        cx.element = Some(item);
        let hit = eval_expr(pred, cx).truthy();
        if every && !hit { result = false; break; }
        if !every && hit { result = true; break; }
    }
    cx.element = saved;
    result
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/
git commit -m "feat(script): bounded some/every quantifiers with element binding (scripted-ops T6)"
```

---

### Task 7: statements + body evaluators

**Files:**
- Modify: `crates/wickedways-core/src/script/ast.rs` (`Stmt`, `EffectTemplate`, `FieldTemplate`, `DamageBody`)
- Modify: `crates/wickedways-core/src/script/eval.rs` (`eval_predicate`, `eval_effects`, `eval_script`, `eval_damage`)

**Interfaces:**
- Produces (`ast.rs`):
  ```rust
  #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum Stmt {
      Guard { cond: Expr },                                  // falsy -> stop the body, keep accumulated output
      When { cond: Expr, then: Vec<Stmt> },
      SetState { field: String, value: Expr },
      SetStateIn { map_field: String, key: Expr, value: Expr },
      Emit { effect: EffectTemplate },                       // effect bodies only
      Pass { value: Expr },                                  // exit script bodies only; last Pass wins
  }
  #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum EffectTemplate {                                  // mirrors the closed Effect set
      Damage { target: Expr, amount: Expr },
      Heal { target: Expr, amount: Expr },
      AdjustStat { target: Expr, stat: StatType, delta: Expr },
      GrantImmunity { target: Expr, turns: Expr },
      Cue { text: Expr },
      Status { fields: Vec<FieldTemplate> },
  }
  #[serde(rename_all = "camelCase")]
  pub struct FieldTemplate { pub label: String, pub value: Expr,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      #[cfg_attr(feature = "ts", ts(optional))]
      pub emphasis: Option<Expr> }
  #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum DamageBody {                                      // modify-damage body
      Value { expr: Expr },
      Final { expr: Expr },                                  // halts the fold (TS { value, final: true })
      IfElse { cond: Expr, then: Box<DamageBody>, r#else: Box<DamageBody> },
  }
  ```
- Produces (`eval.rs`):
  ```rust
  pub fn eval_predicate(e: &Expr, cx: &mut Ctx) -> bool                    // truthiness of the result
  pub fn eval_effects(body: &[Stmt], cx: &mut Ctx) -> Vec<Effect>          // effect bodies (mechanic hooks/actions)
  pub fn eval_script(body: &[Stmt], cx: &mut Ctx) -> Option<String>        // exit run_script bodies
  pub fn eval_damage(body: &DamageBody, d: &DamageView, cx: &mut Ctx) -> TransformResult
  ```
  Emit ORDER is preserved (contract-relevant). Effect target exprs resolve to a `CharacterId` via `Ev::Char(c) -> c.id` or `Ev::Val(Str(s)) -> CharacterId(s)`; an unresolvable target skips that one `Emit` (mirrors the TS conformance shadow's `if (target !== undefined)` guard, `conformance/fixtures/dread-shadow.ts:26-28`). Amount/delta/turns exprs must yield `Number`, else the `Emit` is skipped. Cue text and Status field values/emphasis coerce via `coerce_str`; an `emphasis` of `None` yields `StatusField.emphasis = None`. `eval_damage` on a non-number result returns `TransformResult::Value(d.amount)` (identity, total).
- Consumes: `Effect`, `TransformResult`, `MechanicCue`, `StatusField`, `StatType`, `CharacterId`; `state_set`/`state_set_in` (Task 5).

- [ ] **Step 1: Write the failing tests** (in `eval.rs` tests)

```rust
    use crate::presentation::{MechanicCue, StatusField};
    use crate::world::mechanics::{Effect, TransformResult};

    fn s_lit(v: Value) -> Expr { Expr::Lit { value: v } }

    #[test]
    fn effect_body_guard_when_setstate_emit_preserves_order() {
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = view.party[0].clone();
        let mut state = serde_json::json!({});
        // The dread-HH shape: guard(!hasEquipped) then emit adjustStat(actor)
        let body = alloc::vec![
            Stmt::Guard { cond: Expr::Not { expr: Box::new(Expr::HasEquipped {
                of: Box::new(Expr::Actor), item_key: "lantern".into() }) } },
            Stmt::SetState { field: "fired".into(), value: s_lit(Value::Bool(true)) },
            Stmt::Emit { effect: EffectTemplate::AdjustStat {
                target: Expr::Actor, stat: crate::stats::StatType::Sanity,
                delta: s_lit(Value::Number(-1.0)) } },
            Stmt::Emit { effect: EffectTemplate::Cue { text: s_lit(Value::Str("after".into())) } },
        ];
        let mut cx = Ctx { view: Some(&view), actor: Some(&actor),
                           state: CtxState::Write(&mut state), ..Ctx::empty() };
        let fx = eval_effects(&body, &mut cx);
        assert_eq!(fx.len(), 2, "guard passed; both emits ran, in order");
        assert!(matches!(&fx[0], Effect::AdjustStat { target, stat: crate::stats::StatType::Sanity, delta }
            if target == &cid("pc") && *delta == -1.0));
        assert!(matches!(&fx[1], Effect::Cue { cue } if cue.text.as_deref() == Some("after")));
        assert_eq!(state, serde_json::json!({ "fired": true }));
    }

    #[test]
    fn guard_false_stops_and_keeps_accumulated_effects() {
        let body = alloc::vec![
            Stmt::Emit { effect: EffectTemplate::Cue { text: s_lit(Value::Str("kept".into())) } },
            Stmt::Guard { cond: s_lit(Value::Bool(false)) },
            Stmt::Emit { effect: EffectTemplate::Cue { text: s_lit(Value::Str("dropped".into())) } },
        ];
        let fx = eval_effects(&body, &mut Ctx::empty());
        assert_eq!(fx.len(), 1);
        assert!(matches!(&fx[0], Effect::Cue { cue } if cue.text.as_deref() == Some("kept")));
        // a Guard nested in When also halts the WHOLE body (early return)
        let body2 = alloc::vec![
            Stmt::When { cond: s_lit(Value::Bool(true)), then: alloc::vec![
                Stmt::Guard { cond: s_lit(Value::Bool(false)) } ] },
            Stmt::Emit { effect: EffectTemplate::Cue { text: s_lit(Value::Str("late".into())) } },
        ];
        assert!(eval_effects(&body2, &mut Ctx::empty()).is_empty());
    }

    #[test]
    fn status_effect_template_builds_fields_with_optional_emphasis() {
        let body = alloc::vec![Stmt::Emit { effect: EffectTemplate::Status { fields: alloc::vec![
            FieldTemplate { label: "Sanity".into(),
                value: Expr::Str { num: Box::new(s_lit(Value::Number(7.0))) },
                emphasis: Some(s_lit(Value::Str("normal".into()))) },
            FieldTemplate { label: "Round".into(),
                value: Expr::Concat { parts: alloc::vec![
                    Expr::Str { num: Box::new(s_lit(Value::Number(3.0))) },
                    s_lit(Value::Str("/".into())),
                    Expr::Str { num: Box::new(s_lit(Value::Number(150.0))) },
                ] },
                emphasis: None },
        ] } }];
        let fx = eval_effects(&body, &mut Ctx::empty());
        assert_eq!(fx, alloc::vec![Effect::Status { fields: alloc::vec![
            StatusField { label: "Sanity".into(), value: "7".into(), emphasis: Some("normal".into()) },
            StatusField { label: "Round".into(), value: "3/150".into(), emphasis: None },
        ] }]);
    }

    #[test]
    fn script_body_pass_and_state_write() {
        let mut state = serde_json::json!({ "unlocked": false });
        // the door shape: when(!unlocked) { unlocked = true; pass(opened) }
        let body = alloc::vec![Stmt::When {
            cond: Expr::Not { expr: Box::new(Expr::StateGet {
                field: "unlocked".into(), default: Value::Bool(false) }) },
            then: alloc::vec![
                Stmt::SetState { field: "unlocked".into(), value: s_lit(Value::Bool(true)) },
                Stmt::Pass { value: s_lit(Value::Str("The door opens.".into())) },
            ],
        }];
        let mut cx = Ctx { state: CtxState::Write(&mut state), ..Ctx::empty() };
        assert_eq!(eval_script(&body, &mut cx), Some(alloc::string::String::from("The door opens.")));
        assert_eq!(state["unlocked"], serde_json::json!(true));
        // second run: unlocked -> no Pass -> None (the silent re-pass)
        let mut cx2 = Ctx { state: CtxState::Write(&mut state), ..Ctx::empty() };
        assert_eq!(eval_script(&body, &mut cx2), None);
    }

    #[test]
    fn damage_body_value_and_final() {
        let dv = crate::world::mechanics::DamageView {
            amount: 3.5, target: cid("pc"),
            stat: crate::stats::StatType::Health, source: None,
        };
        // the conformance-dread cap shape: amount > 3 ? Final(3) : Value(amount)
        let body = DamageBody::IfElse {
            cond: Expr::Bin { op: BinOp::Gt,
                left: Box::new(Expr::Get { of: Box::new(Expr::Damage), field: "amount".into() }),
                right: Box::new(s_lit(Value::Number(3.0))) },
            then: Box::new(DamageBody::Final { expr: s_lit(Value::Number(3.0)) }),
            r#else: Box::new(DamageBody::Value {
                expr: Expr::Get { of: Box::new(Expr::Damage), field: "amount".into() } }),
        };
        let mut cx = Ctx { damage: Some(&dv), ..Ctx::empty() };
        assert_eq!(eval_damage(&body, &dv, &mut cx), TransformResult::Final(3.0));
        let dv2 = crate::world::mechanics::DamageView { amount: 2.0, ..dv.clone() };
        let mut cx2 = Ctx { damage: Some(&dv2), ..Ctx::empty() };
        assert_eq!(eval_damage(&body, &dv2, &mut cx2), TransformResult::Value(2.0));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core script::eval`
Expected: compile error (`Stmt`/`EffectTemplate`/evaluators missing).

- [ ] **Step 3: Implement**

`ast.rs`: add the enums/struct from Interfaces verbatim (plus `use crate::stats::StatType;` and `use alloc::vec::Vec;`).

`eval.rs`:

```rust
use crate::presentation::{MechanicCue, StatusField};
use crate::world::ids::CharacterId;
use crate::world::mechanics::{Effect, TransformResult};
use super::ast::{DamageBody, EffectTemplate, FieldTemplate, Stmt};
use super::value::value_to_json;

pub fn eval_predicate(e: &Expr, cx: &mut Ctx) -> bool {
    eval_expr(e, cx).truthy()
}

enum Flow { Continue, Halt }

pub fn eval_effects(body: &[Stmt], cx: &mut Ctx) -> Vec<Effect> {
    let mut effects = Vec::new();
    let mut pass = None;
    let _ = exec_stmts(body, cx, &mut effects, &mut pass);
    effects
}

pub fn eval_script(body: &[Stmt], cx: &mut Ctx) -> Option<String> {
    let mut effects = Vec::new();
    let mut pass = None;
    let _ = exec_stmts(body, cx, &mut effects, &mut pass);
    pass
}

fn exec_stmts(stmts: &[Stmt], cx: &mut Ctx, effects: &mut Vec<Effect>,
              pass: &mut Option<String>) -> Flow {
    for s in stmts {
        match s {
            Stmt::Guard { cond } => {
                if !eval_expr(cond, cx).truthy() { return Flow::Halt; }
            }
            Stmt::When { cond, then } => {
                if eval_expr(cond, cx).truthy() {
                    if let Flow::Halt = exec_stmts(then, cx, effects, pass) {
                        return Flow::Halt; // a nested Guard is an early return
                    }
                }
            }
            Stmt::SetState { field, value } => {
                let v = value_to_json(&eval_expr(value, cx).into_value());
                if let CtxState::Write(state) = &mut cx.state {
                    state_set(state, field, v);
                }
            }
            Stmt::SetStateIn { map_field, key, value } => {
                let k = coerce_str(&eval_expr(key, cx).into_value());
                let v = value_to_json(&eval_expr(value, cx).into_value());
                if let CtxState::Write(state) = &mut cx.state {
                    state_set_in(state, map_field, &k, v);
                }
            }
            Stmt::Pass { value } => {
                *pass = Some(coerce_str(&eval_expr(value, cx).into_value()));
            }
            Stmt::Emit { effect } => {
                if let Some(e) = build_effect(effect, cx) {
                    effects.push(e);
                }
            }
        }
    }
    Flow::Continue
}

/// Resolve an effect-target expr to a CharacterId (a character subject or a
/// string id). `None` skips the emit — the dread-shadow `if (target !== undefined)` shape.
fn as_character_id(ev: Ev) -> Option<CharacterId> {
    match ev {
        Ev::Char(c) => Some(c.id),
        Ev::Val(Value::Str(s)) => Some(CharacterId(s)),
        _ => None,
    }
}

fn as_number(ev: Ev) -> Option<f64> {
    match ev.into_value() {
        Value::Number(n) => Some(n),
        _ => None,
    }
}

fn build_effect(t: &EffectTemplate, cx: &mut Ctx) -> Option<Effect> {
    match t {
        EffectTemplate::Damage { target, amount } => Some(Effect::Damage {
            target: as_character_id(eval_expr(target, cx))?,
            amount: as_number(eval_expr(amount, cx))?,
        }),
        EffectTemplate::Heal { target, amount } => Some(Effect::Heal {
            target: as_character_id(eval_expr(target, cx))?,
            amount: as_number(eval_expr(amount, cx))?,
        }),
        EffectTemplate::AdjustStat { target, stat, delta } => Some(Effect::AdjustStat {
            target: as_character_id(eval_expr(target, cx))?,
            stat: *stat,
            delta: as_number(eval_expr(delta, cx))?,
        }),
        EffectTemplate::GrantImmunity { target, turns } => Some(Effect::GrantImmunity {
            target: as_character_id(eval_expr(target, cx))?,
            turns: as_number(eval_expr(turns, cx))?,
        }),
        EffectTemplate::Cue { text } => Some(Effect::Cue {
            cue: MechanicCue { text: Some(coerce_str(&eval_expr(text, cx).into_value())), sound: None },
        }),
        EffectTemplate::Status { fields } => Some(Effect::Status {
            fields: fields.iter().map(|f: &FieldTemplate| StatusField {
                label: f.label.clone(),
                value: coerce_str(&eval_expr(&f.value, cx).into_value()),
                emphasis: f.emphasis.as_ref()
                    .map(|e| coerce_str(&eval_expr(e, cx).into_value())),
            }).collect(),
        }),
    }
}

pub fn eval_damage(body: &DamageBody, d: &DamageView, cx: &mut Ctx) -> TransformResult {
    match body {
        DamageBody::Value { expr } => match as_number(eval_expr(expr, cx)) {
            Some(n) => TransformResult::Value(n),
            None => TransformResult::Value(d.amount), // total: identity
        },
        DamageBody::Final { expr } => match as_number(eval_expr(expr, cx)) {
            Some(n) => TransformResult::Final(n),
            None => TransformResult::Value(d.amount),
        },
        DamageBody::IfElse { cond, then, r#else } => {
            if eval_expr(cond, cx).truthy() { eval_damage(then, d, cx) }
            else { eval_damage(r#else, d, cx) }
        }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core script && cargo build -p wickedways-core --no-default-features`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/script/
git commit -m "feat(script): statements + effect/script/damage body evaluators (scripted-ops T7)"
```

---

### Task 8: widen `ActionView` with the move payload

**Files:**
- Modify: `crates/wickedways-core/src/world/mechanics/mod.rs` (`ActionView.room` + `ActionView::of`)
- Modify: `crates/wickedways-core/src/world/turn.rs` (`record_action` takes `ActionView`)
- Modify: `crates/wickedways-core/src/world/movement.rs:290` (move passes the room payload)
- Modify: `crates/wickedways-core/src/world/combat.rs:261,403`, `crates/wickedways-core/src/world/items_actions.rs:274,540`, `crates/wickedways-core/src/world/gate.rs:101`, `crates/wickedways-core/src/world/mechanics/dispatch.rs:331,361` (call sites)
- Modify: `crates/wickedways-core/src/script/eval.rs` (`Get(Action,"room")` + `Ev::RoomRef` fields)

**Interfaces:**
- Produces:
  ```rust
  // world/mechanics/mod.rs
  pub struct ActionView {
      pub kind: String,
      /// Move payload — TS ActionDetail's "move" variant carries room {id,name}
      /// (src/lib/character/history.ts:13). None for every other action kind.
      pub room: Option<crate::world::history::RoomRef>,
  }
  impl ActionView {
      /// A room-less action view (every non-move action).
      pub fn of(kind: &str) -> ActionView { ActionView { kind: kind.into(), room: None } }
  }
  // world/turn.rs — signature change (was action_kind: &str)
  pub(crate) fn record_action(&mut self, actor: &CharacterId, budgeted: bool,
      action: ActionView, cat: &Catalog, cues: &mut Vec<PresentationCue>)
      -> Result<(), ProceduralViolation>
  ```
  and eval: `Get(Action, "kind") -> Str`, `Get(Action, "room") -> Ev::RoomRef | Null`, `Get(RoomRef, "id"|"name") -> Str`.
- Consumes: `RoomRef` (`world/history.rs:12`), the Task-3 `get_field`.

- [ ] **Step 1: Write the failing tests**

In `eval.rs` tests:

```rust
    #[test]
    fn action_reads_expose_kind_and_move_room_payload() {
        use crate::world::history::RoomRef;
        use crate::world::ids::RoomId;
        let mv = crate::world::mechanics::ActionView {
            kind: "move".into(),
            room: Some(RoomRef { id: RoomId("parlor".into()), name: "Parlor".into() }),
        };
        let mut cx = Ctx { action: Some(&mv), ..Ctx::empty() };
        let val = |e: &Expr, cx: &mut Ctx| eval_expr(e, cx).into_value();
        assert_eq!(val(&Expr::Get { of: Box::new(Expr::Action), field: "kind".into() }, &mut cx),
                   Value::Str("move".into()));
        // the storyteller read: action.room.name
        assert_eq!(val(&Expr::Get {
            of: Box::new(Expr::Get { of: Box::new(Expr::Action), field: "room".into() }),
            field: "name".into() }, &mut cx),
            Value::Str("Parlor".into()));
        // non-move: room -> Null, nested read stays total
        let other = crate::world::mechanics::ActionView::of("pickUp");
        let mut cx2 = Ctx { action: Some(&other), ..Ctx::empty() };
        assert_eq!(val(&Expr::Get {
            of: Box::new(Expr::Get { of: Box::new(Expr::Action), field: "room".into() }),
            field: "name".into() }, &mut cx2),
            Value::Null);
    }
```

In `turn.rs` tests (append to the existing test module):

```rust
    #[test]
    fn record_action_move_carries_room_payload_to_on_action() {
        // The widened ActionView is engine-internal (not serialized), so this
        // asserts construction shape only: ActionView::of has room None.
        let av = crate::world::mechanics::ActionView::of("attack");
        assert_eq!(av.kind, "attack");
        assert!(av.room.is_none());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core`
Expected: compile error (`ActionView` has no field `room` / `ActionView::of` missing).

- [ ] **Step 3: Implement**

1. `world/mechanics/mod.rs` — replace the `ActionView` struct with the widened form + `of` (Interfaces above).
2. `world/turn.rs` `record_action` — change the parameter and the dispatch call:

```rust
    pub(crate) fn record_action(
        &mut self,
        actor: &CharacterId,
        budgeted: bool,
        action: crate::world::mechanics::ActionView,
        cat: &Catalog,
        cues: &mut Vec<PresentationCue>,
    ) -> Result<(), ProceduralViolation> {
        if budgeted {
            if let Some(c) = self.characters.get_mut(actor) {
                c.actions_this_round += 1;
            }
            self.dispatch_action(actor, action, cat, cues)?;
        }
        // ... (unchanged at_cap tail)
```

3. Call sites (mechanical; `use crate::world::mechanics::ActionView;` where needed):
   - `movement.rs:290` →
     ```rust
     self.record_action(actor, true, ActionView {
         kind: "move".into(),
         room: Some(RoomRef { id: room.clone(), name: room_name.clone() }),
     }, cat, cues)?;
     ```
     (`room`/`room_name` are already in scope — they build the `ActionHistoryEntry::Move` at `movement.rs:274-279`.)
   - `combat.rs:261` → `self.record_action(actor, true, ActionView::of("attack"), cat, cues)?;`
   - `combat.rs:403` → `self.record_action(target, false, ActionView::of("takeDamage"), cat, cues)?;`
   - `items_actions.rs:274` → `ActionView::of("pickUp")`; `items_actions.rs:540` → `ActionView::of("drop")`
   - `gate.rs:101` → `ActionView::of("fumble")`
   - `dispatch.rs:331` (`use_mechanic_action`'s ctx) → `action: ActionView::of("mechanicAction"),`
   - `dispatch.rs:361` → `self.record_action(actor, true, ActionView::of("mechanicAction"), cat, cues)`
   - `dispatch.rs` test at `:609` → `ActionView::of("move")` (the unit test constructs one).
   - `turn.rs` test at `:462` and any other test call sites found by the compiler → `ActionView::of("attack")` etc.
4. `script/eval.rs` — extend `get_field`:
   - on `Ev::Action(a)`, add:
     ```rust
            "room" => match &a.room {
                Some(r) => Ev::RoomRef(r.clone()),
                None => Ev::Val(Value::Null),
            },
     ```
   - add the `Ev::RoomRef` arm:
     ```rust
        Ev::RoomRef(r) => match field {
            "id" => Ev::Val(Value::Str(r.id.0.clone())),
            "name" => Ev::Val(Value::Str(r.name.clone())),
            _ => Ev::Val(Value::Null),
        },
     ```

- [ ] **Step 4: Run to verify pass — including the existing conformance gate**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS (the compiler found every call site; `ActionView` is not serialized so no golden changes).

Run: `pnpm run test:conformance`
Expected: ALL existing differential suites still green (this proves the widening is behavior-neutral).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/
git commit -m "feat(mechanics): widen ActionView with the move room payload (scripted-ops T8)"
```

---

### Task 9: ScriptedMechanic + `Catalog.behaviors` + mechanic resolution seam + `validate_mechanics`

**Files:**
- Modify: `crates/wickedways-core/src/script/ast.rs` (`MechanicHooks`, `MechanicScript`, `ExitScript`, `VictoryScript`, `BehaviorScript`)
- Create: `crates/wickedways-core/src/script/ops.rs` (`ScriptedMechanic`)
- Modify: `crates/wickedways-core/src/script/mod.rs` (`pub mod ops;` + `validate_behavior`)
- Modify: `crates/wickedways-core/src/world/descriptor.rs` (`Catalog.behaviors`)
- Modify: `crates/wickedways-core/src/world/mechanics/mod.rs` (`ResolvedMechanicOp`, `resolve_mechanic_op`)
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (5 resolve sites + `validate_mechanics(&self, cat)`)
- Modify: `crates/wickedways-wasm/src/lib.rs:92` (parse catalog before validate; pass `&cat`)

**Interfaces:**
- Produces (`ast.rs`):
  ```rust
  #[serde(rename_all = "camelCase")]
  pub struct MechanicHooks {   // every field: #[serde(default, skip_serializing_if = "Option::is_none")] + ts(optional)
      pub on_round_start: Option<Vec<Stmt>>,
      pub on_round_end: Option<Vec<Stmt>>,
      pub on_turn_start: Option<Vec<Stmt>>,
      pub on_turn_end: Option<Vec<Stmt>>,
      pub on_action: Option<Vec<Stmt>>,
      pub modify_damage: Option<DamageBody>,
  }
  #[serde(rename_all = "camelCase")]
  pub struct MechanicScript {
      /// Literal JSON state seed (TS `initialState()` return value). Plain data,
      /// NOT an Expr — see plan deviation note 1.
      #[cfg_attr(feature = "ts", ts(type = "unknown"))]
      pub init: serde_json::Value,
      #[serde(default)]
      pub hooks: MechanicHooks,
      /// Custom actions (TS `Mechanic.actions`), keyed by action key.
      #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
      pub actions: BTreeMap<String, Vec<Stmt>>,
  }
  #[serde(rename_all = "camelCase")]
  pub struct ExitScript {
      pub can_pass: Expr,
      #[serde(default)]
      pub run_script: Vec<Stmt>,
      #[serde(default, skip_serializing_if = "Option::is_none")] pub pass_message: Option<String>,
      #[serde(default, skip_serializing_if = "Option::is_none")] pub fail_message: Option<String>,
  }
  pub struct VictoryScript { pub test: Expr }
  #[serde(tag = "family", rename_all = "camelCase")]
  pub enum BehaviorScript {
      Mechanic { script: MechanicScript },
      Exit { script: ExitScript },
      Victory { script: VictoryScript },
  }
  ```
  (`MechanicHooks` derives `Default`; all structs/enums derive `Clone, Debug, PartialEq, Serialize, Deserialize` + the `ts` cfg_attr like every boundary type.)
- Produces (`descriptor.rs`):
  ```rust
  pub struct Catalog {
      pub items: BTreeMap<String, ItemDescriptor>,
      pub aliases: BTreeMap<String, Vec<String>>,
      /// Campaign-authored scripted behaviors, keyed by behavior key
      /// (mechanic key / exit behaviorKey / victory condition key).
      #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
      pub behaviors: BTreeMap<String, crate::script::ast::BehaviorScript>,
  }
  ```
- Produces (`ops.rs`):
  ```rust
  pub struct ScriptedMechanic<'a> { pub script: &'a MechanicScript }
  impl MechanicOp for ScriptedMechanic<'_> { /* full trait */ }
  ```
- Produces (`mechanics/mod.rs`):
  ```rust
  pub enum ResolvedMechanicOp<'a> {
      Native(&'static dyn MechanicOp),
      Scripted(crate::script::ops::ScriptedMechanic<'a>),
  }
  impl<'a> ResolvedMechanicOp<'a> {
      pub fn as_op(&self) -> &dyn MechanicOp { ... }
  }
  /// Native registry first; on None, `catalog.behaviors` (Mechanic family only).
  pub fn resolve_mechanic_op<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedMechanicOp<'a>>
  ```
- Produces (`script/mod.rs`):
  ```rust
  /// Load-time AST shape check (spec: fail fast at load, never mid-turn).
  /// Rejects: `Pass` inside an effect body (mechanic hooks/actions), `Emit`
  /// inside an exit `run_script`, and a `Lookup`/`Has` whose `map` operand is
  /// not a `MapLit`.
  pub fn validate_behavior(key: &str, b: &crate::script::ast::BehaviorScript)
      -> Result<(), crate::error::ProceduralViolation>
  ```
- Produces (`dispatch.rs`): `pub fn validate_mechanics(&self, cat: &Catalog) -> Result<(), ProceduralViolation>` — for every `campaign.mechanics[].key`: resolve native-then-scripted (unknown → the EXISTING message `"Mechanic '{key}' is not registered."`); scripted → `validate_behavior`. (Exit/victory key validation is added here in Tasks 13/14.)
- Consumes: `MechanicOp`/`HookCtx`/`TurnCtx`/`ActionCtx` (`world/mechanics/mod.rs:84-99`), `eval_effects`/`eval_damage` (Task 7), `Ctx`/`CtxState`/`RoomSource` (Task 3).

- [ ] **Step 1: Write the failing tests**

In `descriptor.rs` tests:

```rust
    #[test]
    fn catalog_without_behaviors_still_parses_and_roundtrips_empty() {
        // Every committed fixture catalog lacks "behaviors" — must stay loadable.
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {}
        })).unwrap();
        assert!(cat.behaviors.is_empty());
        // empty behaviors are omitted on serialize (fixture-catalog stability)
        let out = serde_json::to_value(&cat).unwrap();
        assert!(out.get("behaviors").is_none());
    }

    #[test]
    fn catalog_parses_a_mechanic_behavior() {
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "dread": { "family": "mechanic", "script": {
                "init": {},
                "hooks": { "onTurnStart": [
                    { "kind": "guard", "cond": { "kind": "not", "expr":
                        { "kind": "hasEquipped", "of": { "kind": "actor" }, "itemKey": "lantern" } } },
                    { "kind": "emit", "effect": { "kind": "adjustStat",
                        "target": { "kind": "actor" }, "stat": "sanity",
                        "delta": { "kind": "lit", "value": -1.0 } } }
                ] }
            } } }
        })).unwrap();
        assert!(matches!(cat.behaviors.get("dread"),
            Some(crate::script::ast::BehaviorScript::Mechanic { .. })));
    }
```

In `dispatch.rs` tests:

```rust
    /// A Catalog carrying the scripted HH-dread shape under key "dread".
    fn cat_with_scripted_dread() -> Catalog {
        serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "dread": { "family": "mechanic", "script": {
                "init": {},
                "hooks": { "onTurnStart": [
                    { "kind": "guard", "cond": { "kind": "not", "expr":
                        { "kind": "hasEquipped", "of": { "kind": "actor" }, "itemKey": "lantern" } } },
                    { "kind": "emit", "effect": { "kind": "adjustStat",
                        "target": { "kind": "actor" }, "stat": "sanity",
                        "delta": { "kind": "lit", "value": -1.0 } } }
                ] }
            } } }
        })).unwrap()
    }

    #[test]
    fn dispatch_turn_runs_a_scripted_mechanic_from_the_catalog() {
        let mut w = world_with_party(&["pc"], 10); // sanity 5
        w.campaign.mechanics.push(MechanicSnapshot {
            key: "dread".into(), state: serde_json::json!({}),
        });
        let cat = cat_with_scripted_dread();
        let mut cues = Vec::new();
        w.dispatch_turn(TurnPhase::Start, &cid("pc"), &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 4.0, "scripted AdjustStat applied");
        // missing hooks are no-ops (defaulted trait behavior)
        w.dispatch_round(RoundPhase::Start, &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].stats.sanity, 4.0);
        assert!(cues.is_empty(), "no cues from a cue-less script");
    }

    #[test]
    fn native_registry_wins_over_a_same_key_behavior() {
        // "conformance:dread" resolves NATIVE even if the catalog shadows the key.
        let mut cat = cat_with_scripted_dread();
        let script = cat.behaviors.remove("dread").unwrap();
        cat.behaviors.insert("conformance:dread".into(), script);
        match crate::world::mechanics::resolve_mechanic_op("conformance:dread", &cat) {
            Some(crate::world::mechanics::ResolvedMechanicOp::Native(_)) => {}
            other => panic!("expected native resolution, got {:?}", other.is_some()),
        }
    }

    #[test]
    fn validate_mechanics_accepts_scripted_and_rejects_unknown_with_cat() {
        let mut w = world_with_party(&["pc"], 10);
        let cat = cat_with_scripted_dread();
        w.campaign.mechanics.push(MechanicSnapshot { key: "dread".into(), state: serde_json::json!({}) });
        assert!(w.validate_mechanics(&cat).is_ok());
        w.campaign.mechanics.push(MechanicSnapshot { key: "storyteller".into(), state: serde_json::json!({}) });
        let err = w.validate_mechanics(&cat).unwrap_err();
        assert!(err.0.contains("Mechanic 'storyteller' is not registered."));
    }

    #[test]
    fn validate_mechanics_rejects_ill_shaped_scripts() {
        // a Pass statement inside a mechanic hook (an effect body) is ill-shaped
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "bad": { "family": "mechanic", "script": {
                "init": {},
                "hooks": { "onTurnStart": [
                    { "kind": "pass", "value": { "kind": "lit", "value": "nope" } }
                ] }
            } } }
        })).unwrap();
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.mechanics.push(MechanicSnapshot { key: "bad".into(), state: serde_json::json!({}) });
        assert!(w.validate_mechanics(&cat).is_err());
    }

    #[test]
    fn scripted_run_action_resolves_and_missing_action_is_none() {
        use crate::script::ast::BehaviorScript;
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "m": { "family": "mechanic", "script": {
                "init": {},
                "hooks": {},
                "actions": { "brace": [
                    { "kind": "emit", "effect": { "kind": "cue",
                        "text": { "kind": "lit", "value": "You brace." } } }
                ] }
            } } }
        })).unwrap();
        let Some(BehaviorScript::Mechanic { script }) = cat.behaviors.get("m") else { panic!() };
        let op = crate::script::ops::ScriptedMechanic { script };
        // init_state returns the literal seed and ignores config
        assert_eq!(crate::world::mechanics::MechanicOp::init_state(&op, &serde_json::json!(null)),
                   serde_json::json!({}));
        let w = world_with_party(&["pc"], 10);
        let view = w.build_campaign_view(&Catalog::default());
        let actor = w.character_view(&cid("pc"), &Catalog::default()).unwrap();
        let mut state = serde_json::json!({});
        let mut rng = w.rng.clone();
        let mut cx = crate::world::mechanics::ActionCtx {
            base: crate::world::mechanics::HookCtx { state: &mut state, view: &view, rng: &mut rng },
            actor,
            action: crate::world::mechanics::ActionView::of("mechanicAction"),
        };
        let fx = crate::world::mechanics::MechanicOp::run_action(&op, "brace", &mut cx).unwrap();
        assert_eq!(fx.len(), 1);
        assert!(crate::world::mechanics::MechanicOp::run_action(&op, "nope", &mut cx).is_none());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core`
Expected: compile errors (`behaviors` field, `BehaviorScript`, `resolve_mechanic_op`, `validate_mechanics(&cat)` missing).

- [ ] **Step 3: Implement**

1. `ast.rs`: add the script structs/enums from Interfaces (all with serde + `ts` derives; `MechanicHooks` also `Default`).
2. `descriptor.rs`: add the `behaviors` field (Interfaces). No other change — `Default`/`PartialEq` derives extend naturally.
3. `script/ops.rs`:

```rust
//! Adapter ops: satisfy the existing Phase-1 traits by interpreting a stored AST.
use alloc::string::String;
use alloc::vec::Vec;
use serde_json::Value as Json;

use crate::script::ast::{MechanicScript, Stmt};
use crate::script::eval::{eval_damage, eval_effects, Ctx, CtxState, RoomSource};
use crate::world::mechanics::{
    ActionCtx, DamageView, Effect, HookCtx, MechanicOp, TransformResult, TurnCtx,
};

/// A `MechanicOp` bound to a borrowed script (built per fire-point by
/// `resolve_mechanic_op` — no cloning of the AST).
pub struct ScriptedMechanic<'a> {
    pub script: &'a MechanicScript,
}

impl ScriptedMechanic<'_> {
    fn run_body(
        &self,
        body: Option<&Vec<Stmt>>,
        base: &mut HookCtx,
        actor: Option<&crate::world::mechanics::CharacterView>,
        action: Option<&crate::world::mechanics::ActionView>,
    ) -> Vec<Effect> {
        let Some(body) = body else { return Vec::new() }; // missing hook = no-op
        let mut cx = Ctx {
            view: Some(base.view),
            state: CtxState::Write(base.state),
            actor,
            action,
            damage: None,
            element: None,
            rng: Some(base.rng),
            rooms: RoomSource::None, // mechanics cannot see rooms (oracle parity)
        };
        eval_effects(body, &mut cx)
    }
}

impl MechanicOp for ScriptedMechanic<'_> {
    fn init_state(&self, _config: &Json) -> Json {
        self.script.init.clone()
    }
    fn on_round_start(&self, cx: &mut HookCtx) -> Vec<Effect> {
        self.run_body(self.script.hooks.on_round_start.as_ref(), cx, None, None)
    }
    fn on_round_end(&self, cx: &mut HookCtx) -> Vec<Effect> {
        self.run_body(self.script.hooks.on_round_end.as_ref(), cx, None, None)
    }
    fn on_turn_start(&self, cx: &mut TurnCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        self.run_body(self.script.hooks.on_turn_start.as_ref(), &mut cx.base, Some(&actor), None)
    }
    fn on_turn_end(&self, cx: &mut TurnCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        self.run_body(self.script.hooks.on_turn_end.as_ref(), &mut cx.base, Some(&actor), None)
    }
    fn on_action(&self, cx: &mut ActionCtx) -> Vec<Effect> {
        let actor = cx.actor.clone();
        let action = cx.action.clone();
        self.run_body(self.script.hooks.on_action.as_ref(), &mut cx.base, Some(&actor), Some(&action))
    }
    fn modify_damage(&self, d: &DamageView, cx: &mut HookCtx) -> TransformResult {
        match &self.script.hooks.modify_damage {
            None => TransformResult::Value(d.amount),
            Some(body) => {
                let mut ecx = Ctx {
                    view: Some(cx.view),
                    state: CtxState::Write(cx.state),
                    actor: None,
                    action: None,
                    damage: Some(d),
                    element: None,
                    rng: Some(cx.rng),
                    rooms: RoomSource::None,
                };
                eval_damage(body, d, &mut ecx)
            }
        }
    }
    fn run_action(&self, action_key: &str, cx: &mut ActionCtx) -> Option<Vec<Effect>> {
        let body = self.script.actions.get(action_key)?;
        let actor = cx.actor.clone();
        let action = cx.action.clone();
        Some(self.run_body(Some(body), &mut cx.base, Some(&actor), Some(&action)))
    }
}
```

4. `script/mod.rs` — add `pub mod ops;` and `validate_behavior`:

```rust
use crate::error::ProceduralViolation;
use alloc::format;
use ast::{BehaviorScript, Expr, Stmt};

/// Load-time shape check for a scripted behavior — fail fast at load, never
/// mid-turn. The interpreter is total, so this rejects only AUTHORING mistakes:
/// a `Pass` in an effect body, an `Emit` in an exit script, a non-`MapLit`
/// `Lookup`/`Has` operand.
pub fn validate_behavior(key: &str, b: &BehaviorScript) -> Result<(), ProceduralViolation> {
    let bad = |why: &str| Err(ProceduralViolation(format!("Behavior '{key}' is invalid: {why}")));
    match b {
        BehaviorScript::Mechanic { script } => {
            let hooks = [
                &script.hooks.on_round_start, &script.hooks.on_round_end,
                &script.hooks.on_turn_start, &script.hooks.on_turn_end,
                &script.hooks.on_action,
            ];
            for body in hooks.into_iter().flatten() {
                check_stmts(body, /*allow_pass=*/false, /*allow_emit=*/true)
                    .or_else(|w| bad(w))?;
            }
            for body in script.actions.values() {
                check_stmts(body, false, true).or_else(|w| bad(w))?;
            }
            Ok(())
        }
        BehaviorScript::Exit { script } => {
            check_expr(&script.can_pass).or_else(|w| bad(w))?;
            check_stmts(&script.run_script, /*allow_pass=*/true, /*allow_emit=*/false)
                .or_else(|w| bad(w))
        }
        BehaviorScript::Victory { script } => check_expr(&script.test).or_else(|w| bad(w)),
    }
}

fn check_stmts(stmts: &[Stmt], allow_pass: bool, allow_emit: bool) -> Result<(), &'static str> {
    for s in stmts {
        match s {
            Stmt::Pass { value } if !allow_pass => return Err("Pass is not legal in an effect body"),
            Stmt::Pass { value } => check_expr(value)?,
            Stmt::Emit { .. } if !allow_emit => return Err("Emit is not legal in an exit script"),
            Stmt::Emit { effect } => check_effect(effect)?,
            Stmt::Guard { cond } => check_expr(cond)?,
            Stmt::When { cond, then } => {
                check_expr(cond)?;
                check_stmts(then, allow_pass, allow_emit)?;
            }
            Stmt::SetState { value, .. } => check_expr(value)?,
            Stmt::SetStateIn { key, value, .. } => { check_expr(key)?; check_expr(value)?; }
        }
    }
    Ok(())
}

fn check_effect(t: &ast::EffectTemplate) -> Result<(), &'static str> {
    use ast::EffectTemplate as T;
    match t {
        T::Damage { target, amount } | T::Heal { target, amount } => {
            check_expr(target)?; check_expr(amount)
        }
        T::AdjustStat { target, delta, .. } => { check_expr(target)?; check_expr(delta) }
        T::GrantImmunity { target, turns } => { check_expr(target)?; check_expr(turns) }
        T::Cue { text } => check_expr(text),
        T::Status { fields } => {
            for f in fields {
                check_expr(&f.value)?;
                if let Some(e) = &f.emphasis { check_expr(e)?; }
            }
            Ok(())
        }
    }
}

/// Recursive expression walk: `Lookup`/`Has` must take a `MapLit` map operand.
fn check_expr(e: &Expr) -> Result<(), &'static str> {
    match e {
        Expr::Lookup { map, key } | Expr::Has { map, key } => {
            if !matches!(map.as_ref(), Expr::MapLit { .. }) {
                return Err("Lookup/Has requires a MapLit operand");
            }
            check_expr(key)
        }
        Expr::Bin { left, right, .. } => { check_expr(left)?; check_expr(right) }
        Expr::Not { expr } | Expr::Defined { expr } | Expr::Str { num: expr }
        | Expr::Length { list: expr } | Expr::First { list: expr } => check_expr(expr),
        Expr::IfElse { cond, then, r#else } => {
            check_expr(cond)?; check_expr(then)?; check_expr(r#else)
        }
        Expr::Index { list, index } => { check_expr(list)?; check_expr(index) }
        Expr::Includes { list, value } => { check_expr(list)?; check_expr(value) }
        Expr::Get { of, .. } | Expr::HasEquipped { of, .. }
        | Expr::HasItem { of, .. } | Expr::HasKey { of, .. } => check_expr(of),
        Expr::StateGetIn { key, .. } => check_expr(key),
        Expr::Some { list, pred } | Expr::Every { list, pred } => {
            check_expr(list)?; check_expr(pred)
        }
        Expr::Concat { parts } => { for p in parts { check_expr(p)?; } Ok(()) }
        Expr::Lit { .. } | Expr::MapLit { .. } | Expr::Round | Expr::MaxRounds
        | Expr::Party | Expr::Actor | Expr::Action | Expr::Damage | Expr::Element
        | Expr::StateGet { .. } => Ok(()),
    }
}
```

(NOTE: `Stmt::Pass { value }` in the not-allowed arm intentionally ignores `value` — bind as `Stmt::Pass { .. }` if the compiler flags the unused binding.)

5. `world/mechanics/mod.rs` — add the resolver:

```rust
use crate::world::descriptor::Catalog;

/// A key resolved to an op: a compiled-in native, or an interpreter bound to a
/// catalog-borrowed AST (no per-fire-point clone — spec risk note).
pub enum ResolvedMechanicOp<'a> {
    Native(&'static dyn MechanicOp),
    Scripted(crate::script::ops::ScriptedMechanic<'a>),
}

impl<'a> ResolvedMechanicOp<'a> {
    pub fn as_op(&self) -> &dyn MechanicOp {
        match self {
            ResolvedMechanicOp::Native(op) => *op,
            ResolvedMechanicOp::Scripted(s) => s,
        }
    }
}

/// Native registry first; on `None`, look the key up in `catalog.behaviors`
/// (Mechanic family only). `None` when both miss.
pub fn resolve_mechanic_op<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedMechanicOp<'a>> {
    if let Some(op) = mechanic_op(key) {
        return Some(ResolvedMechanicOp::Native(op));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Mechanic { script }) => {
            Some(ResolvedMechanicOp::Scripted(crate::script::ops::ScriptedMechanic { script }))
        }
        _ => None,
    }
}
```

6. `dispatch.rs` — at each of the five sites replace the direct lookup. Pattern (in `dispatch_round`; identical in `dispatch_turn` and `dispatch_action`):

```rust
                let Some(resolved) = crate::world::mechanics::resolve_mechanic_op(&m.key, cat) else {
                    return Err(ProceduralViolation(format!(
                        "Mechanic '{}' is not registered.", m.key
                    )));
                };
                let op = resolved.as_op();
```

In `run_damage_transformers` (silent-continue semantics preserved):

```rust
            let Some(resolved) = crate::world::mechanics::resolve_mechanic_op(&m.key, cat) else { continue };
            let op = resolved.as_op();
```

In `use_mechanic_action` (`dispatch.rs:318`):

```rust
        let resolved = crate::world::mechanics::resolve_mechanic_op(mechanic_key, cat)
            .ok_or_else(|| ProceduralViolation(format!(
                "Mechanic '{}' is not registered.", mechanic_key
            )))?;
        let op = resolved.as_op();
```

And widen `validate_mechanics`:

```rust
    /// Fail-fast on an unresolvable mechanic key or an ill-shaped scripted AST
    /// (TS registry throw at hydrate). Call after building a `World` for replay.
    /// Tasks 13/14 extend this to exit behavior keys and victory condition keys.
    pub fn validate_mechanics(&self, cat: &Catalog) -> Result<(), ProceduralViolation> {
        for m in &self.campaign.mechanics {
            if crate::world::mechanics::resolve_mechanic_op(&m.key, cat).is_none() {
                return Err(ProceduralViolation(format!(
                    "Mechanic '{}' is not registered.", m.key
                )));
            }
            if let Some(b) = cat.behaviors.get(&m.key) {
                if crate::world::mechanics::mechanic_op(&m.key).is_none() {
                    crate::script::validate_behavior(&m.key, b)?;
                }
            }
        }
        Ok(())
    }
```

Update the existing `validate_mechanics` unit test (`dispatch.rs:766`) to pass `&Catalog::default()`.

7. `crates/wickedways-wasm/src/lib.rs` (`replay_commands`) — move the catalog parse ABOVE validation and pass it:

```rust
    let mut world = World::from_snapshot(snap);
    let cat: Catalog =
        serde_json::from_str(catalog_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    world.validate_mechanics(&cat).map_err(|e| JsValue::from_str(&e.0))?;
    world.seed_rng(seed);
```

(delete the later duplicate `let cat: Catalog = ...` line.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS / no_std build green.

Run: `pnpm run test:conformance`
Expected: the wasm build (rebuilt by this script via `wasm:build`) compiles with the reordered `validate_mechanics(&cat)`, and every existing suite stays green (native resolution path unchanged; empty `behaviors` defaulted).

- [ ] **Step 5: Commit**

```bash
git add crates/
git commit -m "feat(script): ScriptedMechanic + Catalog.behaviors + native-then-scripted resolution seam (scripted-ops T9)"
```

---

### Task 10: ts-rs bindings for the AST

**Files:**
- Modify: `crates/wickedways-core/src/stats.rs` (`export_typescript_bindings` list)
- Generated: `generated/bindings/*.ts` (via `bindings:gen` — NEVER hand-edited)

**Interfaces:**
- Produces: generated TS types `ScriptValue`, `BinOp`, `Expr`, `Stmt`, `EffectTemplate`, `FieldTemplate`, `DamageBody`, `MechanicHooks`, `MechanicScript`, `ExitScript`, `VictoryScript`, `BehaviorScript` in `generated/bindings/`, plus a regenerated `Catalog` carrying `behaviors`. Task 11's builders import these.
- Consumes: the `#[cfg_attr(feature = "ts", derive(TS), ts(export))]` attributes already present on every type from Tasks 1–9 (verify each new type in `script/value.rs`/`script/ast.rs` carries them — that is this task's checklist).

- [ ] **Step 1: Add the exports (the "failing test" is the bindings check)**

In `stats.rs`'s `ts_export` module test, append:

```rust
        // Scripted-ops DSL AST (scripted-ops plan, Task 10)
        use crate::script::ast::{
            BehaviorScript, BinOp, DamageBody, EffectTemplate, Expr, ExitScript,
            FieldTemplate, MechanicHooks, MechanicScript, Stmt, VictoryScript,
        };
        use crate::script::value::Value as ScriptValue;
        ScriptValue::export_all().expect("export ScriptValue");
        BinOp::export_all().expect("export BinOp");
        Expr::export_all().expect("export Expr");
        Stmt::export_all().expect("export Stmt");
        EffectTemplate::export_all().expect("export EffectTemplate");
        FieldTemplate::export_all().expect("export FieldTemplate");
        DamageBody::export_all().expect("export DamageBody");
        MechanicHooks::export_all().expect("export MechanicHooks");
        MechanicScript::export_all().expect("export MechanicScript");
        ExitScript::export_all().expect("export ExitScript");
        VictoryScript::export_all().expect("export VictoryScript");
        BehaviorScript::export_all().expect("export BehaviorScript");
```

- [ ] **Step 2: Run to verify the check fails before regeneration**

Run: `pnpm run bindings:check`
Expected: FAIL — `git diff --exit-code generated/bindings` reports new/changed files (the new AST types + the widened `Catalog.ts`). If instead the ts build fails, fix the missing `ts` cfg_attrs on the offending type first.

- [ ] **Step 3: Regenerate and inspect**

Run: `pnpm run bindings:gen && git status --short generated/bindings`
Expected: new files `ScriptValue.ts`, `BinOp.ts`, `Expr.ts`, `Stmt.ts`, `EffectTemplate.ts`, `FieldTemplate.ts`, `DamageBody.ts`, `MechanicHooks.ts`, `MechanicScript.ts`, `ExitScript.ts`, `VictoryScript.ts`, `BehaviorScript.ts`; modified `Catalog.ts`. Spot-check `Expr.ts` starts with the `kind`-tagged union and `ScriptValue.ts` is `boolean | number | string | Array<ScriptValue> | null`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run bindings:check && pnpm run typecheck`
Expected: PASS (clean diff after commit staging; root typecheck unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-core/src/stats.rs generated/bindings/
git commit -m "feat(bindings): export scripted-ops AST types via ts-rs (scripted-ops T10)"
```

---

### Task 11: TS builder helpers

**Files:**
- Create: `packages/campaigns/src/scripted/builders.ts`
- Create: `packages/campaigns/src/scripted/index.ts`
- Test: `packages/campaigns/src/scripted/builders.test.ts`

**Interfaces:**
- Produces (`builders.ts`) — every helper returns the ts-rs-generated types (single source of truth):
  ```ts
  // exprs
  lit(v: string | number | boolean | null): Expr
  mapLit(entries: Record<string, ScriptValue>): Expr
  round, maxRounds, party, actor, action, element: Expr          // constants
  first(list), length(list), index(list, i), includes(list, v)   // -> Expr
  get(of, field), hasEquipped(of, itemKey), hasItem(of, itemKey), hasKey(of, keyCode)
  add/sub/mul/div/eq/ne/lt/lte/gt/gte/and/or(left, right), not(expr), ifElse(cond, then, els), defined(expr)
  stateGet(field, def), stateGetIn(mapField, key, def), lookup(map, key), has(map, key)
  some(list, pred), every(list, pred), str(num), concat(...parts)
  // stmts
  guard(cond), when(cond, then: Stmt[]), setState(field, value), setStateIn(mapField, key, value),
  emit(effect), pass(value)
  sequence(...stmts: Stmt[]): Stmt[]                              // identity helper for readable bodies
  // effect templates
  damage(target, amount), heal(target, amount), adjust(target, stat, delta),
  grantImmunity(target, turns), cue(text), status(fields), field(label, value, emphasis?)
  // families
  mechanic(def: { init: unknown; hooks?: MechanicHooks; actions?: Record<string, Stmt[]> }): BehaviorScript
  exit(def: { canPass: Expr; runScript?: Stmt[]; passMessage?: string; failMessage?: string }): BehaviorScript
  victory(test: Expr): BehaviorScript
  ```
- Consumes: `generated/bindings/{Expr,Stmt,EffectTemplate,FieldTemplate,MechanicHooks,BehaviorScript,ScriptValue,StatType}.ts` (Task 10). Imports use `.ts` extensions relative to the repo root (`packages/campaigns/tsconfig.json` sets `allowImportingTsExtensions: true`).

- [ ] **Step 1: Write the failing test**

`packages/campaigns/src/scripted/builders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as s from "./builders.ts";

describe("scripted-ops builders", () => {
  it("emits the exact serde AST JSON for expressions", () => {
    expect(s.lit(5)).toEqual({ kind: "lit", value: 5 });
    expect(s.not(s.hasEquipped(s.actor, "lantern"))).toEqual({
      kind: "not",
      expr: { kind: "hasEquipped", of: { kind: "actor" }, itemKey: "lantern" },
    });
    expect(s.eq(s.get(s.action, "kind"), s.lit("move"))).toEqual({
      kind: "bin", op: "eq",
      left: { kind: "get", of: { kind: "action" }, field: "kind" },
      right: { kind: "lit", value: "move" },
    });
    expect(s.stateGetIn("seen", s.lit("Parlor"), false)).toEqual({
      kind: "stateGetIn", mapField: "seen", key: { kind: "lit", value: "Parlor" }, default: false,
    });
    expect(s.some(s.party, s.lte(s.get(s.element, "sanity"), s.lit(0)))).toEqual({
      kind: "some", list: { kind: "party" },
      pred: { kind: "bin", op: "lte",
        left: { kind: "get", of: { kind: "element" }, field: "sanity" },
        right: { kind: "lit", value: 0 } },
    });
    expect(s.concat(s.str(s.round), s.lit("/"), s.str(s.maxRounds))).toEqual({
      kind: "concat", parts: [
        { kind: "str", num: { kind: "round" } },
        { kind: "lit", value: "/" },
        { kind: "str", num: { kind: "maxRounds" } },
      ],
    });
  });

  it("emits statements and effect templates", () => {
    expect(s.emit(s.adjust(s.actor, "sanity", s.lit(-1)))).toEqual({
      kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" },
        stat: "sanity", delta: { kind: "lit", value: -1 } },
    });
    expect(s.setStateIn("seen", s.lit("Parlor"), s.lit(true))).toEqual({
      kind: "setStateIn", mapField: "seen",
      key: { kind: "lit", value: "Parlor" }, value: { kind: "lit", value: true },
    });
    // FieldTemplate is a plain struct (NOT kind-tagged); emphasis omitted when absent
    expect(s.field("Round", s.lit("1/10"))).toEqual({
      label: "Round", value: { kind: "lit", value: "1/10" },
    });
    expect(s.field("Sanity", s.lit("7"), s.lit("normal"))).toEqual({
      label: "Sanity", value: { kind: "lit", value: "7" },
      emphasis: { kind: "lit", value: "normal" },
    });
  });

  it("emits behavior-script families", () => {
    expect(s.victory(s.lit(true))).toEqual({
      family: "victory", script: { test: { kind: "lit", value: true } },
    });
    expect(s.exit({ canPass: s.lit(true), failMessage: "locked" })).toEqual({
      family: "exit",
      script: { canPass: { kind: "lit", value: true }, runScript: [], failMessage: "locked" },
    });
    expect(s.mechanic({ init: {}, hooks: { onTurnStart: [s.guard(s.lit(true))] } })).toEqual({
      family: "mechanic",
      script: { init: {}, hooks: { onTurnStart: [{ kind: "guard", cond: { kind: "lit", value: true } }] }, actions: {} },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/campaigns/src/scripted/builders.test.ts`
Expected: FAIL — module `./builders.ts` not found.

- [ ] **Step 3: Implement**

`packages/campaigns/src/scripted/builders.ts`:

```ts
/**
 * Typed builder helpers for the scripted-ops DSL. Each helper emits the exact
 * serde JSON of the Rust AST (`crates/wickedways-core/src/script/ast.rs`); the
 * types are the ts-rs-generated bindings, so authoring and interpretation share
 * one source of truth. See docs/superpowers/specs/2026-07-06-rust-engine-scripted-ops-dsl-design.md.
 */
import type { Expr } from "../../../../generated/bindings/Expr.ts";
import type { Stmt } from "../../../../generated/bindings/Stmt.ts";
import type { EffectTemplate } from "../../../../generated/bindings/EffectTemplate.ts";
import type { FieldTemplate } from "../../../../generated/bindings/FieldTemplate.ts";
import type { MechanicHooks } from "../../../../generated/bindings/MechanicHooks.ts";
import type { BehaviorScript } from "../../../../generated/bindings/BehaviorScript.ts";
import type { ScriptValue } from "../../../../generated/bindings/ScriptValue.ts";
import type { StatType } from "../../../../generated/bindings/StatType.ts";
import type { BinOp } from "../../../../generated/bindings/BinOp.ts";

export type { BehaviorScript, Expr, Stmt, EffectTemplate, FieldTemplate };

// ── expressions ───────────────────────────────────────────────────────────────
export const lit = (value: string | number | boolean | null): Expr => ({ kind: "lit", value });
export const mapLit = (entries: Record<string, ScriptValue>): Expr => ({ kind: "mapLit", entries });
export const round: Expr = { kind: "round" };
export const maxRounds: Expr = { kind: "maxRounds" };
export const party: Expr = { kind: "party" };
export const actor: Expr = { kind: "actor" };
export const action: Expr = { kind: "action" };
export const damageSubject: Expr = { kind: "damage" };
export const element: Expr = { kind: "element" };
export const first = (list: Expr): Expr => ({ kind: "first", list });
export const length = (list: Expr): Expr => ({ kind: "length", list });
export const index = (list: Expr, i: Expr): Expr => ({ kind: "index", list, index: i });
export const includes = (list: Expr, value: Expr): Expr => ({ kind: "includes", list, value });
export const get = (of: Expr, field: string): Expr => ({ kind: "get", of, field });
export const hasEquipped = (of: Expr, itemKey: string): Expr => ({ kind: "hasEquipped", of, itemKey });
export const hasItem = (of: Expr, itemKey: string): Expr => ({ kind: "hasItem", of, itemKey });
export const hasKey = (of: Expr, keyCode: string): Expr => ({ kind: "hasKey", of, keyCode });

const bin = (op: BinOp) => (left: Expr, right: Expr): Expr => ({ kind: "bin", op, left, right });
export const add = bin("add"); export const sub = bin("sub");
export const mul = bin("mul"); export const div = bin("div");
export const eq = bin("eq"); export const ne = bin("ne");
export const lt = bin("lt"); export const lte = bin("lte");
export const gt = bin("gt"); export const gte = bin("gte");
export const and = bin("and"); export const or = bin("or");
export const not = (expr: Expr): Expr => ({ kind: "not", expr });
export const ifElse = (cond: Expr, then: Expr, els: Expr): Expr => ({ kind: "ifElse", cond, then, else: els });
export const defined = (expr: Expr): Expr => ({ kind: "defined", expr });

export const stateGet = (field: string, def: ScriptValue): Expr =>
  ({ kind: "stateGet", field, default: def });
export const stateGetIn = (mapField: string, key: Expr, def: ScriptValue): Expr =>
  ({ kind: "stateGetIn", mapField, key, default: def });
export const lookup = (map: Expr, key: Expr): Expr => ({ kind: "lookup", map, key });
export const has = (map: Expr, key: Expr): Expr => ({ kind: "has", map, key });

export const some = (list: Expr, pred: Expr): Expr => ({ kind: "some", list, pred });
export const every = (list: Expr, pred: Expr): Expr => ({ kind: "every", list, pred });
export const str = (num: Expr): Expr => ({ kind: "str", num });
export const concat = (...parts: Expr[]): Expr => ({ kind: "concat", parts });

// ── statements ────────────────────────────────────────────────────────────────
export const guard = (cond: Expr): Stmt => ({ kind: "guard", cond });
export const when = (cond: Expr, then: Stmt[]): Stmt => ({ kind: "when", cond, then });
export const setState = (field: string, value: Expr): Stmt => ({ kind: "setState", field, value });
export const setStateIn = (mapField: string, key: Expr, value: Expr): Stmt =>
  ({ kind: "setStateIn", mapField, key, value });
export const emit = (effect: EffectTemplate): Stmt => ({ kind: "emit", effect });
export const pass = (value: Expr): Stmt => ({ kind: "pass", value });
/** Readability helper: a statement body is just an array. */
export const sequence = (...stmts: Stmt[]): Stmt[] => stmts;

// ── effect templates ──────────────────────────────────────────────────────────
export const damage = (target: Expr, amount: Expr): EffectTemplate =>
  ({ kind: "damage", target, amount });
export const heal = (target: Expr, amount: Expr): EffectTemplate =>
  ({ kind: "heal", target, amount });
export const adjust = (target: Expr, stat: StatType, delta: Expr): EffectTemplate =>
  ({ kind: "adjustStat", target, stat, delta });
export const grantImmunity = (target: Expr, turns: Expr): EffectTemplate =>
  ({ kind: "grantImmunity", target, turns });
export const cue = (text: Expr): EffectTemplate => ({ kind: "cue", text });
export const status = (fields: FieldTemplate[]): EffectTemplate => ({ kind: "status", fields });
export const field = (label: string, value: Expr, emphasis?: Expr): FieldTemplate =>
  emphasis === undefined ? { label, value } : { label, value, emphasis };

// ── behavior families ─────────────────────────────────────────────────────────
export const mechanic = (def: {
  init: unknown;
  hooks?: MechanicHooks;
  actions?: Record<string, Stmt[]>;
}): BehaviorScript => ({
  family: "mechanic",
  script: { init: def.init, hooks: def.hooks ?? {}, actions: def.actions ?? {} },
});

export const exit = (def: {
  canPass: Expr;
  runScript?: Stmt[];
  passMessage?: string;
  failMessage?: string;
}): BehaviorScript => ({
  family: "exit",
  script: {
    canPass: def.canPass,
    runScript: def.runScript ?? [],
    ...(def.passMessage !== undefined ? { passMessage: def.passMessage } : {}),
    ...(def.failMessage !== undefined ? { failMessage: def.failMessage } : {}),
  },
});

export const victory = (test: Expr): BehaviorScript => ({
  family: "victory",
  script: { test },
});
```

`packages/campaigns/src/scripted/index.ts`:

```ts
export * from "./builders.ts";
```

NOTE: the generated binding types may model optional fields as `x?: T` or `x: T | null` depending on the `ts(optional)` attrs — read the generated `.ts` files after Task 10 and, if a builder's emitted object needs a `null` instead of an omitted key (or vice versa), match the GENERATED type (the serde side accepts omitted keys via `#[serde(default)]`; prefer omission, and add `ts(optional)` attrs in `ast.rs` + regenerate rather than emitting `null`s).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/campaigns/src/scripted/builders.test.ts && pnpm --filter @wickedways/campaigns run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/campaigns/src/scripted/
git commit -m "feat(authoring): typed TS builders emitting the scripted-ops AST (scripted-ops T11)"
```

---

### Task 12: re-author the Hollow House mechanics as scripts + differential fixtures

**Files:**
- Create: `packages/campaigns/src/hollow-house/scripted.ts` (dread / storyteller / status-bar this task; doors in Task 13, victory in Task 14)
- Test: `packages/campaigns/src/hollow-house/scripted.test.ts`
- Create: `conformance/fixtures/scripted-helpers.ts`
- Create: `conformance/fixtures/scripted-mechanics.gen.test.ts` → writes `scripted-mechanics.{start.snapshot,catalog,golden}.json`
- Create: `conformance/scripted-mechanics.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts` (register the generator)

**Interfaces:**
- Produces (`scripted.ts`):
  ```ts
  export const dreadScript: BehaviorScript                       // oracle: packages/campaigns/src/hollow-house/mechanics.ts:5-11
  export function storytellerScript(lore: Record<string, string>): BehaviorScript  // oracle: mechanics.ts:13-28
  export const statusBarScript: BehaviorScript                   // oracle: status.ts:4-31
  export function hollowHouseBehaviors(): Record<string, BehaviorScript>
      // this task: { [Mechanics.Dread], [Mechanics.Storyteller], [Mechanics.StatusBar] }
      // Task 13 adds the two ExitBehaviors keys; Task 14 the three Conditions keys.
  ```
- Produces (`scripted-helpers.ts`): `itemToCatalogEntry(item)` and `buildCatalog(registry, itemKeys, aliases, behaviors)` — the catalog exporter shared by all scripted generators (lifted verbatim from `conformance/fixtures/mechanics.gen.test.ts:125-167`, plus a `behaviors` pass-through slot).
- Consumes: builders (Task 11), the ORACLE closures `dread`/`makeStoryteller`/`statusBar` and `LORE` (`packages/campaigns/src/hollow-house/{mechanics,status,content}.ts` — imported UNCHANGED into the generator as the TS side), `Items`/`Rooms`/`Mechanics` ids (`ids.ts`), fixture plumbing (`mulberry32`, `viewProjected`, `serializeCampaign`, `authorTemplate`, `startSession`, `defineRegistry`).

- [ ] **Step 1: Write the scripted ops + their shape test (failing first)**

`packages/campaigns/src/hollow-house/scripted.ts`:

```ts
/**
 * The Hollow House ops re-authored in the scripted-ops DSL. Each script MUST
 * reproduce its hand-written closure (mechanics.ts / status.ts / content.ts /
 * index.ts) exactly — those closures are the differential-gate oracle.
 */
import * as s from "../scripted/builders.ts";
import type { BehaviorScript, Expr, EffectTemplate } from "../scripted/builders.ts";
import { LORE } from "./content.js";
import { Items, Mechanics } from "./ids.js";

// ── dread (oracle: mechanics.ts:5-11) ────────────────────────────────────────
// onTurnStart: hasEquipped(lantern) ? [] : [adjustStat(actor, sanity, -1)]
export const dreadScript: BehaviorScript = s.mechanic({
  init: {},
  hooks: {
    onTurnStart: [
      s.guard(s.not(s.hasEquipped(s.actor, Items.Lantern))),
      s.emit(s.adjust(s.actor, "sanity", s.lit(-1))),
    ],
  },
});

// ── storyteller (oracle: mechanics.ts:13-28) ─────────────────────────────────
// Guard order mirrors the closure: move? -> lore fragment? -> journal? -> unseen?
export function storytellerScript(lore: Record<string, string>): BehaviorScript {
  const roomName: Expr = s.get(s.get(s.action, "room"), "name");
  const loreMap: Expr = s.mapLit(lore);
  return s.mechanic({
    init: { seen: {} },
    hooks: {
      onAction: [
        s.guard(s.eq(s.get(s.action, "kind"), s.lit("move"))),
        s.guard(s.has(loreMap, roomName)),
        s.guard(s.hasItem(s.actor, Items.Journal)),
        s.guard(s.not(s.stateGetIn("seen", roomName, false))),
        s.setStateIn("seen", roomName, s.lit(true)),
        s.emit(s.cue(s.lookup(loreMap, roomName))),
      ],
    },
  });
}

// ── status-bar (oracle: status.ts:4-31) ──────────────────────────────────────
// emphasisFor: <=3 critical, <=6 warn, else normal. "Round" has NO emphasis.
const emphasisFor = (sanity: Expr): Expr =>
  s.ifElse(s.lte(sanity, s.lit(3)), s.lit("critical"),
    s.ifElse(s.lte(sanity, s.lit(6)), s.lit("warn"), s.lit("normal")));

const statusFields = (sanity: Expr): EffectTemplate =>
  s.status([
    s.field("Sanity", s.str(sanity), emphasisFor(sanity)),
    s.field("Round", s.concat(s.str(s.round), s.lit("/"), s.str(s.maxRounds))),
  ]);

export const statusBarScript: BehaviorScript = s.mechanic({
  init: {},
  hooks: {
    // Initial paint at round start (party may be empty pre-boot -> emit nothing).
    onRoundStart: [
      s.guard(s.gt(s.length(s.party), s.lit(0))),
      s.emit(statusFields(s.get(s.first(s.party), "sanity"))),
    ],
    // After each turn's effects (e.g. dread), so values are current.
    onTurnEnd: [s.emit(statusFields(s.get(s.actor, "sanity")))],
  },
});

/** Every Hollow House behavior, keyed exactly as the engine resolves them.
 *  (Doors join in plan Task 13; victory conditions in Task 14.) */
export function hollowHouseBehaviors(): Record<string, BehaviorScript> {
  return {
    [Mechanics.Dread]: dreadScript,
    [Mechanics.Storyteller]: storytellerScript(LORE),
    [Mechanics.StatusBar]: statusBarScript,
  };
}
```

`packages/campaigns/src/hollow-house/scripted.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dreadScript, hollowHouseBehaviors, storytellerScript } from "./scripted.ts";
import { LORE } from "./content.js";
import { Rooms } from "./ids.js";

describe("hollow-house scripted behaviors", () => {
  it("dread guards on the equipped lantern and drains sanity by 1", () => {
    expect(dreadScript).toEqual({
      family: "mechanic",
      script: {
        init: {},
        hooks: {
          onTurnStart: [
            { kind: "guard", cond: { kind: "not", expr:
              { kind: "hasEquipped", of: { kind: "actor" }, itemKey: "lantern" } } },
            { kind: "emit", effect: { kind: "adjustStat", target: { kind: "actor" },
              stat: "sanity", delta: { kind: "lit", value: -1 } } },
          ],
        },
        actions: {},
      },
    });
  });

  it("storyteller embeds the lore table and dedupes through state.seen", () => {
    const st = storytellerScript(LORE);
    if (st.family !== "mechanic") throw new Error("expected mechanic");
    expect(st.script.init).toEqual({ seen: {} });
    const body = st.script.hooks.onAction!;
    expect(body).toHaveLength(6);
    // the embedded MapLit carries the exact LORE fragments
    const hasGuard = body[1] as { kind: string; cond: { kind: string; map: { entries: Record<string, string> } } };
    expect(hasGuard.cond.map.entries[Rooms.Parlor]).toBe(LORE[Rooms.Parlor]);
  });

  it("registers all three mechanic keys", () => {
    expect(Object.keys(hollowHouseBehaviors()).sort())
      .toEqual(["dread", "status-bar", "storyteller"]);
  });
});
```

Run: `pnpm vitest run packages/campaigns/src/hollow-house/scripted.test.ts`
Expected: FAIL first (file missing), then PASS after writing `scripted.ts`.

- [ ] **Step 2: Write the shared fixture helper**

`conformance/fixtures/scripted-helpers.ts`:

```ts
/**
 * Catalog exporter for the scripted-ops generators: identical to the
 * itemToCatalogEntry/buildCatalog pair in mechanics.gen.test.ts:125-167 (copy
 * the two functions VERBATIM from there), plus a `behaviors` slot so the Rust
 * side can resolve scripted keys from `Catalog.behaviors`.
 */
import type { Item } from "wickedways/lib/inventory";
import type { BehaviorScript } from "../../packages/campaigns/src/scripted/builders.ts";

export function itemToCatalogEntry(item: Item): Record<string, unknown> {
  /* copy verbatim from conformance/fixtures/mechanics.gen.test.ts:125-153 */
  return {
    name: item.name,
    type: item.type,
    stat: item.stat,
    modifier: item.modifier,
    properties: {
      equippable: item.properties.equippable,
      equipped: item.properties.equipped,
      destroyable: item.properties.destroyable,
      usable: item.properties.usable,
      ...(item.properties.droppable !== undefined
        ? { droppable: item.properties.droppable }
        : {}),
    },
    ...(item.slot !== undefined ? { slot: item.slot } : {}),
    ...(item.twoHanded !== undefined ? { twoHanded: item.twoHanded } : {}),
    ...(item.emitsLight !== undefined ? { emitsLight: item.emitsLight } : {}),
    ...(item.maxDurability !== undefined ? { maxDurability: item.maxDurability } : {}),
    ...(item.lore !== undefined ? { lore: item.lore } : {}),
    ...(item.presentation !== undefined ? { presentation: item.presentation } : {}),
    ...(item.keyCode !== undefined ? { keyCode: item.keyCode } : {}),
    ...(item.consumeOnUse !== undefined ? { consumeOnUse: item.consumeOnUse } : {}),
    recipe: item.recipe,
    teaches: item.teaches ?? null,
    immunities: item.immunities ?? null,
    grantsImmunity: item.grantsImmunity ?? null,
  };
}

export function buildCatalog(
  itemFactories: Record<string, () => Item>,
  itemKeys: string[],
  aliases: Record<string, string[]>,
  behaviors: Record<string, BehaviorScript>,
): { items: Record<string, unknown>; aliases: Record<string, string[]>;
     behaviors: Record<string, BehaviorScript> } {
  const items: Record<string, unknown> = {};
  for (const key of itemKeys) {
    items[key] = itemToCatalogEntry(itemFactories[key]!());
  }
  return { items, aliases, behaviors };
}
```

- [ ] **Step 3: Write the differential generator**

`conformance/fixtures/scripted-mechanics.gen.test.ts` — the TS side runs the REAL hand-written closures; the Rust side (replay) will interpret the scripted ASTs from the catalog. Model the boilerplate on `mechanics.gen.test.ts` (imports, `here`, cue drain, file writes) and `items-actions.gen.test.ts:406-470` (the command-dispatch switch and `findInLoot`/`findHeld` helpers — copy those helpers verbatim):

```ts
/**
 * scripted-mechanics golden generator.
 *
 * TS side: the REAL Hollow House closures (dread / makeStoryteller(LORE) /
 * statusBar) — the oracle. Rust side: the same keys resolve to the scripted
 * ASTs carried in catalog.behaviors. Green = the AST + interpreter reproduce
 * the closures byte-for-byte (incl. num->string Status fields and the
 * action.room.name storyteller read).
 *
 * Coverage (spec gate list):
 *   dread        — drain without the lantern; NO drain once it is equipped
 *   storyteller  — lore cue on first journal-carrying entry to the Parlor;
 *                  dedupe on re-entry; no cue without the journal (Ben);
 *                  no cue in a non-lore room (Foyer)
 *   status-bar   — Sanity emphasis normal (7) / warn (6..4) / critical (<=3)
 *                  + the "round/maxRounds" concat, per turn-end and round-start
 *
 * Writes scripted-mechanics.{start.snapshot,catalog,golden}.json.
 * Run via: pnpm run fixtures:gen
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { mulberry32 } from "../seeded-rng.ts";
import { defineRegistry } from "wickedways/lib/authoring/registry";
import { authorTemplate } from "wickedways/lib/authoring/template-builder";
import { startSession } from "wickedways/lib/authoring/orchestration";
import { serializeCampaign } from "wickedways/lib/serialization/serializer";
import { StatType } from "wickedways/lib/character/stats";
import { Directions } from "wickedways/lib/room";
import type { PresentationCue } from "wickedways/lib/presentation";
import type { IItem, ILoot } from "wickedways/lib/inventory"; // match items-actions.gen imports
import { viewProjected } from "./gen-helpers.ts";
import { buildCatalog } from "./scripted-helpers.ts";
import { dread, makeStoryteller } from "../../packages/campaigns/src/hollow-house/mechanics.ts";
import { statusBar } from "../../packages/campaigns/src/hollow-house/status.ts";
import { LORE } from "../../packages/campaigns/src/hollow-house/content.ts";
import { ITEM_FACTORIES } from "../../packages/campaigns/src/hollow-house/items.ts";
import { Items, Mechanics, Rooms } from "../../packages/campaigns/src/hollow-house/ids.ts";
import { hollowHouseBehaviors } from "../../packages/campaigns/src/hollow-house/scripted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 0x5c21;

type Command =
  | { kind: "startTurn" } | { kind: "endTurn" } | { kind: "nextPlayer" }
  | { kind: "go"; dir: (typeof Directions)[keyof typeof Directions] }
  | { kind: "take"; targetId: string }
  | { kind: "equip"; targetId: string };

describe("generate scripted-mechanics golden", () => {
  it("writes the booted snapshot + per-step golden", () => {
    const registry = defineRegistry({
      items: { [Items.Lantern]: ITEM_FACTORIES[Items.Lantern]!, [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
      mechanics: {
        [Mechanics.Dread]: dread,
        [Mechanics.Storyteller]: makeStoryteller(LORE),
        [Mechanics.StatusBar]: statusBar,
      },
    });

    const template = authorTemplate("Scripted Mechanics (conformance)", registry, {
      rng: mulberry32(SEED), maxRounds: 10, baseEncounterChance: 0,
    })
      // Ada shows normal->warn; Ben shows critical. Energy 5 mirrors HH.
      .archetype({ id: "heir", name: "Heir",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 8, [StatType.Energy]: 5 } })
      .archetype({ id: "frail", name: "Frail",
        baseStats: { [StatType.Health]: 12, [StatType.Sanity]: 4, [StatType.Energy]: 5 } })
      .room(Rooms.Foyer, { description: "The entrance hall." })
      .room(Rooms.Parlor, { description: "A mildewed parlor." }) // a LORE room
      .startRoom(Rooms.Foyer)
      .exit(Rooms.Foyer, Directions.East, Rooms.Parlor)
      .exit(Rooms.Parlor, Directions.West, Rooms.Foyer)
      .loot("foyer-table", { room: Rooms.Foyer, items: [Items.Journal, Items.Lantern],
        description: "A hall table." })
      .useMechanic(Mechanics.Dread)
      .useMechanic(Mechanics.Storyteller)
      .useMechanic(Mechanics.StatusBar);

    const campaign = startSession(template, {
      players: [{ name: "Ada", archetype: "heir" }, { name: "Ben", archetype: "frail" }],
      gm: 0,
    });

    // Resolve the loot item ids for the command stream.
    const foyer = campaign.activeCharacter.currentRoom!;
    const table = [...foyer.loot.values()][0]!;
    const journalId = table.contents.find((i) => i.behaviorKey === Items.Journal)!.id as unknown as string;
    const lanternId = table.contents.find((i) => i.behaviorKey === Items.Lantern)!.id as unknown as string;

    const start = serializeCampaign(campaign);
    writeFileSync(join(here, "scripted-mechanics.start.snapshot.json"),
      JSON.stringify(start, null, 2) + "\n");

    let buf: PresentationCue[] = [];
    campaign.onCue((c: PresentationCue) => buf.push(c));
    const drain = () => { const out = buf; buf = []; return out; };

    const commands: Command[] = [
      // R0 Ada (sanity 8 -> 7 at startTurn; both takes fill the budget -> auto endTurn)
      { kind: "startTurn" },
      { kind: "take", targetId: journalId },
      { kind: "take", targetId: lanternId },
      { kind: "nextPlayer" },
      // R0 Ben (4 -> 3): moves into the Parlor WITHOUT the journal -> no lore cue
      { kind: "startTurn" },
      { kind: "go", dir: Directions.East },
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // round end -> round 1 -> statusBar round-start paint
      // R1 Ada (7 -> 6): equip lantern (free), first journal-carrying Parlor entry -> LORE cue,
      // back to the Foyer (non-lore -> no cue); budget 2 -> auto endTurn
      { kind: "startTurn" },
      { kind: "equip", targetId: lanternId },
      { kind: "go", dir: Directions.East },
      { kind: "go", dir: Directions.West },
      { kind: "nextPlayer" },
      // R1 Ben (3 -> 2)
      { kind: "startTurn" },
      { kind: "endTurn" },
      { kind: "nextPlayer" }, // -> round 2
      // R2 Ada: lantern equipped -> NO drain; Parlor re-entry -> dedupe, no cue
      { kind: "startTurn" },
      { kind: "go", dir: Directions.East },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
      // R2 Ben (2 -> 1)
      { kind: "startTurn" },
      { kind: "endTurn" },
      { kind: "nextPlayer" },
    ];

    const pcNow = () => campaign.activeCharacter;
    const findHeld = (id: string): IItem => {
      const it = pcNow().inventory.items.find((i) => (i.id as unknown as string) === id);
      if (!it) throw new Error(`Item ${id} not held by active PC.`);
      return it;
    };
    const opened = new Set<string>();
    const findInLoot = (id: string): { loot: ILoot; item: IItem } => {
      const room = pcNow().currentRoom!;
      for (const loot of room.loot.values()) {
        const item = loot.contents.find((i) => (i.id as unknown as string) === id);
        if (item) return { loot, item };
      }
      throw new Error(`Item ${id} not found in any co-located loot container.`);
    };

    const steps = commands.map((cmd) => {
      switch (cmd.kind) {
        case "startTurn": pcNow().startTurn(); break;
        case "endTurn": pcNow().endTurn(); break;
        case "nextPlayer": campaign.nextPlayer(); break;
        case "go": pcNow().go(cmd.dir); break;
        case "take": {
          const { loot, item } = findInLoot(cmd.targetId);
          if (!opened.has(loot.id as unknown as string)) {
            pcNow().openLootBox(loot);
            opened.add(loot.id as unknown as string);
          }
          pcNow().takeFromLootBox(loot, [item]);
          break;
        }
        case "equip": pcNow().equip(findHeld(cmd.targetId)); break;
      }
      return {
        command: cmd,
        cues: drain(),
        snapshot: serializeCampaign(campaign),
        view: viewProjected(campaign, {}, opened),
      };
    });

    // ── self-checks: the fixture must actually exercise the gate coverage ────
    const allCues = steps.flatMap((s) => s.cues);
    const mechanicTexts = allCues
      .filter((c): c is Extract<PresentationCue, { kind: "mechanic" }> => c.kind === "mechanic")
      .map((c) => c.cue.text);
    const loreHits = mechanicTexts.filter((t) => t === LORE[Rooms.Parlor]);
    if (loreHits.length !== 1) throw new Error(`expected exactly 1 Parlor lore cue, got ${loreHits.length}`);
    const emphases = new Set(
      allCues
        .filter((c): c is Extract<PresentationCue, { kind: "status" }> => c.kind === "status")
        .flatMap((c) => c.fields.filter((f) => f.label === "Sanity").map((f) => f.emphasis)),
    );
    for (const want of ["normal", "warn", "critical"]) {
      if (!emphases.has(want as never)) throw new Error(`missing Sanity emphasis "${want}"`);
    }
    // the lantern blocked round-2 drain: Ada's sanity is unchanged at 6
    const ada = campaign.party[0]!;
    if (ada.effectiveStat(StatType.Sanity) !== 6) {
      throw new Error(`expected Ada sanity 6 after the shielded turn, got ${ada.effectiveStat(StatType.Sanity)}`);
    }

    const behaviors = hollowHouseBehaviors();
    const catalog = buildCatalog(
      { [Items.Lantern]: ITEM_FACTORIES[Items.Lantern]!, [Items.Journal]: ITEM_FACTORIES[Items.Journal]! },
      [Items.Lantern, Items.Journal],
      {},
      {
        [Mechanics.Dread]: behaviors[Mechanics.Dread]!,
        [Mechanics.Storyteller]: behaviors[Mechanics.Storyteller]!,
        [Mechanics.StatusBar]: behaviors[Mechanics.StatusBar]!,
      },
    );
    writeFileSync(join(here, "scripted-mechanics.catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    writeFileSync(join(here, "scripted-mechanics.golden.json"),
      JSON.stringify({ seed: SEED, commands, steps }, null, 2) + "\n");
  });
});
```

NOTE for the implementer: if a self-check throws because a low-sanity affliction fizzle ate one of Ben's actions, bump `SEED` until the stream lands clean — the assertions, not the numbers, are the contract. If any TS driving call differs (e.g. `openLootBox` naming), mirror `conformance/fixtures/items-actions.gen.test.ts:435-470` exactly — that file is the working reference for every command case used here.

- [ ] **Step 4: Register the generator + write the replay test**

In `conformance/fixtures/vitest.config.ts`, append to `include` (before the closing bracket):

```ts
      "conformance/fixtures/scripted-mechanics.gen.test.ts",
```

`conformance/scripted-mechanics.test.ts` (the replay diff — same harness as `conformance/mechanics.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { canonicalize } from "./canonical-json.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require("../crates/wickedways-wasm/pkg/wickedways_wasm.js") as {
  replay_commands: (s: string, c: string, cat: string, seed: number) => string;
};

const start = readFileSync(join(here, "fixtures/scripted-mechanics.start.snapshot.json"), "utf8");
const catalogJson = readFileSync(join(here, "fixtures/scripted-mechanics.catalog.json"), "utf8");
const golden = JSON.parse(
  readFileSync(join(here, "fixtures/scripted-mechanics.golden.json"), "utf8"),
) as {
  seed: number;
  commands: unknown[];
  steps: Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
};

describe("scripted-mechanics differential conformance", () => {
  it("Rust scripted ops match the TS closure oracle per step (cues + snapshot + view)", () => {
    const out = JSON.parse(
      wasm.replay_commands(start, JSON.stringify(golden.commands), catalogJson, golden.seed),
    ) as Array<{ command: unknown; cues: unknown; snapshot: unknown; view: unknown }>;
    expect(out.length).toBe(golden.steps.length);
    out.forEach((step, i) => {
      const want = golden.steps[i]!;
      expect(canonicalize(step.cues), `step ${i} cues`).toEqual(canonicalize(want.cues));
      expect(canonicalize(step.snapshot), `step ${i} snapshot`).toEqual(canonicalize(want.snapshot));
      expect(canonicalize(step.view), `step ${i} view`).toEqual(canonicalize(want.view));
    });
  });
});
```

- [ ] **Step 5: Generate goldens, then run the gate**

Run: `pnpm run fixtures:gen`
Expected: the three `scripted-mechanics.*.json` files are written; every self-check assertion passed; all pre-existing generators still write byte-identical files (`git status` shows ONLY the three new files).

Run: `pnpm run test:conformance`
Expected: `conformance/scripted-mechanics.test.ts` PASSES along with every existing suite. Any per-step diff = an interpreter/AST bug — fix it in `script/` (or `scripted.ts`), regenerate NOTHING, and re-run. Do not touch goldens or `canonical-json.ts`.

Run: `pnpm vitest run packages/campaigns/src/hollow-house/scripted.test.ts && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/campaigns/src/hollow-house/scripted.ts packages/campaigns/src/hollow-house/scripted.test.ts \
        conformance/fixtures/scripted-helpers.ts conformance/fixtures/scripted-mechanics.gen.test.ts \
        conformance/fixtures/scripted-mechanics.*.json conformance/scripted-mechanics.test.ts \
        conformance/fixtures/vitest.config.ts
git commit -m "test(conformance): scripted dread/storyteller/status-bar vs TS closure oracle (scripted-ops T12)"
```

---

### Task 13: ScriptedExit + exit resolution seam + re-author the doors + fixtures

**Files:**
- Modify: `crates/wickedways-core/src/script/ops.rs` (`ScriptedExit`)
- Modify: `crates/wickedways-core/src/world/exits.rs` (`ResolvedExitBehavior`, `resolve_exit_behavior`)
- Modify: `crates/wickedways-core/src/world/movement.rs:104` (`go` resolves via the seam)
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`validate_mechanics` also checks exit behavior keys)
- Modify: `packages/campaigns/src/hollow-house/scripted.ts` (`doorScript` + the two door keys in `hollowHouseBehaviors`)
- Create: `conformance/fixtures/scripted-doors.gen.test.ts` (+ `scripted-doors.{start.snapshot,catalog,golden}.json`)
- Create: `conformance/scripted-doors.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts`

**Interfaces:**
- Produces (`ops.rs`):
  ```rust
  pub struct ScriptedExit<'a> { pub script: &'a ExitScript }
  impl ExitBehavior for ScriptedExit<'_> {
      fn can_pass(&self, actor: &CharacterView, state: &Json) -> bool   // eval_predicate, CtxState::Read
      fn run_script(&self, actor: &CharacterView, state: &mut Json) -> Option<String> // eval_script, CtxState::Write
      fn pass_message(&self) -> Option<&str>    // script.pass_message.as_deref()
      fn fail_message(&self) -> Option<&str>
  }
  ```
  Exit eval contexts: `view: None`, `rooms: RoomSource::None`, `actor: Some(..)` (matches the TS `ExitPrecondition(character, state)` shape — `src/lib/exit.ts:12-14`).
- Produces (`exits.rs`):
  ```rust
  pub enum ResolvedExitBehavior<'a> {
      Native(&'static dyn ExitBehavior),
      Scripted(crate::script::ops::ScriptedExit<'a>),
  }
  impl<'a> ResolvedExitBehavior<'a> { pub fn as_behavior(&self) -> &dyn ExitBehavior }
  pub fn resolve_exit_behavior<'a>(key: &str, cat: &Catalog) -> Option<ResolvedExitBehavior<'a>>
      // native first; then catalog.behaviors (Exit family only)   [lifetime: cat: &'a Catalog]
  ```
- Produces (`scripted.ts`):
  ```ts
  export function doorScript(keyCode: string, name: string, opened: string): BehaviorScript
  // oracle: content.ts doorBehavior(keyCode, name, opened) — content.ts:23-39
  ```
  `hollowHouseBehaviors()` gains `[ExitBehaviors.StudyDoor]` (brass) and `[ExitBehaviors.AtticDoor]` (iron) with the exact HH messages (`index.ts:31-32`).
- Consumes: `ExitBehavior` trait (`world/exits.rs:10-18`), `go`'s behavior branch (`movement.rs:101-132`), `eval_predicate`/`eval_script` (Task 7), builders (Task 11).

- [ ] **Step 1: Write the failing Rust tests**

In `exits.rs` — a shared test-catalog builder placed at the bottom of the FILE (outside the `tests` module, `#[cfg(test)]`-gated + `pub(crate)`) so the `movement.rs` test below reuses it, then the tests. Inside `exits.rs`'s own test module, alias it: `use super::tests_catalog_with_door as cat_with_door;`

```rust
    #[cfg(test)]
    pub(crate) fn tests_catalog_with_door(key: &str) -> crate::world::descriptor::Catalog {
        serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { key: { "family": "exit", "script": {
                "canPass": { "kind": "bin", "op": "or",
                    "left": { "kind": "stateGet", "field": "unlocked", "default": false },
                    "right": { "kind": "hasKey", "of": { "kind": "actor" }, "keyCode": "brass" } },
                "runScript": [ { "kind": "when",
                    "cond": { "kind": "not", "expr":
                        { "kind": "stateGet", "field": "unlocked", "default": false } },
                    "then": [
                        { "kind": "setState", "field": "unlocked",
                          "value": { "kind": "lit", "value": true } },
                        { "kind": "pass", "value": { "kind": "lit", "value": "The door unlocks." } }
                    ] } ],
                "failMessage": "The study door won't budge — it's locked."
            } } }
        })).unwrap()
    }

    #[test]
    fn resolve_exit_behavior_native_first_then_scripted() {
        let cat = cat_with_door("study-door");
        assert!(matches!(resolve_exit_behavior("conformance:keyed-door", &cat),
            Some(ResolvedExitBehavior::Native(_))));
        assert!(matches!(resolve_exit_behavior("study-door", &cat),
            Some(ResolvedExitBehavior::Scripted(_))));
        assert!(resolve_exit_behavior("nope", &cat).is_none());
    }

    #[test]
    fn scripted_door_matches_the_hh_door_contract() {
        use crate::world::descriptor::Catalog;
        use crate::world::ids::{CharacterId, ItemId};
        use crate::world::snapshot::ItemSnapshot;
        use crate::world::test_support::world_with_party;
        let cat = cat_with_door("study-door");
        let Some(ResolvedExitBehavior::Scripted(door)) = resolve_exit_behavior("study-door", &cat)
            else { panic!("expected scripted") };
        let b: &dyn ExitBehavior = &door;

        // actor WITHOUT the brass key
        let mut w = world_with_party(&["pc"], 10);
        let no_key = w.character_view(&CharacterId("pc".into()), &Catalog::default()).unwrap();
        let mut state = json!({ "unlocked": false });
        assert!(!b.can_pass(&no_key, &state), "locked + keyless -> blocked");
        assert_eq!(b.fail_message(), Some("The study door won't budge — it's locked."));
        assert_eq!(b.pass_message(), None);

        // actor WITH the brass key: passes, unlocks once, silent re-pass
        w.items.insert(ItemId("k1".into()), ItemSnapshot::Key {
            id: ItemId("k1".into()), name: "Brass Key".into(),
            key_code: "brass".into(), consume_on_use: false,
        });
        w.characters.get_mut(&CharacterId("pc".into())).unwrap()
            .inventory.key_ids.push(ItemId("k1".into()));
        let with_key = w.character_view(&CharacterId("pc".into()), &Catalog::default()).unwrap();
        assert!(b.can_pass(&with_key, &state));
        assert_eq!(b.run_script(&with_key, &mut state).as_deref(), Some("The door unlocks."));
        assert_eq!(state["unlocked"], json!(true));
        assert_eq!(b.run_script(&with_key, &mut state), None, "already unlocked -> silent");
        // and now even a keyless actor passes (state.unlocked)
        assert!(b.can_pass(&no_key, &state));
    }
```

In `movement.rs` tests — reuse the module's existing keyed-exit helpers (`make_north_exit_keyed` at `movement.rs:554` and the two `keyed_exit_*` tests at `movement.rs:550-584` are the template), plus a small real-Key seeder since the scripted door matches by `keyCode`, not `behaviorKey`:

```rust
    /// Put a true Key (kind:"key") with `key_code` into `char_id`'s keyring.
    fn seed_held_key(w: &mut crate::world::World, char_id: &str, key_code: &str) {
        use crate::world::snapshot::ItemSnapshot;
        let item_id = crate::world::ids::ItemId(alloc::format!("key-{key_code}"));
        w.items.insert(item_id.clone(), ItemSnapshot::Key {
            id: item_id.clone(), name: alloc::format!("{key_code} key"),
            key_code: key_code.into(), consume_on_use: false,
        });
        if let Some(c) = w.characters.get_mut(&cid(char_id)) {
            c.inventory.key_ids.push(item_id);
        }
    }

    #[test]
    fn go_resolves_a_scripted_exit_from_the_catalog() {
        // Same two-room world as the conformance:keyed-door tests, but the
        // north exit resolves through Catalog.behaviors ("study-door").
        let cat = crate::world::exits::tests_catalog_with_door("study-door"); // see note below
        let mut w = world_two_rooms(false);
        w.make_north_exit_keyed("study-door");
        for ex in w.exits.values_mut() {
            if ex.behavior_key.is_some() { ex.state = serde_json::json!({ "unlocked": false }); }
        }
        let start_room = w.characters[&cid("pc")].current_room_id.clone();
        let mut cues = Vec::new();

        // 1. keyless: blocked, fail cue, no move
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_eq!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The study door won't budge — it's locked."))));

        // 2. with the brass key: unlock narration + move + persisted state
        seed_held_key(&mut w, "pc", "brass");
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::North, &cat, &mut cues).unwrap();
        assert_ne!(w.characters[&cid("pc")].current_room_id, start_room);
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { cue }
            if cue.text.as_deref() == Some("The door unlocks."))));
        assert!(w.exits.values().any(|ex| ex.state.get("unlocked") == Some(&serde_json::json!(true))));

        // 3. re-pass back through the unlocked door: silent (no mechanic cue)
        let mut cues = Vec::new();
        w.go(&cid("pc"), Direction::South, &cat, &mut cues).unwrap();
        assert!(!cues.iter().any(|c| matches!(c, PresentationCue::Mechanic { .. })),
            "unlocked re-pass must be silent");
    }
```

Sharing note: `cat_with_door` lives in `exits.rs`'s test module (Step 1). Rather than duplicating the JSON, hoist it as `#[cfg(test)] pub(crate) fn tests_catalog_with_door(key: &str) -> Catalog` at the bottom of `exits.rs` (outside the `tests` module, `cfg(test)`-gated) so both test modules use one copy.

In `dispatch.rs` tests:

```rust
    #[test]
    fn validate_mechanics_rejects_an_unregistered_exit_behavior_key() {
        let mut w = crate::world::test_support::world_two_rooms(false);
        // stamp an unknown behavior key on the connecting exit
        let exit_id = w.exits.keys().next().unwrap().clone();
        w.exits.get_mut(&exit_id).unwrap().behavior_key = Some("ghost-door".into());
        let err = w.validate_mechanics(&Catalog::default()).unwrap_err();
        assert!(err.0.contains("Exit behavior 'ghost-door' is not registered."));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core`
Expected: compile errors (`ScriptedExit`, `resolve_exit_behavior` missing).

- [ ] **Step 3: Implement (Rust)**

`ops.rs`:

```rust
use crate::script::ast::ExitScript;
use crate::script::eval::{eval_predicate, eval_script};
use crate::world::exits::ExitBehavior;
use crate::world::mechanics::CharacterView;

/// An `ExitBehavior` bound to a borrowed script. Exit contexts have no campaign
/// view and no room resolver — matching the TS `ExitPrecondition(character, state)`
/// contract (src/lib/exit.ts:12-14).
pub struct ScriptedExit<'a> {
    pub script: &'a ExitScript,
}

impl ExitBehavior for ScriptedExit<'_> {
    fn can_pass(&self, actor: &CharacterView, state: &Json) -> bool {
        let mut cx = Ctx {
            view: None,
            state: CtxState::Read(state),
            actor: Some(actor),
            action: None, damage: None, element: None, rng: None,
            rooms: RoomSource::None,
        };
        eval_predicate(&self.script.can_pass, &mut cx)
    }
    fn run_script(&self, actor: &CharacterView, state: &mut Json) -> Option<String> {
        let mut cx = Ctx {
            view: None,
            state: CtxState::Write(state),
            actor: Some(actor),
            action: None, damage: None, element: None, rng: None,
            rooms: RoomSource::None,
        };
        eval_script(&self.script.run_script, &mut cx)
    }
    fn pass_message(&self) -> Option<&str> { self.script.pass_message.as_deref() }
    fn fail_message(&self) -> Option<&str> { self.script.fail_message.as_deref() }
}
```

`exits.rs`:

```rust
use crate::world::descriptor::Catalog;

pub enum ResolvedExitBehavior<'a> {
    Native(&'static dyn ExitBehavior),
    Scripted(crate::script::ops::ScriptedExit<'a>),
}

impl<'a> ResolvedExitBehavior<'a> {
    pub fn as_behavior(&self) -> &dyn ExitBehavior {
        match self {
            ResolvedExitBehavior::Native(b) => *b,
            ResolvedExitBehavior::Scripted(s) => s,
        }
    }
}

/// Native registry first; then `catalog.behaviors` (Exit family only).
pub fn resolve_exit_behavior<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedExitBehavior<'a>> {
    if let Some(b) = exit_behavior(key) {
        return Some(ResolvedExitBehavior::Native(b));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Exit { script }) => {
            Some(ResolvedExitBehavior::Scripted(crate::script::ops::ScriptedExit { script }))
        }
        _ => None,
    }
}
```

`movement.rs:104` — replace the resolve line only (`behavior` keeps its name so the rest of `go` is untouched):

```rust
            let resolved = crate::world::exits::resolve_exit_behavior(&key, cat).ok_or_else(|| {
                ProceduralViolation(format!("Exit behavior '{key}' is not registered."))
            })?;
            let behavior = resolved.as_behavior();
```

`dispatch.rs` `validate_mechanics` — append after the mechanics loop:

```rust
        for exit in self.exits.values() {
            if let Some(key) = &exit.behavior_key {
                if crate::world::exits::resolve_exit_behavior(key, cat).is_none() {
                    return Err(ProceduralViolation(format!(
                        "Exit behavior '{key}' is not registered."
                    )));
                }
                if let Some(b) = cat.behaviors.get(key) {
                    if crate::world::exits::exit_behavior(key).is_none() {
                        crate::script::validate_behavior(key, b)?;
                    }
                }
            }
        }
```

- [ ] **Step 4: Implement (TS) — the doors in `scripted.ts`**

Append to `packages/campaigns/src/hollow-house/scripted.ts` (and extend `hollowHouseBehaviors`):

```ts
// ── keyed doors (oracle: content.ts doorBehavior, content.ts:23-39) ──────────
// canPass: state.unlocked || hasKey(keyCode); script: first pass sets unlocked
// and returns the opened line; no passMessage -> silent re-pass.
export function doorScript(keyCode: string, name: string, opened: string): BehaviorScript {
  return s.exit({
    canPass: s.or(s.stateGet("unlocked", false), s.hasKey(s.actor, keyCode)),
    runScript: [
      s.when(s.not(s.stateGet("unlocked", false)), [
        s.setState("unlocked", s.lit(true)),
        s.pass(s.lit(opened)),
      ]),
    ],
    failMessage: `The ${name} won't budge — it's locked.`,
  });
}
```

and in `hollowHouseBehaviors()` (import `ExitBehaviors` from `./ids.js`):

```ts
    [ExitBehaviors.StudyDoor]: doorScript("brass", "study door",
      "The brass key turns; the study door swings open."),
    [ExitBehaviors.AtticDoor]: doorScript("iron", "attic door",
      "The iron key grinds in the lock; the attic stairs open above you."),
```

Add to `scripted.test.ts`:

```ts
  it("door scripts mirror doorBehavior", () => {
    const door = doorScript("brass", "study door", "It opens.");
    expect(door).toEqual({
      family: "exit",
      script: {
        canPass: { kind: "bin", op: "or",
          left: { kind: "stateGet", field: "unlocked", default: false },
          right: { kind: "hasKey", of: { kind: "actor" }, keyCode: "brass" } },
        runScript: [{ kind: "when",
          cond: { kind: "not", expr: { kind: "stateGet", field: "unlocked", default: false } },
          then: [
            { kind: "setState", field: "unlocked", value: { kind: "lit", value: true } },
            { kind: "pass", value: { kind: "lit", value: "It opens." } },
          ] }],
        failMessage: "The study door won't budge — it's locked.",
      },
    });
    expect(Object.keys(hollowHouseBehaviors())).toContain("study-door");
    expect(Object.keys(hollowHouseBehaviors())).toContain("attic-door");
  });
```

(update the earlier "registers all three mechanic keys" assertion to the five keys now present).

- [ ] **Step 5: Write the differential generator + replay test**

`conformance/fixtures/scripted-doors.gen.test.ts` — TS oracle: the REAL `doorBehavior` closures registered under `study-door`/`attic-door`; Rust: the scripted door ASTs in `catalog.behaviors`. Structure identical to Task 12's generator (imports, drain, self-checks, writes) with these campaign specifics:

```ts
// registry: dagger (copy makeDagger from conformance/fixtures/mechanics.gen.test.ts:92-108
//   under the same "items/dagger" key), brass key factory from hollow-house items,
//   exits: { [ExitBehaviors.StudyDoor]: doorBehavior("brass", "study door",
//             "The brass key turns; the study door swings open."),
//            [ExitBehaviors.AtticDoor]: doorBehavior("iron", "attic door",
//             "The iron key grinds in the lock; the attic stairs open above you.") }
//   (doorBehavior imported from ../../packages/campaigns/src/hollow-house/content.ts)
// NO mechanics. maxRounds 10, baseEncounterChance 0, single player Ada
// (archetype: health 10 / sanity 10 / energy 10), dagger equipped pre-snapshot
// exactly like mechanics.gen.test.ts does.
//
// map: Landing (start) —west/study-door→ Study; —north/attic-door→ Attic;
//      —east→ Nursery (plain corridor, declared both ways)
//   .exit(Rooms.Landing, Directions.West, Rooms.Study,
//         { behaviorKey: ExitBehaviors.StudyDoor, name: "study door", initialState: { unlocked: false } })
//   .exit(Rooms.Landing, Directions.North, Rooms.Attic,
//         { behaviorKey: ExitBehaviors.AtticDoor, name: "attic door", initialState: { unlocked: false } })
// mob: .mob("Wraith", { stats: { health: 2, sanity: 4, energy: 4 }, room: Rooms.Nursery,
//                       drops: [Keys.Brass], naturalAttack: { stat: StatType.Sanity, power: 1 } })
//   — room-origin, so on defeat its keyring drops into the remains loot
//     (see conformance/fixtures/mob-drop.gen.test.ts:12: keys drop when origin === "room").
//   dagger damage: 3 * max(0, 10 − 4) * 0.2 = 3.6 ≥ 2 health → one-hit KO.
//
// command stream (budget 2/turn; ids resolved at gen time):
//   R0: startTurn,
//       go north  -> attic-door LOCKED  (fail cue, no move, no budget tick)
//       go west   -> study-door LOCKED  (fail cue, no move, no budget tick)
//       go east   -> Nursery [budget 1]
//       attack <wraithId> -> KO + remains(brass key) [budget 2 -> auto endTurn]
//       nextPlayer
//   R1: startTurn, take <brassKeyId> [1], go west -> Landing [2 -> endTurn], nextPlayer
//   R2: startTurn,
//       go west  -> study-door: hasKey("brass") -> unlock cue + move to Study [1]
//       go east  -> unlocked re-pass: SILENT (no mechanic cue) -> Landing [2 -> endTurn]
//       nextPlayer
//
// command dispatch switch: copy the cases from Task 12's generator; the attack
// case mirrors conformance/fixtures/mob-drop.gen.test.ts:446-455 (find the mob
// among the current room's occupants by id, then pcNow().attack(mob)).
// <wraithId> and <brassKeyId> are read from live objects while driving
// (deterministic-ids guarantee the Rust replay produces the same ids), and the
// recorded command stream carries the resolved strings.
//
// self-checks before writing files:
//   - fail cues appear EXACTLY once each:
//     "The attic door won't budge — it's locked." / "The study door won't budge — it's locked."
//   - unlock cue appears exactly once: "The brass key turns; the study door swings open."
//   - the final go-east step has NO mechanic cue (silent re-pass)
//   - Ada ends in Rooms.Landing
//
// catalog: buildCatalog(itemFactories, ["items/dagger"], {},
//   { [ExitBehaviors.StudyDoor]: ..., [ExitBehaviors.AtticDoor]: ... from hollowHouseBehaviors() })
//   (the brass key is a true Key — it serializes standalone and needs NO catalog entry,
//    see mob-drop.gen.test.ts:96-97.)
// writes scripted-doors.{start.snapshot,catalog,golden}.json
```

Write the full file following that shape — every helper referenced exists in the two cited generators; keep the golden/replay harness byte-identical to Task 12's.

`conformance/scripted-doors.test.ts`: copy `conformance/scripted-mechanics.test.ts` replacing `scripted-mechanics` with `scripted-doors` in the three paths and the describe title.

Register in `conformance/fixtures/vitest.config.ts`:

```ts
      "conformance/fixtures/scripted-doors.gen.test.ts",
```

- [ ] **Step 6: Run everything**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS (unit tests incl. the new exit/movement/validate ones).

Run: `pnpm run fixtures:gen && pnpm run test:conformance`
Expected: `scripted-doors` goldens written with all self-checks green; the replay diff passes; every pre-existing suite (incl. `keyed-exit` — the NATIVE door path) stays green.

Run: `pnpm vitest run packages/campaigns/src/hollow-house/scripted.test.ts packages/campaigns/src/scripted/builders.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ packages/campaigns/src/hollow-house/ conformance/
git commit -m "feat(script): ScriptedExit + exit seam; scripted HH doors gated vs doorBehavior oracle (scripted-ops T13)"
```

---

### Task 14: ScriptedVictory + victory resolution seam + re-author the 3 victory conditions + fixtures

**Files:**
- Modify: `crates/wickedways-core/src/script/ops.rs` (`ScriptedVictory`)
- Modify: `crates/wickedways-core/src/world/victory.rs` (`ResolvedVictory`, `resolve_victory`)
- Modify: `crates/wickedways-core/src/world/turn.rs` (`resolve_outcome` seam)
- Modify: `crates/wickedways-core/src/world/mechanics/dispatch.rs` (`validate_mechanics` also checks victory keys)
- Modify: `packages/campaigns/src/hollow-house/scripted.ts` (three victory scripts + keys)
- Create: `conformance/fixtures/hollow-victory-shadow.ts`
- Create: `conformance/fixtures/scripted-victory-won.gen.test.ts`, `scripted-victory-sanity.gen.test.ts`, `scripted-victory-partydown.gen.test.ts` (+ their `.start.snapshot/.catalog/.golden.json`)
- Create: `conformance/scripted-victory-won.test.ts`, `scripted-victory-sanity.test.ts`, `scripted-victory-partydown.test.ts`
- Modify: `conformance/fixtures/vitest.config.ts`

**Interfaces:**
- Produces (`victory.rs`):
  ```rust
  pub enum ResolvedVictory<'a> {
      Native(&'static dyn VictoryConditionBehavior),
      Scripted(&'a crate::script::ast::VictoryScript),
  }
  /// Native registry first; then catalog.behaviors (Victory family only).
  pub fn resolve_victory<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedVictory<'a>>
  ```
- Produces (`ops.rs`):
  ```rust
  /// Victory adapter. NOT a `VictoryConditionBehavior` impl — the trait's
  /// `test(&CampaignView)` cannot carry the World access the lazy room
  /// resolver needs (plan deviation note 2); the resolve_outcome seam calls
  /// this directly for the Scripted arm.
  pub struct ScriptedVictory<'a> { pub script: &'a VictoryScript }
  impl ScriptedVictory<'_> {
      pub fn test(&self, view: &CampaignView, world: &World, cat: &Catalog) -> bool
      // Ctx { view: Some(view), rooms: RoomSource::World { world, cat, cache: BTreeMap::new() }, .. }
  }
  ```
- Produces (`scripted.ts`): `reachedAtticWithJournalScript`, `sanityZeroScript`, `partyDownScript` (oracles: `index.ts:23-28`) + the three `Conditions.*` keys in `hollowHouseBehaviors()`.
- Consumes: `resolve_outcome` (`turn.rs:204-229`), `VictoryConditionBehavior` (`victory.rs:10-12`), `RoomSource::World` (Task 4), quantifiers (Task 6), builders (Task 11).

- [ ] **Step 1: Write the failing Rust tests**

In `victory.rs` tests:

```rust
    #[test]
    fn resolve_victory_native_first_then_scripted() {
        let cat: crate::world::descriptor::Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "sanity-zero": { "family": "victory", "script": {
                "test": { "kind": "some", "list": { "kind": "party" },
                    "pred": { "kind": "bin", "op": "lte",
                        "left": { "kind": "get", "of": { "kind": "element" }, "field": "sanity" },
                        "right": { "kind": "lit", "value": 0.0 } } } } } }
        })).unwrap();
        assert!(matches!(resolve_victory("conformance:round-reached", &cat),
            Some(ResolvedVictory::Native(_))));
        assert!(matches!(resolve_victory("sanity-zero", &cat),
            Some(ResolvedVictory::Scripted(_))));
        assert!(resolve_victory("nope", &cat).is_none());
    }
```

In `turn.rs` tests:

```rust
    #[test]
    fn end_round_resolves_a_scripted_victory_with_room_reads() {
        use crate::world::snapshot::VictoryConditionSnapshot;
        // reached-room shape: party[0].room.name == "Start" (true immediately)
        let cat: Catalog = serde_json::from_value(serde_json::json!({
            "items": {}, "aliases": {},
            "behaviors": { "in-start": { "family": "victory", "script": {
                "test": { "kind": "bin", "op": "eq",
                    "left": { "kind": "get",
                        "of": { "kind": "get",
                            "of": { "kind": "first", "list": { "kind": "party" } },
                            "field": "room" },
                        "field": "name" },
                    "right": { "kind": "lit", "value": "Start" } } } } }
        })).unwrap();
        let mut w = crate::world::test_support::world_two_rooms(false);
        w.campaign.started = true;
        w.campaign.win_conditions.push(VictoryConditionSnapshot {
            key: "in-start".into(), narration: None,
        });
        // every party member has acted -> end_round may resolve
        for id in w.campaign.party_ids.clone() {
            w.campaign.acted_this_round.push(id);
        }
        let mut cues = Vec::new();
        w.end_round(&cat, &mut cues).unwrap();
        assert_eq!(w.campaign.outcome, crate::presentation::CampaignOutcome::Won);
        assert_eq!(w.campaign.outcome_reason.as_deref(), Some("in-start"));
        assert!(cues.iter().any(|c| matches!(c, PresentationCue::Resolution { .. })));
    }

    #[test]
    fn resolve_outcome_unknown_victory_key_message_is_unchanged() {
        use crate::world::snapshot::VictoryConditionSnapshot;
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.started = true;
        w.campaign.lose_conditions.push(VictoryConditionSnapshot {
            key: "ghost".into(), narration: None,
        });
        w.campaign.acted_this_round.push(cid("pc"));
        let mut cues = Vec::new();
        let err = w.end_round(&Catalog::default(), &mut cues).unwrap_err();
        assert!(err.0.contains("No condition registered for key 'ghost'."));
    }
```

In `dispatch.rs` tests:

```rust
    #[test]
    fn validate_mechanics_rejects_an_unregistered_victory_key() {
        use crate::world::snapshot::VictoryConditionSnapshot;
        let mut w = world_with_party(&["pc"], 10);
        w.campaign.win_conditions.push(VictoryConditionSnapshot {
            key: "ghost-win".into(), narration: None,
        });
        let err = w.validate_mechanics(&Catalog::default()).unwrap_err();
        assert!(err.0.contains("No condition registered for key 'ghost-win'."));
    }
```

(If `VictoryConditionSnapshot` carries more fields, the compiler will say so — populate them from `world/snapshot.rs`'s definition, never invent.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p wickedways-core`
Expected: compile errors (`ResolvedVictory`/`resolve_victory`/`ScriptedVictory` missing).

- [ ] **Step 3: Implement (Rust)**

`victory.rs`:

```rust
use crate::world::descriptor::Catalog;

pub enum ResolvedVictory<'a> {
    Native(&'static dyn VictoryConditionBehavior),
    Scripted(&'a crate::script::ast::VictoryScript),
}

/// Native registry first; then `catalog.behaviors` (Victory family only).
pub fn resolve_victory<'a>(key: &str, cat: &'a Catalog) -> Option<ResolvedVictory<'a>> {
    if let Some(b) = victory_behavior(key) {
        return Some(ResolvedVictory::Native(b));
    }
    match cat.behaviors.get(key) {
        Some(crate::script::ast::BehaviorScript::Victory { script }) => {
            Some(ResolvedVictory::Scripted(script))
        }
        _ => None,
    }
}
```

`ops.rs`:

```rust
use alloc::collections::BTreeMap;
use crate::script::ast::VictoryScript;
use crate::world::descriptor::Catalog;
use crate::world::mechanics::CampaignView;
use crate::world::World;

/// Victory adapter (see plan deviation note 2). Victory is the one context the
/// TS oracle evaluates against the LIVE campaign (`pc.currentRoom`), so it gets
/// the lazy, memoizing World-backed room resolver.
pub struct ScriptedVictory<'a> {
    pub script: &'a VictoryScript,
}

impl ScriptedVictory<'_> {
    pub fn test(&self, view: &CampaignView, world: &World, cat: &Catalog) -> bool {
        let mut cx = Ctx {
            view: Some(view),
            state: CtxState::None,
            actor: None, action: None, damage: None, element: None, rng: None,
            rooms: RoomSource::World { world, cat, cache: BTreeMap::new() },
        };
        eval_predicate(&self.script.test, &mut cx)
    }
}
```

`turn.rs` `resolve_outcome` — replace both loops' bodies (keep loss-before-win order and the exact error text):

```rust
        let view = self.build_campaign_view(cat);
        let fired = |c: &VictoryConditionSnapshot, this: &World|
            -> Result<bool, ProceduralViolation> {
            match crate::world::victory::resolve_victory(&c.key, cat).ok_or_else(|| {
                ProceduralViolation(format!("No condition registered for key '{}'.", c.key))
            })? {
                crate::world::victory::ResolvedVictory::Native(b) => Ok(b.test(&view)),
                crate::world::victory::ResolvedVictory::Scripted(script) => {
                    Ok(crate::script::ops::ScriptedVictory { script }.test(&view, this, cat))
                }
            }
        };
        for c in &self.campaign.lose_conditions {
            if fired(c, self)? {
                return Ok((CampaignOutcome::Lost, Some(c.key.clone())));
            }
        }
        for c in &self.campaign.win_conditions {
            if fired(c, self)? {
                return Ok((CampaignOutcome::Won, Some(c.key.clone())));
            }
        }
```

(If the closure-borrowing form fights the borrow checker — `view` borrows `self` immutably, which is fine since `resolve_outcome` is `&self` — fall back to a small private method `fn victory_fired(&self, c: &VictoryConditionSnapshot, view: &CampaignView, cat: &Catalog) -> Result<bool, ProceduralViolation>` with the same body.)

`dispatch.rs` `validate_mechanics` — append after the exits loop:

```rust
        for c in self.campaign.lose_conditions.iter().chain(self.campaign.win_conditions.iter()) {
            if crate::world::victory::resolve_victory(&c.key, cat).is_none() {
                return Err(ProceduralViolation(format!(
                    "No condition registered for key '{}'.", c.key
                )));
            }
            if let Some(b) = cat.behaviors.get(&c.key) {
                if crate::world::victory::victory_behavior(&c.key).is_none() {
                    crate::script::validate_behavior(&c.key, b)?;
                }
            }
        }
```

- [ ] **Step 4: Implement (TS) — the victory scripts**

Append to `packages/campaigns/src/hollow-house/scripted.ts` (import `Conditions`, `Rooms` from `./ids.js`):

```ts
// ── victory conditions (oracle: index.ts:23-28) ──────────────────────────────
// reached-attic-with-journal: pc?.currentRoom?.name === Attic && pc holds the journal.
// party[0] missing / no room -> Null propagates -> false (mirrors `pc?.`).
export const reachedAtticWithJournalScript: BehaviorScript = s.victory(
  s.and(
    s.eq(s.get(s.get(s.first(s.party), "room"), "name"), s.lit(Rooms.Attic)),
    s.hasItem(s.first(s.party), Items.Journal),
  ),
);

// sanity-zero: party.some(p => p.effectiveStat(Sanity) <= 0)
export const sanityZeroScript: BehaviorScript = s.victory(
  s.some(s.party, s.lte(s.get(s.element, "sanity"), s.lit(0))),
);

// party-down: party.length > 0 && party.every(p => p.status.includes(KO))
export const partyDownScript: BehaviorScript = s.victory(
  s.and(
    s.gt(s.length(s.party), s.lit(0)),
    s.every(s.party, s.includes(s.get(s.element, "status"), s.lit("ko"))),
  ),
);
```

and extend `hollowHouseBehaviors()` with:

```ts
    [Conditions.ReachedAtticWithJournal]: reachedAtticWithJournalScript,
    [Conditions.SanityZero]: sanityZeroScript,
    [Conditions.PartyDown]: partyDownScript,
```

Add to `scripted.test.ts`: assert `Object.keys(hollowHouseBehaviors()).sort()` now equals the eight keys `["attic-door", "dread", "party-down", "reached-attic-with-journal", "sanity-zero", "status-bar", "storyteller", "study-door"]`.

- [ ] **Step 5: Fixture shadows + the three generators**

`conformance/fixtures/hollow-victory-shadow.ts` — TS shadows of the three HH victory lambdas (they are inline in `buildHauntedHouseRegistry`, so the shadow re-declares them; MUST match `packages/campaigns/src/hollow-house/index.ts:23-28` byte-for-byte in behavior):

```ts
/**
 * TS shadows of the Hollow House victory conditions — MUST match
 * packages/campaigns/src/hollow-house/index.ts:23-28 exactly (they are inline
 * lambdas there, hence this re-declaration; shared by all scripted-victory
 * generators so the oracle cannot drift between fixtures).
 */
import type { ICampaign } from "wickedways/lib/campaign";
import { StatType } from "wickedways/lib/character/stats";
import { Status } from "wickedways/lib/status";
import { Rooms, Items } from "../../packages/campaigns/src/hollow-house/ids.ts";

export const reachedAtticWithJournal = (c: ICampaign): boolean => {
  const pc = c.party[0];
  return pc?.currentRoom?.name === Rooms.Attic &&
    pc.inventory.items.some((i) => i.behaviorKey === Items.Journal);
};
export const sanityZero = (c: ICampaign): boolean =>
  c.party.some((p) => p.effectiveStat(StatType.Sanity) <= 0);
export const partyDown = (c: ICampaign): boolean =>
  c.party.length > 0 && c.party.every((p) => p.status.includes(Status.KO));
```

The three generators follow the Task-12 generator's harness (imports, drain, dispatch switch, self-checks, three file writes, `viewProjected`) and the victory-lost generator's registry/condition wiring (`registry.registerCondition(key, fn)` + `.winWhen`/`.loseWhen`, `conformance/fixtures/victory-lost.gen.test.ts:32-43`). Campaign specifics per file:

**`scripted-victory-won.gen.test.ts`** (`SEED = 0x51c1`)
- Registry: journal item (`ITEM_FACTORIES[Items.Journal]`); `registerCondition(Conditions.ReachedAtticWithJournal, reachedAtticWithJournal)`.
- Template: single archetype (health 12 / sanity 16 / energy 5), single player Ada; rooms `Rooms.Foyer` (start) → north → `"Hall"` → north → `Rooms.Attic` (corridors declared both ways); loot `foyer-table` holding the journal; `maxRounds: 10, baseEncounterChance: 0`; `.winWhen(Conditions.ReachedAtticWithJournal, { text: "You climb into the attic with the journal in hand, and at last the house is only a house. You understand. You may leave." })` (the REAL HH narration, `index.ts:81`).
- Commands: `startTurn`, `take <journalId>` [1], `go north` [2 → auto endTurn], `nextPlayer` (round end — NOT in the attic → ongoing), `startTurn`, `go north` → Attic [1], `endTurn`, `nextPlayer` (round end → WON).
- Self-checks: final step carries a `resolution` cue, `outcome === "won"`, `narration.text` equals the win text; `campaign.outcome === "won"`.
- Catalog: `buildCatalog({ [Items.Journal]: ITEM_FACTORIES[Items.Journal]! }, [Items.Journal], {}, { [Conditions.ReachedAtticWithJournal]: hollowHouseBehaviors()[Conditions.ReachedAtticWithJournal]! })`.

**`scripted-victory-sanity.gen.test.ts`** (`SEED = 0x51c2`)
- Registry: no items; mechanics `{ [Mechanics.Dread]: dread }` (the REAL closure); `registerCondition(Conditions.SanityZero, sanityZero)`.
- Template: archetype health 12 / **sanity 1** / energy 5; single player Ada; one room `Rooms.Foyer` (start); `.useMechanic(Mechanics.Dread)`; `.loseWhen(Conditions.SanityZero, { text: "The dark gets in. Your thoughts come apart like wet paper, and the Hollow House keeps what is left of you." })` (`index.ts:82`).
- Commands: `startTurn` (dread drains 1 → 0; Panic may latch — deterministic on both sides), `endTurn`, `nextPlayer` (round end → LOST via `some(sanity <= 0)`).
- Self-checks: resolution cue `outcome === "lost"`, narration equals the lose text, `campaign.outcome === "lost"`.
- Catalog behaviors: `{ [Mechanics.Dread]: ..., [Conditions.SanityZero]: ... }` (dread must resolve on the Rust side too — its key is live in the snapshot).

**`scripted-victory-partydown.gen.test.ts`** (`SEED = 0x51c3`)
- Registry: a bespoke `"items/cursed-band"` item factory (copy the `makeDagger` Item-construction shape from `mechanics.gen.test.ts:92-108`, changing: name `"Cursed Band"`, `type: ItemType.Accessory`, `stat: StatType.Health`, `modifier: -99`, `slot: SlotKind.Finger`, no `maxDurability`); `registerCondition(Conditions.PartyDown, partyDown)`.
- Template: archetype health 12 / sanity 16 / energy 5; TWO players Ada + Ben; one room; `.loseWhen(Conditions.PartyDown, { text: "You fall, and do not rise. The house is patient. It has all the time there is." })` (`index.ts:83`).
- Pre-snapshot setup: give each PC a cursed band and equip it (the same direct pre-snapshot equip `mechanics.gen.test.ts` performs with the dagger). Effective health = max(0, 12 − 99) = 0, so KO latches at each PC's first `startTurn`.
- Commands: `startTurn` (Ada KO latches), `nextPlayer`, `startTurn` (Ben KO latches), `nextPlayer` (round end → `party.length > 0 && every KO` → LOST).
- Self-checks: BOTH party members' `status` include KO before the final step; resolution `outcome === "lost"` with the party-down narration. If KO does not latch at `startTurn`, insert an explicit `{ kind: "endTurn" }` after each `startTurn` (the reconcile path) and re-check — adjust the command stream, never the goldens.
- Catalog: items `{"items/cursed-band"}` + behaviors `{ [Conditions.PartyDown]: ... }`.

Replay tests: `conformance/scripted-victory-won.test.ts`, `scripted-victory-sanity.test.ts`, `scripted-victory-partydown.test.ts` — each a copy of `conformance/scripted-mechanics.test.ts` with the fixture basename and describe title swapped.

Register all three generators in `conformance/fixtures/vitest.config.ts`:

```ts
      "conformance/fixtures/scripted-victory-won.gen.test.ts",
      "conformance/fixtures/scripted-victory-sanity.gen.test.ts",
      "conformance/fixtures/scripted-victory-partydown.gen.test.ts",
```

- [ ] **Step 6: Run everything**

Run: `cargo test -p wickedways-core && cargo build -p wickedways-core --no-default-features`
Expected: PASS (victory/turn/dispatch unit tests green; existing native victory tests untouched).

Run: `pnpm run fixtures:gen && pnpm run test:conformance`
Expected: the three scripted-victory golden sets written with self-checks green; all replay diffs pass — including the existing `victory-won/lost/timeout/ended` suites (native path unchanged).

Run: `pnpm vitest run packages/campaigns/src/hollow-house/scripted.test.ts`
Expected: PASS (eight keys).

- [ ] **Step 7: Commit**

```bash
git add crates/ packages/campaigns/src/hollow-house/ conformance/
git commit -m "feat(script): ScriptedVictory + victory seam; scripted HH conditions gated vs oracle (scripted-ops T14)"
```

---

### Task 15: finalize — full gate + living docs

**Files:**
- Modify: `README.md`
- Verify: everything

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a green `checks:phase2` + stable fixtures + updated living docs. After this task, `Catalog.behaviors` carries every key Hollow House needs, so `validate_mechanics` passes for the real campaign — the precondition the parked single-player-cutover plan resumes from.

- [ ] **Step 1: Run the full gate**

```bash
cargo build -p wickedways-core --no-default-features
cargo test --workspace
pnpm run bindings:check
pnpm run test:conformance
pnpm run fixtures:stable
pnpm checks
```

Expected, in order: no_std build OK; every Rust test green; bindings clean (no drift); every differential suite green (all pre-existing + the 5 new scripted suites); `fixtures:stable` proves regenerating changes NO committed fixture bytes; lint + typecheck (root and `-r`) + the full TS suite green. Fix any failure at its root (interpreter/AST/builders) — never in goldens or `canonical-json.ts`.

- [ ] **Step 2: Update README.md (living-docs convention)**

Add a subsection to the mechanics/custom-content area of `README.md` (place it adjacent to the existing custom-mechanics documentation; adapt heading level to its neighbors):

```markdown
### Scripted behaviors (the ops DSL)

Alongside hand-written TS `Mechanic`/`ExitBehavior`/victory closures, first-party
ops can be authored as **scripts**: a closed, loop-free, deterministic data-AST
(values, expressions, statements) interpreted by the Rust core. Scripts are pure —
they read a projection (`CampaignView`, the actor, the action, their own JSON
state) and return effects / a boolean / an optional narration line; the engine
applies the results through the same collect-then-apply pipeline as native ops.

- **Authoring:** typed builders in `@wickedways/campaigns` (`packages/campaigns/src/scripted/builders.ts`)
  emit the AST; the AST types are generated from Rust via ts-rs (`generated/bindings/`).
- **Storage/resolution:** scripts ride in the campaign catalog under
  `Catalog.behaviors[key]`; the engine resolves a behavior key against the native
  registry first, then the catalog (`family: "mechanic" | "exit" | "victory"`).
  Unknown keys and ill-shaped ASTs fail fast at load with `ProceduralViolation`.
- **Determinism:** f64 arithmetic is restricted to `+ − × ÷` and comparisons,
  iteration is ordered, string-from-number matches JS `Number.prototype.toString`
  byte-for-byte, and randomness only comes from the injected rng.
- **Hollow House** is the reference user: its dread/storyteller/status-bar
  mechanics, both keyed doors, and all three victory conditions are re-authored in
  `packages/campaigns/src/hollow-house/scripted.ts` and gated byte-for-byte against
  the hand-written closures by the `conformance/scripted-*` differential fixtures.
```

Also confirm the TSDoc on `builders.ts` and `scripted.ts` (written in Tasks 11–12) still matches the final surface; adjust if any helper was renamed during implementation.

- [ ] **Step 3: Re-run the doc-adjacent checks**

Run: `pnpm run lint && pnpm run typecheck`
Expected: PASS (README edits cannot break these; this is the pre-commit sanity pass).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: scripted-ops DSL section in README (living docs, scripted-ops T15)"
```

---

## Execution notes for the controller

- Tasks 1–7 are pure-Rust interpreter work with no engine-facing edits; they can be reviewed on unit tests + the no_std build alone.
- Task 8 is the one behavior-neutral engine refactor — its gate is "existing conformance stays green".
- Tasks 12–14 are where the differential gate becomes the authority. A red scripted suite means the AST or the interpreter is unfaithful; the TS closures and the committed goldens are never the thing to change.
- The `conformance:*` native shadows and their suites remain untouched throughout — they keep gating the native-registry path.
