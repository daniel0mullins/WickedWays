# Rust Campaign Author (G2) — Item bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `wickedways-author` with the `AdjustStat` effect + a consumable `ItemDescriptor` + item `onUse`/`onRead` behavior bodies, so a usable consumable can be authored in TOML — gated byte-for-byte against a new `g2-item` TS-twin oracle.

**Architecture:** Add `emit adjustStat(target, stat, delta)` to the statement parser (`parse_stmts`/`parse_emit` reused). Extend the `[[items]]` surface so a non-`keyCode` item is a consumable, branching `lower_item` on key-vs-consumable. Add `[behaviors.item.<key>]` (`onUse`/`onRead`) → `BehaviorScript::Item`, keyed the same as the item. Prove it with a `g2-item` oracle (a laudanum-style consumable whose `onUse` emits `adjustStat`).

**Tech Stack:** Rust 2021, the existing `wickedways-author` crate, `wickedways-core` (`EffectTemplate::AdjustStat`, `StatType`, `ItemScript`, `Stmt`), `wickedways-assemble` (`CampaignDescription`). TS side: the existing `vitest` conformance generators + the `s.*` scripted builders + a real consumable item factory.

**Spec:** `docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-items-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential gate is the authority.** NEVER hand-edit a golden, a `*.description.json`/`*.catalog.json` fixture, or `conformance/canonical-json.ts` to force a pass. Regenerating a fixture by running the real TS generator is legitimate; hand-editing one is forbidden.
- **Byte-parity is the acceptance criterion** — `compile(g2-item.toml)`'s emitted description + catalog must equal the committed fixtures under the existing canonicalized `serde_json::Value` gate (the `canon_numbers`/`assert_json_eq` helpers in `crates/wickedways-author/tests/gate.rs`; do not weaken them).
- **The compiler is panic-free on author input.** NEVER `panic!`/`unwrap()`/`expect()` on author text in `src/` (the parser's `Result`-returning `expect` method + `#[cfg(test)]` are the only exceptions). Return `CompileError`.
- **`BTreeMap`/`BTreeSet` only**; no `HashMap`/`HashSet`; no `rand`/`uuid`.
- **This slice implements only the `AdjustStat` effect** (beyond the scene slice's `Cue`). `emit` of any OTHER effect (`Heal`/`Damage`/`GrantImmunity`/`Status`/`GiveItem`/`SetVisible`), and `Pass`/`SetStateIn`, MUST stay **rejected with a clear `CompileError`** — never silently mis-lowered. Only the item family is added; npc/mechanic untouched.
- **The `g2-item` oracle stays inside what this slice implements** (consumable item + `onUse`/`onRead` using only `cue`/`adjustStat`). Author it ASCII-only.
- `compile()`'s signature must not change.
- Work on branch `design/rust-campaign-author-g2-items`. Never commit to `main`.

### The AST serde shapes (verbatim from `crates/wickedways-core/src/script/ast.rs` + `stats.rs`)

- `EffectTemplate::AdjustStat { target: Expr, stat: StatType, delta: Expr }` → `{"kind":"adjustStat","target":…,"stat":"sanity","delta":…}`. `StatType` is `#[serde(rename_all = "lowercase")]` → `sanity`/`health`/`energy`.
- `ItemScript { on_use: Option<Vec<Stmt>>, on_read: Option<Vec<Stmt>> }` — both `#[serde(default, skip_serializing_if = "Option::is_none")]` (omitted when None). `BehaviorScript::Item` serializes as `{"family":"item","script":{…}}`.
- The laudanum descriptor (the consumable model — the `g2-item` oracle's item descriptor is byte-matched, not necessarily identical): `{"name":…,"type":"consumable","stat":"sanity","modifier":6,"properties":{"equippable":false,"equipped":false,"destroyable":true,"usable":true},"recipe":{…},"teaches":null,"immunities":null,"grantsImmunity":null}`.

---

## File Structure

**Modify:**
- `crates/wickedways-author/src/stmt.rs` — `parse_emit` gains the `adjustStat` arm.
- `crates/wickedways-author/src/author_doc.rs` — `[[items]]` consumable fields + `[behaviors.item.<key>]`.
- `crates/wickedways-author/src/lower.rs` — consumable `lower_item` branch + item behavior lowering.
- `crates/wickedways-author/tests/gate.rs` — the `g2-item` byte-parity gate + determinism.
- `crates/wickedways-assemble/tests/goldens.rs` — gate `g2-item` as a new single-PC pre-begin golden.
- `conformance/fixtures/vitest.config.ts` — register `g2-item.gen.test.ts`.
- `README.md` — document items + the `adjustStat` effect.

**Create:**
- `conformance/fixtures/g2-item.gen.test.ts` — the TS-twin oracle generator.
- `conformance/fixtures/g2-item.toml` — the item campaign in the new surface.

---

## Task 1: The `AdjustStat` effect in `parse_emit`

**Files:**
- Modify: `crates/wickedways-author/src/stmt.rs`

**Interfaces:**
- Consumes: `expr::parse_expr`, `wickedways_core::script::ast::EffectTemplate`, `wickedways_core::stats::StatType`.
- Produces: `parse_stmts` now compiles `emit adjustStat(...)`.

- [ ] **Step 1: Write the failing tests**

Add to the `stmt` test module in `src/stmt.rs`:

```rust
    #[test]
    fn emit_adjust_stat() {
        assert_eq!(s("emit adjustStat(actor, sanity, 6)"), serde_json::json!([
            {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},
             "stat":"sanity","delta":{"kind":"lit","value":6}}}
        ]));
    }

    #[test]
    fn adjust_stat_unknown_stat_rejected() {
        assert!(parse_stmts("emit adjustStat(actor, vigor, 6)", Span { line: 1, col: 1 }).is_err());
    }

    #[test]
    fn heal_effect_still_rejected() {
        // Only cue + adjustStat this slice; heal (and every other effect) still errors.
        assert!(parse_stmts("emit heal(actor, 6)", Span { line: 1, col: 1 }).is_err());
    }
```

(`s(...)` is the existing serde-JSON helper in the module; `canon_numbers` in it already reconciles `6.0`↔`6`.)

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author stmt::emit_adjust_stat stmt::adjust_stat stmt::heal`
Expected: FAIL — `emit adjustStat(...)` currently errors (only `cue` is recognized).

- [ ] **Step 3: Implement the `adjustStat` arm**

In `parse_emit`, dispatch on the effect name: `cue` → existing `Cue`; `adjustStat` → parse 3 args — arg1 `parse_expr` (target), arg2 a **bare stat keyword** mapped to `StatType` (`sanity`/`health`/`energy`; an unknown keyword → `CompileError::ExprParse`), arg3 `parse_expr` (delta) → `EffectTemplate::AdjustStat { target, stat, delta }`; any other name → the existing rejection. Read `crates/wickedways-core/src/stats.rs` for `StatType`'s variants and `ast.rs` for `AdjustStat`'s field names/order. Do NOT parse the stat arg as an expression — it is a keyword. Panic-free.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-author stmt::`
Expected: PASS — the 3 new tests + all prior stmt tests.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/stmt.rs
git commit -m "feat(author): adjustStat effect (emit adjustStat(target, stat, delta))"
```

---

## Task 2: The consumable item surface + the `g2-item` oracle

**Files:**
- Modify: `crates/wickedways-author/src/author_doc.rs`, `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`
- Create: `conformance/fixtures/g2-item.gen.test.ts`, `conformance/fixtures/g2-item.toml`

**Interfaces:**
- Produces: `AuthorDoc` consumable-item + item-behavior structs; committed `g2-item.{description,catalog,genesis}.json` (the Task 3 targets) + `g2-item.toml`.

- [ ] **Step 1: Extend the surface schema + a parse test**

Extend `ItemEntry` (currently `{ key, name, key_code? }`) with the consumable descriptor fields (all `#[serde(default)]`, camelCase): `type_: Option<String>` (serde `rename = "type"`), `stat: Option<String>`, `modifier: Option<i64>`, `usable: Option<bool>`, `destroyable: Option<bool>`, and `recipe: Option<toml::Value>` (the inert crafting map — include ONLY if the oracle's item needs it; see Step 3). Add to the `Behaviors` struct: `#[serde(default)] pub item: BTreeMap<String, ItemBehaviorEntry>`, with `ItemBehaviorEntry { on_use: Option<String>, on_read: Option<String> }` (statement-block strings; camelCase + `deny_unknown_fields`). Keep `deny_unknown_fields` on `ItemEntry`.

Add a unit test that a consumable `[[items]]` entry + `[behaviors.item.<key>]` parses into the new fields. Run `cargo test -p wickedways-author author_doc::` → PASS.

- [ ] **Step 2: Read the item-authoring patterns**

Run: `sed -n '1,60p' packages/campaigns/src/hollow-house/items.ts` (the consumable item factory — how a `type:"consumable"` item incl. its `recipe` is built) and inspect how `laudanum` + its `s.item({onUse})` twin are authored (`packages/campaigns/src/hollow-house/scripted.ts` — the laudanum script) and how a fixture emits an item catalog (`conformance/fixtures/g2-vault.gen.test.ts`). Confirm `s.item`, `s.emit`, `s.adjustStat` exist in `packages/campaigns/src/scripted/builders.ts`; add any missing (thin sugar over the serde JSON — `adjustStat` takes `(target, stat, delta)`).

- [ ] **Step 3: Author the `g2-item` TS twin**

Create `conformance/fixtures/g2-item.gen.test.ts` (modeled on `g2-vault.gen.test.ts`): a small ASCII campaign (1 room, PC `Ada`) declaring a **usable consumable** item (via the real consumable factory, e.g. a laudanum-style `type:"consumable"`, `usable:true`, `stat:"sanity"`, `modifier:6`) registered under a key, with a `s.item({ onUse: [ s.emit(s.adjustStat(s.actor, "sanity", s.lit(6))) ] })` behavior under the SAME key. Emit `g2-item.{description,catalog}.json` (stripRng / catalogFromRegistry) + `g2-item.genesis.json` (seated `player:Ada`, pre-begin). Register in `vitest.config.ts`.

**Keep the oracle inside the slice subset:** the item's `onUse` uses only `adjustStat` (positive delta); no other effect, no `onRead` unless it also uses only `adjustStat`. Choose the item so its descriptor is expressible by the Step-1 surface — if its `recipe` is author-data the surface must carry it, add the `recipe` field and author it in the TOML twin; if `recipe` is factory-derived per kind, `lower_item` fills it (Task 3) and the surface omits it. Read the factory to decide.

- [ ] **Step 4: Generate + guardrail**

Run: `pnpm run fixtures:gen`. Confirm (paste in your report) the `g2-item.catalog.json` `items[<key>]` descriptor (`type:"consumable"`, `usable:true`, …) and the `behaviors[<key>]` = `{"family":"item","script":{"onUse":[{emit adjustStat ...}]}}`. Confirm genesis pre-begin.

Run: `git status --short conformance/fixtures/ | grep -v '^??' | grep -E '\.genesis\.json$|\.snapshot\.json$|\.golden\.json$' && echo "EXISTING ORACLE CHANGED - STOP" || echo "no existing oracle changed OK"`
Expected: `no existing oracle changed OK`. Then `pnpm run fixtures:stable` → PASS.

- [ ] **Step 5: Author the TOML twin**

Create `conformance/fixtures/g2-item.toml`: the `[[items]]` consumable (key/name/type/stat/modifier/usable/destroyable + recipe if authored) + `[behaviors.item.<key>]` `onUse = "emit adjustStat(actor, sanity, 6)"`. ASCII only. Same key for item + behavior.

- [ ] **Step 6: Gate the oracle through the assembler**

Add `g2-item` to `crates/wickedways-assemble/tests/goldens.rs` (single-PC pre-begin, `Seat { name:"Ada", archetype: None }` — confirm from genesis). Run `cargo test -p wickedways-assemble --test goldens g2_item` → PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/wickedways-author/src/author_doc.rs conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): g2-item oracle fixture (TS twin) + consumable item surface"
```

---

## Task 3: Item lowering → byte-parity on `g2-item`

**Files:**
- Modify: `crates/wickedways-author/src/lower.rs`, `crates/wickedways-author/tests/gate.rs`

**Interfaces:**
- Consumes: `author_doc` item structs, `stmt::parse_stmts`, `wickedways_core::world::descriptor::ItemDescriptor`, `wickedways_core::script::ast::{BehaviorScript, ItemScript}`.
- Produces: a consumable `ItemDescriptor` + `BehaviorScript::Item` in the lowered outputs.

- [ ] **Step 1: Add the failing gate tests**

Add to `tests/gate.rs` (reuse the existing `fixtures()`/`read()`/`assert_json_eq` helpers):

```rust
#[test]
fn g2_item_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-item.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-item.description.json"))).unwrap(),
        "g2-item.description.json");
}

