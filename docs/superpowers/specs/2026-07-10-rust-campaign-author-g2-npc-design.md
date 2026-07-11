# Rust Campaign Author (G2) — NPC dialogue design

**Date:** 2026-07-10
**Status:** design, approved for planning
**Predecessor:** G2 item bodies (`docs/superpowers/specs/2026-07-10-rust-campaign-author-g2-items-design.md`), merged via PR #60.

## Context

The scene and item slices built the reusable statement grammar + the `Cue`/`AdjustStat` effects.
This slice adds the **npc** family — the one with genuinely new structure: a *dialogue* AST
(match/response/effects/once), plus the `GiveItem` + `SetVisible` effects. It is the largest
slice so far.

Worked reference (the committed hollow-house Caretaker — exact):
```json
// catalog.behaviors["caretaker"]
{"family":"npc","script":{
  "description":"A stooped caretaker...",
  "default":{
    "match":{"kind":"exact","text":""},
    "response":{"kind":"lit","value":"Take the cellar key. I am leaving now..."},
    "effects":[
      {"kind":"giveItem","from":{"kind":"lit","value":"npc:Caretaker"},"to":{"kind":"actor"},
       "item":{"kind":"lit","value":"npc:Caretaker:item#0"}},
      {"kind":"setVisible","target":{"kind":"lit","value":"npc:Caretaker"},"visible":{"kind":"lit","value":false}}]},
  "dialogue":[]}}
// description-side NpcDef: { name:"Caretaker", stats:{…}, room:"Foyer", behavior:"caretaker", holds:["cellar-key"] }
```
Facts this establishes:
- An NPC has **two artifacts**: a description-side `NpcDef` (name/stats/room/behavior/holds) and a
  catalog-side `BehaviorScript::Npc` (description + dialogue), linked by the `behavior` key.
- The `default` entry (match `exact ""`) is the catch-all fired on a bare `talk`.
- `giveItem`/`setVisible` reference the NPC + its held item by **literal minted id strings**
  (`"npc:Caretaker"`, `"npc:Caretaker:item#0"`) — id-derivation is a separate deferred slice, so
  the surface author writes these literally, matching today's hand-authored twins.

## Goal

Author an NPC entirely in TOML — a `[[npcs]]` declaration + a `[behaviors.npc.<key>]` dialogue
behavior (description + a `default` entry + optional `dialogue` entries, with `match`/`response`/
`effects`/`once`) — and compile it to a byte-identical `NpcDef` + `BehaviorScript::Npc`, gated
against a new `g2-npc` TS-twin oracle.

## Decisions (settled during brainstorming)

1. **Vertical target: npc.** The remaining families are npc and mechanic; npc is done first (it
   introduces the dialogue AST; mechanic is the largest, saved for last).
2. **Polymorphic `match`.** `match = "text"` (a TOML string) → `Exact { text }`; `match = { fuzzy
   = [...] }` (a table) → `Fuzzy { tokens }`. The string-vs-table shape unambiguously picks the
   variant; the `default` catch-all is `match = ""`.
3. **Only `GiveItem` + `SetVisible` effects** this slice — the effects the NPC oracle exercises.
4. **Dialogue `effects` reuse `parse_stmts`, restricted to `emit`.** An effects body is a
   statement block where every statement must be `emit <effect>`; the compiler collects the inner
   `EffectTemplate`s into the entry's `Vec<EffectTemplate>`. A non-`emit` statement (`guard`/
   `when`/`set`/`pass`) in an effects body is a `CompileError`.

## Non-goals (deferred to later slices)

- **`Damage`/`Heal`/`GrantImmunity`/`Status`** effects (and `Pass`/`SetStateIn`) — still rejected;
  each lands with the family/fixture that exercises it.
- **The mechanic family** — the final family slice.
- **Id-derivation for script references.** `giveItem`/`setVisible` reference minted ids as literal
  strings this slice; deriving them from author-friendly references is its own slice.
- **A computed `response`.** The surface `response` is a plain string → `Lit{Str}` (matching the
  Caretaker); a non-literal response `Expr` (e.g. `Concat`) waits for a fixture that needs it.
- Full Def coverage beyond what an NPC needs, Hollow House capstone, npx/WASM packaging.

`compile()`'s signature does not change.

## Architecture

Additions to `crates/wickedways-author`:
1. **`src/stmt.rs` — two effects.** Extend `parse_emit`: `emit giveItem(<from>, <to>, <item>)` →
   `EffectTemplate::GiveItem { from, to, item }` (three exprs); `emit setVisible(<target>,
   <visible>)` → `EffectTemplate::SetVisible { target, visible }` (two exprs). Every other effect
   name stays rejected. Also expose a helper that parses an effects-only block (reuse
   `parse_stmts`, require every `Stmt` be `Emit`, collect the `EffectTemplate`s) — used by dialogue
   entries.
2. **`src/npc.rs` (new) — the dialogue parser.** `parse_dialogue_entry(...)` and a builder for
   `NpcScript { description, default, dialogue }` from the surface. `DialogueEntry { match_,
   response, effects, once }`; `match` per the polymorphic rule; `response` a plain string →
   `Lit{Str}`; `effects` via the effects-block helper; `once` a bool.
