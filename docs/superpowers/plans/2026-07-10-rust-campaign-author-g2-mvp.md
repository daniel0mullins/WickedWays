# Rust Campaign Author (G2) MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Rust crate `wickedways-author` that compiles a small TOML campaign + an infix JS-like expression language into the `description.json` + `catalog.json` that G1's `assemble()` consumes, gated byte-for-byte against a TS-twin oracle fixture.

**Architecture:** `compile(toml_src) -> Result<CompiledCampaign, CompileError>` runs a four-stage pipeline — parse TOML into an `AuthorDoc`, Pratt-parse each expression string into the closed `Expr` AST, validate/lower `AuthorDoc` into a `CampaignDescription` + `Catalog`, and emit both via the same serde types G1 uses (so bytes match). A `[[bin]]` rides on `compile()`. The differential gate: a purpose-built `g2-vault` oracle fixture (a one-time TS twin) whose committed `description.json` + `catalog.json` the compiler must reproduce byte-for-byte.

**Tech Stack:** Rust 2021, `serde`/`serde_json`, the `toml` crate (spanned parse errors), `wickedways-core` (the `Expr`/`BehaviorScript` AST), `wickedways-assemble` (`CampaignDescription`, `Catalog`). TS side: the existing `vitest` conformance fixture generators only.