#[test]
fn g2_item_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-item.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-item.catalog.json"))).unwrap(),
        "g2-item.catalog.json");
}
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author --test gate g2_item`
Expected: FAIL — consumable items + item behaviors aren't lowered yet (`lower_item` still produces a key descriptor; no item behaviors).

- [ ] **Step 3: Implement item lowering**

In `lower.rs`:
- **`lower_item` branch:** if `key_code` is Some → the existing key descriptor (unchanged). Else (a consumable) → build the `ItemDescriptor` from the surface `type`/`stat`/`modifier`/`usable`/`destroyable`(+`recipe`) with the inert fields (`teaches`/`immunities`/`grantsImmunity` = null) and `properties` (`equippable:false, equipped:false, destroyable, usable`). The committed `g2-item.catalog.json` `items[<key>]` is the exact target — read it + `crates/wickedways-core/src/world/descriptor.rs` `ItemDescriptor` for the exact fields, and read the consumable factory (Task 2 Step 2) for any kind-derived default (e.g. `recipe`).
- **Item behavior:** for each `behaviors.item.<key>` → `BehaviorScript::Item { script: ItemScript { on_use: on_use.map(parse_stmts).transpose()?, on_read: on_read.map(parse_stmts).transpose()? } }`, keyed by `<key>` (shares the item key). Read `ast.rs` for the exact `ItemScript`/`BehaviorScript::Item` shape.
Iterate against the gate's first-diff until BOTH halves byte-match.

- [ ] **Step 4: Run both gates + the full suite**

Run: `cargo test -p wickedways-author`
Expected: PASS — the two g2-item gates + ALL prior tests (g2-vault, g2-scene, determinism, parser).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower consumable items + item onUse/onRead (byte-parity)"
```

