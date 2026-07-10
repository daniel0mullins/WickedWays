# Rust Campaign Author (G2) — Item onUse/onRead design

**Date:** 2026-07-10
**Status:** design, approved for planning
**Predecessor:** G2 scene bodies (`docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-scenes-design.md`), merged via PR #59.

## Context

The scene slice built the reusable **statement grammar** (`guard`/`when`/`set`/`emit cue`) and
proved it on scene bodies. This slice extends it to the **item** family — `onUse`/`onRead`
bodies — which reuse `parse_stmts` unchanged and add the first *targeted* effect, `AdjustStat`.

Worked reference (the committed hollow-house laudanum):
```json
// catalog.items["laudanum"]
{"name":"Vial of Laudanum","type":"consumable","stat":"sanity","modifier":6,
 "properties":{"equippable":false,"equipped":false,"destroyable":true,"usable":true},
 "recipe":{"healing":1},"teaches":null,"immunities":null,"grantsImmunity":null}
// catalog.behaviors["laudanum"]
{"family":"item","script":{"onUse":[{"kind":"emit","effect":
 {"kind":"adjustStat","target":{"kind":"actor"},"stat":"sanity","delta":{"kind":"lit","value":6}}}]}}
```
Two facts this establishes:
- **An item and its behavior share a key.** `laudanum` is a key in BOTH `catalog.items` (the
  descriptor) and `catalog.behaviors` (the `onUse` script); the engine resolves an item's
  `onUse` via `catalog.behaviors[item_key]`. `usable:true` on the descriptor enables it.
- `AdjustStat { target: Expr, stat: StatType, delta: Expr }` serializes as
  `{"kind":"adjustStat","target":…,"stat":"sanity","delta":…}` (`StatType` is `rename_all =
  "lowercase"` → `sanity`/`health`/`energy`).

## Goal

Author a usable consumable item entirely in the TOML surface — a `[[items]]` consumable
descriptor + a `[behaviors.item.<key>]` `onUse`/`onRead` body emitting `adjustStat` — and
compile it to a byte-identical `ItemDescriptor` + `BehaviorScript::Item`, gated against a new
`g2-item` TS-twin oracle.

## Decisions (settled during brainstorming)

1. **Vertical target: item.** `onUse`/`onRead` are `Vec<Stmt>` bodies that reuse `parse_stmts`
   as-is — the smallest next family. (npc adds a whole dialogue AST; mechanic is the largest.)
2. **Only the `AdjustStat` effect this slice** — the effect the item oracle exercises.

## Non-goals (deferred to later slices)

- **`Heal`** and the other five effects (`Damage`/`GrantImmunity`/`Status`/`GiveItem`/`SetVisible`)
  — each lands with the family/fixture that exercises it (byte-parity discipline: no unverified
  effect lowering). `emit` of any effect other than `cue`/`adjustStat` stays **rejected** with a
  clear `CompileError`.
- **`Pass`, `SetStateIn`** — still rejected (exit-`runScript` / storyteller-mechanic slices).
- **The npc and mechanic families** — their own slices (they reuse this same `parse_stmts`).
- Item kinds other than *key* (already shipped) and *consumable* (this slice) — e.g. weapons,
  light sources — land when a fixture needs them.
- Full Def coverage, id-derivation, Hollow House capstone, npx/WASM packaging.

`compile()`'s signature does not change.

## Architecture

Three additions to `crates/wickedways-author`:
1. **`src/stmt.rs` — the `AdjustStat` effect.** Extend `parse_emit` to recognize
   `emit adjustStat(<target-expr>, <stat-keyword>, <delta-expr>)` → `EffectTemplate::AdjustStat
   { target, stat, delta }`. The 2nd argument is a **bare stat keyword** (`sanity`/`health`/
   `energy`), parsed to `StatType` (reject an unknown stat with a clear `CompileError`), NOT an
   expression. `target` and `delta` are expressions via `parse_expr`. `parse_stmts` is otherwise
   reused unchanged for the `onUse`/`onRead` bodies.
