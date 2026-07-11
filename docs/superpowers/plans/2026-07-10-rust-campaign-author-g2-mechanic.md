# Rust Campaign Author (G2) — Mechanic scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `wickedways-author` with negative number literals + the `MechanicScript` AST (init + hooks) + the `[[mechanics]]` surface, so a `dread`-style mechanic can be authored in TOML — gated byte-for-byte against a new `g2-mechanic` TS-twin oracle.

**Architecture:** Add negative-numeric `Lit` parsing to the expression parser. Add a mechanic converter (`MechanicBehaviorEntry` → `MechanicScript`: init literal + the 5 hook bodies via `parse_stmts`; actions/modifyDamage deferred). Lower `[[mechanics]]`→`MechanicEntry` + `[behaviors.mechanic.<key>]`→`BehaviorScript::Mechanic`. Prove it with a `g2-mechanic` oracle (the real dread).

**Tech Stack:** Rust 2021, the existing `wickedways-author` crate, `wickedways-core` (`MechanicScript`/`MechanicHooks`, `Stmt`, `Value`), `wickedways-assemble` (`CampaignDescription`, `MechanicEntry`). TS side: the `vitest` conformance generators + the `s.*` scripted builders + the real dread content.

**Spec:** `docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mechanic-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential gate is the authority.** NEVER hand-edit a golden, a `*.description.json`/`*.catalog.json` fixture, or `conformance/canonical-json.ts` to force a pass. Regenerating via the real TS generator is legitimate; hand-editing is forbidden.
- **Byte-parity is the acceptance criterion** — `compile(g2-mechanic.toml)`'s description + catalog must equal the committed fixtures under the existing canonicalized `serde_json::Value` gate (`canon_numbers`/`assert_json_eq` in `crates/wickedways-author/tests/gate.rs`; do not weaken them).
- **The compiler is panic-free on author input.** NEVER `panic!`/`unwrap()`/`expect()` on author text in `src/` (the parser's `Result`-returning `expect` method + `#[cfg(test)]` excepted). Return `CompileError`.
- **`BTreeMap`/`BTreeSet` only**; no `HashMap`/`HashSet`; no `rand`/`uuid`.
- **This slice adds only:** negative number literals + the mechanic scaffolding (`init` + the 5 hooks). **`actions`, `modify_damage`, the `Damage`/`Heal`/`GrantImmunity`/`Status` effects, `Pass`/`SetStateIn`, and the storyteller forms (`action`/`mapLit`/`has`/`lookup`/`stateGetIn`) MUST stay unimplemented/rejected** — do NOT surface them. Only the mechanic family is added.
- **The `g2-mechanic` oracle stays inside what this slice implements** (a dread-style mechanic: init + one hook using `guard`/`not`/`hasEquipped`/`adjustStat` + the negative `-1` literal). ASCII-only.
- **HAZARD:** the `wwauthor` bin writes `<stem>.json` beside its input — never run it against the committed `g2-mechanic.toml` (it clobbers the oracle). Gate only via `gate.rs`.
- `compile()`'s signature must not change.
- Work on branch `design/rust-campaign-author-g2-mechanic`. Never commit to `main`.

### The AST serde shapes (verbatim from `crates/wickedways-core/src/script/ast.rs`)

- `Expr::Lit { value: Value }` with `Value::Number(f64)` — a negative number serializes as `{"kind":"lit","value":-1}` (canon_numbers normalizes `-1.0`↔`-1`).
- `MechanicHooks { on_round_start, on_round_end, on_turn_start, on_turn_end, on_action: Option<Vec<Stmt>> (skip-when-None), modify_damage: Option<DamageBody> (skip-when-None) }` — all `#[serde(default)]`.
- `MechanicScript { init: serde_json::Value (NO default — always serialized), hooks: MechanicHooks (default), actions: BTreeMap<String, Vec<Stmt>> (default, skip_serializing_if = "BTreeMap::is_empty") }`. `BehaviorScript::Mechanic` → `{"family":"mechanic","script":{…}}`.
- Description-side `MechanicEntry { key: String, config?: … }` — read `crates/wickedways-assemble/src/description.rs` for exact fields/optionality.

---

## File Structure

**Create:**
- `crates/wickedways-author/src/mechanic.rs` — the mechanic converter.
- `conformance/fixtures/g2-mechanic.gen.test.ts` — the TS-twin oracle generator.
- `conformance/fixtures/g2-mechanic.toml` — the mechanic campaign in the new surface.

