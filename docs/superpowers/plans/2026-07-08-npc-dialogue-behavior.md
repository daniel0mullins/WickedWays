# NPC Dialogue System — Sub-plan 2: Data-Driven Dialogue Behavior — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). The fuzzy matcher (Task 2) is a byte-parity crux — gate it against the TS `IDialogue` algorithm.

**Goal:** A data-driven `BehaviorScript::Npc` family (resolved via `npc_behavior_key`): prompt→response matching (exact→fuzzy→default) that emits a response cue **and** optional effects (`GiveItem`/`SetVisible` from Sub-plan 1), with a `once` latch. Wire `talk` to run it, and `examine <npc>` to return its description.

**Spec:** `docs/superpowers/specs/2026-07-08-npc-dialogue-behavior-design.md`. **Depends on Sub-plan 1** (visibility, `talk` non-advancing + NPC resolution, `GiveItem`/`SetVisible`).

## Global Constraints
- **Fuzzy-match byte-parity** with the TS `IDialogue` rule (non-player-character.ts): **exact** = full lowercased string equality; **fuzzy** = `triggerTokens ⊆ promptTokens` where prompt tokens = lowercased prompt `.split(/\s+/)`, trimmed, non-empty, set-deduped (subset of ALL trigger tokens — NOT substring, NOT any-overlap); **bare/no prompt** → the initial/`default` response; **no match** → empty; **multiple matches** → responses concatenated in block order. Reproduce exactly in Rust; gate against the oracle.
- Differential gate authority; `no_std`; `bindings:check`; `checks:phase2` green. `GameSession.start` sync.

---

## Task 1: `NpcScript` AST + `BehaviorScript::Npc` + validation + bindings
**Files:** `crates/wickedways-core/src/script/ast.rs` (`BehaviorScript` ~235-243); `crates/wickedways-core/src/script/mod.rs` (`validate_behavior`); `crates/wickedways-core/src/stats.rs` (ts export); bindings.

- [ ] Define (serde+ts-rs, mirroring `ItemScript`):
  ```
  NpcScript { description: String, default: DialogueEntry, dialogue: Vec<DialogueEntry> }
  DialogueEntry {
    match_: DialogueMatch,           // serde rename "match"
    response: Expr,                  // text Expr (reuse the DSL text Expr / Concat / Lit-str)
    #[serde(default)] effects: Vec<EffectTemplate>,
    #[serde(default)] once: bool,
  }
  DialogueMatch = Exact { text: String } | Fuzzy { tokens: Vec<String> }   // tag = "kind"
  ```
  Add `BehaviorScript::Npc { script: NpcScript }` (family `"npc"`).
- [ ] `validate_behavior` Npc arm: check each entry's `response`/`effects` (reuse `check_expr`/`check_effect`, `allow_emit` true, `allow_pass` false). Register `NpcScript` (+ new types) in the stats.rs export. Regen bindings, `bindings:check`.
- [ ] Tests (validate accepts a well-formed NpcScript; rejects an ill-typed effect). no_std. Commit.

## Task 2: The matcher + `ScriptedNpc` adapter (byte-parity)
**Files:** `crates/wickedways-core/src/script/ops.rs` (`ScriptedNpc`, mirror `ScriptedMechanic`); a matcher fn in `eval.rs` or `ops.rs`; tests.

