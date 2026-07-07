# Light-Tied Mob Initiative (v1: no ambush on entering a lit room)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-07
**Branch:** `design/rust-engine-core`
**Related:** the Phase-2 single-player cutover (`2026-07-06-rust-engine-phase-2-single-player-cutover-design.md`) — this refines the ported `runMobReactions`/`submit` combat orchestration.

## Goal

Stop a mob from getting a free "ambush" swing when the player simply **walks into a lit room**. Give the player initiative on entry when they can see — so entering a lit room means *you* choose the first move (assess, strike, or leave) instead of eating a hit you had no counter to.

## Background — why this is a one-rule change

The desired "hunter/prey" combat feel was brainstormed as a full initiative model (light → player acts first and can pre-empt; dark → the mob is the aggressor). Tracing it against the shipped `run_mob_reactions` (`crates/wickedways-core/src/world/submit.rs`) showed **almost all of that model already exists**:

| Desired behavior | Already true? | Why |
|---|---|---|
| A killing blow denies the mob's counter | ✅ | `run_mob_reactions` skips KO'd mobs |
| Fleeing denies the mob's swing | ✅ | reactions run against the player's **post-action current room**, so a mob you moved away from is no longer co-located |
| Loitering (wait/take/use) next to a live mob still gets you hit | ✅ | non-move actions provoke a reaction |
| A dark-dwelling (light-averse / sees-in-dark) mob ambushes you on entry | ✅ | it can see you in the dark; a *normal* mob can't, so a lightless dark room is already a mutual standoff |
| **Entering a *lit* room does NOT provoke a free swing** | ❌ | **the one gap** — a move currently always provokes a reaction against the destination room |

So the entire felt fix is a single rule:

> **Skip mob reactions on a time-advancing *move* whose destination room is lit.**

Everything else (pre-emption, loiter-trades, dark ambush) is unchanged existing behavior.

## The rule (v1)

Inside the ported `execute`/`submit` orchestration, mob reactions currently fire after **every** time-advancing action. Change that to:

```
reactions fire  ⟺  action advances time  AND  NOT (action is a Move into a lit room)
```

- **"Move"** = the `move` intent (the only intent that changes rooms).
- **"lit"** = `is_lit(destination_room, catalog)` — the player's current room *after* the move resolves. `is_lit` already accounts for the player's own equipped lantern (occupant-carried light), fixed room light sources, and other occupants' light, so "I walked in carrying a lit lantern" correctly reads as lit.
- All other time-advancing intents (attack, wait, take, drop, use, talk) are unaffected — reactions fire exactly as today.
- A move into a **dark** room still provokes: a light-averse mob ambushes; a normal mob can't see you (existing standoff). No change there.

### Resulting semantics (light vs dark × action)

