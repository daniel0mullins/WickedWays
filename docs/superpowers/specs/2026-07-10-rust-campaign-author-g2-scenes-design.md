# Rust Campaign Author (G2) — Scene statement/effect bodies design

**Date:** 2026-07-10
**Status:** design, approved for planning
**Predecessor:** G2 MVP (`docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-mvp-design.md`), merged via PR #58.

## Context

The G2 MVP shipped `wickedways-author` compiling a TOML campaign surface + an infix
**expression** language into `description.json` + `catalog.json`, proven byte-for-byte on a
keyed door (`canPass`) and a victory (`test`). It is **expressions only** — no behavior
*bodies*.

This slice adds the **statement grammar** (`Vec<Stmt>`) and the first **effect**, the shared
unlock behind every behavior body (mechanic hooks/actions, scene enter/exit, item
`onUse`/`onRead`, exit `runScript`, NPC dialogue effects). Following the MVP's vertical-slice
discipline, it proves the grammar on **one** family — **scenes** — then later slices broaden
to the others (the wiring is mechanical once the grammar exists).

Worked reference (the committed `scripted-scene` fixture, `scene/threshold-draft`):
```json
{"family":"scene","script":{
  "canPlay":{"kind":"not","expr":{"kind":"stateGet","field":"seen","default":false}},
  "onEnter":[
    {"kind":"emit","effect":{"kind":"cue","text":{"kind":"lit","value":"A cold draft..."}}},
    {"kind":"setState","field":"seen","value":{"kind":"lit","value":true}}]}}
```
This is the first-visit pattern: `canPlay = !stateGet('seen', false)` (plays until seen);
`onEnter` emits a cue and marks the scene seen.

## Goal

Author a scene entirely in the TOML surface — a scene attached to a room, with a `canPlay`
predicate and an `onEnter`/`onExit` **statement body** — and compile it to a byte-identical
`BehaviorScript::Scene` (plus its `SceneDef` in the description), gated against a new
`g2-scene` TS-twin oracle. This proves the statement compiler end-to-end, exactly as the MVP
proved the expression compiler.

## Decisions (settled during brainstorming)

1. **Vertical target: scenes.** Scene `onEnter`/`onExit` bodies exercise the core statement
   forms + the `Cue` effect + state writes without pulling in combat/character targeting. A
   small, self-contained oracle. (Mechanic and exit-`runScript` targets were considered;
   mechanic is the largest single family, exit-`runScript` the smallest but weakest on
   effects.)
2. **Multi-line block statement grammar.** A `'''...'''` TOML string of newline-separated
   statements with brace-nested `when cond { ... }`. Extends the MVP's Pratt parser with
   statement forms; handles `When` nesting naturally. (Array-of-strings and AST-as-TOML were
   rejected — nesting is awkward / verbose.)

## Non-goals (deferred to later slices)

- **The other seven effects:** `Damage`, `Heal`, `AdjustStat`, `GrantImmunity`, `Status`,
  `GiveItem`, `SetVisible`. Scenes emit **cues**, so this slice implements only the `Cue`
  effect. Implementing effect lowering no fixture proves would ship unverified code against the
  byte-parity discipline; each effect lands with the family slice that exercises it.
- **`Pass`** (exit-script narration; illegal in effect bodies per `script/mod.rs`) and exit
  `runScript` — the exit-family slice.
