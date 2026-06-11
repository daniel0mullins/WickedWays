# Mob Encounters & Loot — Design

**Status:** Approved (brainstorm)
**Date:** 2026-06-11

## Goal

Give mobs a real combat lifecycle: they can attempt to flee (and fail), they
drop loot when defeated, they can be placed directly in rooms, and "roving"
formations attached to the campaign can ambush the party as it explores.

## Scope

Four cohesive parts, all centered on the `Mob`/encounter concept:

1. **Randomized escape** — `escape()` becomes a Health-gated roll instead of an
   always-succeed, take-the-first-exit move.
2. **Drop-on-defeat** — a mob distributes its drops automatically the instant it
   is KO'd: items into a room loot box, materials into the campaign pool, key
   items into the loot box (room-attached mobs only).
3. **Room-attached mobs & origin** — mobs can be placed directly in a room and
   know they are room-attached vs. campaign-roving; origin gates key-item drops.
4. **Roving formations** — a dedicated `EncounterTable` owns weighted formations
   that spawn on first room entry, scaled by a per-room danger attribute.

## Architecture

A new focused unit, `EncounterTable`, owns the encounter machinery (formations,
weighted selection, spawn-chance roll, visited-room tracking). `Campaign`
composes one and exposes a thin `maybeSpawn(room)` / `addFormation(formation)`
surface, keeping the already-large `Campaign` class free of spawn logic.

All randomness routes through the existing `roll(sides, rng)` dice primitive and
injected `rng`, so every outcome is deterministic under test. `Campaign` gains
an injected `rng` (new) that drives spawn checks, formation selection, and the
mobs it mints.

Unforgeable state transitions use the existing symbol-seam pattern (`CLAIM`,
`DEPOSIT_MATERIALS`, …). Two new symbols are introduced:

- `SET_ORIGIN` — sets a mob's origin (`"room"` | `"campaign"`); only `Room`
  placement and `EncounterTable` spawning call it.
- `STASH_DROP` — places an item (including a key) into a `Loot` box on the
  defeat path, bypassing the player-facing "no keys in loot" guard.

---

## Part 1 — Randomized escape (Health-gated)

`Mob.escape()` resolves a roll rather than always succeeding.

- **Constructor option:** `baseEscapeChance?: number` (default `50`), threaded
  through `options` alongside `rng`/`afflictionConfig`.
- **Threshold:** `clamp(baseEscapeChance + effectiveStat(Health), 0, 100)`. A
  wounded mob flees worse; a 0-Health mob is already KO'd and never reaches the
  escape path.
- **Resolution:** `roll(100, rng) <= threshold` → success.
- **Exit choice:** on success, pick a random available exit via
  `roll(exits.length, rng) - 1` (not always the first exit).
- **Failure cost:** whether the roll fails *or* there are no exits, the mob stays
  put and the escape is still recorded (the action budget ticks). The roll
  fizzle/block from the affliction gate runs first and is unchanged.
- **History:** the `escape` entry gains a success flag —
  `{ kind: "escape"; success: boolean }`.

### Ordering

1. Affliction gate (`attemptAction(this.escape, false)`) — may block (throw) or
   fizzle (record fumble, return) exactly as today.
2. Compute threshold from `baseEscapeChance + effective Health`.
3. Roll. On failure, record `{ kind: "escape", success: false }` and return.
4. On success with an available exit, pick a random exit, move
   (gate-suppressed), and record `{ kind: "escape", success: true }`.
5. On success with no exits, record `{ kind: "escape", success: false }`.

---

## Part 2 — Drop-on-defeat (automatic, on KO)

When a mob's `Status.KO` **newly latches**, the engine distributes its drops
exactly once.

### KO-transition hook

`Character.#reconcile()` captures KO membership before and after
`applyFromStats`. On a `false → true` transition it calls a
`protected onKnockOut()` hook (default no-op). `Mob` overrides it to drop loot.
Player characters do not override — the party drops nothing on KO.

The constructor's initial reconcile establishes the baseline **without** firing
the hook, so a mob built already-dead does not dump loot at construction. (The
guard is "fire only on a transition observed after construction completes.")

### What drops

- **Items:** the mob's inventory at death. The constructor `drops: IItem[]`
  already live in the inventory; anything the mob is carrying is lootable.
- **Materials:** a new constructor option `materialDrops?: MaterialMap`
  (default `{}`).

### Distribution

- **Regular items** → a new `Loot` box is created in the mob's current room
  (`room.loot`). Players collect via the existing `takeFromLootBox` flow
  (co-location + slot limits already enforced).
- **Key items** → stashed into that same loot box via the new `STASH_DROP`
  seam, which bypasses the player-facing key guard. Taking the key routes it to
  the keyring (`receiveItem` already does this). Only mobs with
  `origin === "room"` reach this branch.
- **Materials** → deposited to the campaign pool via the existing
  `campaign[DEPOSIT_MATERIALS](materialDrops)`.

### Edge cases

- Mob KO'd while in **no room**: no loot box is created (nowhere to put it);
  materials still deposit to the campaign pool.
- **Empty** item drop set: no loot box is created.
- A roving mob (`origin === "campaign"`) carrying a key item cannot occur,
  because `addFormation` rejects it at authoring time (Part 4). The
  `origin === "room"` check on the key branch is belt-and-suspenders.

---

