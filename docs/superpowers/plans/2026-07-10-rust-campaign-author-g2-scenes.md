# Rust Campaign Author (G2) — Scene bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `wickedways-author` with a block statement grammar (`guard`/`when`/`set`/`emit cue`) + the `Cue` effect + the `stateGet` expression, so scene `canPlay`/`onEnter`/`onExit` bodies can be authored in TOML — gated byte-for-byte against a new `g2-scene` TS-twin oracle.

**Architecture:** Add `stateGet` to the Pratt expression parser and a new `parse_stmts` block-statement parser (reusing `parse_expr` for embedded expressions). Extend the TOML surface with `[[scenes]]` (→ `SceneDef`) + `[behaviors.scene.<key>]` (→ `BehaviorScript::Scene`). Lower both, and prove it with a `g2-scene` oracle whose scene body exercises the full statement grammar.

**Tech Stack:** Rust 2021, the existing `wickedways-author` crate, `wickedways-core` (`Stmt`/`EffectTemplate`/`SceneScript`/`Expr` AST), `wickedways-assemble` (`CampaignDescription` incl. `SceneDef`). TS side: the existing `vitest` conformance generators + the `s.*` scripted builders.

**Spec:** `docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-scenes-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential gate is the authority.** NEVER hand-edit a golden, a `*.description.json`/`*.catalog.json` fixture, or `conformance/canonical-json.ts` to force a pass. Regenerating a fixture by running the real TS generator is legitimate; hand-editing one is forbidden.
- **Byte-parity is the acceptance criterion** — `compile(g2-scene.toml)`'s emitted description + catalog must equal the committed fixtures under the existing canonicalized `serde_json::Value` gate (the `canon_numbers`/`assert_json_eq` helpers already in `crates/wickedways-author/tests/gate.rs`; do not weaken them).
- **The compiler is panic-free on author input.** NEVER `panic!`/`unwrap()`/`expect()` on author text in `src/` (the parser's `Result`-returning `expect` method and `#[cfg(test)]` are the only exceptions). Return `CompileError`.
- **`BTreeMap`/`BTreeSet` only**, never `HashMap`/`HashSet`. No `rand`/`uuid`.
- **This slice implements only:** the statements `guard` / `when` / `setState` / `emit cue`, the `Cue` effect, and the `stateGet` expression. `Pass`, `SetStateIn`, and `emit` of any non-`Cue` effect MUST be **rejected with a clear `CompileError`** (not silently mis-lowered). The other four families are untouched.
- **The `g2-scene` oracle stays inside what this slice implements** (statements + `Cue` only) so byte-parity is achievable. Author it ASCII-only.
- `compile()`'s signature must not change.
- Work on branch `design/rust-campaign-author-g2-scenes`. Never commit to `main`.

### The AST serde shapes (verbatim from `crates/wickedways-core/src/script/ast.rs`)

`Stmt` and `EffectTemplate` are `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`; `Expr` likewise; `Value` untagged.

| syntax | node | serde JSON |
| --- | --- | --- |
| `guard <expr>` | `Stmt::Guard{cond}` | `{"kind":"guard","cond":…}` |
| `when <expr> { <stmts> }` | `Stmt::When{cond,then}` | `{"kind":"when","cond":…,"then":[…]}` |
| `set state.<f> = <expr>` | `Stmt::SetState{field,value}` | `{"kind":"setState","field":"seen","value":…}` |
| `emit cue(<expr>)` | `Stmt::Emit{effect:EffectTemplate::Cue{text}}` | `{"kind":"emit","effect":{"kind":"cue","text":…}}` |
| `stateGet('f', <lit>)` | `Expr::StateGet{field,default:Value}` | `{"kind":"stateGet","field":"seen","default":false}` |

`SceneScript` (ast.rs:287): `{ can_play: Option<Expr> (always serialized — `null` when absent), on_enter: Option<Vec<Stmt>> (skip when None), on_exit: Option<Vec<Stmt>> (skip when None) }`. `BehaviorScript::Scene` serializes as `{"family":"scene","script":{…}}`.

---

## File Structure