- The other four families (mechanic, item, npc) — their own slices.
- Full Def coverage, id-derivation, npx/WASM packaging, Hollow House capstone, editor tooling.
- `stateGetIn` (dynamic string-keyed state maps, e.g. the storyteller's `seen[roomName]`) is
  added **only if** the `g2-scene` oracle needs it; otherwise it waits for a fixture that does.

`compile()`'s signature does not change.

## Architecture

Extends the existing `crates/wickedways-author` crate:
- `src/expr/parser.rs` — add the state-read expressions scenes use in `canPlay`: `stateGet(field, default)` → `Expr::StateGet { field, default }` (and `stateGetIn(mapField, key, default)` → `Expr::StateGetIn` iff the oracle needs it). `field`/`mapField` and `default` are literal-ish per the AST (`default: Value`); confirm shapes against `ast.rs`.
- `src/stmt.rs` (new) — `parse_stmts(src, base) -> Result<Vec<Stmt>, CompileError>`: a block-statement parser that reuses `parse_expr` for embedded expressions. Panic-free.
- `src/author_doc.rs` — add the `[[scenes]]` surface (`room`, `key`, `phase?`, `initialState?`) and extend `[behaviors.scene.<key>]` (`canPlay?`, `onEnter?`, `onExit?` — the bodies are statement-block strings).
- `src/lower.rs` — lower `[[scenes]]` → `SceneDef` entries in the `CampaignDescription`, and `[behaviors.scene.<key>]` → `BehaviorScript::Scene { script: SceneScript { can_play, on_enter, on_exit } }` in the catalog.
- `tests/gate.rs` — the new `g2-scene` byte-parity gate (description scenes + catalog scene behavior).

## The statement grammar (this slice)

A body is newline-separated statements inside a `'''...'''` TOML string:

| syntax | `Stmt` node | serde JSON |
| --- | --- | --- |
| `guard <expr>` | `Guard{cond}` | `{"kind":"guard","cond":…}` |
| `when <expr> { <stmts> }` | `When{cond,then}` | `{"kind":"when","cond":…,"then":[…]}` |
| `set state.<field> = <expr>` | `SetState{field,value}` | `{"kind":"setState","field":"seen","value":…}` |
| `emit cue(<expr>)` | `Emit{effect:Cue{text}}` | `{"kind":"emit","effect":{"kind":"cue","text":…}}` |

Statements are newline-terminated; `when` uses `{ }` for its nested body (which may contain any
of these, including a nested `when` — a `Guard` inside still halts the whole body per the AST's
short-circuit semantics). `Pass`, `SetStateIn`, and `emit` of non-`Cue` effects are **rejected**
in this slice (clear `CompileError`, not silent) so an author gets a real error instead of
unverified output. (`SetStateIn` — dynamic string-keyed map writes — fits the storyteller-style
mechanic, not a scene; it lands with the family that naturally exercises it.)

Plus the expression additions scenes need in `canPlay` (extends the MVP grammar):
- `stateGet('field', <default-literal>)` → `Expr::StateGet` — e.g. `!stateGet('seen', false)`.

## The scene surface (TOML)

```toml
[[scenes]]
room = "Threshold"
key = "threshold-draft"
phase = "enter"            # "enter" | "exit"; how the SceneDef attaches (default "enter")
# initialState optional

[behaviors.scene.threshold-draft]
canPlay = "!stateGet('seen', false)"   # Expr; absent = always plays (SceneScript.can_play None)
onEnter = '''
  emit cue('A cold draft stirs the dust of the threshold.')
  set state.seen = true
'''
# onExit optional
```

`[[scenes]]` mirrors the description's `SceneDef { room, key, phase?, initialState? }`.
`[behaviors.scene.<key>]` mirrors `SceneScript { can_play: Option<Expr>, on_enter:
Option<Vec<Stmt>>, on_exit: Option<Vec<Stmt>> }` (`can_play` is always serialized — `null` when
absent; `on_enter`/`on_exit` are omitted when absent). The exact enter/exit firing semantics
(and the `phase` ↔ `onEnter`/`onExit` relationship) are pinned by the oracle, which is authored
with the proven `s.scene(...)` builder + a `SceneDef`.

## The differential gate

A new `g2-scene` oracle fixture, same pattern as `g2-vault`:
1. A one-time **TS twin** (`s.scene({...})` + `.scene(room, key, {...})` on the template) emits
   committed `g2-scene.{description,catalog,genesis}.json`. To fully exercise the statement
   grammar (not just the two forms `threshold-draft` uses), the oracle scene's `onEnter` body
   uses **`guard`, a nested `when { ... }`, `set state.x = …`, and `emit cue(…)`**, and its
   `canPlay` uses `stateGet` — so byte-parity proves every statement form and the `Cue` effect
   this slice implements.
2. `g2-scene.toml` authored in the new surface.
3. A `wickedways-author` test: `compile(g2-scene.toml)`'s description + catalog byte-match the
   committed oracle (via the existing canonicalized-value gate). This proves the scene's
   `SceneDef` and its `BehaviorScript::Scene` (canPlay expr + statement bodies) are reproduced
   node-for-node.

**The gate is the authority.** Never hand-edit a golden / fixture input / `canonical-json.ts`.
The `g2-scene` oracle stays inside what this slice implements (statements + `Cue` only; no
`Pass`, no other effects). Author it ASCII-only.

## Testing

- **Unit — `parse_stmts`:** each statement form; `when` nesting; a `guard` inside a `when`;
  errors — a bad statement keyword, an `emit` of a non-cue effect (rejected), a `pass`
  (rejected), malformed `set`. Assert on serialized `Stmt` JSON (robust to Rust field names).
- **Unit — expression additions:** `stateGet('seen', false)` → the `StateGet` shape; `!stateGet(...)`.
- **Differential gate:** the `g2-scene` fixture (description + catalog byte-match).
- **Determinism:** compile twice → byte-identical.
- **Hygiene:** panic-free on author input in `src/`; no `HashMap`/`HashSet`; `BTreeMap`-only.
- **CI:** the existing `cargo test -p wickedways-author` job covers it.

## Program context

engine core (#55) → G1 assembler (#57) → G2 MVP (#58) → **G2 scene bodies** [this slice] →
G2 remaining slices (other effects + the mechanic/item/npc families; exit `runScript`; full Def
coverage; id-derivation; Hollow House capstone; npx/WASM packaging + runtime-load) → A (Rust
core party/turn order) → B (sync) → C (server) → D (Dioxus) → E (chat/AV) → F (retire TS). Each
slice is its own spec → plan → implementation cycle.