| Your action | Lit room | Dark room |
|---|---|---|
| **Move** (enter/flee) | **no reaction** (you got the drop) — *the change* | reaction fires (light-averse mob ambushes; normal mob can't see) |
| **Attack** | strike first; kill → no counter; live → counters (unchanged) | impossible (dark-combat gate throws) |
| **Wait / take / drop / use / talk** | live mob counters after your action (unchanged) | mob strikes if it can see (unchanged) |

## Architecture

The mob-reaction *orchestration* (deciding whether to run `runMobReactions`) lives in two places that must change **in lockstep**; the underlying combat/damage engine is untouched.

1. **Rust core — `crates/wickedways-core/src/world/submit.rs`, `World::submit`.**
   Today: `mob_attacks = if advances { run_mob_reactions(...) } else { Vec::new() }`.
   New: also skip when the intent is `Intent::Move` and `is_lit(current_room_after_move, cat)` is true. On a skip, `mob_attacks` is the empty success vector (`Some(vec![])`) exactly as a no-mob action produces today. `next_player`/turn-wrap still runs (a move still advances time).

2. **Frozen gate oracle — `conformance/fixtures/oracle-session.ts`, `execute()`.**
   Today: `const mobAttacks = advances ? this.runMobReactions() : []` (:98). Apply the same skip condition using the TS engine's `Room.isLit` getter on `pc.currentRoom` (post-move). This keeps the oracle and the core defining the *same* behavior, so the regenerated goldens encode the new rule and the differential gate stays meaningful.

3. **Live app — no change.** `packages/play-runtime/src/session.ts` `GameSession.execute` delegates to `Authority.submit` (the cutover removed its local `runMobReactions`), so the live browser build inherits the fix from the Rust core automatically.

## Determinism & the gate

- **Determinism is unchanged.** The rule is a pure branch on `is_lit` + intent kind; no new randomness, no ordering nondeterminism.
- **The gate stays the authority.** This is a *deliberate behavior change to the oracle*, not a golden hack: we change `oracle-session.ts`, then **regenerate** the affected facade goldens from it (never hand-edit a golden), and the Rust core must reproduce the regenerated goldens byte-for-byte. Any facade golden whose command stream includes a move into a lit, occupied room will legitimately lose that step's entry `mobAttack` — the plan enumerates and regenerates them.
- **New differential coverage** (per the gate methodology — oracle drives, Rust replays):
  - **lit-entry-no-ambush:** player with a lit lantern moves into a lit room holding a live mob → the entering step yields **no** mob attack; a subsequent `attack`/`wait` still trades. (The core assertion of this feature.)
  - **dark-entry-still-ambush (control):** a light-averse mob in a dark room still strikes on entry — proves the skip is scoped to *lit* moves only.
  - **attack/loiter-unchanged (control):** killing pre-empts; a non-lethal attack and a `wait` next to a live mob still draw a counter — proves nothing else regressed.
  - New `*.gen.test.ts` generators must be registered in `conformance/fixtures/vitest.config.ts` (explicit include list); replay harnesses are auto-discovered.

## Balance implications

Lit fights get one hit easier — you no longer eat the entry swing. Worked example (Revenant, lantern equipped, 12 Sanity): today you finish at ~2 Sanity; after this change ~4. This is an intentional easing of the exact feel-bad that motivated the change. Ship the rule first; retune mob stats only if a fight becomes trivial (none is expected to).

## Scope

- **Global engine rule.** Not a per-campaign or per-mob knob. A future per-mob "always ambushes" flag is possible if a designer ever wants a lit-room lurker, but it is out of scope here.

## Non-goals / deferred

Deliberately **not** in v1 — each only matters for **light-averse / sees-in-dark mobs, which no shipped campaign has yet**:

1. **Dark "mob strikes *before* your action"** (true mob-first ordering) — today a dark mob reacts *after* your non-attack action; reordering it to before would only change KO-timing when you `use`/heal in the dark next to a seeing mob. Deferred.
2. **A parting shot when you flee a dark room** — today fleeing escapes cleanly regardless of light. Deferred.
3. **Per-mob ambush override**, initiative for multiplayer, and any change to the underlying damage/mitigation math.

When a light-averse creature is actually authored, revisit (1) and (2) with their own spec.

## Edge cases

- **Move into a lit room with no mob:** reactions would return `[]` anyway; skipping is equivalent. No observable change.
- **Blocked move** (locked door / no exit): `dispatch` errors before reactions; unaffected.
- **Room lit by a fixed source or another occupant (incl. a mob carrying light):** `is_lit` is true → entry does not provoke. Acceptable and consistent ("you can see, so you get the drop").
- **Multi-mob lit room:** entry provokes none of them (skip is per-action, not per-mob); once you attack/loiter, all live mobs react as today.

## Testing strategy

- **Rust unit tests** in `submit.rs`: a move into a lit occupied room returns empty `mob_attacks` and leaves the mob unharmed/player unhit; a move into a dark room with a seeing mob still produces an attack; a non-move advancing action still triggers reactions.
- **Differential conformance fixtures** as above (the acceptance bar).
- **`checks:phase2`** green end-to-end, including the regenerated facade goldens.

## Invariant check

- **Gate is authority** — oracle (`oracle-session.ts`) and core changed in lockstep; goldens regenerated from the oracle, never hand-edited. ✅
- **Determinism** — pure branch on `is_lit` + intent kind. ✅
- **`no_std`** — `submit.rs` change is `alloc`-only; `--no-default-features` unaffected. ✅
- **Serializable boundary** — no schema change; `ExecuteResult`/`mobAttacks` shape unchanged. ✅
- **Scope** — one global rule; nothing else in the combat model moves. ✅
