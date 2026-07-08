# NPC Dialogue System — Sub-plan 3: Hollow House Caretaker Content

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-08
**Branch:** `design/rust-engine-core`
**Part of:** the NPC dialogue system (3 sub-plans). Depends on Sub-plan 1 (NPC foundation) + Sub-plan 2 (data-driven dialogue). This sub-plan is mostly **authoring** on top of that machinery, plus one differential fixture.
**Related:** keyed doors (`doorBehavior`), `createKey`, scenes (onEnter), the item/behavior/formation authoring precedents.

## Goal

Author the actual Hollow House experience: a **caretaker** NPC in the Foyer who, on **entering the Foyer**, is introduced by an automatic onEnter **scene**; **talking** to the caretaker hands over the **cellar key** (from the caretaker's inventory) and makes the caretaker vanish (visibility flip); and the **Foyer→Cellar** corridor becomes a **keyed door** that the cellar key opens. `examine caretaker` gives a physical description.

## Player experience (the target)

1. **Enter the Foyer (game start / on entry):** an onEnter scene narrates the caretaker's presence (atmosphere/introduction). The caretaker is a visible occupant.
2. **`examine caretaker`** → physical description (free, non-advancing).
3. **`talk to caretaker`** (bare, or a matching prompt like "cellar"/"how do I get out") → the caretaker hands you the **cellar key** and is **gone** (visibility flips false); response cue plays. Non-time-advancing. One-time (`once`).
4. **Foyer→Cellar** is a **keyed door**: locked until you carry the cellar key; the first pass unlocks it with the door's line. (The Revenant + iron key still live beyond it, unchanged.)

## Scope (Sub-plan 3 — authoring + one fixture)

- **The caretaker NPC:** seed an `Npc` occupant in the Foyer, `visible: true`, holding the `cellar-key` in its inventory, with `npc_behavior_key` → a `BehaviorScript::Npc` (Sub-plan 2) authored via the `npc({...})` builder: a `description` (for `examine`), and dialogue whose bare/`default` (and/or a "cellar" pattern) entry emits `GiveItem(caretaker → player, cellar-key)` + `SetVisible(caretaker, false)`, `once: true`, with a hand-off response line; optional extra prompt→lore entries for flavor.
- **The onEnter intro scene:** a Foyer scene that narrates the caretaker on entry (a `mechanic` cue). If it must run at game start (start-room), confirm/enable start-room enter-scene firing (a Sub-plan 1/3 detail); otherwise it plays on first arrival. The scene emits cues only (no new effects needed for the intro) — but note scenes gaining an effect channel is a possible dependency if the intro should also toggle visibility; the caretaker starts visible, so the intro is cue-only.
- **The keyed door + key:** add a `cellar-key` (`createKey`, `consumeOnUse: false` like brass/iron) and a `cellar-door` `doorBehavior(keyCode="cellar", ...)`; replace the current free Foyer↔Cellar corridor (declared both ways today) with a **single** keyed exit declaration (a reverse declaration would shadow the `behaviorKey`, per the existing door convention). Register the scripted door twin in `hollowHouseBehaviors()`. NOTE: the key comes from the NPC (not loot, not a mob drop) — the keys-in-loot ban is irrelevant; the caretaker's inventory + `GiveItem` deliver it.
- **Differential fixture** (the gate): drive the facade/HH oracle through: enter Foyer → intro cue; `examine caretaker` → description cue; `talk caretaker` → hand-off (cellar key received, caretaker invisible, response cue) + re-`talk`/re-`examine` shows the caretaker gone; then move Foyer→Cellar succeeds only with the key (locked without, unlocked with). Byte-identical Rust↔oracle.

## Balance / interaction with existing content

- The cellar now needs the caretaker's key. The **Revenant** (Cellar) + **iron key** (attic) path is unchanged beyond the added door. The capstone/winning path gains one step (get the cellar key from the caretaker before descending) — update the capstone test accordingly.
- Roving Rats + the Foyer NPC: `maybe_spawn` suppresses spawns while a live non-party occupant is present, and the Foyer has `spawnModifier: 0` — so rats won't spawn on the caretaker; after the caretaker turns invisible, confirm an invisible NPC does not wrongly count as an occupant for spawn suppression (Sub-plan 1's visibility filter should exclude it).

## Determinism & the gate

- Authoring-only + one differential fixture; the machinery (dialogue, effects, visibility, keyed door) is already gated by Sub-plans 1–2. The new fixture proves the *composed* caretaker flow end-to-end.
- `checks:phase2` green, including the updated capstone winning-path test and the new caretaker fixture; the manifest-boot guard covers the caretaker's `npc_behavior_key`/behaviors threading.

## Non-goals

- No new engine mechanics (all in Sub-plans 1–2). No additional NPCs/dialogue trees beyond the caretaker. No change to the Revenant/iron-key/attic win beyond the added cellar door.

## Invariant check

- **Gate is authority** — the composed caretaker flow diffed Rust↔oracle. ✅
- **First-party as data** — the caretaker is authored data (NPC dialogue script + door script + item/key + scene), zero new engine code. ✅
- **Docs** — README (NPCs/dialogue + the caretaker) updated per convention. ✅
