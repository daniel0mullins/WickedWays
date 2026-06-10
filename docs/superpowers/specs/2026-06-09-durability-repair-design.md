# Durability, Armor & Repair — Design Spec

**Date:** 2026-06-09
**Sub-project:** ③ of the crafting initiative (follows ① Material economy, ② Crafting)
**Status:** Approved design — ready for implementation plan

## Goal

Combat equipment (weapons and armor) carries numeric durability. It wears down with
use, can be authored as already worn or broken, and is repaired by spending raw
materials from the party pool. As part of this, armor gains a real damage-mitigation
role in combat — the natural hook that makes armor wear meaningful.

## Scope

One coherent implementation plan. The three concerns — durability state, armor's
combat role, and repair — are tightly coupled around the same item state and the same
two combat methods (`Combatant.attack`, `Character.takeDamage`), so they are built
together rather than split.

In scope:
- Numeric durability on items that carry `maxDurability` (weapons and armor in practice).
- Weapon wear on attack; armor wear on mitigating a hit.
- Armor mitigation in `takeDamage`.
- A free `Character.repair` action with a proportional material cost.
- Authoring items as found-worn / found-broken via an initial durability value.

Out of scope (YAGNI for v1):
- Per-item wear rates (wear is a flat −1; fragility is expressed via a lower `maxDurability`).
- Durability on non-combat items (keys, consumables, throwables) — they have no
  `maxDurability` and never wear or break.
- Auto-unequip on break — a broken item stays equipped but inert.
- Repairing partway to a chosen durability — repair always restores to full.
- **Equipment slots & handedness** (hand limits, two-handed weapons, armor slots for
  head/torso/legs/feet/wrists, rings) — **deferred to sub-project ④** as an independent
  subsystem. Durability is intentionally slot-agnostic: it only reads `properties.equipped`
  and never auto-unequips, so a future slot system layers on top without reworking
  durability (a broken item simply keeps occupying its slot).

## Durability model

Numeric points. An item that defines `maxDurability` starts at full durability and
loses points with use. At `0` it is **broken**: inert until repaired.

- `maxDurability` is **flat −1 per use**, regardless of attack strength or which item it
  is. An item's lifespan is exactly `maxDurability` uses.
- Items without `maxDurability` have no durability concept at all (`isBroken` is always
  `false`, they never wear, and `repair` rejects them).

### Item data model (`src/lib/inventory.ts`)

Add to the `IItem` interface and `Item` class:

- `maxDurability?: number` — authored, immutable. Absent ⇒ the item has no durability.
- `durability?: number` — current value. Defaults to `maxDurability` when not authored;
  may be authored lower (worn) or `0` (broken). Publicly read-only.
- `get isBroken(): boolean` — `true` iff `maxDurability` is defined and `durability === 0`.
- A privileged, symbol-keyed setter that clamps to `[0, maxDurability]`, following the
  existing `CLAIM` / `DEPOSIT_MATERIALS` / `DEPLETE` pattern. Only engine-internal paths
  (wear during combat, repair) call it. Direct assignment is not part of the public API.

The constructor descriptor accepts `maxDurability?` and an optional initial
`durability?`. When `maxDurability` is present and `durability` is omitted, current
durability initializes to `maxDurability`. `createKey` is unaffected (keys carry no
durability).

**Invariants:**
- `0 ≤ durability ≤ maxDurability` always (enforced by the clamping setter).
- An item with `durability` defined also has `maxDurability` defined.

## Combat integration

### Weapon wear — `Combatant.attack` (`src/lib/character/combatant.ts`)

- Broken weapons (`isBroken`) contribute **no** modifier to the attack matrix — they are
  treated as not equipped for damage purposes.
- After damage resolves, each equipped, non-broken weapon that contributed wears **−1**.
- The unarmed fallback (strength-1 to health when no usable weapon is equipped) is
  unchanged. Note a fully-broken equipped weapon means the character effectively fights
  unarmed.
- A weapon at `durability 1` lands its full hit (it is non-broken at attack time), then
  drops to `0` and is broken for the next attack.
- With multiple weapons equipped, each independently wears −1 per attack.

### Armor mitigation + wear — `Character.takeDamage` (`src/lib/character/character.ts`)

Current formula:

```
final = attackStrength * (MAX_STAT − mitigatorStat) * MITIGATION_PER_POINT
```

New formula — armor reduces the **raw** strength before the stat multiplier, mirroring
how attacking weapons add to raw strength:

