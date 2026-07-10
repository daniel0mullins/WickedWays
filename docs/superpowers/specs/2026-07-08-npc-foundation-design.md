# NPC Dialogue System — Sub-plan 1: Presence & Interaction Foundation

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-08
**Branch:** `design/rust-engine-core`
**Part of:** the NPC dialogue system (3 sub-plans). This is the foundation; Sub-plan 2 adds the data-driven dialogue behavior; Sub-plan 3 is the Hollow House caretaker content.
**Related:** scripted-ops DSL, item-effects `onUse`, data-driven formations (the "first-party content as data" precedents).

## Goal

Lay the engine foundation for NPCs the player can perceive and interact with: a per-character **visibility** flag, `examine`-an-NPC returning its **description**, the `talk` verb wired as a **non-time-advancing** interaction that resolves an NPC occupant (instead of throwing), and two new closed **effects** — `GiveItem` (transfer an item from an NPC to the player) and `SetVisible` (flip a character's visibility). No dialogue *content* yet (that's Sub-plan 2) — this is the plumbing every NPC interaction rides on.

## Background

`CharacterKind::Npc` exists but is near-dormant; `CharacterSnapshot.npc_behavior_key: Option<String>` is a dormant serde field never read by the core; and the `Talk { npc_id, prompt? }` intent is dispatched to a hard throw (`"There's no one here to talk to."`) in both `submit.rs` and the frozen oracle `oracle-session.ts`. `talk` is currently classified **time-advancing** (`is_time_advancing` / the TS `TIME_ADVANCING` set include `"talk"`). The closed `Effect` set is `Damage | Heal | AdjustStat | GrantImmunity | Cue | Status`; scenes/mechanics emit these via the collect-then-apply pipeline. There is no "give item to the player from a non-player source" and no "hide a character" primitive.

## Scope (Sub-plan 1)

1. **`visible` flag** on `CharacterSnapshot` (`visible: bool`, default `true`, serde `#[serde(default = ...)]` so existing snapshots parse). The view/scope **omits an invisible occupant** (not listed as a room occupant, not in `scope`, not a valid `talk`/`examine`/`attack` target). Reversible — an effect can flip it back.
2. **`examine <occupant>` → NPC description.** Extend the existing free, non-advancing examine/read path (CRT `examine`/`x`/`look-at`/`read` → `session.read`; PnC affordance) so an *occupant* target returns the NPC's physical description as a `mechanic` cue (mirrors item-lore reads). The description is authored data on the NPC (a `description` field — where exactly is pinned in Sub-plan 2's descriptor; Sub-plan 1 wires the read path + a description source on the character/catalog).
3. **`talk` becomes non-time-advancing.** Remove `"talk"` from `is_time_advancing` (Rust) and `TIME_ADVANCING` (TS) so talking never advances the round or provokes mob reactions.
4. **`Talk` dispatch resolves an NPC occupant.** In `submit.rs` and `oracle-session.ts`, the `Talk { npc_id, prompt? }` arm resolves a co-located, **visible** `Npc` occupant by id. In Sub-plan 1 (no dialogue yet) a resolved NPC with no dialogue behavior is a quiet no-op / a placeholder cue; an unresolved id keeps a `ProceduralViolation` (message pinned in the plan — likely reworded from "There's no one here to talk to." to still fire when no such NPC is present). The dialogue *behavior* invocation is Sub-plan 2.
5. **Two new closed effects** (both engines, gated):
   - **`GiveItem { from: CharacterId, to: CharacterId, item: ItemId }`** — move an item id from `from`'s inventory to `to`'s inventory. The item's `ItemSnapshot` already lives in `World.items` (it was the NPC's inventory item), so this is an id move — no new snapshot, reachability stays consistent. Mirrors TS `receiveItem`/inventory transfer.
   - **`SetVisible { target: CharacterId, visible: bool }`** — set the character's `visible` flag.
   Add matching `EffectTemplate::GiveItem`/`SetVisible` to the DSL so Sub-plan 2's dialogue (and scenes) can emit them; extend `apply_effect`/`build_effect` + the TS oracle apply.

## Architecture

- **`visible` on `CharacterSnapshot`** (Rust) + the TS `NonPlayerCharacter`/character serialize. The view builder (`view.rs`) filters invisible occupants out of `occupants`/`scope`; `run_mob_reactions`/`maybe_spawn` already skip non-mobs so NPCs don't fight/suppress-wrongly, but confirm an *invisible* character is also skipped by any occupant iteration that matters (targeting, encounter suppression).
- **Examine seam:** the CRT/PnC "examine" already routes to `session.read`. Extend the host `read`/`Authority.read` (or a sibling `examine`) so an occupant target resolves to the NPC and returns its description cue. Keep it free + non-advancing (like `read_item`). A new `Command::Examine`/reuse is a plan detail; the differential entrypoint mirrors `Command::Read`.
- **`Talk` dispatch:** resolve `npc_id` against the current room's visible `Npc` occupants; Sub-plan 1 wires resolution + the not-found error; Sub-plan 2 runs the dialogue behavior (via `npc_behavior_key` → `catalog.behaviors[key]` as the new `BehaviorScript::Npc` family) producing cues + effects.
- **Effects:** `GiveItem`/`SetVisible` join the closed `Effect` enum and the DSL `EffectTemplate`; `apply_effect` handles them; the TS oracle apply mirrors. `GiveItem`'s id-move keeps `World.items` reachability intact (no dangling refs).

## Determinism & the gate

- Pure, deterministic: visibility filter + id-move + flag set; no rng.
- The gate stays the authority: `submit.rs`/`oracle-session.ts` change in lockstep; differential fixtures cover: an invisible NPC is absent from the view/scope; `examine <npc>` returns the description cue; `talk` is non-advancing (round unchanged, no mob reaction); `GiveItem` moves the item (player gains it, NPC loses it, `items` array unchanged); `SetVisible` toggles presence. New `.gen.test.ts` registered in `conformance/fixtures/vitest.config.ts`.
- `no_std`, `bindings:check` (new `visible` field + effect variants regenerate), `checks:phase2` green.

## Non-goals (Sub-plan 1)

- No dialogue matching/content (Sub-plan 2), no caretaker/keyed-door content (Sub-plan 3).
- No revival of the full TS dialogue-prompt semantics yet (Sub-plan 2 brings `IDialogue` onto the gate path).
- `RemoveOccupant` is explicitly **not** added — visibility (reversible) replaces removal per the design.

## Invariant check

- **Gate is authority** — submit/oracle lockstep; new effects + visibility gated. ✅
- **Determinism / `no_std`** — pure, alloc-only. ✅
- **Serializable boundary** — `visible` + effect variants are serde/ts-rs data. ✅
- **First-party as data** — sets up NPC dialogue as `catalog.behaviors` data (Sub-plan 2) via the dormant `npc_behavior_key`. ✅
