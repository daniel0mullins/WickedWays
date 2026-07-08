# NPC Dialogue System — Sub-plan 2: Data-Driven Dialogue Behavior

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-08
**Branch:** `design/rust-engine-core`
**Part of:** the NPC dialogue system (3 sub-plans). Depends on Sub-plan 1 (visibility, `examine`-describe, `talk` non-advancing + NPC resolution, `GiveItem`/`SetVisible` effects). Sub-plan 3 authors the Hollow House caretaker on top of this.
**Related:** the scripted-ops DSL (`BehaviorScript` families) + data-driven formations (the "first-party content as data" precedent).

## Goal

Give NPCs authorable **dialogue**: a data-driven `BehaviorScript::Npc` family (resolved via the NPC's `npc_behavior_key`) that maps a player's `talk` prompt to a **response** (a cue) plus optional **effects** (so a response can `GiveItem` + `SetVisible(false)`). Wire `talk` (from Sub-plan 1) to run it. Bring the dormant TS `NonPlayerCharacter`/`IDialogue` matching onto the differential gate path, mirrored in Rust, so dialogue is byte-faithful across engines.

## Background

The TS authoring layer already has `NonPlayerCharacter` + `IDialogue` (fuzzy + exact prompt→response matching, `dialogue(prompt)`), registered via `defineRegistry({ npcs })` and rebound on hydrate via `registry.npc(npcBehaviorKey)` — but it is **off the gate path** (neither the Rust core nor `oracle-session.ts` runs it; `talk` was a throw until Sub-plan 1). `CharacterSnapshot.npc_behavior_key` is the (formerly dormant) key we resolve against. `BehaviorScript` currently has `Mechanic | Exit | Victory | Item`; formations proved the "author first-party content as data + interpret in the core" pattern.

## The dialogue model (data)

A dialogue is static data — prompt patterns → response + effects — no expressions needed. Add a `BehaviorScript::Npc` family carrying an `NpcScript`:

```
NpcScript {
  description: String,                 // returned by `examine` (Sub-plan 1's read path sources this)
  dialogue: Vec<DialogueEntry>,
  default: DialogueEntry,              // bare `talk` (no prompt) OR no pattern matched
}

DialogueEntry {
  patterns: Vec<String>,              // matched against the talk prompt (exact, then fuzzy)
  response: Expr /* text */,          // the NPC's line (a cue)
  effects: Vec<EffectTemplate>,       // optional — e.g. GiveItem + SetVisible(false)
  once: bool,                         // if true, fire effects only the first time (guarded by NPC state)
}
```

- **Matching:** a prompted `talk "…"` matches `patterns` (exact first, then the existing `IDialogue` fuzzy rule — ported byte-faithfully); a bare `talk` (or no match) uses `default`. The matcher is the one genuinely tricky primitive (fuzzy parity) — validated against the TS `IDialogue` oracle in the gate, like `num→string` was for the DSL.
- **Effects:** a response's `effects` flow through the existing collect-then-apply pipeline (using Sub-plan 1's `GiveItem`/`SetVisible` templates). The caretaker's `default` entry (or a "cellar" pattern) emits `GiveItem(keeper → player, cellar-key)` + `SetVisible(keeper, false)`, `once: true`.
- **Once-guard:** `once` fires the effects a single time; re-`talk` after the hand-off returns just the response (and the NPC is invisible anyway once `SetVisible(false)` ran, so it's unreachable). Backed by the mechanic-style per-behavior JSON state (the DSL already has `SetState`/state), so the "already handed off" latch is deterministic and serialized.

## Architecture

- **`BehaviorScript::Npc { script: NpcScript }`** in the AST (serde `family="npc"`, ts-rs). `NpcScript`/`DialogueEntry` are serde+ts-rs data; `response` reuses the DSL text `Expr`; `effects` reuse `EffectTemplate` (incl. Sub-plan 1's new variants).
- **Resolution seam:** `talk` (Sub-plan 1 resolves the visible NPC occupant) → `resolve_npc(npc_behavior_key, cat)` → `catalog.behaviors[key]` as `BehaviorScript::Npc` → a `ScriptedNpc` adapter (mirrors `ScriptedMechanic`) that runs the matcher against the prompt, emits the response cue, and returns the entry's effects. `validate_mechanics` extends to validate NPC scripts + that every NPC's `npc_behavior_key` resolves.
- **`examine` source:** Sub-plan 1's occupant-read returns `NpcScript.description`.
- **TS oracle:** `oracle-session.ts` `talk` runs the same matcher (either the ported `IDialogue` fuzzy/exact over the descriptor, or a shared data-driven matcher) producing the same cue + effects; the live `GameSession` delegates to the Authority so it inherits the Rust behavior.
- **Authoring:** a TS `npc({ description, dialogue, default })` builder (mirrors `item(...)`/`mechanic(...)`) emitting the `BehaviorScript::Npc` AST; registered in the campaign's `behaviors` map by the NPC's `npc_behavior_key`.

## Determinism & the gate

- Deterministic: matching is ordered (exact→fuzzy→default); effects ordered; the `once` latch is serialized state. No rng.
- **Fuzzy-match parity is the top risk** — the Rust matcher must reproduce the TS `IDialogue` fuzzy rule byte-for-byte; validated against the TS oracle in the gate (a dialogue differential fixture: bare talk, an exact-match prompt, a fuzzy-match prompt, a no-match→default, and a `once` effect firing then not re-firing).
- `no_std`, `bindings:check` (new AST types), `checks:phase2` green.

## Non-goals (Sub-plan 2)

- The caretaker/cellar content + keyed door + intro scene (Sub-plan 3).
- Branching/stateful conversation trees beyond `once` (a single-turn prompt→response with an optional one-time effect covers the caretaker; richer trees are future work).
- NPC movement/AI/turns (NPCs are stationary interaction props).

## Invariant check

- **Gate is authority** — dialogue diffed against the TS `IDialogue` oracle; fixes in the matcher/AST, never goldens. ✅
- **Determinism / `no_std`** — ordered matching, serialized latch, alloc-only. ✅
- **Serializable boundary / bindings** — `NpcScript` is serde/ts-rs data. ✅
- **First-party as data** — dialogue joins mechanic/exit/victory/item/formation as authorable catalog data, via the (revived) `npc_behavior_key`. ✅
