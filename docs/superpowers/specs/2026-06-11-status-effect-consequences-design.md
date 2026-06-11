# Status Effect Consequences — Design

**Date:** 2026-06-11
**Status:** Approved (design)

## Summary

Today the four statuses — **KO**, **Panic**, **Fear**, **Confused** — are pure
derivations of a character's effective stats (`Character.#resolveStatuses`): they
are recomputed on every damage event and turn boundary, and clear the instant the
underlying stat recovers. They are observable flags with **no mechanical
consequence**.

This design gives them consequences:

| Status   | Trigger (effective stat) | Consequence |
|----------|--------------------------|-------------|
| KO       | Health ≤ 0               | No actions at all — not even `use`. Clears only on revival (Health > 0). |
| Panic    | Sanity ≤ 0               | Only `move` (and `use`) allowed; every other action is blocked. |
| Fear     | 0 < Sanity < 5           | `move` is blocked; everything else allowed. |
| Confused | Energy ≤ 0 (hysteresis)  | Any gated action has a chance to **fizzle** (no effect; a recordable action still consumes a budget slot, a free action just no-ops). |

Two further rules:

- **KO wipes the rest.** When a character KOs, Panic / Fear / Confused are cleared.
- **Self-clearing.** Every status *except KO* gets an increasing per-turn chance to
  clear early while its stat is still depleted (a percentile "shake it off" roll).

Plus a new immunity path: **timed, consumable-granted immunity** to Panic / Fear /
Confused.

## Motivation

The status system is currently inert. Combat depletes stats, statuses light up, but
nothing changes about what a character can do. These consequences turn the
Health/Sanity/Energy economy into a system with teeth: depleting an opponent's
Sanity now strips their options, not just a flag.

## Architecture

### The `Afflictions` unit (Approach B)

`character.ts` is already ~27K and owns a great deal. Rather than grow it further,
the status lifecycle moves into a dedicated, independently testable unit.

**New file:** `src/lib/character/afflictions.ts`

`Character` stops owning the raw `#status` matrix and delegates to one `Afflictions`
instance. `Character.status` / `Character.isNormal` read through it.

**State it owns:**

- `active: Map<Status, boolean>` — the current status matrix.
- `turnsActive: Map<Status, number>` — how many of the character's turns each non-KO
  status has been latched. Drives the clearing probability.
- `shakenOff: Set<Status>` — statuses an early roll cleared *while the stat is still
  depleted*; suppressed until the stat recovers above threshold.
- `immunity: Map<Status, number>` — turns of immunity remaining per status.

**Public API (consumed by `Character`):**

- `applyFromStats(effective)` — pure reconciliation of the flags from current
  effective stats. Replaces today's `#resolveStatuses` body; called from the same
  three sites (`takeDamage`, `startTurn`, `endTurn`). No RNG, no timer mutation.
- `onTurnStart(rng)` — the time-based step: tick immunity timers down, increment
  `turnsActive`, run clearing rolls, then reconcile. Called from `Character.startTurn`.
- `gate(isMove)` — returns `"allow" | "block" | "fizzle"` for an attempted action.
- `[GRANT_IMMUNITY](statuses, turns)` — symbol-gated seam so only sanctioned paths
  (consumable `use`) can grant immunity, matching the engine's other protected seams.
- `get list(): Status[]` / `get isNormal(): boolean` — surfaced through `Character`
  unchanged from today's public shape.

### RNG injection

`Character` takes an optional `rng: () => number = Math.random` constructor option —
the same injectable-RNG pattern `buildMap` already uses — and hands it to its
`Afflictions`. Tests inject deterministic sequences; production defaults to
`Math.random`.

### Dice primitive

**New file:** `src/lib/dice.ts`

```ts
roll(sides = 100, rng = Math.random): number   // integer in [1, sides]
```

A small, reusable die helper. Default is **d100**, so status clearing calls
`roll(100, rng)`. The `sides` parameter is parameterized for future call sites
(e.g. character creation rolling `roll(6)` / `roll(20)`), but status clearing always
uses d100 — keeping the odds table a clean percentage and avoiding granularity
issues from mixing arbitrary die sizes into probabilities.

## Status lifecycle

All thresholds read the **effective** stat (base + equipped accessory modifiers), as
they do today.

### Reconciliation (`applyFromStats`)

Per non-KO status `S` with threshold predicate `P(S)`:

- **Immune to `S`** → `active[S] = false`; does not latch.
- **Above threshold** (`¬P(S)`) → `active[S] = false`; clear `shakenOff[S]`; reset
  `turnsActive[S] = 0` (the episode is over).
- **Below threshold & shaken-off** → `active[S] = false` (suppressed this episode).
- **Below threshold & not shaken-off** → `active[S] = true` (latched on).

Confused keeps its existing `(0, 1]` hysteresis dead-band on the *apply* direction
(set at ≤ 0, cleared above 1) to avoid flickering as effective Energy oscillates.

### KO precedence

KO is resolved last and overrides the rest:

- Effective Health ≤ 0 → `active[KO] = true`, and Panic / Fear / Confused are wiped
  (`active`, `turnsActive`, `shakenOff` all reset for those three).
- Effective Health > 0 → `active[KO] = false`.

KO has **no clearing roll and no shaken-off state**; it clears only when Health rises
above 0 (revival = healing). Immunity timers are not affected by KO.