**Spec:** `docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mvp-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential gate is the authority.** NEVER hand-edit a golden, a `*.description.json`/`*.catalog.json` fixture, or `conformance/canonical-json.ts` to force a pass. Regenerating a fixture by running the real TS generator is legitimate; hand-editing one is forbidden.
- **Byte-parity is the acceptance criterion** — `compile(g2-vault.toml)`'s emitted description and catalog must equal the committed fixtures under `serde_json::Value` equality with the whole-float→int `canon_numbers` normalization G1 established (copy it; do not re-derive `canonicalize`).
- **The compiler is panic-free on author input.** `compile` is the modding trust boundary. NEVER `panic!`/`unwrap()`/`expect()` on author text in `src/`. Return `Result`. `unwrap`/`expect` permitted only in tests.
- **Every collection reaching serialization uses `BTreeMap`/`BTreeSet`, never `HashMap`/`HashSet`.**
- **The crate must not depend on `rand` or `uuid`.** Ids are derived by `assemble`, not the author crate.
- **MVP is expressions only.** Parse the `Expr` grammar; do NOT build the statement grammar (`Guard`/`When`/`SetState`/`Emit`/`Pass`) or effects. A keyed door is `canPass` (Expr) + `pass`/`failMessage`; a victory is `test` (Expr).
- **MVP behavior families: exit + victory only.** No mechanic/item/npc/scene.
- **The `g2-vault` oracle stays inside the MVP's expressible subset** (a `canPass`-only door with empty `runScript`; a victory `test`) so byte-parity with an expressions-only compiler is achievable.
- **ASCII only** for all fixture room names, item names, prompts, and descriptions (the JS-UTF16-vs-Rust-UTF8 sort constraint carries from G1).
- **Do not build later G2 slices** — no statements/effects, no other families, no full Def coverage, no id-derivation for script refs, no npx/WASM packaging, no runtime-load. `compile()`'s signature must not need to change when they land.
- Work on branch `design/rust-campaign-author-g2`. Never commit to `main`.

### The `Expr` serde shape (the parser's compile target — verbatim from `crates/wickedways-core/src/script/ast.rs`)

`Expr` is `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`; `BinOp` is `rename_all = "lowercase"`; `Value` serializes untagged (`Str`→plain string, `Number(f64)`→JSON number, `Bool`→bool, `Null`→null). The MVP surfaces this subset:

| syntax | `Expr` node | serde JSON |
| --- | --- | --- |
| `'text'` / `42` / `true` | `Lit{value}` | `{"kind":"lit","value":"text"}` |
| `actor` | `Actor` | `{"kind":"actor"}` |
| `party` | `Party` | `{"kind":"party"}` |
| `round` | `Round` | `{"kind":"round"}` |
| `maxRounds` | `MaxRounds` | `{"kind":"maxRounds"}` |
| `x[i]` | `Index{list,index}` | `{"kind":"index","list":…,"index":…}` |
| `x.field` | `Get{of,field}` | `{"kind":"get","of":…,"field":"room"}` |
| `hasKey(x,'c')` | `HasKey{of,key_code}` | `{"kind":"hasKey","of":…,"keyCode":"c"}` |
| `hasItem(x,'k')` | `HasItem{of,item_key}` | `{"kind":"hasItem","of":…,"itemKey":"k"}` |
| `hasEquipped(x,'k')` | `HasEquipped{of,item_key}` | `{"kind":"hasEquipped","of":…,"itemKey":"k"}` |
| `a && b`, `==`, `<=`, `+` … | `Bin{op,left,right}` | `{"kind":"bin","op":"and","left":…,"right":…}` |
| `!a` | `Not{expr}` | `{"kind":"not","expr":…}` |
| `c ? a : b` | `IfElse{cond,then,else}` | `{"kind":"ifElse","cond":…,"then":…,"else":…}` |

**MVP mapping decisions (state them in code comments):**
- Subscript `x[i]` always lowers to `Index` (never `First`), even for literal `0`. The oracle is authored to match.
- `BinOp` spelling: `==`→`eq`, `!=`→`ne`, `<`→`lt`, `<=`→`lte`, `>`→`gt`, `>=`→`gte`, `&&`→`and`, `||`→`or`, `+`→`add`, `-`→`sub`, `*`→`mul`, `/`→`div`.
- Precedence (loosest→tightest): ternary `?:` < `||` < `&&` < equality (`== !=`) < comparison (`< <= > >=`) < additive (`+ -`) < multiplicative (`* /`) < unary (`!`) < postfix (`[]` `.` call). `&&`/`||` left-assoc; ternary right-assoc.
- Bare identifiers resolve to the four subjects; any other bare identifier or unknown call name → `UnknownReference`.

---

## File Structure

**Create:**
- `crates/wickedways-author/Cargo.toml` — crate manifest; deps `wickedways-core`, `wickedways-assemble`, `serde`, `serde_json`, `toml`. No `rand`/`uuid`.
- `crates/wickedways-author/src/lib.rs` — public surface: `compile`, `CompiledCampaign`, re-exports. Nothing else.
- `crates/wickedways-author/src/error.rs` — `CompileError` + `Span`, `Display` impls.
- `crates/wickedways-author/src/author_doc.rs` — the TOML surface serde structs (`AuthorDoc` + sub-structs). Pure data.
- `crates/wickedways-author/src/expr/mod.rs` — `parse_expr(&str) -> Result<Expr, CompileError>`.
- `crates/wickedways-author/src/expr/lexer.rs` — tokenizer.
- `crates/wickedways-author/src/expr/parser.rs` — the Pratt parser.
- `crates/wickedways-author/src/lower.rs` — `AuthorDoc` + parsed exprs → `CampaignDescription` + `Catalog`.
- `crates/wickedways-author/src/bin/wwauthor.rs` — the `[[bin]]` (argv toml → write two JSONs).
- `crates/wickedways-author/tests/gate.rs` — the differential gate over `g2-vault`.
- `conformance/fixtures/g2-vault.gen.test.ts` — the TS-twin oracle generator.
- `conformance/fixtures/g2-vault.toml` — the campaign authored in the new surface.

**Modify:**
- `Cargo.toml` (workspace) — add `crates/wickedways-author` to `members`.
- `conformance/fixtures/vitest.config.ts` — register `g2-vault.gen.test.ts` in `include`.
- `crates/wickedways-assemble/tests/goldens.rs` — gate `g2-vault` as a new single-PC pre-begin golden (proves the oracle inputs assemble correctly).
- `.github/workflows/checks.yml` — add `cargo test -p wickedways-author`.
- `README.md` — document the author crate + the TOML surface.
- `package.json` — add a `checks:author` convenience script.

---

## Task 1: Scaffold the crate, `CompileError`, the `AuthorDoc` surface, and the TOML-parse skeleton

**Files:**
- Create: `crates/wickedways-author/Cargo.toml`, `src/lib.rs`, `src/error.rs`, `src/author_doc.rs`
- Modify: `Cargo.toml` (workspace `members`)

**Interfaces:**
- Produces: `wickedways_author::{compile, CompiledCampaign}`; `error::{CompileError, Span}`; `author_doc::AuthorDoc` (+ sub-structs) — all `Deserialize + Debug + PartialEq`.

- [ ] **Step 1: Write the failing test**

Create `src/author_doc.rs` with ONLY this test module (structs come in Step 4):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_minimal_surface() {
        let src = r#"
            title = "Vault"
            startRoom = "Hall"
            [[rooms]]
            name = "Hall"
            description = "A cold stone hall."
            [[exits]]
            from = "Hall"
            to = "Vault"
            direction = "north"
            behavior = "vault-door"
            [behaviors.exit.vault-door]
            canPass = "hasKey(actor, 'vault')"
            failMessage = "Locked."
            [victory.win.reached-vault]
            test = "party[0].room.name == 'Vault'"
        "#;
        let doc: AuthorDoc = toml::from_str(src).expect("parse");
        assert_eq!(doc.title, "Vault");
        assert_eq!(doc.start_room.as_deref(), Some("Hall"));
        assert_eq!(doc.rooms.len(), 1);
        assert_eq!(doc.exits[0].behavior.as_deref(), Some("vault-door"));
        assert_eq!(doc.behaviors.exit["vault-door"].can_pass, "hasKey(actor, 'vault')");
        assert_eq!(doc.victory.win["reached-vault"].test, "party[0].room.name == 'Vault'");
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-author`
Expected: FAIL — `error: no matching package named 'wickedways-author'`.