**Modify:**
- `crates/wickedways-author/src/expr/parser.rs` (and `lexer.rs` if needed) — negative number literals.
- `crates/wickedways-author/src/author_doc.rs` — `[[mechanics]]` + `[behaviors.mechanic.<key>]` structs.
- `crates/wickedways-author/src/lib.rs` — `pub(crate) mod mechanic;`.
- `crates/wickedways-author/src/lower.rs` — mechanic lowering.
- `crates/wickedways-author/tests/gate.rs` — the `g2-mechanic` gate + determinism.
- `crates/wickedways-assemble/tests/goldens.rs` — gate `g2-mechanic` as a new single-PC pre-begin golden.
- `conformance/fixtures/vitest.config.ts` — register `g2-mechanic.gen.test.ts`.
- `README.md` — document mechanics + negative literals.

---

## Task 1: Negative number literals

**Files:**
- Modify: `crates/wickedways-author/src/expr/parser.rs` (and `lexer.rs` if the lexer must recognize the sign)

**Interfaces:**
- Produces: `parse_expr` compiles a prefix `-<number>` to a negative numeric `Lit`.

- [ ] **Step 1: Write the failing tests**

Add to the `expr` test module (`src/expr/mod.rs`):

```rust
    #[test]
    fn negative_number_literal() {
        assert_eq!(p("-1"), serde_json::json!({"kind":"lit","value":-1}));
        assert_eq!(p("-1.5"), serde_json::json!({"kind":"lit","value":-1.5}));
    }

    #[test]
    fn minus_between_operands_is_subtraction() {
        assert_eq!(p("round - 1"), serde_json::json!({
            "kind":"bin","op":"sub","left":{"kind":"round"},"right":{"kind":"lit","value":1}}));
    }

    #[test]
    fn unary_minus_on_non_number_errors() {
        // There is no unary-negation AST node; `-` is only valid before a number literal.
        assert!(crate::expr::parse_expr("-actor", crate::error::Span { line: 1, col: 1 }).is_err());
    }
```

And add to the `stmt` test module (`src/stmt.rs`):

```rust
    #[test]
    fn adjust_stat_negative_delta() {
        assert_eq!(s("emit adjustStat(actor, sanity, -1)"), serde_json::json!([
            {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},
             "stat":"sanity","delta":{"kind":"lit","value":-1}}}
        ]));
    }
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author expr::negative expr::minus expr::unary stmt::adjust_stat_negative`
Expected: FAIL — `-1` currently errors (no prefix-minus handling).

- [ ] **Step 3: Implement**

In the Pratt parser's prefix/operand handling: when the next token is `-` AND the token after it is a numeric literal, consume both and produce `Expr::Lit { value: Value::Number(-n) }`. A `-` in infix position (between two parsed operands) stays the `Sub` binary operator (unchanged). A prefix `-` NOT followed by a number → `CompileError::ExprParse` (no unary negation of non-numbers). Read the existing lexer to see whether the sign is lexed as a separate `-` token (most likely) and handle it in the parser's prefix rule. Panic-free. Do not change any other precedence/operator behavior.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-author expr:: stmt::`
Expected: PASS — the 4 new tests + ALL prior expr/stmt tests (existing subtraction, precedence, etc. unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/expr crates/wickedways-author/src/stmt.rs
git commit -m "feat(author): negative number literals (-1 -> Lit)"
```

---

## Task 2: The mechanic surface schema + converter

**Files:**
- Modify: `crates/wickedways-author/src/author_doc.rs`, `crates/wickedways-author/src/lib.rs`
- Create: `crates/wickedways-author/src/mechanic.rs`

**Interfaces:**
- Consumes: `stmt::parse_stmts`; `wickedways_core::script::ast::{MechanicScript, MechanicHooks}`.
- Produces: `AuthorDoc` mechanic structs; `mechanic::to_mechanic_script(entry: &author_doc::MechanicBehaviorEntry) -> Result<MechanicScript, CompileError>`.

- [ ] **Step 1: Write the failing test**

Create `crates/wickedways-author/src/mechanic.rs` with ONLY this test module:

