# Equipment Slots, Handedness & Accessory Effects — Design Spec

**Date:** 2026-06-10
**Sub-project:** ④ of the crafting/equipment initiative (follows ① material economy, ② crafting, ③ durability/armor/repair)
**Status:** Approved design — pending user review

## Goal

Equipped gear occupies bounded, named slots instead of being unlimited. A character
has two hands (a two-handed weapon consumes both), a fixed set of armor slots, and
ring slots. Equipping into a full slot auto-swaps the conflicting item out. Worn rings
passively buff the wearer's stats while equipped.

## Background (current state)

- Equipping is a per-item boolean: `Item.actions.equip` sets `properties.equipped = true`
  with **no validation** — a character may equip arbitrarily many weapons or armor pieces.
- `Combatant.attack` sums **every** equipped weapon's `modifier`; `Character.takeDamage`
  sums **every** equipped armor piece whose `stat` matches the attacked stat. Neither caps.
- The character has **no equipment slots / anatomy** — equipped-ness lives only on each item.
- Items have no `slot` field and no handedness; there is no accessory/ring concept.
- All stat reads live in `character.ts`: damage mitigation (`takeDamage`) reads the
  mitigator stat; status resolution (`#resolveStatuses`) reads Health/Sanity/Energy against
  the KO/Panic/Fear/Confused thresholds. Damage is applied to the base stat.
