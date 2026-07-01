# Rust Engine Core — Phase 1, Sub-plan 4a (Afflictions, Gating, seesInDark)

**Status:** Design approved, ready for implementation plan
**Date:** 2026-07-01

## Goal

Add the **turn-start affliction lifecycle**, **action gating**, and the **`seesInDark` seam** to
the Rust core — the turn-lifecycle half of combat. This is the first slice of sub-plan 4 (combat),
which decomposes into **4a** (this: afflictions/status tick + immunity + gating + seesInDark),
**4b** (attack/takeDamage/mitigation/durability/defeated-via-damage), and **4c**
(mobs/encounters/escape/drop-on-defeat + the deferred room-BFS reconciliation).

4a owns the **turn-start RNG frame** that every subsequent combat mechanic sits inside, so it must
land first and be byte-deterministic. The current `start_turn` is a partial, hardcoded-JSON stub;
4a **replaces** it (does not extend it) — extending it would desync the recorded RNG sequence.

Parent specs:
- `docs/superpowers/specs/2026-06-30-rust-engine-core-design.md`
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-world-foundation-design.md`
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-2-turn-loop-movement-design.md`
  (cue model, command-stream gate, `roll`/dice, `start_turn`)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-3a-descriptor-catalog-items-projection-design.md`
  (catalog, `resolve_item`, `effective_stat`, widened `view` — including the item `immunities`
  inert field 4a now consumes)
- `docs/superpowers/specs/2026-06-30-rust-engine-phase-1-subplan-3b-item-actions-design.md`
  (`use`/`grantsImmunity` deferral, command dispatch, `replay_commands` widened `view`)

Builds on `design/rust-engine-core` @ `a0200b2` (sub-plans 1+2+3a+3b complete & merge-ready).

TS oracle: `src/lib/character/afflictions.ts` (the authoritative source — mirror it exactly),
`src/lib/status.ts` (the `Status` enum), `src/lib/character/character.ts` (`attemptAction`,
`start`/`startTurn`, `seesInDark`, `requireVisibleTarget`), `packages/play-runtime/src/viewmodel.ts`
(`defeated` = `status.includes(Status.KO)`), `src/lib/dice.ts` (`roll`).

## Scope

### In scope

1. **Typed `Afflictions` state** — promote the snapshot's `afflictions` field from inert
   `serde_json::Value` to a typed, ts-rs-exported struct; give `Status` its own binding. This
   reverses the sub-plan-2 inert-Value stopgap now that the field is live and mutated.
2. **`start_turn` rewrite** — the full `onTurnStart` tick (clear rolls → `apply_from_stats` →
   immunity decrement), replacing the partial stub.
3. **Action gating** — a shared gate (block/fizzle) mirroring `Afflictions.gate`, wired into the
   budgeted commands at the point TS calls `attemptAction`.
4. **`grantImmunity`** — activates the 3b-deferred `use`-path `grantsImmunity`: a `use` of an item
   whose descriptor carries `grantsImmunity` grants timed immunity before the item is consumed.
5. **`passiveImmune` sourcing** — computed each tick from archetype immunities (the previously inert
   `archetype_immunities` snapshot field) ∪ equipped items' catalog `immunities` (the previously
   inert 3a descriptor field).
6. **`seesInDark` seam** — replace the hardcoded `let sees_in_dark = false` in the `items_actions.rs`
   take-gate with `World::sees_in_dark(actor)` reading a character property (base `false`).
7. **`defeated` view un-deferral** — `view()` emits `defeated` (= `active[KO]`) on occupants + scope
   entities; the conformance `viewProjected` helper stops stripping `defeated`.
8. **Conformance** — a bespoke afflictions campaign + seeded differential gate.

### Out of scope (deferred)

- **`attack` / `takeDamage` / mitigation / durability decrement / reaching KO via damage** → **4b**.
  4a implements the KO *gate* and the `apply_from_stats` reconcile that *sets* KO from `health≤0`,
  but the normal path to that state (damage) is 4b. 4a fixtures reach KO by seeding `health≤0`.
- **Mobs / `lightAverse`-true / `seesInDark`-true / escape / encounters / drop-on-defeat** → **4c**.
- **Room-BFS `to_snapshot` reachability reconciliation** → **4c** (carried from 3b; dormant).
- **Mechanic hooks** (`TRANSFORM_DAMAGE`, `DISPATCH_TURN`, `RECORD_ENCOUNTER`) → **sub-plan 6**;
  they keep their existing no-op call sites.
- **`is_lit` widening for equipped/carried light sources** — tied to light items with no player
  intent; stays deferred. `is_lit` continues to read room `dark` + placed `light_source_ids`.
- **`i64`→`bigint` binding decision + `ts(optional)` retro-fix** — pre-Phase-2 binding pass.

## Data model

New file `crates/wickedways-core/src/world/afflictions.rs`:

```rust
// Status: the 4 statuses. serde rename_all = "lowercase" → "panic","fear","confused","ko".
enum Status { Panic, Fear, Confused, Ko }