```rust
#[cfg(test)]
mod tests {
    use super::to_mechanic_script;
    use crate::author_doc::MechanicBehaviorEntry;
    use serde_json::json;

    fn script_json(toml_src: &str) -> serde_json::Value {
        let entry: MechanicBehaviorEntry = toml::from_str(toml_src).expect("toml");
        serde_json::to_value(to_mechanic_script(&entry).expect("convert")).expect("json")
    }

    #[test]
    fn init_and_on_turn_start_hook() {
        let v = script_json(r#"
            init = { }
            onTurnStart = "guard !hasEquipped(actor, 'lantern')\nemit adjustStat(actor, sanity, -1)"
        "#);
        assert_eq!(v, json!({
            "init":{},
            "hooks":{"onTurnStart":[
                {"kind":"guard","cond":{"kind":"not","expr":{"kind":"hasEquipped","of":{"kind":"actor"},"itemKey":"lantern"}}},
                {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},"stat":"sanity","delta":{"kind":"lit","value":-1}}}]}
        }));
    }

    #[test]
    fn init_defaults_to_empty_object() {
        let v = script_json("onRoundStart = \"emit cue('dawn')\"");
        assert_eq!(v["init"], json!({}));
    }
}
```

(The `actions` field is `skip_serializing_if` empty, so it is absent from the JSON — the test does not assert it.)

- [ ] **Step 2: Run to make sure it fails**

Run: `cargo test -p wickedways-author mechanic::`
Expected: FAIL — `MechanicBehaviorEntry`/`to_mechanic_script` undefined.

- [ ] **Step 3: Write the surface structs (`author_doc.rs`)**

Add (camelCase, `deny_unknown_fields`):

```rust
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MechanicEntryToml {
    pub key: String,
    #[serde(default)] pub config: Option<toml::Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MechanicBehaviorEntry {
    #[serde(default)] pub init: Option<toml::Value>,
    #[serde(default)] pub on_round_start: Option<String>,
    #[serde(default)] pub on_round_end: Option<String>,
    #[serde(default)] pub on_turn_start: Option<String>,
    #[serde(default)] pub on_turn_end: Option<String>,
    #[serde(default)] pub on_action: Option<String>,
}
```

Add `#[serde(default)] pub mechanics: Vec<MechanicEntryToml>` to `AuthorDoc`, and `#[serde(default)] pub mechanic: BTreeMap<String, MechanicBehaviorEntry>` to `Behaviors`. Add `pub(crate) mod mechanic;` to `lib.rs`.

- [ ] **Step 4: Write the converter (`mechanic.rs`, above the tests)**

```rust
use wickedways_core::script::ast::{MechanicHooks, MechanicScript, Stmt};

use crate::author_doc::MechanicBehaviorEntry;
use crate::error::{CompileError, Span};
use crate::stmt::parse_stmts;

const BASE: Span = Span { line: 1, col: 1 };

fn hook(src: &Option<String>) -> Result<Option<Vec<Stmt>>, CompileError> {
    match src {
        Some(s) => Ok(Some(parse_stmts(s, BASE)?)),
        None => Ok(None),
    }
}

pub(crate) fn to_mechanic_script(entry: &MechanicBehaviorEntry) -> Result<MechanicScript, CompileError> {
    let init = match &entry.init {
        Some(v) => serde_json::to_value(v).unwrap_or_else(|_| serde_json::json!({})),
        None => serde_json::json!({}),
    };
    Ok(MechanicScript {
        init,
        hooks: MechanicHooks {
            on_round_start: hook(&entry.on_round_start)?,
            on_round_end: hook(&entry.on_round_end)?,
            on_turn_start: hook(&entry.on_turn_start)?,
            on_turn_end: hook(&entry.on_turn_end)?,
            on_action: hook(&entry.on_action)?,
            modify_damage: None,
        },
        actions: Default::default(),
    })
}
```

Confirm the exact `MechanicScript`/`MechanicHooks` field names against `ast.rs`; the test's JSON is the target shape.

- [ ] **Step 5: Add an `author_doc::` surface parse test + run**