- Mitigation cycle (`stats.ts`): `MitigatorStatType` = Health←Sanity, Sanity←Energy,
  Energy←Health (a stat's mitigator defends incoming damage to it).

## Scope & decomposition

One spec, **two sequential implementation plans** (each its own PR):

- **④a — Equipment slots & handedness:** slot model, per-character capacities, validated
  `equip`/`unequip` with auto-swap, two-handed weapons, the `accessory` item type and the
  `Ring` slot. This alone makes equipping bounded (the existing attack/armor filters become
  naturally capped because you can no longer over-equip).
- **④b — Passive ring effects:** the effective-stat layer — worn rings add their `modifier`
  to the wearer's effective stat, and the combat/status stat reads consume the effective
  value. Depends on ④a (rings must exist as equippable slot items first).

Out of scope (YAGNI / deferred): per-character/anatomy-configurable capacities (humanoid
defaults are fixed constants); non-ring accessory effects; accessory durability; equipping
costing an action (it stays free, as today).

---

## ④a — Equipment slots & handedness

### Slot model (`src/lib/inventory.ts`)

- New `EquipmentSlot` enum: `Hand`, `Head`, `Torso`, `Legs`, `Feet`, `Wrist`, `Ring`.
- New `ItemType` value: `accessory` (rings, and future trinkets). Keeps rings out of the
  `weapon`/`armor` combat filters, which key on `type`.
- `Item` / `IItem` gain (authored, optional, immutable):
  - `slot?: EquipmentSlot` — where the item equips. Absent ⇒ not slot-equippable.
  - `twoHanded?: boolean` — weapons only; a two-handed weapon consumes both hand slots.
- Threaded through the constructor descriptor exactly like the durability fields.
- Authoring: weapon → `slot: Hand` (+ optional `twoHanded: true`); armor → a body slot
  (`Head`/`Torso`/`Legs`/`Feet`/`Wrist`), still `type: "armor"`, still mitigates per ③;
  ring → `type: "accessory"`, `slot: Ring` (its `stat`/`modifier` are its future buff, inert
  until ④b).

### Per-character capacity (`src/lib/character/character.ts`)

A fixed default capacity map (humanoid):

```
Hand 2, Head 1, Torso 1, Legs 1, Feet 1, Wrist 2, Ring 8
```

A two-handed weapon counts as occupying **2** hand units; everything else occupies 1 unit
of its slot. (Per-character/anatomy overrides are deferred.)

### Validated equip / unequip (`src/lib/character/character.ts`)

The character owns equip logic (only it knows every held item). New methods:

- `Character.equip(item)`:
  1. Guard: the item is held, `properties.equippable`, and has a `slot`; else throw
     `ProceduralViolation`.
  2. Compute current occupants of that slot = held items with `equipped === true` and the
     same `slot`. Occupancy is summed in **units** (a two-handed weapon = 2 hand units).
  3. Required units = 2 for a two-handed weapon, else 1. If `occupiedUnits + required >
     capacity`, **auto-swap**: unequip occupants in inventory order until enough units free.
     (Equipping a 1-handed weapon while a two-handed weapon is worn frees both hands by
     displacing it; equipping a two-handed weapon displaces whatever occupies the hands.)
  4. Mark the item equipped (firing the item's existing `equip` action / `onEquip`).
- `Character.unequip(item)`: clears `equipped` (firing `unequip`/`onUnequip`). Guard: item
  is held and currently equipped.
- Both are **free** (not registered as budgeted actions; no `recordAction`) — matching how
  equipping behaves today.
- Displaced items remain in inventory, simply `equipped === false`.

`Character.equip`/`unequip` become the sanctioned entry points; the raw item-level
`actions.equip` is rerouted to flow through them so capacity can't be bypassed.

### Effect on combat filters

`Combatant.attack` and `Character.takeDamage` are **unchanged** — they still sum equipped
weapons/armor. Because equipping is now capped at equip time, those sums are naturally
bounded (≤ 2 weapons, or 1 two-handed; armor by body-slot counts). The cap is enforced
where items are equipped, not where they are consumed.

### ④a error handling

All illegal operations throw `ProceduralViolation` before mutating state: equipping an
unheld / non-equippable / slot-less item; unequipping an item that is not held or not
equipped. Auto-swap is the defined behavior for a full slot (it does **not** throw).

### ④a testing

- Slot/`twoHanded` authoring and threading.
- Capacity enforcement: equipping up to capacity succeeds; the next equip auto-swaps a
  displaced occupant (in inventory order; single-capacity slots: head/torso/legs/feet;
  multi: wrist 2, ring 8).
- Hands: two 1-handed weapons fill both hands; a third auto-swaps; a two-handed weapon
  displaces both hands; equipping a 1-handed weapon while a two-handed is worn displaces it.
- Displaced items stay in inventory, unequipped.
- Guards throw (unheld / non-equippable / slot-less / unequip-not-equipped).
- equip/unequip record no history (free).
- The attack/armor sums are now bounded by equip capacity (a regression test that you can't
  stack 3 weapons into the attack).

---

## ④b — Passive ring effects (effective-stat layer)

### Effective stat (`src/lib/character/character.ts`)

- New `Character.effectiveStat(stat: StatType): number` =
  `this.stats[stat]` + Σ `modifier` of equipped items where `slot === Ring` and
  `item.stat === stat`. Additive (four +2-Sanity rings ⇒ +8). Base stats are never mutated.
- Rings reuse the existing `stat`/`modifier` fields: a ring authored
  `{ type: "accessory", slot: Ring, stat: Sanity, modifier: 2 }` grants **+2 effective Sanity**
  while worn.

### Read routing

Every character stat **read** switches from `this.stats[x]` to `this.effectiveStat(x)`:

- **Damage mitigation** (`takeDamage`): the mitigator lookup uses `effectiveStat(mitigator)`.
  So a ring boosting the mitigator stat reduces incoming damage. Damage is still **applied to
  the base stat** (`this.stats[attackStat] -= …`), unchanged.
- **Status thresholds** (`#resolveStatuses`): the KO/Panic/Fear/Confused comparisons read
  `effectiveStat(...)`. A worn ring can therefore stave off Fear/Panic or prevent KO; removing
  it re-evaluates against the now-lower effective value.
- **Base clamping is unchanged:** `#resolveStatuses` still floors each *base* stat at 0
  (`stats[x] = max(0, stats[x])`). It clamps base, but evaluates the status *conditions*
  against the effective value. Damage application and clamping stay on base; only the
  comparisons consult effective.

(Writes — damage application and the base floor — are NOT rerouted; only reads are.)

### ④b testing

- `effectiveStat` sums equipped ring modifiers for the matching stat; ignores rings of other
  stats, unequipped rings, and non-ring items (weapons/armor are not double-counted).
- Mitigation: a +mitigator-stat ring reduces incoming damage (compare with/without the ring);
  damage still subtracts from base.
- Status: a ring lifting effective Sanity above the Fear threshold prevents Fear; unequipping
  it restores Fear. A +Health ring keeps effective Health > 0 to prevent KO at base 0;
  unequipping re-KOs.
- Lossless: equip → take damage (base drops) → unequip restores no buff to base; base reflects
  only real damage, effective reflects rings.
- Additivity across multiple rings; ring-slot capacity (8) interplay from ④a.

### Seam (④b)

An end-to-end test: equip rings into ring slots, verify mitigation and status both reflect the
effective value, auto-swap a ring at capacity, and confirm unequipping a life-saving ring
flips the wearer to KO.

---

## Reused existing API / patterns

- The `Symbol`-keyed privileged-mutator convention (if any equip-state needs guarding — the
  equipped boolean stays a public property; the new logic lives in `Character.equip`).
- `ProceduralViolation` for all illegal operations.
- The item descriptor threading pattern (durability/teaches) for `slot`/`twoHanded`.
- `MitigatorStatType`, `#resolveStatuses`, `takeDamage` — the stat-read sites ④b reroutes.