**Modify:**
- `crates/wickedways-author/src/expr/parser.rs` — add the `stateGet` call.
- `crates/wickedways-author/src/author_doc.rs` — add `[[scenes]]` + `[behaviors.scene.<key>]` structs.
- `crates/wickedways-author/src/lower.rs` — lower scenes (description `SceneDef` + catalog `BehaviorScript::Scene`).
- `crates/wickedways-author/tests/gate.rs` — the `g2-scene` byte-parity gate.
- `crates/wickedways-author/src/lib.rs` — add `pub(crate) mod stmt;`.
- `crates/wickedways-assemble/tests/goldens.rs` — gate `g2-scene` as a new single-PC pre-begin golden.
- `conformance/fixtures/vitest.config.ts` — register `g2-scene.gen.test.ts`.
- `README.md` — document scenes + the statement grammar.

**Create:**
- `crates/wickedways-author/src/stmt.rs` — `parse_stmts`.
- `conformance/fixtures/g2-scene.gen.test.ts` — the TS-twin oracle generator.
- `conformance/fixtures/g2-scene.toml` — the scene campaign in the new surface.

---

## Task 1: The `stateGet` expression + the `parse_stmts` block statement parser

**Files:**
- Modify: `crates/wickedways-author/src/expr/parser.rs`, `src/lib.rs`
- Create: `crates/wickedways-author/src/stmt.rs`

**Interfaces:**
- Consumes: `expr::parse_expr`, `error::{CompileError, Span}`, `wickedways_core::script::ast::{Stmt, EffectTemplate, Expr}`, `wickedways_core::script::value::Value`.
- Produces: `stmt::parse_stmts(src: &str, base: Span) -> Result<Vec<Stmt>, CompileError>`; and `parse_expr` now recognizes `stateGet`.

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-author/src/stmt.rs` with ONLY this test module:

```rust
#[cfg(test)]
mod tests {
    use super::parse_stmts;
    use crate::error::{CompileError, Span};
    use serde_json::json;

    fn s(src: &str) -> serde_json::Value {
        serde_json::to_value(parse_stmts(src, Span { line: 1, col: 1 }).expect("parse")).unwrap()
    }