```
armorSum = Σ modifier over equipped, non-broken armor where stat === attackStat
raw      = max(0, attackStrength − armorSum)
final    = raw * (MAX_STAT − mitigatorStat) * MITIGATION_PER_POINT
```

- Only equipped, non-broken armor whose `stat` matches the attacked stat contributes.
- Each contributing armor piece wears **−1** for the hit it helped absorb (even if `final`
  reaches 0 — it still absorbed the blow).
- Armor-less calls leave `armorSum = 0`, preserving today's behavior exactly, so existing
  `takeDamage` tests remain green.

This change lives on `Character.takeDamage`, so it applies uniformly to every character.
`Combatant` and `Mob` inherit `attack` and `takeDamage` unchanged, so weapon wear and
armor mitigation apply to players and mobs alike with no special-casing.

## Repair (`src/lib/character/character.ts`)

New method `Character.repair(item: IItem): void`.

- **Free action** — it does not tick the action budget or record history. It uses the
  low-level material path (`campaign.withdrawMaterials`, established by the material
  economy) and the durability setter directly, not the budget-ticking
  `addToInventory` / `recordAction` paths.
- **Guards, all checked before anything is spent** (so a rejected repair costs nothing):
  1. The item is held by this character. Otherwise throw `ProceduralViolation`.
  2. The item has durability (`maxDurability` defined). Otherwise throw `ProceduralViolation`.
  3. The item is actually damaged (`durability < maxDurability`). Otherwise throw
     `ProceduralViolation` (nothing to repair).
  4. The party pool can afford the cost (`campaign.canAfford(cost)`). Otherwise throw
     `ProceduralViolation`.
- **Cost** — proportional to the missing fraction, per component, rounded up:

  ```
  missing      = maxDurability − durability
  cost[c]      = ceil(recipe[c] * missing / maxDurability)   for each component c in recipe
  ```

  A fully-broken item (`missing === maxDurability`) costs exactly its full recipe; light
  wear costs little. Because of the `ceil`, every component present in the recipe costs
  **at least 1** whenever the item is damaged — so even one point of wear costs a minimum
  of 1 of each recipe component. An item with an empty recipe therefore repairs for free
  (a degenerate authoring case, not a concern).
- **Effect** — `campaign.withdrawMaterials(cost)`, then set durability to `maxDurability`
  (full restore) via the privileged setter.

## Authoring found-broken / found-worn items

No new authoring path. Author an item with `maxDurability` and an initial `durability`
(`0` = broken, between = worn) and place it in loot / rooms exactly as today. Such items
are inert (broken) or partially worn until repaired.

## Error handling

All illegal operations throw `ProceduralViolation` (the established engine error), and do
so before mutating any state:
- Repairing an unheld item, a durability-less item, an undamaged item, or one the party
  cannot afford.
- The durability setter clamps rather than throwing, so combat wear can never drive
  durability below 0 or a repair above max.

## Testing strategy

Unit tests:
- Durability getters and the clamping setter (floor at 0, ceiling at max); `isBroken`.
- Constructor: defaults `durability` to `maxDurability`; honors an authored lower/zero value.
- Weapon wear: an attack decrements each contributing weapon by 1; a weapon breaks after
  `maxDurability` attacks; a broken weapon contributes no damage; multiple weapons each
  wear independently.
- Armor mitigation: equipped matching armor reduces damage per the raw-strength formula;
  non-matching-stat armor and broken armor do not mitigate; armor-less behavior is
  unchanged.
- Armor wear: a mitigated hit decrements each contributing armor piece by 1; armor breaks
  after `maxDurability` hits.
- Repair: proportional `ceil` cost math (including the fully-broken = full-recipe case and
  components that round to 0); full restore; free action (no history); each guard throws
  and spends nothing (unheld / no durability / undamaged / unaffordable).
- Authoring: a found-broken weapon starts `isBroken` and contributes nothing; a found-worn
  item starts below max.

Integration seam: equip a weapon and a piece of armor, fight until the weapon breaks
(verify it then contributes nothing), repair it from a stocked pool (verify the pool is
debited and the weapon is effective again), and confirm armor mitigates and wears over the
same fight.

## Reused existing API

- `Campaign.canAfford(materials)`, `Campaign.withdrawMaterials(materials)` — repair cost.
- `MaterialMap`, item `recipe` — basis for the proportional cost.
- The `Symbol("…")` privileged-mutator convention — for the durability setter.
- `Combatant.attack`, `Character.takeDamage` — the wear/mitigation hooks.