// The three clearable (non-KO) statuses. CLEARABLE order = [Panic, Fear, Confused] — this order
// IS the turn-start RNG contract. Modeled as Status values; KO is rejected at the clearable seams.

struct Afflictions {
    active:       BTreeMap<Status, bool>,  // SERIALIZES ONLY true entries (TS Partial<Record<Status,bool>>)
    turns_active: BTreeMap<Status, i64>,   // clearable keys only
    shaken_off:   Vec<Status>,             // clearable keys only (a set; deterministic order = CLEARABLE order)
    immunity:     BTreeMap<Status, i64>,   // clearable keys only
}

struct ClearOdds { base: i64, increment: i64 }
struct AfflictionConfig {
    clear: BTreeMap<Status, ClearOdds>,    // Fear{40,30}, Panic{20,20}, Confused{15,15}
    confused_fail_chance: i64,             // 50
}
```

**Serialized-shape fidelity (byte-for-byte vs `Afflictions[SERIALIZE]`):**
- `active` contains **only statuses whose value is true** (TS builds `active` by
  `for (const [s,on] of #active) if (on) active[s] = true`). An all-normal character serializes
  `active: {}`.
- `turnsActive`, `shakenOff`, `immunity` carry **clearable keys only** and use **lowercase** status
  strings. Empty collections serialize as `{}` / `[]` (never absent).
- `shakenOff` is a set in TS (`[...#shakenOff]`, insertion order). To stay deterministic and match,
  the Rust `shaken_off` is emitted in **CLEARABLE order** (`[Panic, Fear, Confused]` filtered to
  members); the differential gate confirms this against the oracle, and the comparator may treat it
  as an unordered set (like `equippedNames`) if insertion vs CLEARABLE order ever diverges.

The snapshot's `afflictions` field changes type from `Value` to `Afflictions`; `Status` and
`Afflictions` gain ts-rs bindings (drift-checked). `archetype_immunities` stays as-is for now
(read as a `Vec<Status>` for `passiveImmune`; keep its existing serialized shape — confirm against
the TS archetype-immunity serialization in the plan).

## Turn-start lifecycle (`start_turn` rewrite)

Rewrite `World::start_turn` to mirror `Afflictions.onTurnStart` **exactly**, in this order:

1. `actions_this_round = 0` (unchanged).
2. **Clear rolls** — `for s in [Panic, Fear, Confused]`: if `!active[s]` continue; else
   `turns = turns_active[s] + 1; turns_active[s] = turns;`
   `p = clamp(base + increment * (turns - 1), 0, 100);`
   **`if roll(100, rng) <= p { shaken_off.insert(s) }`**.
   This yields 0–3 rng draws, one per *active* clearable, in `[Panic, Fear, Confused]` order — the
   determinism contract. `roll(n, rng)` is the existing `dice.rs` fn (proven equal to TS in 1–2).
3. **`apply_from_stats(effective, passive_immune)`** (pure — no rng, no timer mutation):
   - `effective.health ≤ 0` → `active[KO]=true`, `clear_episode` every clearable, **return**.
   - else `active[KO]=false`, then `resolve`:
     - `Panic`  ← `effective.sanity ≤ 0`
     - `Fear`   ← `effective.sanity > 0 && effective.sanity < 5`
     - `Confused` ← `effective.energy ≤ 0` (apply); `effective.energy > 1` (clear); `(0,1]` is a
       **hold band** (leave as-is) — except if immune in-band, `clear_episode(Confused)` (the
       documented hysteresis: does NOT re-apply until energy drops to ≤0 again).
   - `resolve(s, below)`: if `immune(s) || !below` → `clear_episode(s)`; else
     `active[s] = !shaken_off.contains(s)`.
   - `clear_episode(s)`: `active[s]=false; shaken_off.remove(s); turns_active[s]=0`.
   - `immune(s)` = `passive_immune.contains(s) || immunity[s] > 0`.
4. **Immunity decrement** — `for (s, remaining) in immunity`: `remaining ≤ 1` → delete; else `-= 1`.

`effective` = `{ health: effective_stat(actor, Health), sanity: …Sanity, energy: …Energy }`
(reuse the 3a `effective_stat`). `passive_immune` = archetype immunities ∪
{ each equipped item's resolved catalog `immunities` }, computed once before step 2.

> **Determinism trap:** the stub's hardcoded in-place `turnsActive` increment is DELETED, not
> extended. Any future custom-affliction logic must replace this path, never append rolls to it.

## Action gating

`World::gate(actor, is_move) -> GateVerdict` mirrors `Afflictions.gate`, called where TS calls
`attemptAction`. Precedence:

1. `active[KO]` → `block("Cannot act while KO'd.")`
2. `active[Panic] && !is_move` → `block("Panicked: can only move.")`
3. `active[Fear] && is_move` → `block("Too afraid to move.")`
4. `active[Confused]` → **`if roll(100, rng) <= confused_fail_chance { fizzle }`** — the only rng
   draw during an action, only when Confused is active.
5. else `allow`.

**Block vs fizzle observable:** both mean the action does not occur. The plan MUST pin, against the
TS `attemptAction` return path (`character.ts`), the exact observable for each: whether budget
(`actions_this_round`) ticks, whether a cue is emitted, and whether it is a silent no-op vs a
`ProceduralViolation`. The differential gate is the authority; the fixture exercises both.

**Command gate policy (preserves each method's budgeted/free identity):**

| Command | Gates? | `is_move` | Notes |
|---|---|---|---|
| `Go` | yes | `true` | Fear blocks; Panic allows |
| `Take` | yes | `false` | Panic blocks; visibility gate too |
| `Drop` | yes | `false` | Panic blocks |
| `Use` | **no** | — | always-allowed escape hatch (immunity potion usable under any affliction) |
| `Equip`/`Unequip`/`Open` | no | — | free (no budget, no gate) — unchanged from 3b |
| `StartTurn`/`EndTurn`/`NextPlayer` | no | — | lifecycle, not actions |
| `Attack` | (4b) | `false` | out of scope here |

## seesInDark seam

Replace the hardcoded `let sees_in_dark = false;` in `items_actions.rs` `take` with
`World::sees_in_dark(actor)` reading a character property. Base characters → `false`, so 4a behavior
is unchanged (players never see in dark); the seam lets 4c's `Mob(lightAverse)` flip it. `is_lit`
is unchanged (room `dark` + placed light sources only).

## `defeated` view un-deferral

`view()` emits `defeated` (= `active[KO]`) on occupants and every scope entity. The conformance
`viewProjected` helper (in the fixture generators) **stops stripping `defeated`**. `exits` /
`lockedDoors` remain stripped (sub-plan 6 territory). The plan MUST verify against `viewmodel.ts`
whether the PC's top-level `status` object also surfaces an active-status list; if so the view
widens to match, otherwise per-entity `defeated` is the only view change.

## Conformance

A bespoke **afflictions** campaign (inline generator under the isolated fixtures config), seeded
`rng` for deterministic d100 rolls:

- A player seeded with effective stats below thresholds — e.g. `sanity=0` (→Panic), `energy=0`
  (→Confused) — so afflictions latch on the first `apply_from_stats`. A second player seeded at
  `health≤0` to prove the KO gate + `defeated`.
- An item whose descriptor carries `grantsImmunity` (statuses + turns) to prove grant/clear.
- A command stream driving the engine **directly** (as sub-plans 2/3b did — one action per command,
  explicit `StartTurn`/`NextPlayer`; NOT `GameSession.execute`): repeated turn cycles to tick
  `turnsActive` + exercise clear-rolls + immunity decrement; a `Use` of the immunity item; gated
  `Go`/`Take` under Panic/Fear/Confused to observe **block** and **fizzle** (with the fizzle rng
  draw landing in the correct sequence); the KO character proving the KO block + `defeated`.
- The differential gate diffs `{cues, snapshot, view}` byte-for-byte via `replay_commands`. The
  snapshot now carries typed `afflictions`; the view carries `defeated`.
- **Self-validating generator:** assert ≥1 active affliction, ≥1 `shakenOff`, an immunity grant
  that clears an episode, a **block**, a **fizzle**, and a **KO/`defeated`** — else throw.
- Isolation discipline (per the standing rule): register the new gen test in the fixtures vitest
  config; run `fixtures:gen`; restore any pre-existing fixtures it clobbers
  (seed/hollow-house/turn-movement/items-projection/items-actions); commit only the new
  `afflictions.*` files + config/gate edits. Never touch `packages/seed`.

## Testing

- **Rust unit tests:** clear-roll order + formula (seeded rng, multiple active clearables to prove
  `[Panic,Fear,Confused]` order); `apply_from_stats` threshold table (KO, Panic, Fear band,
  Confused `≤0` / `>1` / hold-band / immunity-in-band hysteresis); immunity decrement + expiry;
  `grantImmunity` refresh-to-max + episode reset + KO-ignored; `gate` precedence + Confused fizzle
  (seeded); `passive_immune` from archetype ∪ equipped-item immunities; `defeated` in the view;
  serialized shape (`active` only-true, clearable-only maps, lowercase keys, empty `{}`/`[]`).
- **Differential conformance:** the afflictions command stream (cues + snapshot + view), exact
  canonical-JSON equality; plus the existing gates staying green under the `afflictions`-typed
  snapshot + `defeated`-carrying view (regenerate goldens where the shape widened).
- **ts-rs drift:** `Afflictions` + `Status` bindings regenerate; `bindings:check` clean.
- `checks:phase3` is the whole-suite gate (no_std build + `cargo test --workspace` +
  `bindings:check` + `test:conformance`).

## Risks & open questions

- **Turn-start roll order** is the primary determinism trap — the fixture MUST have multiple active
  clearables simultaneously to prove `[Panic, Fear, Confused]` ordering (dormant with ≤1 active).
- **Serialized-shape parity:** `active`-only-true, clearable-only maps, empty-`{}`-vs-absent, and
  `shakenOff` set order. Pin each against `Afflictions[SERIALIZE]`; the gate is the authority.
- **Block-vs-fizzle observable** (budget tick / cue / no-op vs throw) — pin against `attemptAction`.
- **`archetype_immunities` shape** — confirm the TS serialization and read it as `Vec<Status>` for
  `passive_immune` without changing its wire shape (or promote it too if cleaner — decide in plan).
- **View status surface** — confirm whether `viewmodel.ts` exposes an active-status list on the PC
  status object beyond per-entity `defeated`; widen the Rust view to match if so.
- **Regenerating existing goldens** — the `afflictions` field type change + `defeated` un-strip is a
  cross-fixture change; regenerate all goldens atomically and restore any unintended clobbers.

## Carried-forward notes honored / created here

- **Replaces** (not extends) the `start_turn` affliction stub — the rng-desync trap from the 3b
  final review.
- **Consumes** two previously-inert fields: item `immunities` (3a catalog) + `archetype_immunities`.
- **Activates** the 3b-deferred `use`-path `grantsImmunity`.
- **Un-defers** the `defeated` view field (stripped since 3a).
- Carries forward to **4b**: attack/takeDamage/mitigation/durability/reaching-KO-via-damage.
- Carries forward to **4c**: mobs/`lightAverse`(seesInDark-true)/escape/encounters/drops + the
  room-BFS `to_snapshot` reconciliation.
- `i64`→`bigint` + `ts(optional)` retro-fix remain the pre-Phase-2 binding pass.
