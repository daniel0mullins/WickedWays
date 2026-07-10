# Rust Campaign Author (G2) — MVP design

**Date:** 2026-07-10
**Status:** design, approved for planning
**Predecessor:** G1 (`docs/superpowers/specs/2026-07-09-rust-campaign-assembler-design.md`), merged via PR #57.

## Context

G1 shipped `wickedways-assemble::assemble(desc, catalog, party) -> CampaignSnapshot` — a
Rust port of the TS assembler that reproduces every pre-begin genesis golden byte-for-byte
from two JSON inputs: a `CampaignDescription` and a `Catalog`. Today those two inputs are
produced by hand-written TypeScript: a fluent `TemplateBuilder` (the description) plus a
`CampaignRegistry` of closures exported via `catalogFromRegistry` (the catalog), and — for
every behavior — a second, byte-identical `BehaviorScript` "DSL twin" so the Rust engine can
interpret it.

**The pain (worked example: `packages/campaigns/src/hollow-house/`):**
- **Two-twins duplication.** Every door / mechanic / victory / NPC behavior is written
  twice — once as a TS closure (the assembler oracle) and once as a `BehaviorScript`
  (`scripted.ts`), with comments begging them not to drift ("MUST be byte-identical or the
  differential gate diverges").
- **Verbose AST-by-hand.** Victory conditions are deep `s.and(s.eq(s.get(s.get(...))))`
  trees; status emphasis is nested `s.ifElse(...)`. An infix expression collapses these.
- **Hand-pinned magic ids.** `"npc:Caretaker:item#0"` etc. are literal strings the author
  keeps in sync with the assembler's id scheme.

G2 replaces hand-authored TS with a **plaintext (TOML) campaign-authoring surface + a small
expression language**, compiled to the exact `description.json` + `catalog.json` that
`assemble()` already consumes.

## Goal (this spec: the G2 MVP)

A **vertical MVP**: author one small campaign — a few rooms, one keyed door, one victory
condition — entirely in TOML + the expression language, compile it with a new **Rust** crate
to `description.json` + `catalog.json`, and gate those byte-for-byte against a committed
oracle fixture. This de-risks the hard part (the expression language) end-to-end on a
real-but-small campaign before broadening coverage.

## Decisions (settled during brainstorming)

1. **Vertical MVP first**, not horizontal layers or one big spec. The MVP is a thin
   end-to-end slice; breadth (all Def types, all six behavior families, Hollow House) comes
   in follow-on specs.
2. **Rust hosts the compiler.** The `BehaviorScript` AST and the `CampaignDescription` serde
   types already live in Rust, the runtime-modding target is Rust's `Authority` consuming
   JSON directly, and the program's north star is retiring TS (phase F). TS-hosting was
   rejected: it perpetuates TS and would be rewritten later.
3. **Infix, JS-like expression language.** `&&`/`||`/`==`/`<=`, dotted field access, function
   calls, ternary — readable, matches the AST's JS-truthiness semantics, familiar to the
   team. S-expression and AST-as-TOML were rejected (less readable / negligible win over the
   current builders).

## Non-goals (explicitly deferred to later G2 specs)

- Statement / effect bodies: `Guard`, `When`, `SetState`, `SetStateIn`, `Emit`, `Pass`, and
  all `EffectTemplate`s. The MVP compiles **expressions only** (`Expr`), which is all a keyed
  door's `canPass` and a victory `test` need.
- The other four behavior families: `mechanic` (hooks + `modifyDamage` + actions), `item`
  (`onUse`/`onRead`), `npc` (dialogue), `scene` (`canPlay`/`onEnter`/`onExit`).
- Full Def coverage: archetypes, formation weights, materials tables, and the long-tail
  mob/npc fields.
- Id-derivation for script references (e.g. `giveItem` resolving to a minted `npc:…:item#0`).
- **npx / WASM packaging and runtime-load / modding.** The MVP ships a Rust `compile()` lib
  + a thin `[[bin]]`; distribution is a later spec.
- The full Hollow House re-author (the eventual capstone that proves the whole surface).
- Editor / LSP tooling (syntax highlighting, compile-check).
- The G1-deferred `UnregisteredRecipe` validation (rides along whenever recipes enter the
  TOML surface).

## Architecture

**New leaf crate `crates/wickedways-author`**, depending on `wickedways-core` (the
`BehaviorScript`/`Expr` AST + serde types) and `wickedways-assemble` (`CampaignDescription`,
`Catalog`). One public entry point:

```rust
pub fn compile(toml_src: &str) -> Result<CompiledCampaign, CompileError>;

pub struct CompiledCampaign {
    pub description: CampaignDescription, // wickedways_assemble
    pub catalog: Catalog,                 // wickedways_core::world::descriptor
}
```

Compile pipeline — pure and **panic-free** (this is the modding trust boundary; author text
is untrusted):

1. **Parse TOML → `AuthorDoc`.** Serde structs for the friendly surface schema. The
   declarative parts (rooms, exits, mobs, loot, victory keys, …) deserialize almost directly
   because the target `CampaignDescription` types already exist in Rust. Use a standard Rust
   TOML crate (`toml`), which yields line/col spans on parse errors.
2. **Parse expressions.** A small **Pratt parser** turns each expression string (`canPass`,
   `test`, …) into the closed `Expr` AST, carrying source spans.
3. **Validate & lower.** Check every expression against the closed AST vocabulary (known
   subjects / functions / fields; reject anything that cannot map); split `AuthorDoc` into the
   two outputs — the `CampaignDescription` (names + keys) and the `Catalog` (items, the
   compiled `behaviors` map, formations, recipes, aliases).
4. **Emit.** Serialize both to JSON via the **same serde types G1 uses**, so field ordering,
   number formatting (`format_js_number`), and `BTreeMap` ordering match byte-for-byte.

A thin `[[bin]]` (`campaign.toml` in → `description.json` + `catalog.json` out) rides on
`compile()` for the MVP.

## The TOML surface (MVP)

A complete MVP campaign — exercises rooms, a keyed door, one item, loot placement, and a
victory; nothing more:

```toml
title = "Vault"
startRoom = "Hall"

[[rooms]]
name = "Hall"
description = "A cold stone hall."
[[rooms]]
name = "Vault"
description = "The vault beyond."

[[exits]]
from = "Hall"
to = "Vault"
direction = "north"
behavior = "vault-door"          # references [behaviors.exit.vault-door]

[behaviors.exit.vault-door]
canPass     = "hasKey(actor, 'vault')"
failMessage = "The vault door is locked."
passMessage = "The lock yields."

[[items]]
key = "vault-key"
name = "Vault Key"
keyCode = "vault"

[[loot]]
name = "shelf"
room = "Hall"
items = ["vault-key"]

[victory.win.reached-vault]
test = "party[0].room.name == 'Vault'"
narration = "You reached the vault."
```

Notes:
- The description holds **names and keys** (room names, item keys, behavior keys); `assemble`
  derives ids at assembly time, so the TOML author never writes minted ids.
- `behaviors.exit.<key>` compiles to a `BehaviorScript::Exit { canPass, runScript,
  passMessage, failMessage }`. For the MVP, `runScript` is empty (a keyed door needs only
  `canPass` + messages); statement bodies are deferred.
- `victory.win.<key>` / `victory.lose.<key>` compile to a `BehaviorScript::Victory { test }`
  in the catalog behaviors, plus a `winConditions`/`loseConditions` entry (key + narration) in
  the description — matching how the TS twin authors the two halves.
- `items` entries compile to `ItemDescriptor` catalog entries, reproducing
  `itemToCatalogEntry`'s output (name/type/stat/modifier/properties + `keyCode`/`consumeOnUse`
  for keys + the required inert fields).