- [ ] **Step 3: Create the manifest and register the crate**

`crates/wickedways-author/Cargo.toml`:

```toml
[package]
name = "wickedways-author"
version = "0.0.1"
edition = "2021"

[dependencies]
wickedways-core = { path = "../wickedways-core", features = ["std"] }
wickedways-assemble = { path = "../wickedways-assemble" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"

# NOTE: rand/uuid are deliberately absent — ids are derived by assemble().
```

Workspace `Cargo.toml`: add `"crates/wickedways-author"` to `members`.

- [ ] **Step 4: Write `error.rs` and `author_doc.rs`**

`src/error.rs`:

```rust
//! Aggregated, spanned compile errors. `compile` consumes untrusted author text;
//! nothing here may panic.
use std::fmt;

/// 1-based line/column into the TOML source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span { pub line: usize, pub col: usize }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompileError {
    TomlParse { message: String },
    ExprParse { span: Span, message: String },
    UnknownReference { span: Span, name: String },
    UnresolvedKey { kind: &'static str, key: String },
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompileError::TomlParse { message } => write!(f, "TOML parse error: {message}"),
            CompileError::ExprParse { span, message } =>
                write!(f, "expression syntax error at {}:{}: {message}", span.line, span.col),
            CompileError::UnknownReference { span, name } =>
                write!(f, "unknown reference '{name}' at {}:{}", span.line, span.col),
            CompileError::UnresolvedKey { kind, key } =>
                write!(f, "{kind} references undefined behavior key '{key}'"),
        }
    }
}
impl std::error::Error for CompileError {}
```

`src/author_doc.rs` (ABOVE the test module). Field-for-field mirror of the TOML surface in the spec:

```rust
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorDoc {
    pub title: String,
    #[serde(default)]
    pub start_room: Option<String>,
    #[serde(default)]
    pub rooms: Vec<RoomEntry>,
    #[serde(default)]
    pub exits: Vec<ExitEntry>,
    #[serde(default)]
    pub items: Vec<ItemEntry>,
    #[serde(default)]
    pub loot: Vec<LootEntry>,
    #[serde(default)]
    pub behaviors: Behaviors,
    #[serde(default)]
    pub victory: Victory,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomEntry { pub name: String, pub description: String }

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitEntry {
    pub from: String,
    pub to: String,
    pub direction: String,
    #[serde(default)] pub behavior: Option<String>,
    #[serde(default)] pub one_way: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemEntry {
    pub key: String,
    pub name: String,
    #[serde(default)] pub key_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LootEntry { pub name: String, pub room: String, pub items: Vec<String>,
    #[serde(default)] pub description: Option<String> }

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Behaviors { #[serde(default)] pub exit: BTreeMap<String, ExitBehaviorEntry> }

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExitBehaviorEntry {
    pub can_pass: String,
    #[serde(default)] pub pass_message: Option<String>,
    #[serde(default)] pub fail_message: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Victory {
    #[serde(default)] pub win: BTreeMap<String, ConditionEntry>,
    #[serde(default)] pub lose: BTreeMap<String, ConditionEntry>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionEntry { pub test: String, #[serde(default)] pub narration: Option<String> }
```

Create `src/lib.rs`:

```rust
//! Campaign author: `toml -> (CampaignDescription, Catalog)`.
//! Compiles the friendly TOML surface + an infix expression language into the
//! artifacts `wickedways_assemble::assemble` consumes. Panic-free on author input.
pub mod author_doc;
pub mod error;

use wickedways_assemble::description::CampaignDescription;
use wickedways_core::world::descriptor::Catalog;
use error::CompileError;

#[derive(Clone, Debug, PartialEq)]
pub struct CompiledCampaign { pub description: CampaignDescription, pub catalog: Catalog }

/// Parse the TOML surface. Lowering (expressions → description/catalog) lands in Tasks 4-5.
pub fn compile(toml_src: &str) -> Result<CompiledCampaign, CompileError> {
    let _doc: author_doc::AuthorDoc = toml::from_str(toml_src)
        .map_err(|e| CompileError::TomlParse { message: e.to_string() })?;
    unimplemented!("lowering lands in Tasks 4-5")
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p wickedways-author author_doc::`
Expected: PASS — `parses_the_minimal_surface ... ok`.

