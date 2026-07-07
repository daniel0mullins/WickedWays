# Rust Engine — Scripted-Ops DSL (first-party authoring)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-06
**Branch:** `design/rust-engine-core`
**Master design:** [`2026-06-30-rust-engine-core-design.md`](./2026-06-30-rust-engine-core-design.md)
**Unblocks:** the parked [`2026-07-06-rust-engine-phase-2-single-player-cutover-design.md`](./2026-07-06-rust-engine-phase-2-single-player-cutover-design.md)

## Goal

Give the engine a small, purpose-built, deterministic **data-AST scripting language** so first-party
campaign ops (mechanics, exit behaviors, victory conditions) are authored as **sandboxed scripts
interpreted by the Rust core** instead of hand-written native Rust. Re-author Hollow House's ops as
scripts, gated byte-for-byte against the existing hand-written TypeScript ops. This dogfoods the
Tier-1 scripting path from the master design (a first-party-ergonomics alternative to the deferred
Rhai spike) and is the prerequisite that lets Hollow House boot on the Rust core, unblocking the
single-player cutover.

## Why now

The single-player cutover discovered that Hollow House **cannot boot on the Rust core**:
`validate_mechanics` throws `"Mechanic 'dread' is not registered."` because Phase 1 only shadowed the
real first-party ops with synthetic `conformance:*` natives; the real behaviors exist solely as TS
closures. Something must supply `dread`/`storyteller`/`status-bar`, the two doors, and the three
victory conditions to the Rust registry. The two ways to do that are hand-porting each op to native
Rust, or **authoring them as scripts run by an interpreter**. We choose the latter: it produces the
same gate-verified result, but the interpreter is reusable leverage for all future content and the
untrusted Tier-1 path, and dogfooding first-party content gives scripting a differential-gate safety
net (the existing TS closures are the oracle) that a from-scratch scripting layer would lack.

## Scope

**In scope (v1)**

- A closed, serde-serializable **value + expression + statement AST** in `wickedways-core`, plus a
  pure **deterministic interpreter**.
- Three **adapter ops** that satisfy the existing Phase-1 traits by interpreting a stored AST:
  `ScriptedMechanic` (`MechanicOp`), `ScriptedExit` (`ExitBehavior`), `ScriptedVictory`
  (`VictoryConditionBehavior`).
- **Catalog-hosted script table** (`Catalog.behaviors`) and a registry-resolution seam that resolves
  a behavior key to a native op *or* a scripted op.
- **Typed TS builder helpers** that emit the AST (the authoring surface), with the AST types
  generated from Rust via `ts-rs`.
- **Re-authoring Hollow House** as scripts: 3 mechanics, 2 exits, 3 victory conditions.
- Two prerequisite engine edges: **widen `ActionView`** to carry the move payload
  (`action.room.name`), and a **JS-faithful `num→string`** primitive.
- Differential fixtures diffing each scripted op against its hand-written TS oracle.

**Out of scope**

- **Formations.** Hollow House does not script encounters (`baseEncounterChance: 0`, no formations
  registered; Wraith/Revenant are fixed `.mob()` data). The `conformance:wraith` native shadow keeps
  its existing gate. No mob-record constructor in the DSL.