    #[test]
    fn emit_cue_and_set_state() {
        assert_eq!(s("emit cue('hi')\nset state.seen = true"), json!([
            {"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"hi"}}},
            {"kind":"setState","field":"seen","value":{"kind":"lit","value":true}}
        ]));
    }

    #[test]
    fn guard_and_nested_when() {
        assert_eq!(s("guard round == 0\nwhen round == 1 {\n  emit cue('x')\n}"), json!([
            {"kind":"guard","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":0}}},
            {"kind":"when","cond":{"kind":"bin","op":"eq","left":{"kind":"round"},"right":{"kind":"lit","value":1}},
             "then":[{"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"x"}}}]}
        ]));
    }

    #[test]
    fn pass_is_rejected() {
        assert!(matches!(parse_stmts("pass 'x'", Span { line: 1, col: 1 }).unwrap_err(),
            CompileError::ExprParse { .. }));
    }

    #[test]
    fn non_cue_effect_is_rejected() {
        assert!(parse_stmts("emit damage(actor, 5)", Span { line: 1, col: 1 }).is_err());
    }

    #[test]
    fn set_state_in_map_is_rejected() {
        // `set state.m[k] = v` (SetStateIn) is deferred; must error, not silently drop.
        assert!(parse_stmts("set state.visits[actor] = true", Span { line: 1, col: 1 }).is_err());
    }
}
```

And add to the `expr` test module (`src/expr/mod.rs`) these `stateGet` cases:

```rust
    #[test]
    fn state_get_expression() {
        assert_eq!(p("stateGet('seen', false)"),
            json!({"kind":"stateGet","field":"seen","default":false}));
        assert_eq!(p("!stateGet('seen', false)"),
            json!({"kind":"not","expr":{"kind":"stateGet","field":"seen","default":false}}));
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test -p wickedways-author stmt:: ; cargo test -p wickedways-author expr::state_get`
Expected: FAIL — `cannot find function 'parse_stmts'`; `state_get_expression` fails (`stateGet` currently → `UnknownReference`).

- [ ] **Step 3: Add `stateGet` to the expression parser**

In `parser.rs`, add `stateGet` to the known calls: 2 args, the 1st a string literal (→ `field: String`), the 2nd a **literal** (→ `default: Value` — a `Lit`'s inner `Value`; reject a non-literal 2nd arg with `ExprParse`). Build `Expr::StateGet { field, default }`. Read `ast.rs` for the exact `StateGet` field names/types.

- [ ] **Step 4: Write `parse_stmts`**

Write `src/stmt.rs` above the test module. A block-statement parser over the `'''...'''` body: split into statements at newlines while tracking `{ }` nesting for `when`; dispatch each by leading keyword:
- `guard <expr>` → `parse_expr(rest)` → `Stmt::Guard`.
- `when <expr> { <stmts> }` → `parse_expr(cond)` + recursive `parse_stmts(inner)` → `Stmt::When`.
- `set state.<field> = <expr>` → `parse_expr(rhs)` → `Stmt::SetState`. A subscripted `set state.<m>[<k>] = …` (SetStateIn) MUST error (`CompileError`).
- `emit cue(<expr>)` → `parse_expr(arg)` → `Stmt::Emit { effect: EffectTemplate::Cue { text } }`. `emit` of any other effect name MUST error.
- Any other leading keyword (incl. `pass`) → `CompileError::ExprParse`.
Blank lines are skipped. Must be panic-free on author input. Register `pub(crate) mod stmt;` in `lib.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p wickedways-author stmt:: ; cargo test -p wickedways-author expr::`
Expected: PASS — the 5 stmt tests + the stateGet expr tests.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/src/stmt.rs crates/wickedways-author/src/expr/parser.rs \
        crates/wickedways-author/src/expr/mod.rs crates/wickedways-author/src/lib.rs
git commit -m "feat(author): block statement parser (guard/when/set/emit cue) + stateGet"
```

---

## Task 2: The scene surface + the `g2-scene` oracle fixture

**Files:**
- Modify: `crates/wickedways-author/src/author_doc.rs`, `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`
- Create: `conformance/fixtures/g2-scene.gen.test.ts`, `conformance/fixtures/g2-scene.toml`

**Interfaces:**
- Produces: the `AuthorDoc` scene surface structs; the committed `g2-scene.{description,catalog,genesis}.json` (the Task 3 byte-parity targets) + `g2-scene.toml`.

- [ ] **Step 1: Extend the surface schema (`author_doc.rs`) + a parse test**

Add to `AuthorDoc`: `#[serde(default)] pub scenes: Vec<SceneEntry>`, and to `Behaviors`: `#[serde(default)] pub scene: BTreeMap<String, SceneBehaviorEntry>`. Define (camelCase, `deny_unknown_fields`):

```rust
pub struct SceneEntry { pub room: String, pub key: String,
    #[serde(default)] pub phase: Option<String>,
    #[serde(default)] pub initial_state: Option<toml::Value> }

pub struct SceneBehaviorEntry {
    #[serde(default)] pub can_play: Option<String>,   // expression string
    #[serde(default)] pub on_enter: Option<String>,   // statement-block string
    #[serde(default)] pub on_exit: Option<String> }
```

Add a unit test that `toml::from_str` parses a `[[scenes]]` + `[behaviors.scene.<key>]` doc into these fields.

Run: `cargo test -p wickedways-author author_doc::`
Expected: PASS.

- [ ] **Step 2: Read the scene-authoring patterns**

Run: `sed -n '160,200p' packages/campaigns/src/hollow-house/scripted.ts` (the `s.scene({...})` twin) and `grep -n "\.scene(" packages/campaigns/src/hollow-house/index.ts` (the `.scene(room, key, {...})` template call), and inspect `conformance/fixtures/scripted-scene.gen.test.ts`. Confirm the `s.*` builders `s.scene`, `s.guard`, `s.when`, `s.setState`, `s.emit`, `s.cue`, `s.stateGet` exist in `packages/campaigns/src/scripted/builders.ts`; if any is missing, add it (thin sugar over the serde JSON).

- [ ] **Step 3: Author the `g2-scene` TS twin**

Create `conformance/fixtures/g2-scene.gen.test.ts` building a small campaign (modeled on `g2-vault.gen.test.ts` + `scripted-scene.gen.test.ts`): 1-2 ASCII rooms, a PC `Ada`, and a scene attached to the start room via `.scene(room, key, { phase: "enter" })`, backed by a `s.scene({...})` behavior in the `behaviors` map. The scene body **must exercise the full statement grammar this slice implements**:
- `canPlay`: `s.not(s.stateGet("seen", false))`.
- `onEnter`: `[ s.guard(<expr>), s.when(<expr>, [ s.emit(s.cue("...")), s.setState("revealed", s.lit(true)) ]), s.setState("seen", s.lit(true)) ]` — i.e. a `guard`, a nested `when { emit cue; set }`, and a trailing `set`.
Emit `g2-scene.{description,catalog}.json` (via `stripRng` / `catalogFromRegistry`) and `g2-scene.genesis.json` (seated `player:Ada`, pre-begin — scenes do NOT fire at genesis). Register in `vitest.config.ts`.

- [ ] **Step 4: Generate + guardrail**

Run: `pnpm run fixtures:gen`
Then confirm the scene behavior in `g2-scene.catalog.json` has `canPlay` (a `not`/`stateGet`), `onEnter` (guard + when + setState), and matches the AST shapes in Global Constraints (paste it in your report).

Run: `git status --short conformance/fixtures/ | grep -v '^??' | grep -E '\.genesis\.json$|\.snapshot\.json$|\.golden\.json$' && echo "EXISTING ORACLE CHANGED - STOP" || echo "no existing oracle changed OK"`
Expected: `no existing oracle changed OK`. Then `pnpm run fixtures:stable` → PASS.

- [ ] **Step 5: Author the TOML twin**

Create `conformance/fixtures/g2-scene.toml` in the new surface (the `[[scenes]]` + `[behaviors.scene.<key>]` shape from the spec), expressing the SAME scene: `canPlay = "!stateGet('seen', false)"`, an `onEnter` block with `guard` + `when … { emit cue(…); set state.revealed = true }` + `set state.seen = true`. ASCII only. The exact statement text must lower to the oracle's AST (Task 3 gates this).

- [ ] **Step 6: Gate the oracle through the assembler**

Add `g2-scene` to `crates/wickedways-assemble/tests/goldens.rs` as a single-PC pre-begin golden (`Seat { name:"Ada", archetype: None }` — confirm from the genesis). Run `cargo test -p wickedways-assemble --test goldens g2_scene` → PASS (proves the oracle's description+catalog assemble to its genesis).

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-author/src/author_doc.rs conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): g2-scene oracle fixture (TS twin) + scene TOML surface"
```

---

## Task 3: Scene lowering → byte-parity on `g2-scene`

**Files:**
- Modify: `crates/wickedways-author/src/lower.rs`, `crates/wickedways-author/tests/gate.rs`

**Interfaces:**
- Consumes: `author_doc` scene structs, `stmt::parse_stmts`, `expr::parse_expr`, `wickedways_assemble::description::SceneDef`, `wickedways_core::script::ast::{BehaviorScript, SceneScript}`.
- Produces: scene entries in the lowered `CampaignDescription` + `BehaviorScript::Scene`s in the `Catalog`.

- [ ] **Step 1: Add the failing gate test**

Add to `tests/gate.rs`:

```rust
#[test]
fn g2_scene_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-scene.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-scene.description.json"))).unwrap(),
        "g2-scene.description.json");
}

#[test]
fn g2_scene_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-scene.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-scene.catalog.json"))).unwrap(),
        "g2-scene.catalog.json");
}
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author --test gate g2_scene`
Expected: FAIL — scenes aren't lowered yet (missing `SceneDef` entries / scene behaviors).

- [ ] **Step 3: Implement scene lowering**

In `lower.rs`:
- Description: for each `AuthorDoc.scenes` entry, push a `SceneDef { room, key, phase, initial_state }` into `CampaignDescription.scenes`. Read `crates/wickedways-assemble/src/description.rs` for `SceneDef`'s exact fields (phase default, initial_state type).
- Catalog: for each `behaviors.scene.<key>`, build `BehaviorScript::Scene { script: SceneScript { can_play: can_play.map(parse_expr), on_enter: on_enter.map(parse_stmts), on_exit: on_exit.map(parse_stmts) } }`, keyed by `<key>`. (`can_play` None → `SceneScript.can_play` None, which serializes as `null`.)
Iterate against the gate's first-diff until both halves byte-match. The scene body AST must equal the oracle's `s.*`-authored twin — the serde shapes in Global Constraints are exact.

- [ ] **Step 4: Run both gates + the existing suite**

Run: `cargo test -p wickedways-author`
Expected: PASS — `g2_scene_description_matches`, `g2_scene_catalog_matches`, plus every prior test (g2-vault gates, determinism, parser).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower scenes to SceneDef + BehaviorScript::Scene (byte-parity)"
```