3. **`src/author_doc.rs` — the surface.** `[[npcs]]` (`NpcEntry { name, stats, room?, behavior,
   holds? }`) and `[behaviors.npc.<key>]` (`NpcBehaviorEntry { description, default:
   DialogueEntryToml, dialogue: Vec<DialogueEntryToml> }`, where `DialogueEntryToml { match:
   MatchToml, response: String, once?: bool, effects?: String }` and `MatchToml` is an untagged
   string-or-`{fuzzy=[…]}`). `stats` mirrors the `Stats` shape (health/sanity/energy).
4. **`src/lower.rs` — lowering.** `[[npcs]]` → `NpcDef` (in `CampaignDescription.npcs`);
   `[behaviors.npc.<key>]` → `BehaviorScript::Npc { script: NpcScript{…} }`, keyed by `<key>`.

## The two effects (syntax)

| syntax | node | serde JSON |
| --- | --- | --- |
| `emit giveItem(<f>, <t>, <i>)` | `GiveItem{from,to,item}` | `{"kind":"emit","effect":{"kind":"giveItem","from":…,"to":…,"item":…}}` |
| `emit setVisible(<t>, <v>)` | `SetVisible{target,visible}` | `{"kind":"emit","effect":{"kind":"setVisible","target":…,"visible":…}}` |

All args are expressions; ids are literal `'…'` strings (→ `Lit{Str}`); `visible` is a bool literal.

## The npc surface (TOML)

```toml
[[npcs]]
name = "Caretaker"
stats = { health = 1, sanity = 1, energy = 1 }
room = "Foyer"
behavior = "caretaker"
holds = ["cellar-key"]

[behaviors.npc.caretaker]
description = "A stooped caretaker..."

[behaviors.npc.caretaker.default]           # the catch-all (match "")
match = ""
response = "Take the cellar key. I am leaving now."
once = true
effects = '''
  emit giveItem('npc:Caretaker', actor, 'npc:Caretaker:item#0')
  emit setVisible('npc:Caretaker', false)
'''

# optional additional entries:
[[behaviors.npc.caretaker.dialogue]]
match = { fuzzy = ["key", "cellar"] }
response = "It opens the cellar."
```

`[[npcs]]` mirrors `NpcDef { name, stats, room?, behavior, holds? }`.
`[behaviors.npc.<key>]` mirrors `NpcScript { description, default, dialogue }`.
`match`/`response`/`effects`/`once` map to `DialogueEntry` per the Decisions above.

## The differential gate

A new `g2-npc` oracle fixture, same pattern as the prior slices:
1. A one-time **TS twin** (the real Caretaker-style content — an NPC holding a key, its `default`
   dialogue giving the key + vanishing, authored via `s.npc(...)`/`s.giveItem`/`s.setVisible`)
   emits committed `g2-npc.{description,catalog,genesis}.json`. Stays inside the slice subset
   (only `giveItem`/`setVisible` effects; `Exact` + at least one `Fuzzy` match to exercise both).
2. `g2-npc.toml` authored in the new surface.
3. A `wickedways-author` test: `compile(g2-npc.toml)`'s description + catalog byte-match the
   committed oracle — proving both the `NpcDef` (incl. `holds` + `stats`) and the
   `BehaviorScript::Npc` (description + dialogue entries + the `GiveItem`/`SetVisible` effects) are
   reproduced node-for-node.

**The gate is the authority.** Never hand-edit a golden / fixture input / `canonical-json.ts`.
Author it ASCII-only. The held key item (`cellar-key`) is a key item declared in the catalog —
reuse the MVP's key-item lowering.

## Testing

- **Unit — `parse_emit`:** `emit giveItem(...)` / `emit setVisible(...)` → the exact JSON; the
  effects-block helper (all-`emit` → `Vec<EffectTemplate>`; a non-emit stmt in an effects body →
  error); another effect (`heal`/`damage`) still rejected.
- **Unit — dialogue:** a `default` entry (match `""` → Exact) + a `{ fuzzy = [...] }` entry → the
  exact `DialogueEntry`/`DialogueMatch` JSON; `once`/`effects` defaults.
- **Unit — surface:** `[[npcs]]` + `[behaviors.npc.<key>]` parses into the new structs.
- **Differential gate:** the `g2-npc` fixture (description + catalog byte-match).
- **Determinism:** compile twice → byte-identical.
- **Hygiene:** panic-free on author input; no `HashMap`/`HashSet`; `BTreeMap`-only.
- **CI:** the existing `cargo test -p wickedways-author` + `bindings:check` jobs cover it.

## Program context

engine core (#55) → G1 assembler (#57) → G2 MVP (#58) → scene bodies (#59) → item bodies (#60) →
**G2 npc dialogue** [this slice] → G2 mechanic family (hooks/actions/modifyDamage [+ Damage/
GrantImmunity]) → exit `runScript` [Pass] → full Def coverage → id-derivation → Hollow House TOML
capstone → npx/WASM packaging + runtime-load → A (Rust core) → B (sync) → C (server) → D (Dioxus)
→ E (chat/AV) → F (retire TS). Each slice is its own spec → plan → implementation cycle.