### Clearing rolls (`onTurnStart`)

After ticking immunity timers, for each active non-KO status whose stat is still
below threshold:

1. increment `turnsActive[S]`
2. `p = clamp(base[S] + increment[S] × (turnsActive[S] − 1), 0, 100)`
3. if `roll(100, rng) ≤ p` → add `S` to `shakenOff` (goes inactive this turn even
   though the stat is still depleted)

Then `applyFromStats` reconciles.

A status first applied mid-turn (via `takeDamage`) has `turnsActive = 0`; on the
character's next `startTurn` it becomes 1 and rolls at `base` — so the chance
increases on *subsequent* turns, as intended.

### Configuration

A module-level `DEFAULT_AFFLICTION_CONFIG`, overridable via a `Character` option.
Values are integer percentages (1:1 with d100):

| Status   | base | increment / turn | guaranteed clear by |
|----------|------|------------------|---------------------|
| Fear     | 40   | 30               | turn 3              |
| Panic    | 20   | 20               | turn 5              |
| Confused | 15   | 15               | ~turn 7             |

Plus `confusedFailChance: 50` — the per-action fizzle chance, **separate** from
Confused's clear odds.

## Action gating

A single `gate(isMove)` checkpoint at the top of each gated method. `use` never calls
it (always allowed) — except that KO blocks everything, which is covered because KO
is checked first.

**Resolution order** — hard blocks first, then the Confused fumble roll:

1. **KO active** → `block`.
2. **Panic active** and not `move` → `block`.
3. **Fear active** and `move` → `block`.
4. **Confused active** → `roll(100, rng) ≤ confusedFailChance` → `fizzle`.
5. otherwise → `allow`.

(A character can be both Panicked and Confused: the hard block is evaluated first, so
a Panicked+Confused character moving is allowed past the block, then may still fizzle
the move.)

**Outcomes:**

- `block` → throw `ProceduralViolation` (consistent with the engine's illegal-move
  convention).
- `fizzle` → record a fumble and abort the effect. For a **recordable** action this
  still consumes a budget slot (via the existing `recordAction` tick, which may end
  the turn); for a **free** action there is no budget to consume, so it is a no-op
  with no effect.
- `allow` → proceed normally.

**Gated method set:** `move`, `attack` (Combatant), `escape` (Mob),
`addToInventory`, `removeFromInventory`, `craft`, `equip`, `unequip`, `repair`,
`transferKey`.

**Not gated:** `use` (always allowed except under KO), and internal scene-driven
calls such as `consumeKey` fired by a scene script — gating governs a character's own
deliberate turn actions, not engine bookkeeping.

## Timed immunity

Immunity is granted only by consuming a consumable, and lasts a fixed number of the
character's turns. It covers **Panic / Fear / Confused only** — KO is not immunizable
(0 Health always downs you, and KO blocks `use` so it could not be applied
reactively anyway).

### Item authoring

A factory mirroring `createKey`:

```ts
createImmunityConsumable({ name, statuses, turns, ... })
```

builds a consumable whose `use` callback calls `holder[GRANT_IMMUNITY](statuses, turns)`.
The existing `use` path consumes (removes) the item afterward. Routing through the
symbol seam keeps grants unforgeable.

### Lifecycle

- `[GRANT_IMMUNITY](statuses, turns)` sets `remaining = max(current, turns)` per
  status (refresh to the longer), and resets that status's episode state
  (`active = false`, clear `shakenOff`, `turnsActive = 0`) so it restarts fresh when
  immunity lapses.
- `onTurnStart` decrements each timer; at 0 it expires. "N turns" = active for the
  character's next N turns.
- While immune, `applyFromStats` forces the status off and won't latch it. When
  immunity lapses with the stat still depleted, the status applies fresh on the next
  reconciliation.

## Testing

The project's TDD discipline is strong (57K of `character.test.ts`); this follows it.

- **New `afflictions.test.ts`** — lifecycle with injected deterministic `rng`:
  - latch on crossing threshold; clear on stat recovery
  - shaken-off via a forced clearing roll; suppression until stat recovers
  - clear-odds boundary math (`turnsActive` → `p`, including clamp at 100)
  - KO precedence wiping Panic / Fear / Confused
  - immunity suppress + expiry, and fresh re-application after lapse
- **New `dice.test.ts`** — `roll` bounds `[1, sides]`, default d100, deterministic
  under injected `rng`.
- **`character.test.ts` additions** — gating:
  - Panic blocks attack/craft but allows `move` and `use`
  - Fear blocks `move`, allows others
  - KO blocks everything, including `use`
  - Confused fizzle costs a budget slot for a recordable action, no-ops a free
    action — both under deterministic `rng`
  - `use` of an immunity consumable while Panicked/Confused succeeds and suppresses
    the status

## Out of scope

- **Passive (equipment-worn) immunity** — explicitly dropped in favor of timed
  consumable immunity. A future spec could add it.
- **A generalized per-status "X+ on a dY" die-size system** — the `roll` helper is
  reusable, but status clearing stays percentage-vs-d100.
- **General timed-effect framework** — the immunity timer is a narrow, purpose-built
  map, not a generic buff/duration system.
- **Revival mechanics / healing items** — KO clears when Health rises above 0 via
  whatever existing path restores stats; no new healing mechanic is introduced here.