- [ ] **Step 6: Verify the workspace builds with no forbidden deps**

Run: `cargo build --workspace && ! cargo tree -p wickedways-author | grep -qE '^\s*[|`-]*\s*(rand|uuid) ' && echo "NO rand/uuid ✓"`
Expected: builds, prints `NO rand/uuid ✓`.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-author Cargo.toml
git commit -m "feat(author): scaffold crate, CompileError, and the TOML surface schema"
```

---

## Task 2: The infix expression parser (`parse_expr` → `Expr`)

**Files:**
- Create: `crates/wickedways-author/src/expr/mod.rs`, `src/expr/lexer.rs`, `src/expr/parser.rs`
- Modify: `crates/wickedways-author/src/lib.rs` (add `pub(crate) mod expr;`)

**Interfaces:**
- Consumes: `error::{CompileError, Span}`; `wickedways_core::script::ast::{Expr, BinOp}`, `wickedways_core::script::value::Value`.
- Produces: `expr::parse_expr(src: &str, base: Span) -> Result<Expr, CompileError>` — `base` is the TOML line/col where the expression string starts, so spans point into the file.

This is the heart of the MVP. Tests assert on the **serialized JSON** of the parsed `Expr` (via `serde_json::to_value`) so they are robust to Rust field names and prove the exact serde shape the gate later depends on.

- [ ] **Step 1: Write the failing tests**

Create `src/expr/mod.rs`:

```rust
mod lexer;
mod parser;
pub use parser::parse_expr;

#[cfg(test)]
mod tests {
    use super::parse_expr;
    use crate::error::{CompileError, Span};
    use serde_json::json;

    fn p(s: &str) -> serde_json::Value {
        let e = parse_expr(s, Span { line: 1, col: 1 }).expect("parse");
        serde_json::to_value(e).expect("to_value")
    }

    #[test]
    fn literals_and_subjects() {
        assert_eq!(p("'Vault'"), json!({"kind":"lit","value":"Vault"}));
        assert_eq!(p("42"), json!({"kind":"lit","value":42}));
        assert_eq!(p("true"), json!({"kind":"lit","value":true}));
        assert_eq!(p("actor"), json!({"kind":"actor"}));
        assert_eq!(p("party"), json!({"kind":"party"}));
        assert_eq!(p("round"), json!({"kind":"round"}));
        assert_eq!(p("maxRounds"), json!({"kind":"maxRounds"}));
    }

