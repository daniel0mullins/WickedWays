# Rust Campaign Author (G2) — Expression/effect surface completion design

**Date:** 2026-07-11
**Status:** design, implemented
**Predecessor:** G2 mechanic actions + modifyDamage (`docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-mechanic-actions-design.md`), merged via PR #64.

## Context

Six G2 slices wired the author's behavior families and most of the expression grammar, but a
tail of `Expr`/`Stmt`/`EffectTemplate` nodes stayed unimplemented — each rejected with a clear
`CompileError` rather than mis-lowered, "to land with the slice that exercises it." This design
lands **all** of that tail in one push, so every node of the closed AST is authorable and any
behavior the engine can interpret can be written in TOML. It is delivered as five focused slices,
each with its own bespoke `g2-*` byte-parity oracle (the established pattern).

Grounding: the union of the real hollow-house `storyteller` + `status-bar` mechanics and the three
victory conditions exercises every remaining *expression* form except `defined`; the doors exercise
the exit `runScript`/`pass` gap; and `damage`/`heal`/`grantImmunity` + `defined` (used by no
committed behavior) get a bespoke oracle.

## The five slices

### 1. Exit `runScript` + `Pass`  (oracle: `g2-door`)
The exit path lowered no statement body: `ExitBehaviorEntry` had no `runScript` field and `lower.rs`
hardcoded `run_script: Vec::new()`. Add the `runScript` field + wiring, and the `pass <expr>`
statement — gated to **script bodies** via a new `parse_script`/`allow_pass` split, so `pass` stays
rejected in effect/hook bodies (and threads through nested `when`). Proven on the real `doorScript`.

### 2. Storyteller forms  (oracle: `g2-storyteller`)
Add the `action`/`element` subjects; the calls `mapLit(k, v, …)` (an even-length alternating
key/value list → `MapLit`), `has(map, key)`, `lookup(map, key)`, `stateGetIn(field, key, default)`;
and the subscripted `set state.<map>[<key>] = <v>` (`SetStateIn`) statement — the assignment `=` is
found at bracket-depth 0 so a `[<key>]` subscript and RHS `==` aren't mistaken for it. Proven on the
real `storyteller` mechanic over a 1-entry lore map.

### 3. Status-bar forms  (oracle: `g2-status-bar`)
Add the single-argument calls `str(x)`, `length(x)`, `first(x)` (the `First` node — subscript still
lowers to `Index`, only `first(...)` produces `First`), the variadic `concat(…)`, and the `Status`
effect with a `field(label, value[, emphasis])` sub-grammar parsed in `parse_emit`. Proven on the
real `status-bar` mechanic (emphasis ternary ladder + Round concat).

### 4. Victory quantifiers  (oracle: `g2-victory`)
Add `some(list, pred)`, `every(list, pred)`, `includes(list, value)`. Proven on the three real
win/lose conditions. Win/lose conditions serialize in sorted (`BTreeMap`) key order — faithful to
the unordered TOML-table surface, so the oracle authors its `loseWhen`s sorted.

### 5. Remaining effects + `defined`  (oracle: `g2-effects`)
Add the `damage`/`heal`/`grantImmunity` emittable effects and the `defined(x)` expression. No
committed behavior uses them, so a bespoke `hex` mechanic emits all three behind a `defined` guard.

## Constraints held throughout

- **Byte-parity is the acceptance criterion** — each `g2-*.toml` compiles to committed
  `description`/`catalog` fixtures under the existing canonicalized gate; existing oracles untouched.
- **Panic-free on author input** — no `unwrap`/`expect`/`panic!` in `src/`. The new call arms use a
  const-generic `take_n::<N>` helper (arity via `TryFrom<Vec<_>>`, not `expect`).
- `compile()`'s signature is unchanged; no ts-rs binding changes (all target AST types already have
  bindings). The DSL gained thin `dmg*`/`DamageBody` sugar earlier; this batch adds no new builders.

## Scope boundaries (recorded, not gaps)

- **The one permissive divergence stands:** subscript `x[0]` always lowers to `Index`; only
  `first(x)` produces `First`. The oracles are authored to match.
- **`modifyDamage`'s `cond` is not itself a ternary** (unchanged from the previous slice).
- **What remains is packaging, not language surface:** id-derivation for `giveItem`/`setVisible` +
  computed dialogue responses, the full Hollow House re-author, npx/WASM CLI packaging, and
  runtime-load of a compiled campaign. None change `compile()`'s signature.
