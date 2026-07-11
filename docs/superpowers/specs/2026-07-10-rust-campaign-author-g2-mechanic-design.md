# Rust Campaign Author (G2) — Mechanic scaffolding design

**Date:** 2026-07-10
**Status:** design, approved for planning
**Predecessor:** G2 npc dialogue (`docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-npc-design.md`), merged via PR #61.

## Context

The scene/item/npc slices covered four of the five behavior families. The **mechanic** family
is the largest and, unlike the others, its real instances need many new expression/effect forms.
Grounding against the committed hollow-house mechanics shows:
- `dread` (`onTurnStart`): `guard !hasEquipped(actor,'lantern')` + `adjustStat(actor,sanity,-1)`
  — needs only **negative number literals** (`-1`) beyond what is shipped.
- `storyteller` (`onAction`): needs the `action` subject, `mapLit`/`has`/`lookup`, `stateGetIn`/
  `setStateIn`, chained `get`.
- `status-bar`: the `Status` effect (structured `FieldTemplate`s) + `str`/`length`/`first`.
- **No committed mechanic uses `modifyDamage`, `actions`, `Damage`, or `GrantImmunity`.**

So the mechanic family is decomposed into slices. **This slice is the first: the mechanic
*scaffolding*** — the `MechanicScript` AST (init + hooks) + the `[[mechanics]]` description-side +
negative number literals — proven on the real `dread`. The storyteller and status-bar forms are
their own follow-on mechanic slices; `modifyDamage` (the damage-fold sub-language) is exercised by
nothing committed and defers indefinitely.

Worked reference (the committed hollow-house `dread` — exact):
```json
// catalog.behaviors["dread"]
{"family":"mechanic","script":{"init":{},"hooks":{"onTurnStart":[
  {"kind":"guard","cond":{"kind":"not","expr":{"kind":"hasEquipped","of":{"kind":"actor"},"itemKey":"lantern"}}},
  {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},"stat":"sanity","delta":{"kind":"lit","value":-1}}}]}}}
// description mechanics: [{ "key": "dread" }]
```
Note `delta` is `{"kind":"lit","value":-1}` — a literal negative number, NOT `0 - 1`.

## Goal

Author a `dread`-style mechanic entirely in TOML — a `[[mechanics]]` declaration + a
`[behaviors.mechanic.<key>]` behavior with `init` + hook bodies — and compile it to a
byte-identical `MechanicEntry` + `BehaviorScript::Mechanic`, gated against a new `g2-mechanic`
TS-twin oracle.

## Decisions (settled during brainstorming)

1. **First mechanic slice = scaffolding on `dread`.** The `MechanicScript` AST (init + the 5
   hooks) + the `[[mechanics]]` description-side + negative number literals, reusing everything
   else (`guard`/`not`/`hasEquipped`/`adjustStat`). (Status-bar and the whole-family cuts were the
   larger alternatives.)
2. **Add negative number literals.** A prefix `-` immediately before a numeric literal produces a
   negative numeric `Lit` (`-1` → `Lit{Number(-1.0)}`); a `-` between operands stays subtraction.

## Non-goals (deferred to later slices)

- **`modifyDamage`** (the `DamageBody` value/final/ifElse sub-language) — no committed mechanic
  uses it; defers indefinitely.
- **`actions`** (the `BTreeMap<String, Vec<Stmt>>` custom-action map) — dread has none; add when a
  fixture uses one.
- **The storyteller forms:** `action` subject, `mapLit`, `has`, `lookup`, `stateGetIn`,
  `setStateIn` — the next mechanic slice.
- **The status-bar forms:** the `Status` effect (`FieldTemplate`s), `str`, `length`, `first` — a
  mechanic slice.
- **`Damage`/`Heal`/`GrantImmunity`** effects, `Pass` — rejected still; land with a fixture.
- Full Def coverage, id-derivation, Hollow House capstone, npx/WASM packaging.

`compile()`'s signature does not change.

## Architecture

Additions to `crates/wickedways-author`:
1. **`src/expr/parser.rs`/`lexer.rs` — negative number literals.** In a prefix/operand position, a
   `-` immediately followed by a numeric literal parses to a negative numeric `Expr::Lit`. A `-`
   between two operands remains the `Sub` `BinOp` (unchanged). No unary negation of non-numbers
   (there is no such AST node) — `-actor` errors.
2. **`src/mechanic.rs` (new) — the mechanic converter.** `to_mechanic_script(entry:
   &author_doc::MechanicBehaviorEntry) -> Result<MechanicScript, CompileError>`: `init` (a
   `toml::Value` → `serde_json::Value`, default empty object), `hooks` (each of the 5 optional hook
   strings → `Option<Vec<Stmt>>` via `parse_stmts`), `actions` empty (deferred), `modify_damage`
   None (deferred).
