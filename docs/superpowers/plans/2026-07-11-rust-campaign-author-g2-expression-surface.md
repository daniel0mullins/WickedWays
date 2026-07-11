# Rust Campaign Author (G2) — Expression/effect surface completion Plan

**Goal:** Land every remaining `Expr`/`Stmt`/`EffectTemplate` node in `wickedways-author` so the
closed AST is fully authorable, across five focused slices each gated byte-for-byte against a
bespoke `g2-*` oracle.

**Spec:** `docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-expression-surface-design.md`.

## Global constraints

- Byte-parity is the authority; never hand-edit a golden/fixture — regenerate via the TS generator.
- Panic-free on author input (no `unwrap`/`expect`/`panic!` in `src/`); `BTreeMap` only.
- Never clobber an existing oracle — every slice adds a NEW fixture.
- `compile()`'s signature and the ts-rs bindings are unchanged.

## Slices (all complete)

### Slice A — Exit `runScript` + `pass`
- `stmt.rs`: `parse_script`/`allow_pass` split; `pass <expr>` in script bodies; `when` threads
  `allow_pass`.
- `author_doc.rs`: `ExitBehaviorEntry.run_script`. `lower.rs`: wire via `parse_script`.
- Oracle `g2-door` (real `doorScript`). Gate: description/catalog/determinism + genesis golden.

### Slice B — Storyteller forms
- `parser.rs`: `action`/`element` subjects; `mapLit`/`has`/`lookup`/`stateGetIn` calls.
- `stmt.rs`: `set state.<map>[<key>] = <v>` → `SetStateIn`; `find_assignment_eq` (depth-0 lone `=`).
- Oracle `g2-storyteller` (real storyteller, 1-entry lore).

### Slice C — Status-bar forms
- `parser.rs`: `str`/`length`/`first`/`defined` (1-arg), `concat` (variadic).
- `stmt.rs`: `status(field(...), …)` + `parse_field` → `FieldTemplate`.
- Oracle `g2-status-bar` (real status-bar).

### Slice D — Victory quantifiers
- `parser.rs`: `some`/`every`/`includes`.
- Oracle `g2-victory` (3 real win/lose conditions; sorted key order).

### Slice E — Remaining effects + `defined`
- `stmt.rs`: `damage`/`heal`/`grantImmunity` emit arms (`defined` landed in Slice C's 1-arg block).
- `parser.rs`: refactor new call arms onto the const-generic `take_n::<N>` helper (panic-free).
- Oracle `g2-effects` (bespoke `hex` mechanic).

### Finalize
- README: mark the expression/effect/statement surface complete; extend the gate list; move the
  remaining work to "packaging, not language surface".
- Run `cargo test --workspace`, `pnpm run bindings:check`, `pnpm run fixtures:stable`, `pnpm checks`.

## Notes for the implementer

- Two gotchas that cost a cycle: (1) `Directions` has no `Up`/`Down` — an unknown direction is
  `undefined` in TS and silently omitted; use a real compass direction. (2) A disconnected room is
  pruned by the TS assemble but kept by Rust — don't add rooms the campaign doesn't reach; a victory
  `test` references a room *name* as a string literal, not a room.
- Win/lose conditions and mechanic `actions` serialize in sorted key order; author oracles to match.