## The expression language (MVP subset)

The MVP parses **expressions only** — the grammar needed by `canPass` (`Expr`) and victory
`test` (`Expr`):

- **Literals:** `'string'`, numbers, `true` / `false`.
- **Subjects:** `actor`, `party`, `round`, `maxRounds` → `Expr::Actor` / `Party` / `Round` /
  `MaxRounds`.
- **Indexing:** `party[0]` → `Expr::Index`. **Field access:** `.room`, `.name`,
  `.stats.health` → `Expr::Get { of, field }` (chained).
- **Calls:** `hasKey(x, 'code')`, `hasItem(x, 'key')`, `hasEquipped(x, 'key')` →
  `Expr::HasKey` / `HasItem` / `HasEquipped`.
- **Operators:** `== != < <= > >= && || + - * /` → `Expr::Bin { op }`; `!` → `Expr::Not`;
  ternary `c ? a : b` → `Expr::IfElse`.

Semantics mirror the AST's totality rule (missing views / OOB / ill-typed reads yield `Null`,
never panic) — but that is the **runtime's** concern; the compiler's job is only to emit the
correct AST node. Precedence follows JS (ternary < `||` < `&&` < equality < comparison <
additive < multiplicative < unary < postfix `[]`/`.`/call).

The remaining `Expr` vocabulary the AST supports but the MVP does **not** yet surface
(quantifiers `Some`/`Every`, `StateGet`/`StateGetIn`, `Lookup`/`Has`, `Concat`, `Length`,
`Includes`, `Defined`, `Damage`/`Element`, etc.) is added as later families need it. The
grammar is designed to extend to them without breaking existing syntax.