---

## Task 4: Determinism, hygiene, documentation, and carried cleanups

**Files:**
- Modify: `crates/wickedways-author/tests/gate.rs`, `crates/wickedways-author/src/lib.rs`, `README.md`

- [ ] **Step 1: Determinism over the item fixture**

Add to `tests/gate.rs` a test that `compile(g2-item.toml)` twice → byte-identical (mirror the existing determinism tests). Run: `cargo test -p wickedways-author --test gate` → PASS.

- [ ] **Step 2: Hygiene audit**

Run:
```bash
cd crates/wickedways-author
! grep -rnE "\bHashMap\b|\bHashSet\b" src/ && echo "no HashMap/HashSet ✓"
! grep -rnE "\.unwrap\(\)|panic!|todo!|unimplemented!" src/ && echo "no panics in src ✓"
cd ../..
```
Expected: two ✓ lines (`.expect(` only as the parser's `Result`-returning method + `#[cfg(test)]`).

- [ ] **Step 3: Carried cleanups (from prior slice reviews)**

Refresh two now-stale doc comments: `crates/wickedways-author/src/lib.rs` (the `compile()` comment "Lowering … lands in Tasks 4-5" — lowering shipped in the MVP) and the header in `crates/wickedways-author/tests/gate.rs` ("the CATALOG half lands in Task 5"). Make them describe current reality.

- [ ] **Step 4: Verify the full local gate**

Run: `cargo test --workspace && pnpm run fixtures:stable && pnpm run bindings:check`
Expected: all PASS, 0 failed, 0 ignored.

- [ ] **Step 5: Document in the README**

Extend the `wickedways-author` section: the `adjustStat` effect (`emit adjustStat(target, stat, delta)`, stat ∈ sanity/health/energy); that consumable items (`[[items]]` with a `type` + `[behaviors.item.<key>]` `onUse`/`onRead`) are now authorable and gated by `g2-item`; the deliberate scope (only `Cue`+`AdjustStat` effects; `Heal`/other effects + `Pass`/`SetStateIn` + npc/mechanic families still rejected and deferred).

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/tests/gate.rs crates/wickedways-author/src/lib.rs README.md
git commit -m "test+docs(author): item determinism gate + adjustStat/items docs"
```

---

## Deliberate scope boundaries (recorded so a reviewer doesn't mistake them for gaps)

- **Only `Cue` + `AdjustStat` effects.** `emit heal(...)` and the other five effects are rejected — each lands with the family/fixture that exercises it.
- **`Pass`, `SetStateIn` still rejected** (exit-`runScript` / storyteller-mechanic slices).
- **Only the item family added.** npc/mechanic reuse this same `parse_stmts` in their own slices.
- **Item kinds:** key (MVP) + consumable (this slice). Other kinds land when a fixture needs them.

## Notes for the implementer

**The gate is the authority.** When the compiler's output and the `g2-item` fixture disagree, the compiler is wrong — fix `lower.rs`/the effect parser, never the fixture. If convinced the fixture uses a form this slice can't express, that's a Task 2 generator bug — fix the generator and regenerate, don't hand-edit.

**Two facts most likely to trip you up:**
1. An item and its `onUse` behavior share the SAME key — `catalog.items[k]` (descriptor, `usable:true`) and `catalog.behaviors[k]` (`BehaviorScript::Item`).
2. `adjustStat`'s stat argument is a **bare keyword** (`sanity`/`health`/`energy`) → `StatType` (lowercase serde), NOT an expression; only `target` and `delta` are expressions.