---

## Task 4: Determinism, hygiene, and documentation

**Files:**
- Modify: `crates/wickedways-author/tests/gate.rs`, `README.md`

- [ ] **Step 1: Determinism over the scene fixture**

Add to `tests/gate.rs` a test that `compile(g2-scene.toml)` twice → byte-identical (mirror the existing `compile_is_deterministic`). Run: `cargo test -p wickedways-author --test gate` → PASS.

- [ ] **Step 2: Hygiene audit**

Run:
```bash
cd crates/wickedways-author
! grep -rnE "\bHashMap\b|\bHashSet\b" src/ && echo "no HashMap/HashSet ✓"
! grep -rnE "\.unwrap\(\)|panic!|todo!|unimplemented!" src/ && echo "no panics in src ✓"
cd ../..
```
Expected: two ✓ lines. (`.expect(` appears only as the parser's `Result`-returning method + `#[cfg(test)]`; confirm each hit is exempt.)

- [ ] **Step 3: Verify the full local gate**

Run: `cargo test --workspace && pnpm run fixtures:stable && pnpm run bindings:check`
Expected: all PASS, 0 failed, 0 ignored.

- [ ] **Step 4: Document in the README**

Extend the `wickedways-author` README section: the statement grammar (`guard`/`when`/`set`/`emit cue`) with the scene `onEnter` example from the spec; that scenes (`[[scenes]]` + `[behaviors.scene.<key>]`) are now authorable and gated by the `g2-scene` oracle; the deliberate scope (only the `Cue` effect + `stateGet`; `Pass`/`SetStateIn`/other effects/other families rejected and deferred to their slices).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/tests/gate.rs README.md
git commit -m "test+docs(author): scene determinism gate + statement-grammar docs"
```

---

## Deliberate scope boundaries (recorded so a reviewer doesn't mistake them for gaps)

- **Only the `Cue` effect.** `emit` of `Damage`/`Heal`/`AdjustStat`/`GrantImmunity`/`Status`/`GiveItem`/`SetVisible` is rejected — each lands with the family slice that exercises it (byte-parity discipline: no unverified effect lowering).
- **`Pass` and `SetStateIn` rejected.** `Pass` is exit-script-only (the exit `runScript` slice); `SetStateIn` (dynamic map writes) fits the storyteller-style mechanic. Both error clearly rather than mis-lower.
- **Only the scene family is wired.** Mechanic/item/npc bodies reuse this same `parse_stmts` in their own slices; no lowering for them here.

## Notes for the implementer

**The gate is the authority.** When the compiler's output and the `g2-scene` fixture disagree, the compiler is wrong — fix the parser/lowering, never the fixture. If convinced the fixture is wrong (e.g. it uses a form this slice can't express), that's a Task 2 generator bug — fix the generator and regenerate, don't hand-edit.

**Two facts most likely to trip you up:**
1. `SceneScript.can_play` is `Option<Expr>` with NO `skip_serializing_if`, so it serializes as `null` when absent — the catalog scene behavior always has a `canPlay` key. `on_enter`/`on_exit` ARE skipped when None.
2. The statement `emit cue(x)` nests an `EffectTemplate` inside `Stmt::Emit`: `{"kind":"emit","effect":{"kind":"cue","text":<x>}}` — two levels, both `kind`-tagged.