## Part 3 — Room-attached mobs & origin tracking

A mob must know whether it is room-attached or campaign-roving, because that
gates key-item drops.

- **Origin field:** `Mob` holds a private origin
  (`"room" | "campaign" | "unbound"`, default `"unbound"`), set only through the
  `SET_ORIGIN` symbol seam. No public setter.
- **Room placement:** `room.placeMob(mob)` registers the mob as a resident —
  sets `mob.currentRoom = room`, adds it to occupants, and calls
  `mob[SET_ORIGIN]("room")`. `Room` also accepts residents at construction via a
  `mobs: Mob[]` parameter that runs the same placement path. Room-attached mobs
  persist and are "battled until KO'd."
- **Drop gate:** the Part 2 key branch only fires when `origin === "room"`.

---

## Part 4 — Roving formations & the EncounterTable

### Formation shape

```ts
interface Formation {
  id: string;
  weight: number;                  // relative selection weight
  build: (campaign: ICampaign) => Mob[]; // mints FRESH mobs each spawn
}
```

`build` is a factory because a reusable weighted pool cannot hand out the same
KO'd instances twice. It injects the campaign rng into every mob it builds.

### EncounterTable

Owns:

- the formation list,
- weighted random selection (`roll` against the cumulative weight),
- the spawn-chance roll,
- the visited-room set (first-visit tracking).

### Campaign changes

- New `options.rng` (drives spawn checks, selection, and minted mobs).
- New `baseEncounterChance: number` (e.g. `20`).
- Composes one `EncounterTable`.
- `campaign.addFormation(formation)` delegates to the table.
- `campaign.maybeSpawn(room)` delegates to the table; called by
  `PlayerCharacter.move`.

### Authoring rejection (key-item rule)

`addFormation` mints one **sample** via `build`, inspects the produced mobs'
drops, and throws a `ProceduralViolation` ("roving mobs cannot drop key items")
if any drop is a key. Samples are discarded — mob construction has no global side
effects. This implements the "reject at authoring" decision.

### Room danger attribute

`Room` gains `spawnModifier: number` (default `1`), set at construction:
`0` = safe (never spawns), `1` = normal, `>1` = more dangerous.

### Spawn flow

`PlayerCharacter.move(room)`, after the normal entry, calls
`campaign.maybeSpawn(room)`, which:

1. Skips unless a **player character** is entering this room for the **first
   time** (the table's visited-room set).
2. Skips if the room already holds any **active (non-KO'd) mob** (no stacking).
3. Rolls `roll(100, rng) <= clamp(baseEncounterChance * room.spawnModifier, 0, 100)`.
4. On success: selects one formation weighted by `weight`, calls `build`, sets
   each minted mob's origin to `"campaign"` via `SET_ORIGIN`, and places them in
   the room.

The room is marked **visited on first entry regardless of outcome** — even if
the check is skipped (mobs already present) or the roll fails, a later return is
no longer a first visit and never rolls. Visited-marking happens before steps
2–4 so a skipped or failed first visit still "uses up" the room's one chance.

Only player-character moves trigger checks — a spawned or escaping mob moving
around never rolls a new encounter. Formations remain in the pool and may spawn
again (reusable).

---

## Files touched

- `src/lib/character/mob.ts` — escape roll, `baseEscapeChance`/`materialDrops`
  options, origin field + `SET_ORIGIN`, `onKnockOut()` override (drop logic).
- `src/lib/character/character.ts` — KO-transition detection in `#reconcile`,
  `protected onKnockOut()` no-op hook.
- `src/lib/character/history.ts` — `escape` entry gains `success: boolean`.
- `src/lib/inventory.ts` — new `SET_ORIGIN` and `STASH_DROP` symbols.
- `src/lib/loot.ts` — `STASH_DROP` seam (key-bypassing stow).
- `src/lib/room.ts` — `spawnModifier`, `mobs` constructor param, `placeMob`.
- `src/lib/encounter-table.ts` *(new)* — `Formation`, `EncounterTable`.
- `src/lib/campaign.ts` — `options.rng`, `baseEncounterChance`, composed
  `EncounterTable`, `addFormation`, `maybeSpawn`.
- `src/lib/character/player-character.ts` — `move` calls `campaign.maybeSpawn`.

## Testing

- **Escape:** succeeds/fails deterministically under injected rng at threshold
  boundaries; random exit selection; failed escape still consumes the action and
  records `success: false`; affliction fizzle/block still pre-empts the roll.
- **Drops:** KO spawns a loot box with the mob's items; materials hit the
  campaign pool; key items land in the box for room mobs and route to the
  keyring on pickup; no room → no box but materials still deposit; empty drops →
  no box; drops fire exactly once; player KO drops nothing.
- **Origin:** `placeMob`/constructor sets `"room"`; spawned mobs set
  `"campaign"`; origin is not publicly settable.
- **Formations:** `addFormation` rejects a key-item-dropping factory; weighted
  selection is deterministic under rng; `maybeSpawn` honors first-visit,
  no-stacking, and `baseEncounterChance * spawnModifier`; spawned mobs are
  placed with `"campaign"` origin; revisits and mob moves never trigger.

## Out of scope

- Turn scheduling for spawned mobs (the engine already drives `startTurn`
  externally for all characters).
- Mob AI / target selection.
- Reviving KO'd mobs.