2. **`src/author_doc.rs` + `src/lower.rs` — the consumable item.** The MVP's `[[items]]` surface
   only expressed *key* items and `lower_item` hardcoded a key `ItemDescriptor`. Extend the
   surface so a non-`keyCode` item can be a **consumable**, carrying the descriptor fields it
   needs (`type`, `stat`, `modifier`, `usable`, `destroyable`, and the inert `recipe`), and
   branch `lower_item` on key-vs-consumable to reproduce the factory descriptor. The exact field
   set + defaults are pinned by the `g2-item` oracle and reproduced byte-for-byte (as the MVP's
   key descriptor was pinned by `createKey`'s output); read the consumable item factory + the
   oracle descriptor to get them exact.
3. **`src/author_doc.rs` + `src/lower.rs` — the item behavior.** Add `[behaviors.item.<key>]`
   (`on_use?`/`on_read?` statement-block strings) → `BehaviorScript::Item { script: ItemScript
   { on_use: on_use.map(parse_stmts), on_read: on_read.map(parse_stmts) } }`, keyed the same as
   the item entry (the shared-key link). `ItemScript.on_use`/`on_read` are `skip_serializing_if
   = "Option::is_none"` → omitted when absent.

## The `AdjustStat` effect syntax

| syntax | node | serde JSON |
| --- | --- | --- |
| `emit adjustStat(<t>, <stat>, <d>)` | `Emit{effect:AdjustStat{target,stat,delta}}` | `{"kind":"emit","effect":{"kind":"adjustStat","target":…,"stat":"sanity","delta":…}}` |

`<stat>` ∈ `{sanity, health, energy}` (bare keyword → `StatType`, lowercase). Negative deltas are
written `0 - N` (no unary minus — a carried MVP-parser property); the laudanum oracle uses `+6`.

## The item surface (TOML)

```toml
[[items]]
key = "laudanum"
name = "Vial of Laudanum"
type = "consumable"
stat = "sanity"
modifier = 6
usable = true
destroyable = true
# recipe (inert crafting map) as the factory sets it — exact handling pinned by the gate

[behaviors.item.laudanum]
onUse = "emit adjustStat(actor, sanity, 6)"
# onRead optional
```

A `[[items]]` entry with `keyCode` remains a key (unchanged from the MVP); one with a
consumable `type` lowers to the consumable descriptor. `[behaviors.item.<key>]` mirrors
`ItemScript { on_use, on_read }` and shares the item's key.

## The differential gate

A new `g2-item` oracle fixture, same pattern as `g2-vault`/`g2-scene`:
1. A one-time **TS twin** (a real usable consumable item factory + an `s.item({onUse})` behavior)
   emits committed `g2-item.{description,catalog,genesis}.json`. The item's `onUse` uses
   `adjustStat` (positive delta) and stays inside the slice subset (no other effect, no `onRead`
   unless it also uses only `adjustStat`).
2. `g2-item.toml` authored in the new surface.
3. A `wickedways-author` test: `compile(g2-item.toml)`'s description + catalog byte-match the
   committed oracle — proving both the consumable `ItemDescriptor` and the `BehaviorScript::Item`
   `onUse` AST (incl. the `AdjustStat` effect) are reproduced node-for-node.

**The gate is the authority.** Never hand-edit a golden / fixture input / `canonical-json.ts`.
The `g2-item` oracle stays inside what this slice implements. Author it ASCII-only. (The item is
declared but need not be reachable at genesis — the static gate compares description + catalog.)

## Testing

- **Unit — `parse_emit` AdjustStat:** `emit adjustStat(actor, sanity, 6)` → the exact JSON; an
  unknown stat keyword → `CompileError`; `emit heal(...)` / another effect → still rejected.
- **Unit — surface:** a consumable `[[items]]` + `[behaviors.item.<key>]` parses into the new
  structs.
- **Differential gate:** the `g2-item` fixture (description + catalog byte-match), covering both
  the consumable descriptor and the `onUse` behavior.
- **Determinism:** compile twice → byte-identical.
- **Hygiene:** panic-free on author input; no `HashMap`/`HashSet`; `BTreeMap`-only.
- **CI:** the existing `cargo test -p wickedways-author` + `bindings:check` jobs cover it.

## Program context

engine core (#55) → G1 assembler (#57) → G2 MVP (#58) → G2 scene bodies (#59) → **G2 item
bodies** [this slice] → G2 remaining slices (npc dialogue [+ GiveItem/SetVisible]; mechanic
hooks/actions/modifyDamage [+ Damage/GrantImmunity]; exit `runScript` [Pass]; full Def coverage;
id-derivation; Hollow House TOML capstone; npx/WASM packaging + runtime-load) → A (Rust core) →
B (sync) → C (server) → D (Dioxus) → E (chat/AV) → F (retire TS). Each slice is its own spec →
plan → implementation cycle.