Add a unit test that a `[[mechanics]]` + `[behaviors.mechanic.<key>]` doc parses into the new structs. Run `cargo test -p wickedways-author mechanic:: author_doc::` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/src/mechanic.rs crates/wickedways-author/src/author_doc.rs crates/wickedways-author/src/lib.rs
git commit -m "feat(author): mechanic surface schema + converter (init + hooks)"
```

---

## Task 3: The `g2-mechanic` oracle fixture

**Files:**
- Modify: `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`
- Create: `conformance/fixtures/g2-mechanic.gen.test.ts`, `conformance/fixtures/g2-mechanic.toml`

**Interfaces:**
- Produces: committed `g2-mechanic.{description,catalog,genesis}.json` (Task 4 targets) + `g2-mechanic.toml`.

- [ ] **Step 1: Read the mechanic-authoring patterns**

Run: inspect `packages/campaigns/src/hollow-house/scripted.ts` (the `dreadScript` = `s.mechanic({...})` twin) + `packages/campaigns/src/hollow-house/index.ts` (`.useMechanic("dread")`), and `conformance/fixtures/facade-talk.gen.test.ts` (a mechanic fixture) + `g2-vault.gen.test.ts`. Confirm `s.mechanic` + the hook/guard/emit builders exist in `packages/campaigns/src/scripted/builders.ts`; add any missing (thin sugar). Note `adjustStat`'s delta of `-1` is a literal `lit(-1)`.

- [ ] **Step 2: Author the TS twin**

Create `conformance/fixtures/g2-mechanic.gen.test.ts` (modeled on `facade-talk.gen.test.ts`/`g2-vault.gen.test.ts`): a small ASCII campaign (1 room, PC `Ada`) declaring a dread-style mechanic via `.useMechanic("dread")` (or a fresh key), backed by a `s.mechanic({ init:{}, hooks:{ onTurnStart:[ guard(not(hasEquipped(actor,"lantern"))), emit(adjustStat(actor,"sanity",lit(-1))) ] } })` behavior keyed the same. Emit `g2-mechanic.{description,catalog}.json` (stripRng/catalogFromRegistry) + `g2-mechanic.genesis.json` (seated `player:Ada`, pre-begin). Register in `vitest.config.ts`.

**Stay in-subset:** init + ONE hook (onTurnStart) using only guard/not/hasEquipped/adjustStat + the `-1` literal; no actions, no modifyDamage, no other hooks/effects/forms.

- [ ] **Step 3: Generate + guardrail**

Run: `pnpm run fixtures:gen`. Paste in your report the `g2-mechanic.catalog.json` `behaviors[<key>]` (must be `{"family":"mechanic","script":{"init":{},"hooks":{"onTurnStart":[guard, adjustStat(-1)]}}}`) and the description's `mechanics` entry (`{key}`). Confirm genesis pre-begin.

Run: `git status --short conformance/fixtures/ | grep -v '^??' | grep -E '\.genesis\.json$|\.snapshot\.json$|\.golden\.json$' && echo "EXISTING ORACLE CHANGED - STOP" || echo "no existing oracle changed OK"` → OK. `pnpm run fixtures:stable` → PASS.

- [ ] **Step 4: Author the TOML twin**

Create `conformance/fixtures/g2-mechanic.toml`: `[[mechanics]]` (key) + `[behaviors.mechanic.<key>]` (`init = {}` + `onTurnStart = '''guard !hasEquipped(actor, 'lantern')\n  emit adjustStat(actor, sanity, -1)'''`). ASCII only. Match the oracle exactly.

- [ ] **Step 5: Gate the oracle through the assembler**

Add `g2-mechanic` to `crates/wickedways-assemble/tests/goldens.rs` (single-PC pre-begin, `Seat { name:"Ada", archetype: None }` — confirm from genesis). Run `cargo test -p wickedways-assemble --test goldens g2_mechanic` → PASS.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): g2-mechanic oracle fixture (TS twin) + mechanic TOML surface"
```

---

## Task 4: Mechanic lowering → byte-parity on `g2-mechanic`

**Files:**
- Modify: `crates/wickedways-author/src/lower.rs`, `crates/wickedways-author/tests/gate.rs`

**Interfaces:**
- Consumes: `author_doc` mechanic structs, `mechanic::to_mechanic_script`, `wickedways_assemble::description::MechanicEntry`, `wickedways_core::script::ast::BehaviorScript`.
- Produces: `MechanicEntry`s in the description + `BehaviorScript::Mechanic`s in the catalog.

- [ ] **Step 1: Add the failing gate tests**

Add to `tests/gate.rs` (reuse the existing helpers):

```rust
#[test]
fn g2_mechanic_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic.description.json"))).unwrap(),
        "g2-mechanic.description.json");
}

#[test]
fn g2_mechanic_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-mechanic.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-mechanic.catalog.json"))).unwrap(),
        "g2-mechanic.catalog.json");
}
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author --test gate g2_mechanic`
Expected: FAIL — mechanics + mechanic behaviors not lowered.