3. **`src/author_doc.rs` — the surface.** `[[mechanics]]` (`MechanicEntryToml { key, config? }`)
   and `[behaviors.mechanic.<key>]` (`MechanicBehaviorEntry { init?: toml::Value, on_round_start?:
   String, on_round_end?: String, on_turn_start?: String, on_turn_end?: String, on_action?:
   String }`). `AuthorDoc.mechanics`, `Behaviors.mechanic`.
4. **`src/lower.rs` — lowering.** `[[mechanics]]` → `MechanicEntry` (in
   `CampaignDescription.mechanics`); `[behaviors.mechanic.<key>]` → `BehaviorScript::Mechanic {
   script: to_mechanic_script(entry)? }`, keyed by `<key>`.

## Negative number literals (syntax)

| syntax | node | serde JSON |
| --- | --- | --- |
| `-1` (prefix, before a number) | `Lit{Number(-1.0)}` | `{"kind":"lit","value":-1}` |
| `a - 1` (between operands) | `Bin{Sub, a, 1}` | `{"kind":"bin","op":"sub",…}` (unchanged) |

## The mechanic surface (TOML)

```toml
[[mechanics]]
key = "dread"
# config optional

[behaviors.mechanic.dread]
init = { }                         # literal JSON state seed; default {} if omitted
onTurnStart = '''
  guard !hasEquipped(actor, 'lantern')
  emit adjustStat(actor, sanity, -1)
'''
# onRoundStart/onRoundEnd/onTurnStart/onTurnEnd/onAction all optional; actions + modifyDamage deferred
```

`[[mechanics]]` mirrors the description's `MechanicEntry { key, config? }`.
`[behaviors.mechanic.<key>]` mirrors `MechanicScript { init, hooks, actions }` — this slice fills
`init` + the five hooks; `actions` stays empty (`skip_serializing_if = "BTreeMap::is_empty"` →
omitted) and `modify_damage` stays `None`.

## The differential gate

A new `g2-mechanic` oracle fixture, same pattern as the prior slices:
1. A one-time **TS twin** (a `dread`-style mechanic — `s.mechanic({ init:{}, hooks:{ onTurnStart:
   [guard !hasEquipped(actor,'lantern'), emit adjustStat(actor,sanity,-1)] } })`, declared via
   `.useMechanic("dread")`) emits committed `g2-mechanic.{description,catalog,genesis}.json`. Stays
   inside the slice subset (only the shipped effects; the negative `-1` literal; no actions/
   modifyDamage/storyteller/status-bar forms).
2. `g2-mechanic.toml` authored in the new surface.
3. A `wickedways-author` test: `compile(g2-mechanic.toml)`'s description + catalog byte-match the
   committed oracle — proving both the `MechanicEntry` and the `BehaviorScript::Mechanic` (init +
   the `onTurnStart` hook, incl. the negative-literal `delta`) are reproduced node-for-node.

**The gate is the authority.** Never hand-edit a golden / fixture input / `canonical-json.ts`.
ASCII-only. **HAZARD:** the `wwauthor` bin writes `<stem>.json` beside its input — never run it
against the committed `g2-mechanic.toml`. Gate only through `gate.rs`.

## Testing

- **Unit — negative literals:** `-1`/`-1.5` → the negative `Lit`; `a - 1` still `Bin{Sub}`;
  `emit adjustStat(actor, sanity, -1)` → the `delta` `Lit{-1}`; `-actor` → error.
- **Unit — mechanic converter:** an `init` + `onTurnStart` entry → the exact `MechanicScript` JSON;
  `init` default `{}`; hooks omitted → absent; `actions` empty/omitted; `modify_damage` absent.
- **Unit — surface:** `[[mechanics]]` + `[behaviors.mechanic.<key>]` parses into the new structs.
- **Differential gate:** the `g2-mechanic` fixture (description + catalog byte-match).
- **Determinism:** compile twice → byte-identical.
- **Hygiene:** panic-free on author input; no `HashMap`/`HashSet`; `BTreeMap`-only.
- **CI:** the existing `cargo test -p wickedways-author` + `bindings:check` jobs cover it.

## Program context

engine core (#55) → G1 (#57) → G2 MVP (#58) → scene (#59) → item (#60) → npc (#61) → **G2 mechanic
scaffolding** [this slice] → follow-on mechanic slices (storyteller forms: action/mapLit/has/
lookup/stateGetIn/setStateIn; status-bar forms: Status effect + str/length/first; modifyDamage if
ever needed) → exit `runScript` [Pass] → full Def coverage → id-derivation → Hollow House TOML
capstone → npx/WASM packaging + runtime-load → A (Rust core) → B (sync) → C (server) → D (Dioxus)
→ E (chat/AV) → F (retire TS). Each slice is its own spec → plan → implementation cycle.