- [ ] Failing unit tests replicating the TS algorithm exactly: exact-match (lowercased full-string), fuzzy subset-match (all trigger tokens present, order-independent, extra prompt tokens OK), a fuzzy that FAILS when a trigger token is absent, bare prompt → `default`, no-match → default vs empty (match the TS: no prompt→initial; prompt-with-no-match→empty responses — decide the NpcScript contract: bare talk uses `default`; a prompt that matches nothing → `default` OR empty; pin to mirror `#generateResponse` which returns `[]` on no match — but our NpcScript has an explicit `default` for bare talk; for a non-matching PROMPT, return the default too OR empty — choose and gate).
- [ ] Implement the matcher: normalize prompt (lowercase), tokenize (`split_whitespace` → set), iterate `dialogue` entries in order: `Exact` → `prompt_lc == text.to_lowercase()`; `Fuzzy` → `tokens.iter().all(|t| prompt_tokens.contains(&t.to_lowercase()))`. Concatenate matched responses/effects in order. Bare/empty prompt → `default`.
- [ ] `ScriptedNpc { script }` with `run_talk(prompt, base, actor) -> (Vec<cue>, Vec<Effect>)` and `description() -> &str`; build the `Ctx` like `ScriptedMechanic` (actor + view + rng + the NPC's per-behavior JSON state for the `once` latch). `once`: an entry with `once:true` fires effects only if its state flag is unset, then sets it (via the state seam).
- [ ] Tests pass; no_std. Commit.

## Task 3: Wire `talk` → dialogue + `examine <npc>` → description
**Files:** `crates/wickedways-core/src/world/submit.rs` (`Talk` arm — replace Sub-plan 1's placeholder; add an examine-occupant path); `crates/wickedways-core/src/world/command.rs` (a `Command::Talk`/`Examine` for the replay harness, or extend `Read`); `conformance/fixtures/oracle-session.ts` (talk + examine mirrors); the CRT controller examine-occupant routing; tests.

- [ ] Failing integration tests: `talk` to the caretaker-style NPC (bare) emits the `default` response cue + fires its effects (e.g. GiveItem) once; a matching prompt emits its response; `examine <npc>` returns `NpcScript.description` as a `mechanic` cue (free, non-advancing).
- [ ] `Talk` arm: resolve the visible NPC occupant (Sub-plan 1) → `resolve_npc(npc_behavior_key, cat)` → `BehaviorScript::Npc` → `ScriptedNpc.run_talk(prompt,…)` → push the response cue + `apply_all(effects)` (capped at MAX_EFFECTS_PER_EVENT). `validate_mechanics` extends to validate every NPC occupant's `npc_behavior_key` resolves + each `BehaviorScript::Npc` shape-checks (mirror the item/mechanic loops).
- [ ] `examine <occupant>`: a free path (mirror `read_item`) returning the NPC's `description` cue. Add the replay-harness entrypoint (`Command::Talk { npc_id, prompt? }` + `Command::Examine { target_id }`, or reuse) so the differential fixture can drive them. CRT controller: route `examine` of an occupant target to the examine path.
- [ ] TS oracle (`oracle-session.ts`): mirror `talk` (run the same data-driven matcher + effects) and `examine` (return description). Byte-parity.
- [ ] Tests + typecheck + no_std. Commit.

## Task 4: TS `npc({...})` builder + dialogue differential fixture
**Files:** `packages/campaigns/src/scripted/builders.ts` (`npc(...)` builder); a dialogue conformance fixture (`conformance/fixtures/npc-dialogue.gen.test.ts` + replay); vitest.config registration.

- [ ] `npc({ description, default, dialogue })` builder emitting `{ family: "npc", script: {...} }` (mirror `item(...)`); `dialogueExact("word")` / `dialogueFuzzy(["how","out"])` match helpers + a `dialogueEntry({ match, response, effects?, once? })`. Builder unit test (emitted AST).
- [ ] Dialogue differential fixture: a synthetic NPC with description + an exact entry + a fuzzy entry + a `once` GiveItem entry. Drive the oracle: `examine` (description), `talk` bare (default), `talk "exact phrase"` (exact hit), `talk "how do i get out"` (fuzzy subset hit), `talk "nonsense"` (no match), `talk` again (once → no re-fire). Replay byte-identical (this gates the fuzzy-match parity + effects + once). Register the generator.
- [ ] `pnpm run wasm:build:conformance` + replay green. Commit.

## Task 5: Docs + gate
- [ ] README: NPC dialogue (data-driven `BehaviorScript::Npc`, exact/fuzzy matching, responses emit cues+effects, `once`, `examine` description, `talk` non-advancing).
- [ ] `pnpm run checks:phase2` green. Commit.

## Self-Review
- Fuzzy rule pinned verbatim from the TS oracle (subset). `once` latch via serialized behavior state. Effects reuse Sub-plan 1's `GiveItem`/`SetVisible`. Consumed by Sub-plan 3 (the caretaker authors an `npc({...})`).