- [ ] **Step 3: Implement mechanic lowering**

In `lower.rs`:
- **Description:** for each `AuthorDoc.mechanics` entry → a `MechanicEntry { key, config }` pushed into `CampaignDescription.mechanics`. Read `crates/wickedways-assemble/src/description.rs` for `MechanicEntry`'s exact fields (config type/optionality — dread has none, so `config` is None/absent; if it's a `serde_json::Value` field, convert the optional `toml::Value`).
- **Catalog:** for each `behaviors.mechanic.<key>` → `BehaviorScript::Mechanic { script: mechanic::to_mechanic_script(entry)? }`, keyed by `<key>`.
Iterate against the gate's first-diff until BOTH halves byte-match.

- [ ] **Step 4: Run both gates + the full suite**

Run: `cargo test -p wickedways-author`
Expected: PASS — the two g2-mechanic gates + ALL prior tests (g2-vault, g2-scene, g2-item, g2-npc, determinism, parser, mechanic).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower mechanics to MechanicEntry + BehaviorScript::Mechanic (byte-parity)"
```

---

## Task 5: Determinism, hygiene, and documentation

**Files:**
- Modify: `crates/wickedways-author/tests/gate.rs`, `README.md`

- [ ] **Step 1: Determinism over the mechanic fixture**

Add to `tests/gate.rs` a test that `compile(g2-mechanic.toml)` twice → byte-identical (mirror the existing determinism tests). Run: `cargo test -p wickedways-author --test gate` → PASS.

- [ ] **Step 2: Hygiene audit**

Run:
```bash
cd crates/wickedways-author
! grep -rnE "\bHashMap\b|\bHashSet\b" src/ && echo "no HashMap/HashSet ✓"
! grep -rnE "\.unwrap\(\)|panic!|todo!|unimplemented!" src/ && echo "no panics in src ✓"
cd ../..
```
Expected: two ✓ lines (`.expect(` only as the parser's `Result`-returning method + `#[cfg(test)]`).

- [ ] **Step 3: Verify the full local gate**

Run: `cargo test --workspace && pnpm run fixtures:stable && pnpm run bindings:check`
Expected: all PASS, 0 failed, 0 ignored.

- [ ] **Step 4: Document in the README**

Extend the `wickedways-author` section: negative number literals; that mechanics (`[[mechanics]]` + `[behaviors.mechanic.<key>]` with `init` + the 5 hooks) are now authorable and gated by `g2-mechanic`; the deliberate scope (only init + hooks this slice; `actions`, `modifyDamage`, the `Damage`/`Heal`/`GrantImmunity`/`Status` effects, and the storyteller forms `action`/`mapLit`/`has`/`lookup`/`stateGetIn`/`setStateIn` still deferred to follow-on mechanic slices).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/tests/gate.rs README.md
git commit -m "test+docs(author): mechanic determinism gate + mechanic/negative-literal docs"
```

---

## Deliberate scope boundaries (recorded so a reviewer doesn't mistake them for gaps)

- **Only mechanic scaffolding (init + the 5 hooks) + negative literals.** `actions`, `modify_damage` are deferred (no committed mechanic uses them).
- **No new effects.** The dread oracle reuses `adjustStat`; `Damage`/`Heal`/`GrantImmunity`/`Status` still reject.
- **The storyteller/status-bar expression forms are NOT added** — `action` subject, `mapLit`, `has`, `lookup`, `stateGetIn`, `setStateIn`, `str`, `length`, `first`, and the `Status` effect are follow-on mechanic slices.

## Notes for the implementer

**The gate is the authority.** When the compiler's output and the `g2-mechanic` fixture disagree, the compiler is wrong — fix the converter/lowering/parser, never the fixture. If convinced the oracle uses a form the slice can't express, that's a Task 3 generator bug — fix the generator and regenerate. **Do NOT run the `wwauthor` bin against the committed `g2-mechanic.toml`** (it clobbers the oracle).

**Two facts most likely to trip you up:**
1. A prefix `-` before a number is a negative `Lit`; a `-` between operands stays subtraction. `adjustStat`'s `delta` in dread is `Lit{-1}`, NOT `Bin{0,-,1}`.
2. `MechanicScript.init` has NO serde default (always serialized), so an omitted `init` must lower to `{}`. `hooks`/`actions` skip when empty; `modify_damage` stays `None`.
