# Rust Campaign Author (G2) — NPC dialogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `wickedways-author` with the `GiveItem`/`SetVisible` effects + a dialogue AST + the NPC surface, so an NPC (declaration + dialogue behavior) can be authored in TOML — gated byte-for-byte against a new `g2-npc` (caretaker-style) TS-twin oracle.

**Architecture:** Add `emit giveItem(...)`/`emit setVisible(...)` to the statement parser, plus an effects-only helper (reuse `parse_stmts`, require all `emit`). Add a dialogue converter (`NpcBehaviorEntry` → `NpcScript`): polymorphic `match` (string→`Exact` / `{fuzzy=[…]}`→`Fuzzy`), `response`→`Lit{Str}`, `effects`→`Vec<EffectTemplate>`, `once`. Lower `[[npcs]]`→`NpcDef` + `[behaviors.npc.<key>]`→`BehaviorScript::Npc`. Prove it with a `g2-npc` oracle.

**Tech Stack:** Rust 2021, the existing `wickedways-author` crate, `wickedways-core` (`EffectTemplate::{GiveItem,SetVisible}`, `NpcScript`/`DialogueEntry`/`DialogueMatch`, `Stats`), `wickedways-assemble` (`CampaignDescription`, `NpcDef`). TS side: the `vitest` conformance generators + the `s.*` scripted builders + the real Caretaker content.

**Spec:** `docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-npc-design.md` — read it. It is the authority.

## Global Constraints

Every task's requirements implicitly include this section.

