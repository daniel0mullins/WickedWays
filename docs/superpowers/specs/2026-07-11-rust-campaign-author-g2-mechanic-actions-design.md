# Rust Campaign Author (G2) — Mechanic actions + modifyDamage design

**Date:** 2026-07-11
**Status:** design, implemented
**Predecessor:** G2 mechanic scaffolding (`docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mechanic-design.md`), merged via PR #62.

## Context

The mechanic scaffolding slice (#62) wired the `MechanicScript` AST — the `init` seed and the five
lifecycle hooks — proven on the real hollow-house `dread`. It deliberately stubbed the two remaining
`MechanicScript` members:

- `hooks.modify_damage` → hardcoded `None`,
- `actions` → hardcoded an empty `BTreeMap`,

and documented both as follow-on slices. **This slice lands exactly those two fields**, so the
mechanic family's `catalog` shape is complete.

No *committed* campaign mechanic uses either field (the hollow-house `dread`/`storyteller`/
`status-bar` are hooks-only), so — as with every G2 slice — the differential gate is a **bespoke
oracle**, `g2-mechanic-actions`, authored to exactly the new surface. Its runtime reference is the
conformance dread (`conformance/fixtures/dread-shadow.ts`), which is the one mechanic in the repo
that exercises both a `modifyDamage` cap and a budgeted `brace` action.

Worked reference (the target `catalog.behaviors["dread"].script`, new members only):
```json
"hooks": { "modifyDamage": {
  "kind":"ifElse",
  "cond":{"kind":"bin","op":"gt","left":{"kind":"get","of":{"kind":"damage"},"field":"amount"},"right":{"kind":"lit","value":3}},
  "then":{"kind":"final","expr":{"kind":"lit","value":3}},
  "else":{"kind":"value","expr":{"kind":"get","of":{"kind":"damage"},"field":"amount"}}
}},
"actions": { "brace": [
  {"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"You brace against the dread."}}},
  {"kind":"emit","effect":{"kind":"adjustStat","target":{"kind":"actor"},"stat":"sanity","delta":{"kind":"lit","value":1}}}
]}
```

## What the fields need

**`actions`** (`BTreeMap<String, Vec<Stmt>>`). Each action body is an ordinary effect/statement body
— identical in grammar to a lifecycle hook — so it reuses the existing `stmt::parse_stmts` and the
already-shipped `emit cue`/`emit adjustStat` forms with **no parser change**. The only new surface is
a `[behaviors.mechanic.<key>.actions]` TOML table (`BTreeMap<String, String>`), lowered key-by-key.

**`modify_damage`** (`Option<DamageBody>`). `DamageBody` is a small three-variant mini-AST distinct
from `Expr` and `Stmt`:
```
DamageBody := Value { expr: Expr }                 // pass-through; chain continues
            | Final { expr: Expr }                 // locks the amount; halts the chain
            | IfElse { cond: Expr, then: DamageBody, else: DamageBody }
```
It reads the incoming damage via the **`damage` expression subject** (`Expr::Damage`) — its
`.amount`/`.target` fields via the existing postfix `.field` (`Expr::Get`). Two small additions:

1. **The `damage` subject.** `resolve_subject` gains `"damage" => Expr::Damage` (joining
   `actor`/`party`/`round`/`maxRounds`). It is bound by the interpreter only inside a `modifyDamage`
   body; elsewhere it evaluates to `Null` (unchanged engine semantics).
2. **A `DamageBody` parser** (`damage_body::parse_damage_body`) with its own tiny grammar:
   ```
   body := `final` <expr>                 -> Final   (halting value)
         | <cond> `?` <body> `:` <body>   -> IfElse
         | <expr>                         -> Value
   ```
   `<cond>` is any boolean/comparison `Expr` (parsed by the existing `parse_expr`). The first
   top-level `?` opens the ternary; its matching `:` (tracked at ternary depth 0) ends the `then`
   branch, so the branches recurse and `a ? final X : b ? final Y : Z` chains right. Bracket-nested
   and single-quoted-string `?`/`:` are ignored. Panic-free: every failure is a `CompileError`.

### Authoring surface

`modifyDamage` is a single string on the `[behaviors.mechanic.<key>]` table; `actions` is a nested
table:
```toml
[behaviors.mechanic.dread]
init = {}
modifyDamage = "damage.amount > 3 ? final 3 : damage.amount"

[behaviors.mechanic.dread.actions]
brace = '''
  emit cue('You brace against the dread.')
  emit adjustStat(actor, sanity, 1)
'''
```

## The differential gate

A new `g2-mechanic-actions` oracle (a TS twin + committed `description`/`catalog`/`genesis` JSON +
the TOML twin) proves byte-parity, exactly as `g2-mechanic` did. It is a fresh oracle — the existing
`g2-mechanic` fixture (which asserts `actions: {}` and no `modifyDamage`) is left **untouched**. The
oracle carries the `onTurnStart` hook alongside the two new fields to prove hooks still lower
unchanged beside them. The genesis is the same single-PC, pre-begin, `state: {}` shape as
`g2-mechanic` (neither new field affects genesis — both live only in the catalog behavior).

## Scope boundaries (recorded so a reviewer doesn't mistake them for gaps)

- **Only `actions` + `modify_damage` + the `damage` subject.** No new *effect* is added: the oracle's
  `brace` and cap reuse `cue`/`adjustStat`. `Damage`/`Heal`/`GrantImmunity`/`Status` still reject.
- **The `modifyDamage` `cond` is a boolean/comparison `Expr`, not itself a ternary** (the first
  top-level `?` is taken to open the transform's ternary). The AST permits a ternary `cond`; the
  author grammar does not need it, and no committed transform uses one.
- **The storyteller/status-bar forms stay deferred** — `action`/`mapLit`/`has`/`lookup`/`stateGetIn`/
  `setStateIn`/`str`/`length`/`first`/`Status`/`Pass` — each is a follow-on mechanic slice.
- `compile()`'s signature is unchanged; no ts-rs binding changes (the `DamageBody` binding already
  exists from the AST's Task 7).
