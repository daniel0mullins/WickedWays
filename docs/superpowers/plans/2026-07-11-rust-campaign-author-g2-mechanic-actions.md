# Rust Campaign Author (G2) — Mechanic actions + modifyDamage Implementation Plan

**Goal:** Fill in the two `MechanicScript` members the scaffolding slice (#62) stubbed —
`hooks.modify_damage` and `actions` — in `wickedways-author`, so a `dread`-style mechanic with a
damage cap and a budgeted `brace` action authors in TOML, gated byte-for-byte against a new
`g2-mechanic-actions` TS-twin oracle.

**Spec:** `docs/superpowers/specs/2026-07-11-rust-campaign-author-g2-mechanic-actions-design.md` —
the authority.

## Global Constraints

- **The differential gate is the authority.** Never hand-edit a golden/fixture to force a pass;
  regenerate via the real TS generator.
- **Byte-parity is the acceptance criterion** — `compile(g2-mechanic-actions.toml)`'s description +
  catalog must equal the committed fixtures under the existing canonicalized gate.
- **Panic-free on author input** — never `panic!`/`unwrap()`/`expect()` on author text in `src/`
  (the parser's `Result`-returning `expect` + `#[cfg(test)]` excepted). Return `CompileError`.
- **`BTreeMap`/`BTreeSet` only**; no `rand`/`uuid`.
- **This slice adds only** `actions`, `modify_damage`, and the `damage` expression subject. The
  `Damage`/`Heal`/`GrantImmunity`/`Status` effects, `Pass`/`SetStateIn`, and the storyteller forms
  (`action`/`mapLit`/`has`/`lookup`/`stateGetIn`/`str`/`length`/`first`) MUST stay
  unimplemented/rejected.
- **Never clobber the existing `g2-mechanic` oracle** — this is a NEW fixture.
- `compile()`'s signature must not change; no ts-rs binding changes.

## Tasks (all complete)

### Task 1 — the `damage` expression subject
- `expr/parser.rs`: `resolve_subject` gains `"damage" => Expr::Damage`; update the module doc.
- Tests (`expr/mod.rs`): `damage` resolves; `damage.amount` → `Get`; `damage.amount > 3` → `Bin`.

### Task 2 — the `DamageBody` parser
- New `src/damage_body.rs`: `parse_damage_body(src, base) -> Result<DamageBody, CompileError>`
  with the `final`/ternary/value grammar; top-level `?`/matching-`:` scanners tracking
  bracket/string state; `final` requires a whitespace boundary (so `finalize` is not the keyword).
- `lib.rs`: `pub(crate) mod damage_body;`.
- Tests: the dread cap, bare value, `final`-only, right-nested ternary, missing-`:` error, empty
  error, `finalize`-is-not-`final`.

### Task 3 — surface fields + converter
- `author_doc.rs`: `MechanicBehaviorEntry` gains `#[serde(default)] modify_damage: Option<String>`
  and `#[serde(default)] actions: BTreeMap<String, String>`.
- `mechanic.rs`: `to_mechanic_script` parses `modify_damage` via `parse_damage_body` and each
  `actions` body via `parse_stmts`; drop the `modify_damage: None`/`Default::default()` stubs.
- `lower.rs`: unchanged — it already routes mechanic behaviors through `to_mechanic_script`.
- Tests: converter emits the transform + the `brace` action; absent → empty map + absent transform.

### Task 4 — the `g2-mechanic-actions` oracle
- `packages/campaigns/src/scripted/builders.ts`: add `dmgValue`/`dmgFinal`/`dmgIf` `DamageBody`
  sugar (`damageSubject` already exists).
- `conformance/fixtures/g2-mechanic-actions.gen.test.ts`: a single-room, single-PC (`Ada`, no
  archetype) pre-begin oracle; a native registry twin (`initialState: () => ({})` + the
  onTurnStart/modifyDamage/brace closures) + the DSL twin carrying `modifyDamage` + `actions.brace`.
- `conformance/fixtures/g2-mechanic-actions.toml`: the TOML twin.
- Register in `conformance/fixtures/vitest.config.ts`; `pnpm run fixtures:gen` writes the committed
  `description`/`catalog`/`genesis` JSON.

### Task 5 — the gates
- `crates/wickedways-author/tests/gate.rs`: description + catalog byte-parity + determinism tests.
- `crates/wickedways-assemble/tests/goldens.rs`: the pre-begin single-PC genesis golden.

### Task 6 — docs + full local gate
- README: the mechanic section documents `modifyDamage` + custom `actions` + the `g2-mechanic-actions`
  gate; the scope paragraph moves both fields from "deferred" to "wired".
- Run `cargo test --workspace` + `cargo test -p wickedways-author` + `pnpm run bindings:check`
  (fixture stability confirmed for the new files).

## Deliberate scope boundaries

- Only `actions` + `modify_damage` + the `damage` subject; no new effect (the oracle reuses
  `cue`/`adjustStat`).
- `modifyDamage`'s `cond` is a boolean/comparison expr, not itself a ternary.
- The storyteller/status-bar forms remain follow-on slices.

## Notes for the implementer

- The `modifyDamage` `delta`/branch numeric literals serialize as whole floats; the gate's
  `canon_numbers` collapses them — assert with bare ints.
- **Two facts most likely to trip you up:** (1) `MechanicScript.actions` has no
  `skip_serializing_if`, so it always serializes (an empty map is `{}`); (2) `damage.amount` is
  `Get{ of: Damage, field: "amount" }` — the `damage` subject + postfix `.field`, not a call.