- **The differential gate is the authority.** NEVER hand-edit a golden, a `*.description.json`/`*.catalog.json` fixture, or `conformance/canonical-json.ts` to force a pass. Regenerating via the real TS generator is legitimate; hand-editing is forbidden.
- **Byte-parity is the acceptance criterion** — `compile(g2-npc.toml)`'s description + catalog must equal the committed fixtures under the existing canonicalized `serde_json::Value` gate (`canon_numbers`/`assert_json_eq` in `crates/wickedways-author/tests/gate.rs`; do not weaken them).
- **The compiler is panic-free on author input.** NEVER `panic!`/`unwrap()`/`expect()` on author text in `src/` (the parser's `Result`-returning `expect` method + `#[cfg(test)]` excepted). Return `CompileError`.
- **`BTreeMap`/`BTreeSet` only**; no `HashMap`/`HashSet`; no `rand`/`uuid`.
- **This slice adds only the `GiveItem` + `SetVisible` effects** (beyond `Cue`/`AdjustStat`). `emit` of any OTHER effect (`Heal`/`Damage`/`GrantImmunity`/`Status`), and `Pass`/`SetStateIn`, MUST stay **rejected with a clear `CompileError`**. Only the npc family is added; mechanic untouched.
- **Dialogue `effects` bodies are `emit`-only.** A `guard`/`when`/`set`/`pass` statement inside an effects body is a `CompileError`.
- **`giveItem`/`setVisible` reference ids as literal `'…'` strings** (id-derivation is a separate deferred slice). **`response` is a plain string → `Lit{Str}`** (computed responses deferred).
- **The `g2-npc` oracle stays inside what this slice implements.** ASCII-only.
- `compile()`'s signature must not change.
- Work on branch `design/rust-campaign-author-g2-npc`. Never commit to `main`.

### The AST serde shapes (verbatim from `crates/wickedways-core/src/script/ast.rs`)

- `EffectTemplate::GiveItem { from: Expr, to: Expr, item: Expr }` → `{"kind":"giveItem","from":…,"to":…,"item":…}`.
- `EffectTemplate::SetVisible { target: Expr, visible: Expr }` → `{"kind":"setVisible","target":…,"visible":…}`.
- `DialogueMatch` (tag `kind`): `Exact { text }` → `{"kind":"exact","text":"…"}`; `Fuzzy { tokens }` → `{"kind":"fuzzy","tokens":[…]}`.
- `DialogueEntry { match_ (serde rename "match"): DialogueMatch, response: Expr, effects: Vec<EffectTemplate> (default []), once: bool (default false) }`.
- `NpcScript { description: String, default: DialogueEntry, dialogue: Vec<DialogueEntry> (default []) }`. `BehaviorScript::Npc` → `{"family":"npc","script":{…}}`.
- Description-side `NpcDef { name, stats: Stats, room?: Option<String>, behavior: String, holds: Vec<String> }` (read `crates/wickedways-assemble/src/description.rs` for exact optionality/defaults).

---

## File Structure

**Create:**
- `crates/wickedways-author/src/npc.rs` — the dialogue converter (`NpcBehaviorEntry` → `NpcScript`).
- `conformance/fixtures/g2-npc.gen.test.ts` — the TS-twin oracle generator.
- `conformance/fixtures/g2-npc.toml` — the NPC campaign in the new surface.

**Modify:**
- `crates/wickedways-author/src/stmt.rs` — `parse_emit` gains `giveItem`/`setVisible`; a `parse_effects` helper.
- `crates/wickedways-author/src/author_doc.rs` — `[[npcs]]` + `[behaviors.npc.<key>]` structs.
- `crates/wickedways-author/src/lib.rs` — `pub(crate) mod npc;`.
- `crates/wickedways-author/src/lower.rs` — npc lowering (`NpcDef` + `BehaviorScript::Npc`).
- `crates/wickedways-author/tests/gate.rs` — the `g2-npc` gate + determinism.
- `crates/wickedways-assemble/tests/goldens.rs` — gate `g2-npc` as a new single-PC pre-begin golden.
- `conformance/fixtures/vitest.config.ts` — register `g2-npc.gen.test.ts`.
- `README.md` — document npcs + the giveItem/setVisible effects.

---

## Task 1: The `GiveItem`/`SetVisible` effects + the `parse_effects` helper

**Files:**
- Modify: `crates/wickedways-author/src/stmt.rs`

**Interfaces:**
- Produces: `parse_stmts` compiles `emit giveItem(...)`/`emit setVisible(...)`; `stmt::parse_effects(src: &str, base: Span) -> Result<Vec<EffectTemplate>, CompileError>` (an `emit`-only block → the effects).

- [ ] **Step 1: Write the failing tests**

Add to the `stmt` test module in `src/stmt.rs`:

```rust
    #[test]
    fn emit_give_item_and_set_visible() {
        assert_eq!(s("emit giveItem('npc:X', actor, 'npc:X:item#0')\nemit setVisible('npc:X', false)"),
            serde_json::json!([
            {"kind":"emit","effect":{"kind":"giveItem",
                "from":{"kind":"lit","value":"npc:X"},"to":{"kind":"actor"},
                "item":{"kind":"lit","value":"npc:X:item#0"}}},
            {"kind":"emit","effect":{"kind":"setVisible",
                "target":{"kind":"lit","value":"npc:X"},"visible":{"kind":"lit","value":false}}}
        ]));
    }

    #[test]
    fn parse_effects_collects_emit_only() {
        let effs = parse_effects("emit giveItem('a', actor, 'b')\nemit setVisible('a', false)",
            Span { line: 1, col: 1 }).expect("parse");
        assert_eq!(serde_json::to_value(&effs).unwrap(), serde_json::json!([
            {"kind":"giveItem","from":{"kind":"lit","value":"a"},"to":{"kind":"actor"},"item":{"kind":"lit","value":"b"}},
            {"kind":"setVisible","target":{"kind":"lit","value":"a"},"visible":{"kind":"lit","value":false}}
        ]));
    }

    #[test]
    fn parse_effects_rejects_non_emit() {
        // guard/when/set/pass are not effects — an effects body must be emit-only.
        assert!(parse_effects("set state.x = 1", Span { line: 1, col: 1 }).is_err());
    }
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author stmt::emit_give stmt::parse_effects`
Expected: FAIL — `giveItem`/`setVisible` currently reject; `parse_effects` undefined.

- [ ] **Step 3: Implement**

In `parse_emit`, add arms: `giveItem` (3 expr args → `EffectTemplate::GiveItem { from, to, item }`), `setVisible` (2 expr args → `EffectTemplate::SetVisible { target, visible }`). Every other name still rejects. Add `pub(crate) fn parse_effects(src, base) -> Result<Vec<EffectTemplate>, CompileError>`: run `parse_stmts`, then for each `Stmt` require it be `Stmt::Emit { effect }` (else `CompileError::ExprParse`), collecting the `EffectTemplate`s. Read `ast.rs` for the exact `GiveItem`/`SetVisible` field names. Panic-free.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p wickedways-author stmt::`
Expected: PASS — the 3 new tests + all prior stmt tests.

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/stmt.rs
git commit -m "feat(author): giveItem/setVisible effects + parse_effects (emit-only block)"
```

---

## Task 2: The NPC surface schema + the dialogue converter

**Files:**
- Modify: `crates/wickedways-author/src/author_doc.rs`, `crates/wickedways-author/src/lib.rs`
- Create: `crates/wickedways-author/src/npc.rs`

**Interfaces:**
- Consumes: `stmt::parse_effects`; `wickedways_core::script::ast::{NpcScript, DialogueEntry, DialogueMatch, Expr}`, `wickedways_core::script::value::Value`.
- Produces: `AuthorDoc` npc structs; `npc::to_npc_script(entry: &author_doc::NpcBehaviorEntry) -> Result<NpcScript, CompileError>`.

- [ ] **Step 1: Write the failing tests**

Create `crates/wickedways-author/src/npc.rs` with ONLY this test module:

```rust
#[cfg(test)]
mod tests {
    use super::to_npc_script;
    use crate::author_doc::NpcBehaviorEntry;
    use serde_json::json;

    fn script_json(toml_src: &str) -> serde_json::Value {
        let entry: NpcBehaviorEntry = toml::from_str(toml_src).expect("toml");
        serde_json::to_value(to_npc_script(&entry).expect("convert")).expect("json")
    }

    #[test]
    fn default_exact_and_a_fuzzy_entry() {
        let v = script_json(r#"
            description = "A stooped caretaker."
            [default]
            match = ""
            response = "Take the key."
            once = true
            effects = "emit setVisible('npc:C', false)"
            [[dialogue]]
            match = { fuzzy = ["key", "cellar"] }
            response = "It opens the cellar."
        "#);
        assert_eq!(v, json!({
            "description":"A stooped caretaker.",
            "default":{
                "match":{"kind":"exact","text":""},
                "response":{"kind":"lit","value":"Take the key."},
                "effects":[{"kind":"setVisible","target":{"kind":"lit","value":"npc:C"},"visible":{"kind":"lit","value":false}}],
                "once":true},
            "dialogue":[{
                "match":{"kind":"fuzzy","tokens":["key","cellar"]},
                "response":{"kind":"lit","value":"It opens the cellar."},
                "effects":[],"once":false}]
        }));
    }
}
```

- [ ] **Step 2: Run to make sure it fails**

Run: `cargo test -p wickedways-author npc::`
Expected: FAIL — `NpcBehaviorEntry`/`to_npc_script` undefined.

- [ ] **Step 3: Write the surface structs (`author_doc.rs`)**

Add (camelCase, `deny_unknown_fields`):

```rust
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NpcEntry {
    pub name: String,
    pub stats: wickedways_core::world::snapshot::Stats,
    #[serde(default)] pub room: Option<String>,
    pub behavior: String,
    #[serde(default)] pub holds: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NpcBehaviorEntry {
    pub description: String,
    pub default: DialogueEntryToml,
    #[serde(default)] pub dialogue: Vec<DialogueEntryToml>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueEntryToml {
    #[serde(rename = "match")] pub match_: MatchToml,
    pub response: String,
    #[serde(default)] pub once: bool,
    #[serde(default)] pub effects: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(untagged)]  // string -> Exact, { fuzzy = [...] } -> Fuzzy. (deny_unknown_fields is
                    // NOT supported on untagged enums — do not add it here.)
pub enum MatchToml {
    Exact(String),
    Fuzzy { fuzzy: Vec<String> },
}
```

Add `#[serde(default)] pub npcs: Vec<NpcEntry>` to `AuthorDoc`, and `#[serde(default)] pub npc: BTreeMap<String, NpcBehaviorEntry>` to `Behaviors`. Add `pub(crate) mod npc;` to `lib.rs`.

Confirm `Stats` derives `Deserialize` (it does — read `snapshot.rs`) and its field shape (health/sanity/energy). **Gotcha:** `Stats`'s fields are `f64`; the `toml` crate may refuse to deserialize a bare TOML integer (`health = 1`) into an `f64`. If the `author_doc::` parse test fails on that, author stats as floats in the TOML (`{ health = 1.0, sanity = 1.0, energy = 1.0 }`) — and use the same float form in the `g2-npc.toml` (Task 3). Byte-parity is unaffected: the description serializes `Stats` as `f64` and `canon_numbers` reconciles `1.0`↔`1`.

- [ ] **Step 4: Write the converter (`npc.rs`, above the tests)**

```rust
use wickedways_core::script::ast::{DialogueEntry, DialogueMatch, Expr, NpcScript};
use wickedways_core::script::value::Value;

use crate::author_doc::{DialogueEntryToml, MatchToml, NpcBehaviorEntry};
use crate::error::{CompileError, Span};
use crate::stmt::parse_effects;

pub(crate) fn to_npc_script(entry: &NpcBehaviorEntry) -> Result<NpcScript, CompileError> {
    Ok(NpcScript {
        description: entry.description.clone(),
        default: to_entry(&entry.default)?,
        dialogue: entry.dialogue.iter().map(to_entry).collect::<Result<_, _>>()?,
    })
}

fn to_entry(e: &DialogueEntryToml) -> Result<DialogueEntry, CompileError> {
    Ok(DialogueEntry {
        match_: match &e.match_ {
            MatchToml::Exact(text) => DialogueMatch::Exact { text: text.clone() },
            MatchToml::Fuzzy { fuzzy } => DialogueMatch::Fuzzy { tokens: fuzzy.clone() },
        },
        response: Expr::Lit { value: Value::Str(e.response.clone()) },
        effects: match &e.effects {
            Some(src) => parse_effects(src, Span { line: 1, col: 1 })?,
            None => Vec::new(),
        },
        once: e.once,
    })
}
```

Confirm the exact `DialogueEntry`/`DialogueMatch`/`NpcScript` field names + `Value::Str` variant against `ast.rs`/`value.rs`; adjust if they differ (the test's serde JSON is the source of truth for the shape the gate needs).

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p wickedways-author npc:: author_doc::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/wickedways-author/src/npc.rs crates/wickedways-author/src/author_doc.rs crates/wickedways-author/src/lib.rs
git commit -m "feat(author): npc surface schema + dialogue converter (polymorphic match)"
```

---

## Task 3: The `g2-npc` oracle fixture

**Files:**
- Modify: `conformance/fixtures/vitest.config.ts`, `crates/wickedways-assemble/tests/goldens.rs`
- Create: `conformance/fixtures/g2-npc.gen.test.ts`, `conformance/fixtures/g2-npc.toml`

**Interfaces:**
- Produces: committed `g2-npc.{description,catalog,genesis}.json` (Task 4 targets) + `g2-npc.toml`.

- [ ] **Step 1: Read the NPC-authoring patterns**

Run: inspect the Caretaker content — `packages/campaigns/src/hollow-house/scripted.ts` (the `s.npc({...})` twin with `s.giveItem`/`s.setVisible`), `packages/campaigns/src/hollow-house/index.ts` (the `.npc(name, {...})` template call + the cellar-key item), and `conformance/fixtures/caretaker.gen.test.ts` / `g2-vault.gen.test.ts`. Confirm `s.npc`, `s.giveItem`, `s.setVisible`, `s.entry`/`s.exact`/`s.fuzzy` exist in `packages/campaigns/src/scripted/builders.ts`; add any missing (thin sugar over the serde JSON).

- [ ] **Step 2: Author the TS twin**

Create `conformance/fixtures/g2-npc.gen.test.ts` (modeled on `caretaker.gen.test.ts`): a small ASCII campaign (1-2 rooms, PC `Ada`) with a `cellar-key` **key item** (via `createKey`), an NPC (e.g. `Caretaker`) placed in a room `holds: ["cellar-key"]` via `.npc(...)`, backed by a `s.npc({ description, default: { match:"", response, once, effects:[giveItem('npc:Caretaker', actor, 'npc:Caretaker:item#0'), setVisible('npc:Caretaker', false)] }, dialogue:[ a fuzzy entry ] })` behavior keyed `caretaker`. Emit `g2-npc.{description,catalog}.json` (stripRng/catalogFromRegistry) + `g2-npc.genesis.json` (seated `player:Ada`, pre-begin). Register in `vitest.config.ts`.

**Stay in-subset:** only `giveItem`/`setVisible` effects; a `default` (Exact "") + at least one `Fuzzy` dialogue entry to exercise both match variants; the held item is a key (reuses the MVP key-item lowering).

- [ ] **Step 3: Generate + guardrail**

Run: `pnpm run fixtures:gen`. Paste in your report the `g2-npc.catalog.json` `behaviors["caretaker"]` (the Task 4 target — must show `description`, `default` with `giveItem`+`setVisible` effects, and the fuzzy `dialogue` entry) and the description's `npcs` `NpcDef` (name/stats/room/behavior/holds). Confirm genesis pre-begin.

Run: `git status --short conformance/fixtures/ | grep -v '^??' | grep -E '\.genesis\.json$|\.snapshot\.json$|\.golden\.json$' && echo "EXISTING ORACLE CHANGED - STOP" || echo "no existing oracle changed OK"` → OK (only new g2-npc.* files). `pnpm run fixtures:stable` → PASS.

- [ ] **Step 4: Author the TOML twin**

Create `conformance/fixtures/g2-npc.toml`: `[[items]]` cellar-key (keyCode) + `[[npcs]]` (name/stats/room/behavior/holds) + `[behaviors.npc.caretaker]` (description + `[default]` match ""/response/once/effects giveItem+setVisible + a `[[dialogue]]` fuzzy entry). ASCII only. Match the oracle exactly.

- [ ] **Step 5: Gate the oracle through the assembler**

Add `g2-npc` to `crates/wickedways-assemble/tests/goldens.rs` (single-PC pre-begin, `Seat { name:"Ada", archetype: None }` — confirm from genesis). Run `cargo test -p wickedways-assemble --test goldens g2_npc` → PASS.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures crates/wickedways-assemble/tests/goldens.rs
git commit -m "test(conformance): g2-npc oracle fixture (TS twin) + npc TOML surface"
```

---

## Task 4: NPC lowering → byte-parity on `g2-npc`

**Files:**
- Modify: `crates/wickedways-author/src/lower.rs`, `crates/wickedways-author/tests/gate.rs`

**Interfaces:**
- Consumes: `author_doc` npc structs, `npc::to_npc_script`, the MVP key-item lowering, `wickedways_assemble::description::NpcDef`, `wickedways_core::script::ast::BehaviorScript`.
- Produces: `NpcDef`s in the description + `BehaviorScript::Npc`s in the catalog.

- [ ] **Step 1: Add the failing gate tests**

Add to `tests/gate.rs` (reuse the existing helpers):

```rust
#[test]
fn g2_npc_description_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-npc.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.description).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-npc.description.json"))).unwrap(),
        "g2-npc.description.json");
}

#[test]
fn g2_npc_catalog_matches() {
    let dir = fixtures();
    let compiled = compile(&read(&dir.join("g2-npc.toml"))).expect("compile");
    assert_json_eq(&serde_json::to_value(&compiled.catalog).unwrap(),
        &serde_json::from_str(&read(&dir.join("g2-npc.catalog.json"))).unwrap(),
        "g2-npc.catalog.json");
}
```

- [ ] **Step 2: Run to make sure they fail**

Run: `cargo test -p wickedways-author --test gate g2_npc`
Expected: FAIL — npcs + npc behaviors not lowered.

- [ ] **Step 3: Implement npc lowering**

In `lower.rs`:
- **Description:** for each `AuthorDoc.npcs` entry → an `NpcDef { name, stats, room, behavior, holds }` pushed into `CampaignDescription.npcs`. Read `crates/wickedways-assemble/src/description.rs` for `NpcDef`'s exact fields (stats type, room/holds optionality/defaults). The held `cellar-key` item descriptor comes from the `[[items]]` key entry via the existing `lower_item` — no new item work.
- **Catalog:** for each `behaviors.npc.<key>` → `BehaviorScript::Npc { script: npc::to_npc_script(entry)? }`, keyed by `<key>`.
Iterate against the gate's first-diff until BOTH halves byte-match.

- [ ] **Step 4: Run both gates + the full suite**

Run: `cargo test -p wickedways-author`
Expected: PASS — the two g2-npc gates + ALL prior tests (g2-vault, g2-scene, g2-item, determinism, parser, npc).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/src/lower.rs crates/wickedways-author/tests/gate.rs
git commit -m "feat(author): lower npcs to NpcDef + BehaviorScript::Npc (byte-parity)"
```

---

## Task 5: Determinism, hygiene, and documentation

**Files:**
- Modify: `crates/wickedways-author/tests/gate.rs`, `README.md`

- [ ] **Step 1: Determinism over the npc fixture**

Add to `tests/gate.rs` a test that `compile(g2-npc.toml)` twice → byte-identical (mirror the existing determinism tests). Run: `cargo test -p wickedways-author --test gate` → PASS.

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

Extend the `wickedways-author` section: the `giveItem`/`setVisible` effects; that NPCs (`[[npcs]]` + `[behaviors.npc.<key>]` with a `default` + `dialogue` entries, polymorphic `match`) are now authorable and gated by `g2-npc`; that dialogue `effects` bodies are `emit`-only; that ids in `giveItem`/`setVisible` are literal strings (id-derivation deferred) and `response` is a literal string; the deferred scope (only `Cue`/`AdjustStat`/`GiveItem`/`SetVisible` effects; `Heal`/`Damage`/`GrantImmunity`/`Status` + `Pass`/`SetStateIn` + the mechanic family still rejected/deferred).

- [ ] **Step 5: Commit**

```bash
git add crates/wickedways-author/tests/gate.rs README.md
git commit -m "test+docs(author): npc determinism gate + dialogue/effects docs"
```

---

## Deliberate scope boundaries (recorded so a reviewer doesn't mistake them for gaps)

- **Only `GiveItem` + `SetVisible` added** (beyond `Cue`/`AdjustStat`). `Heal`/`Damage`/`GrantImmunity`/`Status` + `Pass`/`SetStateIn` still reject.
- **Ids are literal strings** in `giveItem`/`setVisible`; `response` is a literal string. Id-derivation + computed responses are their own later slices.
- **Only the npc family added.** The mechanic family is the final family slice.

## Notes for the implementer

**The gate is the authority.** When the compiler's output and the `g2-npc` fixture disagree, the compiler is wrong — fix the converter/lowering, never the fixture. If convinced the oracle uses a form the slice can't express, that's a Task 3 generator bug — fix the generator and regenerate, don't hand-edit.

**Two facts most likely to trip you up:**
1. `DialogueEntry.match_` serializes as `"match"` (serde rename); `MatchToml` is `#[serde(untagged)]` so a TOML string deserializes to `Exact` and a `{ fuzzy = […] }` table to `Fuzzy`.
2. A dialogue `effects` body is `emit`-only: `parse_effects` runs `parse_stmts` and rejects any non-`Emit` statement — the entry's `effects` is a `Vec<EffectTemplate>`, not `Vec<Stmt>`.