## Error handling

`compile()` returns `Result<_, CompileError>`; it never panics on author input. `CompileError`
is an enum, each variant carrying a **source span (line/col)** mapped back through the embedded
expression string to the TOML line:

- `TomlParse` — malformed TOML (span from the `toml` crate).
- `ExprParse` — bad expression syntax (unexpected token, unbalanced parens).
- `UnknownReference` — unknown function, subject, or field.
- `TypeError` — a shape the AST cannot express (e.g. indexing a non-list subject).
- `UnresolvedKey` — an `exit.behavior` (or victory key) referencing a behavior not defined.

Good, spanned error messages are a core value proposition (they are what a modder sees), so
they are tested explicitly, not just the happy path.

## The differential gate

The MVP reuses G1's conformance machinery. G1's `wickedways-assemble` gate already reads
`description.json` + `catalog.json` and asserts the assembled genesis matches a golden. So the
tightest G2 gate is: **`compile(toml)` → `description.json` + `catalog.json` must byte-match a
committed oracle fixture's two inputs** (via `serde_json::Value` equality plus the same
whole-float→int `canon_numbers` normalization G1 uses). If the inputs match, genesis parity
follows for free from the existing assemble gate.

No existing fixture pairs a keyed door with a victory in a small package, so the MVP adds one
oracle fixture, `g2-vault`:

1. A one-time **TS twin** in the conformance generator (the proven `TemplateBuilder` + `s.*`
   behavior builders) emits committed `g2-vault.description.json` + `g2-vault.catalog.json`
   (+ genesis golden). This is the *oracle* — every conformance fixture has one; it is **not**
   ongoing two-twins authoring. Real campaigns are TOML-only.
2. `g2-vault.toml` authored in the new surface.
3. A `wickedways-author` test: `compile(g2-vault.toml)`'s emitted description + catalog
   byte-match the two committed JSONs. This proves the compiler reproduces the proven TS
   path — including the door's `canPass` AST and the victory `test` AST.

The `g2-vault` oracle is deliberately authored **within the MVP's expressible subset**: a
`canPass`-only door (with `pass`/`failMessage` and an empty `runScript`) and a victory `test`
— no statement bodies or effects. Byte-parity with an expressions-only compiler is only
achievable if the oracle stays inside what the MVP can express; richer doors/behaviors arrive
with the statement-body spec.

**The gate is the authority.** Never hand-edit a golden / fixture input / `canonical-json.ts`
to force a pass; a divergence is a compiler bug. Regenerating a fixture by running the real TS
generator is legitimate; hand-editing one is forbidden.

## Testing

- **Unit — Pratt parser:** each operator and its precedence, calls, indexing, chained field
  access, ternary, string/number/bool literals, parenthesization.
- **Unit — validator:** unknown function / subject / field → spanned `UnknownReference`;
  index-of-non-list → `TypeError`; undefined behavior key → `UnresolvedKey`.
- **Unit — error spans:** a malformed expression reports the correct line/col.
- **Differential gate:** the `g2-vault` fixture (compiled description + catalog byte-match the
  committed oracle inputs).
- **Determinism:** compile twice → byte-identical output.
- **Hygiene:** no `panic!`/`unwrap()`/`expect()` on author input in `src/` (tests may use
  them); no `HashMap`/`HashSet`; `BTreeMap`/`BTreeSet` only; the compiler is total.
- **CI:** `cargo test -p wickedways-author` runs in the fast checks job (pure Rust, no
  wasm-pack/browser), beside G1's `cargo test -p wickedways-assemble`.

## Program context

The Rust re-authoring program: single-player engine (merged, PR #55) → **G1 campaign
assembler (merged, PR #57)** → **G2 authoring surface** [this MVP → broaden: all Def
coverage, all six behavior families, statements/effects, id-derivation, Hollow House capstone,
then npx/WASM packaging + runtime-load/modding] → A (Rust core party/turn order) → B (Rust
sync layer) → C (axum room server) → D (Dioxus client) → E (chat + A/V) → F (retire
TypeScript). This MVP is the first slice of G2; each subsequent slice is its own spec → plan →
implementation cycle.