    #[test]
    fn index_then_field_chain() {
        assert_eq!(p("party[0].room.name"), json!({
            "kind":"get","field":"name","of":{
                "kind":"get","field":"room","of":{
                    "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}}));
    }

    #[test]
    fn calls_map_to_typed_nodes() {
        assert_eq!(p("hasKey(actor, 'vault')"),
            json!({"kind":"hasKey","of":{"kind":"actor"},"keyCode":"vault"}));
        assert_eq!(p("hasItem(party[0], 'journal')"),
            json!({"kind":"hasItem","itemKey":"journal","of":{
                "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}));
    }

    #[test]
    fn precedence_and_and_over_eq() {
        // a == b && c  parses as  (a == b) && c
        assert_eq!(p("round == 1 && actor"), json!({
            "kind":"bin","op":"and",
            "left":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
            "right":{"kind":"actor"}}));
    }

    #[test]
    fn comparison_and_ternary_and_not() {
        assert_eq!(p("round <= 3 ? 'lo' : 'hi'"), json!({
            "kind":"ifElse",
            "cond":{"kind":"bin","op":"lte","left":{"kind":"round"},"right":{"kind":"lit","value":3}},
            "then":{"kind":"lit","value":"lo"},"else":{"kind":"lit","value":"hi"}}));
        assert_eq!(p("!actor"), json!({"kind":"not","expr":{"kind":"actor"}}));
    }

    #[test]
    fn victory_expression_full() {
        assert_eq!(p("party[0].room.name == 'Vault'"), json!({
            "kind":"bin","op":"eq",
            "left":{"kind":"get","field":"name","of":{"kind":"get","field":"room","of":{
                "kind":"index","list":{"kind":"party"},"index":{"kind":"lit","value":0}}}},
            "right":{"kind":"lit","value":"Vault"}}));
    }

    #[test]
    fn unknown_call_is_unknown_reference() {
        let err = parse_expr("frobnicate(actor)", Span { line: 4, col: 11 }).unwrap_err();
        assert!(matches!(err, CompileError::UnknownReference { name, .. } if name == "frobnicate"));
    }

    #[test]
    fn syntax_error_is_expr_parse() {
        assert!(matches!(parse_expr("round ==", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
    }
}
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author expr::`
Expected: FAIL to compile — `cannot find function 'parse_expr'`.

- [ ] **Step 3: Implement the lexer**

`src/expr/lexer.rs`: a `Token` enum (`Ident(String)`, `Str(String)`, `Num(f64)`, `Bool(bool)`, punctuation `( ) [ ] . , ? :`, operators `&& || == != <= >= < > + - * / !`) with a `pos: Span` on each token (compute line/col by offsetting `base` by the char index — the MVP keeps expressions single-line, so `col = base.col + char_index`, `line = base.line`). A `tokenize(src, base) -> Result<Vec<(Token, Span)>, CompileError>` that errors `ExprParse` on an unrecognized character or an unterminated string. Strings use single quotes (`'...'`), matching the TOML-embedded style.

- [ ] **Step 4: Implement the Pratt parser**

`src/expr/parser.rs`: `parse_expr(src, base)` tokenizes then runs a Pratt/precedence-climbing parser producing `Expr`. Binding powers follow the precedence table in Global Constraints. Postfix loop handles `.field` (→ `Get`), `[expr]` (→ `Index`), and `name(args)` for the three known calls. Name resolution:
- `actor`/`party`/`round`/`maxRounds` → the unit subjects.
- `true`/`false` → `Lit{Value::Bool}`; numbers → `Lit{Value::Number}`; strings → `Lit{Value::Str}`.
- `hasKey`/`hasItem`/`hasEquipped` (2 args; 2nd must be a string literal) → the typed nodes.
- any other bare identifier or call name → `CompileError::UnknownReference { span, name }`.
Unexpected or missing tokens → `CompileError::ExprParse { span, message }`. Must not panic.

Add `pub(crate) mod expr;` to `lib.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p wickedways-author expr::`
Expected: PASS — 8 tests ok.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/src/expr crates/wickedways-author/src/lib.rs
git commit -m "feat(author): infix expression parser to the closed Expr AST"
```

---

## Task 3: The `g2-vault` oracle fixture (TS twin) + `g2-vault.toml`

**Files:**
- Create: `conformance/fixtures/g2-vault.gen.test.ts`, `conformance/fixtures/g2-vault.toml`
- Modify: `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`

**Interfaces:**
- Produces: committed `conformance/fixtures/g2-vault.{description,catalog,genesis}.json` (the byte-parity targets for Tasks 4-5) and `g2-vault.toml` (the compiler's input).

This generates the oracle by running the proven TS builders. **That is legitimate; hand-editing a golden is not.** The oracle MUST stay inside the MVP's expressible subset (canPass-only door, victory test — no statement bodies).

- [ ] **Step 1: Read an existing generator + the seating oracle**

Run: `sed -n '1,60p' conformance/fixtures/facade-loot.gen.test.ts` and `sed -n '75,100p' conformance/fixtures/oracle-session.ts`
Expected: shows how a `*.gen.test.ts` builds a `TemplateBuilder` + registry, seats one PC (`player:Ada`), captures the pre-begin genesis, and writes `<name>.{genesis,catalog}.json`; and how `catalogFromRegistry` + `stripRng` are used (as in Task 4 of the G1 plan).

- [ ] **Step 2: Author the TS twin**

Create `conformance/fixtures/g2-vault.gen.test.ts` building the `g2-vault` campaign with `TemplateBuilder` + `defineRegistry` + the `s.*` behavior builders, matching the surface in the spec:
- rooms `Hall` (start) + `Vault`; one exit `Hall --north--> Vault` with `behaviorKey: "vault-door"`.
- a key item `vault-key` via `createKey({ keyCode: "vault", name: "Vault Key" })` (read `createKey`'s signature from the hollow-house content), registered under key `vault-key`.
- a loot box `shelf` in `Hall` holding `["vault-key"]`.
- an exit behavior `vault-door` = `s.exit({ canPass: s.hasKey(s.actor(), "vault"), failMessage: "The vault door is locked.", passMessage: "The lock yields." })` (confirm the exact builder names in `packages/campaigns/src/scripted/builders.ts`; `runScript` stays empty/absent).
- a win condition `reached-vault` with narration, backed by a victory behavior `s.victory({ test: s.eq(s.get(s.get(s.index(s.party(), s.lit(0)), "room"), "name"), s.lit("Vault")) })`. **The victory `test` AST here is the byte-parity target for `party[0].room.name == 'Vault'` — it MUST be authored with `index(party, lit(0))` (not `first`), matching the compiler's subscript→`Index` mapping.** If `builders.ts` lacks an `index` builder, add it (it is thin authoring sugar over `{kind:"index",…}`).
- Emit `g2-vault.description.json` (via `stripRng`), `g2-vault.catalog.json` (via `catalogFromRegistry`), and `g2-vault.genesis.json` (seated with `player:Ada`, pre-begin), each `JSON.stringify(x, null, 2) + "\n"`.

Register `"g2-vault.gen.test.ts"` in `conformance/fixtures/vitest.config.ts` `include`.

- [ ] **Step 3: Generate and verify the oracle**

Run: `pnpm run fixtures:gen`
Then: `python3 -c "import json; d=json.load(open('conformance/fixtures/g2-vault.genesis.json')); c=d['campaign']; assert c['started'] is False; print('rooms', len(d['rooms']), 'exits', len(d['exits']), 'winConditions', c.get('winConditions'))"`
Expected: pre-begin; 2 rooms, 1 exit, a `reached-vault` win condition.

Run: `git status --short conformance/fixtures/ | grep -v '^??' | grep -E '\.genesis\.json$|\.snapshot\.json$|\.golden\.json$' && echo "PRE-EXISTING ORACLE CHANGED - STOP" || echo "no existing oracle changed ✓"`
Expected: `no existing oracle changed ✓` (only new `g2-vault.*` files).

Run: `pnpm run fixtures:stable`
Expected: PASS (idempotent).

- [ ] **Step 4: Author the TOML twin**

Create `conformance/fixtures/g2-vault.toml` exactly as the spec's surface example (title `Vault`, startRoom `Hall`, the two rooms, the keyed exit, the `vault-key` item, the `shelf` loot, the `vault-door` behavior, the `reached-vault` victory). ASCII only.

- [ ] **Step 5: Gate the oracle through the existing assembler**

Add `g2-vault` to `crates/wickedways-assemble/tests/goldens.rs` as a single-PC pre-begin golden (mirror `facade_genesis_goldens_single_pc`, seat `Seat { name: "Ada", archetype: None }` — confirm the PC id/archetype from the generated genesis; facade fixtures used `delver`, but g2-vault declares no archetype, so `None` unless the genesis shows otherwise).

Run: `cargo test -p wickedways-assemble --test goldens g2_vault`
Expected: PASS — proves the oracle's description + catalog assemble to its genesis golden.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): g2-vault oracle fixture (TS twin) + TOML twin"
```

---

## Task 4: Description lowering → byte-parity on `g2-vault.description.json`

**Files:**
- Create: `crates/wickedways-author/src/lower.rs`
- Create: `crates/wickedways-author/tests/gate.rs`
- Modify: `crates/wickedways-author/src/lib.rs`

**Interfaces:**
- Consumes: `author_doc::AuthorDoc`, `expr::parse_expr`, `wickedways_assemble::description::*`.
- Produces: `lower::lower(doc: &AuthorDoc) -> Result<CompiledCampaign, CompileError>` (this task fills the `description`; the `catalog` is completed in Task 5).

The gate is the authority: iterate `lower.rs` until the emitted **description** byte-matches the committed fixture. The catalog half is stubbed this task and completed next.

- [ ] **Step 1: Write the failing gate test (description half)**

Create `crates/wickedways-author/tests/gate.rs`:

```rust
use std::path::{Path, PathBuf};
use serde_json::Value;
use wickedways_author::compile;

fn fixtures() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures") }
fn read(p: &Path) -> String { std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display())) }

// Copy canon_numbers + first_diff + assert_json_eq VERBATIM from
// crates/wickedways-assemble/tests/goldens.rs (do not re-derive canonicalize).
// [paste the three helpers here]

#[test]
fn g2_vault_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-vault.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.description).expect("to_value");
    let want: Value = serde_json::from_str(&read(&dir.join("g2-vault.description.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-vault.description.json");
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-author --test gate g2_vault_description`
Expected: FAIL — `compile` hits `unimplemented!()` (lowering not wired).

- [ ] **Step 3: Implement description lowering**

Write `src/lower.rs` building a `CampaignDescription` from `AuthorDoc`: `title`; `start_room`; `rooms` (name/description, defaults for the rest); `exits` (from/direction/to, `behavior_key` from `exit.behavior`, `one_way`); `loot` (name/room/items/description); `win_conditions`/`lose_conditions` = one entry per `victory.win`/`victory.lose` key (key + optional narration) — **note the description carries only the condition key + narration; the `test` expression lives in the catalog behaviors, added in Task 5.** Everything the MVP surface omits (archetypes, mobs, npcs, caches, scenes, formations, materials, recipes, mechanics, opts, chat, av) is empty/default. Wire `lower` into `compile` (replace `unimplemented!()`), returning a `CompiledCampaign` whose `catalog` is `Catalog::default()` for now.

Iterate against the gate's first-diff output until the description matches byte-for-byte. Read `crates/wickedways-assemble/src/description.rs` for the exact field names/defaults.

- [ ] **Step 4: Run the gate to verify the description matches**

Run: `cargo test -p wickedways-author --test gate g2_vault_description`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/src/lib.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower the TOML surface to CampaignDescription (byte-parity)"
```

---

## Task 5: Catalog lowering (key item + exit/victory behaviors) → byte-parity on `g2-vault.catalog.json`

**Files:**
- Modify: `crates/wickedways-author/src/lower.rs`, `crates/wickedways-author/tests/gate.rs`

**Interfaces:**
- Consumes: `expr::parse_expr`, `wickedways_core::world::descriptor::{Catalog, ItemDescriptor, ...}`, `wickedways_core::script::ast::BehaviorScript`.
- Produces: a fully-populated `Catalog` in `CompiledCampaign`.

- [ ] **Step 1: Add the failing gate test (catalog half)**

Add to `tests/gate.rs`:

```rust
#[test]
fn g2_vault_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-vault.toml"))).expect("compile");
    let got: Value = serde_json::to_value(&compiled.catalog).expect("to_value");
    let want: Value = serde_json::from_str(&read(&dir.join("g2-vault.catalog.json"))).expect("parse");
    assert_json_eq(&got, &want, "g2-vault.catalog.json");
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test -p wickedways-author --test gate g2_vault_catalog`
Expected: FAIL — the catalog is still `Catalog::default()` (empty items/behaviors).

- [ ] **Step 3: Implement catalog lowering**

Extend `lower.rs` to populate the `Catalog`:
- **items:** one `ItemDescriptor` per `AuthorDoc.items` entry. An entry with `key_code` is a KEY item — reproduce `createKey`'s descriptor exactly (the committed `g2-vault.catalog.json` `items["vault-key"]` entry is the target; `itemToCatalogEntry` in `packages/play-runtime/src/catalog.ts` shows the field set: name/type/stat/modifier/properties{equippable,equipped,destroyable,usable[,droppable]} + `keyCode`/`consumeOnUse` + the inert `recipe`/`teaches`/`immunities`/`grantsImmunity`). Read `crates/wickedways-core/src/world/descriptor.rs` for `ItemDescriptor`'s exact Rust fields.
- **behaviors:** for each `behaviors.exit.<key>`, a `BehaviorScript::Exit { can_pass: parse_expr(canPass), run_script: [], pass_message, fail_message }`. For each `victory.win`/`victory.lose` key, a `BehaviorScript::Victory { test: parse_expr(test) }` under that key. Emit `UnresolvedKey` if an `exit.behavior` names no `behaviors.exit` entry.
- **aliases / formations / recipes:** empty (`BTreeMap::new()`), matching the fixture.

Iterate against the gate's first-diff output until the catalog matches byte-for-byte. The behavior ASTs must equal the `s.*`-authored twins from Task 3 — the `Expr` serde shapes in Global Constraints are exact.

- [ ] **Step 4: Run both gates**

Run: `cargo test -p wickedways-author --test gate`
Expected: PASS — `g2_vault_description_matches` + `g2_vault_catalog_matches`.

- [ ] **Step 5: Add a determinism test and run the crate suite**

Add to `tests/gate.rs`:

```rust
#[test]
fn compile_is_deterministic() {
    let src = read(&fixtures().join("g2-vault.toml"));
    let a = serde_json::to_value(&compile(&src).expect("a")).unwrap();
    let b = serde_json::to_value(&compile(&src).expect("b")).unwrap();
    assert_eq!(a, b, "compile() is not deterministic");
}
```

Run: `cargo test -p wickedways-author`
Expected: PASS (author_doc + expr + gate + determinism).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower items + exit/victory behaviors to Catalog (byte-parity)"
```

---

## Task 6: The `[[bin]]`, CI wiring, hygiene, and README

**Files:**
- Create: `crates/wickedways-author/src/bin/wwauthor.rs`
- Modify: `.github/workflows/checks.yml`, `README.md`, `package.json`

- [ ] **Step 1: Write the bin**

Create `src/bin/wwauthor.rs`: read a TOML path from argv, `compile` it, and write `<stem>.description.json` + `<stem>.catalog.json` (`serde_json::to_string_pretty` + `"\n"`) beside it; on `Err`, print the `CompileError` `Display` to stderr and exit non-zero. No panics on author input.

- [ ] **Step 2: Smoke-test the bin (never against the committed oracle)**

The bin writes its two JSONs beside its input TOML, so running it on the committed `conformance/fixtures/g2-vault.toml` would CLOBBER the oracle. Copy the TOML to a scratch dir first and run the bin there:

```bash
mkdir -p target/wwauthor-smoke && cp conformance/fixtures/g2-vault.toml target/wwauthor-smoke/
cargo run -p wickedways-author --bin wwauthor -- target/wwauthor-smoke/g2-vault.toml
ls target/wwauthor-smoke/g2-vault.description.json target/wwauthor-smoke/g2-vault.catalog.json
```
Expected: both JSONs written under `target/wwauthor-smoke/`. Confirm `git status --short conformance/fixtures/` shows NO modified oracle. (`target/` is gitignored.)

- [ ] **Step 3: Hygiene audit**

Run:
```bash
cd crates/wickedways-author
! grep -rnE "\bHashMap\b|\bHashSet\b" src/ && echo "no HashMap/HashSet ✓"
! grep -rnE "\.unwrap\(\)|\.expect\(|panic!|todo!|unimplemented!" src/ && echo "no panics in src ✓"
! grep -rqE "^(rand|uuid)\b" Cargo.toml && echo "no rand/uuid ✓"
cd ../..
```
Expected: three ✓ lines. If `unimplemented!` remains in `src/`, lowering is incomplete — go back to Task 4/5.

- [ ] **Step 4: Add the CI gate and convenience script**

In `.github/workflows/checks.yml`, after the Rust toolchain setup and beside `cargo test -p wickedways-assemble`, add `- run: cargo test -p wickedways-author`.
In `package.json` scripts, add `"checks:author": "cargo test -p wickedways-author"`.

- [ ] **Step 5: Verify the full local gate**

Run: `cargo test --workspace && pnpm run fixtures:stable`
Expected: all PASS, 0 failed, 0 ignored.

- [ ] **Step 6: Document in the README**

Add a subsection near the G1 assembler docs covering: the crate `wickedways-author`; `compile(toml) -> description.json + catalog.json`; the TOML surface + the infix expression language (with the `party[0].room.name == 'Vault'` example); that it is gated byte-for-byte against a TS-twin oracle (`g2-vault`); the MVP scope (exit + victory, expressions only) and the forward pointer to later G2 slices (statements/effects, other families, npx/WASM packaging, runtime-load).

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-author/src/bin .github/workflows/checks.yml package.json README.md
git commit -m "feat(author): wwauthor bin, CI gate, and docs"
```

---

## Deliberate divergences from the spec

Recorded so a reviewer doesn't mistake them for gaps.

**1. The compiler is permissive (no compile-time `TypeError`).** The spec listed a `TypeError` variant ("indexing a non-list subject"). The `Expr` AST is *total* — `Index`/`Get` accept any operand and yield `Null` at runtime — and the TS `s.*` builders do no type-checking either. To byte-match the oracle the compiler must map permissively, so the MVP does NOT emit compile-time `TypeError`; the firing variants are `TomlParse`, `ExprParse`, `UnknownReference`, `UnresolvedKey`. Richer semantic diagnostics are a later slice; the variant can be added then.

**2. Subscript always lowers to `Index`, never `First`.** `x[0]` → `Index{list, Lit 0}`. The oracle is authored to match (`index(party, lit(0))`). `First` is simply not surfaced in the MVP.

## Notes for the implementer

**The gate is the authority.** When the compiler's output and the committed fixture disagree, the compiler is wrong until proven otherwise. Never edit the fixture, the oracle, or `canonical-json.ts` to force a pass — fix `lower.rs`/the parser. If you become convinced the oracle is wrong (e.g. it uses a behavior the MVP can't express), that is a fixture-authoring bug in Task 3 — fix Task 3's generator and regenerate, don't hand-edit.

**Two facts most likely to trip you up:**
1. The `Expr` serde tag is `kind`, fields are camelCase, `BinOp` is lowercase, and `Value` is untagged — so `Lit{Str("x")}` serializes as `{"kind":"lit","value":"x"}`.
2. A victory authored in TOML produces TWO artifacts: a `winConditions`/`loseConditions` entry (key + narration) in the description AND a `BehaviorScript::Victory{test}` under that key in the catalog behaviors.