- **A text front-end / parser + the VS Code plugin.** v1 authors via typed builders that emit the AST
  directly. A textual syntax compiling *to* this AST, plus its editor tooling (syntax highlighting +
  compile-check diagnostics), is a **planned follow-on sub-project** — see [Follow-on: text DSL +
  editor tooling](#follow-on-text-dsl--editor-tooling). This spec's AST is deliberately designed as
  that front-end's stable compile target, so the follow-on redoes none of this work.
- **Untrusted-submission hardening** (content-hashing, authority-pinning, op-count/allocation limits
  for adversarial ASTs). The v1 AST is loop-free and closed, so it is bounded by construction, but
  the submission/verification flow for strangers is a later concern. This sub-plan targets *trusted
  first-party* authoring.
- **General variables/loops/recursion/user functions.** The language is loop-free by design; the only
  binding is the implicit quantifier element.
- Deleting the TS oracle closures — they remain the gate oracle until Phase 3.
- Rhai. This design supersedes the deferred sub-plan 6b for the first-party need.

## Invariants (inherited from the master design)

1. **The differential gate is the authority.** Divergences are fixed in the AST or the interpreter,
   never by editing goldens or `conformance/canonical-json.ts`.
2. **Determinism is a hard contract.** Same seed + same commands → byte-identical cues/snapshots on
   every target. The interpreter is pure: only the injected rng, no clock, deterministic iteration,
   f64 restricted to IEEE-754-identical operations.
3. **The core stays `no_std`-friendly.** `script/` is `alloc`-only; `cargo build -p wickedways-core
   --no-default-features` must pass.
4. **Boundary carries only serializable data.** The AST is serde/`ts-rs` data; nothing live crosses.
5. **Generated bindings are artifacts.** AST TS types come from `ts-rs`; `bindings:check` fails on
   drift.
6. **Scripts are pure functions.** A script reads a read-only view + injected rng and returns
   effects / a bool / an optional string; it never mutates engine state directly (the engine applies
   the returned effects) and can only touch its own JSON state.

## Architecture

A new module `wickedways-core/src/script/`:

| File | Responsibility |
|---|---|
| `value.rs` | `Value` — the closed runtime value type: `Number(f64)`, `Bool(bool)`, `Str(String)`, `List(Vec<Value>)`, `Null`. (Characters/rooms/action/damage are accessed via typed reads, not first-class values — see the read model.) |
| `ast.rs` | The closed `Expr`, `Stmt`, `EffectTemplate`, `FieldTemplate`, and `BehaviorScript` enums/structs (serde + `ts-rs`). |
| `eval.rs` | The interpreter: `eval_expr(&Expr, &Ctx) -> Value`, and body evaluators producing `Vec<Effect>` / `bool` / `Option<String>` / `TransformResult`. |
| `ops.rs` | `ScriptedMechanic` / `ScriptedExit` / `ScriptedVictory` adapters implementing the existing traits by delegating to `eval.rs`. |

**Nothing about effect application changes.** A scripted hook returns `Vec<Effect>` into the *existing*
collect-then-apply pipeline (per-mechanic 64-effect cap, `modify_damage` fold, `apply_effect`). The
DSL only produces effects; the engine still owns applying them.

### Script storage + registry resolution

Scripts are immutable authoring data, so they ride in the **`Catalog`** (alongside `items`/`aliases`),
extended with:

```
Catalog { items, aliases, behaviors: BTreeMap<String /*key*/, BehaviorScript> }

enum BehaviorScript {           // serde tag = "family"
  Mechanic(MechanicScript),     // init + per-hook bodies
  Exit(ExitScript),             // can_pass + run_script + messages
  Victory(VictoryScript),       // test
}
```

No `CampaignSnapshot` schema bump — behaviors are catalog data, passed to the World the same way
descriptors already are.

The dispatch sites (turn.rs hook fire-points, `go`'s exit check, `resolve_outcome`'s victory test)
currently call the static `*_behavior(key)`/`mechanic_op(key)` registries. They gain a **resolution
seam**: resolve a key against the static native registry first; on `None`, look it up in
`catalog.behaviors` and build the matching adapter op bound to that AST. Unknown on both →
`ProceduralViolation` (unchanged message shape). `validate_mechanics` extends to verify every
referenced key resolves *and* every scripted AST passes a static type/shape check — **fail fast at
load, never mid-turn.**

**Resolution-seam shapes (pinned during planning against the real traits).** Two of the three seams
can reuse the native trait for the scripted arm; victory cannot:

- **Mechanic / exit** — the scripted adapter (`ScriptedMechanic` / `ScriptedExit`) implements the
  existing `MechanicOp` / `ExitBehavior` trait, so the fire-points resolve to a `dyn Trait` either way.
- **Victory** — `VictoryConditionBehavior::test(&self, &CampaignView)` cannot carry the `World`/`Catalog`
  access the lazy `character.room` resolver needs. So `resolve_outcome` matches a `ResolvedVictory
  { Native(&'static dyn VictoryConditionBehavior), Scripted(&VictoryScript) }`: the native arm calls the
  trait unchanged; the scripted arm calls `ScriptedVictory::test(&view, world, cat)`. `ScriptedVictory`
  therefore does **not** implement the trait.

Because scripted resolution needs the `Catalog`, the wasm `replay_commands` entry point must parse the
catalog **before** calling `validate_mechanics` (today it validates first, at `lib.rs:92`, then parses
the catalog) — a reorder folded into the seam task.

## The language

### Value model

`Number(f64)`, `Bool`, `Str`, `List`, `Null`. Numbers are f64 to match TS `number` (stats/amounts are
already f64 in the core). Arithmetic and comparison are restricted to the IEEE-754 operations that are
bit-identical between Rust and JS (`+ − × ÷`, `== != < <= > >=`); no transcendentals.

### Expressions (closed set)

- **Literals:** `Lit(Value)`, and a literal map `MapLit(BTreeMap<String, Value>)` for static tables
  (e.g. lore).
- **Campaign reads:** `Round`, `MaxRounds`, `Party` (→ List of characters), `Length(list)`,
  `Index(list, i)`, `First(list)`.
- **Contextual subjects:** `Actor` (turn/action/exit contexts), `Action` (action context), `Damage`
  (modify-damage context). Field access via `Get(of, field)`.
- **Character reads** (`of` = a character subject): `Get(char, "sanity"|"energy"|"health")` → Number;
  `Get(char, "status")` → List of status strings; `Get(char, "roomId")` → Str|Null; `Get(char,
  "room")` → the resolved room subject (**lazy** — resolved from `room_id` on access, so nested
  `room.occupants[i].room` cannot build cyclic data); `HasEquipped(char, itemKey)`,
  `HasItem(char, itemKey)`, `HasKey(char, keyCode)` → Bool. (`HasKey` matches a key's `keyCode` —
  e.g. `"brass"`/`"iron"`, as the doors gate — distinct from `HasItem`'s `behaviorKey` match;
  `CharacterView` gains a `has_key(keyCode)` accessor over `inventory.key_ids`, which the current view,
  with only `has_equipped`/`has_item`, lacks.)
- **Room reads** (`of` = a room subject): `Get(room, "name"|"id")` → Str; `Get(room, "lit")` → Bool;
  `Get(room, "occupants")` → List of characters.
- **Action reads:** `Get(Action, "kind")` → Str; `Get(Get(Action, "room"), "name")` → Str (the
  widened move payload). Non-move actions yield `Null` for `room`.
- **State reads:** `StateGet(field, default)`; `StateGetIn(mapField, keyExpr, default)` for dynamic
  string-keyed maps. Missing → the supplied default (mirrors TS `??` / Rust `unwrap_or`).
- **Static-map ops:** `Lookup(mapExpr, keyExpr)` → Value|Null; `Has(mapExpr, keyExpr)` → Bool.
- **Logic/arithmetic:** `Bin(op, left, right)` (`op` ∈ add/sub/mul/div/eq/ne/lt/lte/gt/gte/and/or);
  `Not(expr)`; `Defined(expr)` (non-null check); `Includes(list, value)`.
- **Conditional:** `IfElse(cond, then, else)`.
- **Bounded quantifiers:** `Some(list, pred)`, `Every(list, pred)`; `pred` is an `Expr` that
  references the current element via the `Element` node — the language's *only* binding, bounded by
  list length. No general iteration.
- **Strings:** `Str(numExpr)` — JS-`Number.prototype.toString`-faithful; `Concat(Vec<Expr>)`.

### Statements + bodies

- **Predicate body** = one `Expr` → `bool` (used by `can_pass`, victory `test`, and every `cond`).
- **Effect body** = `Vec<Stmt>` → `Vec<Effect>` (mechanic hooks). Statements: `Guard(cond)`
  (early-return the accumulated effects if false), `When(cond, Vec<Stmt>)`, `SetState(field, expr)`,
  `SetStateIn(mapField, keyExpr, expr)`, `Emit(EffectTemplate)`.
- **Script body** = `Vec<Stmt>` → `Option<String>` (exit `run_script`): the same statement set plus
  `Pass(expr)` (sets the returned narration; last `Pass` wins; absent → `None`).
- **Modify-damage body** = `Expr` → `TransformResult`: evaluated to a Number, wrapped `Value(n)`
  unless a `Final(expr)` marker is used → `Final(n)` (halts the fold), matching the existing
  `TransformResult`.

`EffectTemplate` mirrors the closed `Effect` set: `Cue(textExpr)`, `AdjustStat(targetExpr, stat,
deltaExpr)`, `Status(Vec<FieldTemplate>)`, `Damage(targetExpr, amountExpr)`, `Heal(targetExpr,
amountExpr)`, `GrantImmunity(targetExpr, turnsExpr)`. `FieldTemplate { label: String, value: Expr,
emphasis: Option<Expr> }`. Emit order is preserved (contract-relevant: e.g. dread emits AdjustStat
before Cue).

### Adapter ops (the trait bodies)

```
MechanicScript { init: Expr, hooks: { onRoundStart?, onRoundEnd?, onTurnStart?, onTurnEnd?,
                                      onAction? : EffectBody,  modifyDamage? : ModifyDamageBody },
                 actions: BTreeMap<String, EffectBody> }   // custom run_action(key)
ExitScript    { can_pass: PredicateBody, run_script: ScriptBody,
                pass_message: Option<String>, fail_message: Option<String> }
VictoryScript { test: PredicateBody }
```

`init_state` evaluates `init` once to seed the mechanic's JSON `Value` state. A missing hook is a
no-op (returns `[]` / identity), exactly like the defaulted trait methods.

## Authoring surface (TS builders)

Typed helpers in the campaign-authoring layer build the AST; they read almost exactly like the current
TS closures (making re-authoring near-mechanical and easy to gate). Authors compose freely with
ordinary TS functions — the emitted AST is fully inlined, flat data. The builder output type is the
`ts-rs`-generated `BehaviorScript`, so authoring and interpretation share one source of truth. The
eight Hollow House ops (3 mechanics, 2 exits, 3 victory conditions) are re-authored to reproduce their
existing hand-written TS closures — `packages/campaigns/src/hollow-house/{mechanics,status,content,
index}.ts` — **exactly**; those closures are the authoritative behavior and the fixtures' oracle.

## Read model (what a script sees)

- **CharacterView** gains a **lazily-resolved `room`** accessor → the existing gate-faithful
  `RoomView { id, name, lit, occupants }`. Reached via a character (`actor.room`, `party[i].room`) —
  the global `CampaignView.rooms` list stays empty (unchanged mechanic contract). This matches how TS
  ops reach a room (`pc.currentRoom`) and how TS victory reads the live campaign.
- **`ActionView` widens** from `{ kind }` to carry the move payload so `Get(Get(Action,"room"),
  "name")` resolves — a prerequisite the storyteller op needs regardless of the DSL. Other action
  kinds keep `room = Null`.
- The closed **Effect** set and `TransformResult` are reused unchanged.

## Determinism specifics

- f64 limited to `+ − × ÷` + comparisons (bit-identical Rust/JS); no transcendentals.
- Deterministic iteration only: `List` (ordered `Party`/`occupants`), `MapLit`/state maps are
  `BTreeMap`.
- rng only via the injected stream (available in hook contexts, matching TS `HookCtx.rng/roll`).
- **`Str(number)` must match JS `Number.prototype.toString`** (e.g. `16.0 → "16"`, `2.5 → "2.5"`) —
  the single genuinely tricky primitive, since Rust's default float formatting differs. The
  implementation must be validated against a JS oracle in the gate (status-bar's string fields cross
  the comparator as *strings*, so byte-exactness is load-bearing). This is the design's top
  implementation risk.
- Missing reads return the declared default / `Null`, never panic.

## The gate

Methodology unchanged: the **existing hand-written TS closures are the oracle**; the Rust core
interprets the authored AST; differential fixtures diff outputs (cues/effects/snapshot/view) per step.
Coverage — one fixture family per Hollow House op:

- **dread** — lantern equipped (no drain) vs not (Sanity −1).
- **storyteller** — move into a lore room with the journal (cue), dedupe on re-entry (no cue), move
  without the journal (no cue), move into a non-lore room (no cue).
- **status-bar** — the `Status` fields across the three `emphasisFor` thresholds, exercising the
  `num→string` + `round/maxRounds` concat.
- **study-door / attic-door** — locked (fail message, no move), with the matching key (unlock message
  + move), re-pass after unlock (silent).
- **victory** — each predicate: reached-attic-with-journal (room object + hasItem), sanity-zero
  (`some`), party-down (`every` over KO).

Green means the AST *and* the interpreter faithfully reproduce real behavior. The `conformance:*`
native shadows remain (they still gate the native-registry path and back the Phase-2 cutover
fixtures). New `.gen.test.ts` generators must be registered in `conformance/fixtures/vitest.config.ts`
(the explicit include list).

## Data flow

```
author (TS builders) → BehaviorScript AST → Catalog.behaviors[key]
engine hook fire-point → resolve(key): native? → native op
                                        else    → ScriptedX(AST) → eval → Vec<Effect> / bool / Option<String>
→ (unchanged) collect-then-apply / exit traversal / outcome resolution
```

## Error handling

- **Load time:** `validate_mechanics` (extended) rejects an unregistered key or an ill-typed/ill-shaped
  AST with `ProceduralViolation` — before play begins.
- **Runtime:** the interpreter is total — missing fields/keys resolve to defaults/`Null`; type
  coercions follow defined rules (mirroring the TS `??`/`unwrap_or` and JS truthiness the oracle
  relies on). A first-party AST that type-checks at load cannot panic at runtime. (Adversarial ASTs
  are out of scope — see Non-goals.)

## Testing strategy

- **Rust unit tests** for the interpreter: each `Expr`/`Stmt` node, the quantifier element binding,
  default/missing-key semantics, `Str` formatting against known JS outputs, and each adapter op.
- **Differential conformance** (above) as the cross-engine gate — the acceptance bar.
- **`bindings:check`** covers the generated AST TS types.
- **`no_std`** build (`--no-default-features`) stays green (the `script` module is `alloc`-only;
  builders + `conformance:*` stay behind their existing features).

## Scope / decomposition

One spec. The plan will likely split into two: (1) the value/expr/stmt model + interpreter + the
`ScriptedMechanic` adapter + `ActionView` widening + `num→string`, gated by dread/storyteller/status-bar;
(2) `ScriptedExit` + `ScriptedVictory` + the `room` accessor + the door/victory fixtures + the Catalog
resolution seam wiring. Final decomposition is a writing-plans decision.

## Sequencing

This sub-plan lands **before** the parked single-player cutover plan. Once Hollow House's ops are
scripted and registered via `Catalog.behaviors`, `Authority::new(hollow-house genesis)` passes
`validate_mechanics`, and the cutover's "validate through the real surfaces / e2e" goal becomes
achievable.

## Follow-on: text DSL + editor tooling

A subsequent sub-project (its own spec/plan) adds an ergonomic **text syntax** and its **VS Code
plugin**, layered on this spec without changing it. The architecture is a stable-IR sandwich:

```
TS builders ─┐
             ├─→ data-AST (this spec's IR) ─→ Rust interpreter (this spec's backend)
text DSL  ───┘        ▲
                      └── parser + static checker  ← shared by the build step AND the VS Code LSP
VS Code plugin: TextMate grammar (highlighting) + LSP diagnostics (compile checks over the checker)
```

- **Piece B — text DSL:** a grammar, a deterministic parser (text → the AST above), and a static
  checker (the "compilation" logic — key resolution, field/type validity, the load-time checks
  `validate_mechanics` already performs, surfaced as diagnostics). One implementation, reused by the
  authoring build pipeline and the editor.
- **Piece C — VS Code plugin:** syntax highlighting via a TextMate grammar; compile-check diagnostics
  via a language server wrapping Piece B's checker.

Because the AST is the compile target, a text-authored op and a builder-authored op produce the
*same* AST — a free cross-check when Hollow House's ops are optionally re-expressed as text. The TS
builders remain valid (a programmatic front-end); text is an additional surface, not a replacement.
Sequenced **after** this spec so the cutover's critical path stays short. Implementation language for
the parser/checker (Rust-compiled-to-WASM vs TS) is a decision for that spec.

## Non-goals

- A text syntax / parser and its VS Code plugin **in this spec** (a sequenced follow-on — above).
- Untrusted-submission hardening (content-hashing, op-count/allocation caps, authority-pinning).
- Scripted formations / mob-record construction.
- General-purpose programming constructs (loops, recursion, user functions, arbitrary variables).
- Performance tuning — correctness and determinism are the goals.

## Risks & open questions

- **`Str(number)` JS parity** — the top risk; must match JS `Number.toString` byte-for-byte across the
  stat value ranges. Validated against a JS oracle in the gate; if a general faithful formatter proves
  costly, the fallback is to bound the supported numeric domain (the plan decides the implementation,
  not the contract).
- **Registry-resolution refactor** — the dispatch sites currently consume `&'static dyn Trait`;
  scripted ops are data, so the seam must yield either a native static op or an interpreter bound to a
  borrowed AST without cloning per fire-point. A plan detail (an owned/borrowed `ResolvedOp` enum or a
  direct-interpret call).
- **`room` resolution cost** — lazy per-access resolution from `room_id`; ensure repeated
  `party[i].room` reads in a predicate don't do redundant world scans (memoization is a plan-level
  micro-decision, not a contract).
- **Catalog growth** — `behaviors` becomes a new catalog surface the fixtures and (eventually) the
  cutover's genesis must populate; the plan pins how the TS authoring registry maps to it.

## Invariant check

- **Gate is authority** — scripted ops diffed against the TS oracle; divergences fixed in AST/interpreter. ✅
- **Determinism** — pure interpreter, f64-restricted ops, deterministic iteration, injected rng, faithful `num→string`. ✅
- **`no_std`** — `script/` is `alloc`-only; `--no-default-features` builds. ✅
- **Serializable boundary** — AST is serde/`ts-rs` data. ✅
- **Generated bindings** — AST TS types via `ts-rs`, `bindings:check`-covered. ✅
- **Pure ops** — scripts return effects/bool/string; engine applies; own-state only. ✅
