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

- **④a — Equipment slots & handedness:** slot model (item slot *kinds* + the character's
  named, single-occupancy slots), validated `equip`/`unequip` with auto-swap, two-handed
  weapons, the `accessory` item type and the finger slots. This alone makes equipping bounded
  (the existing attack/armor filters become naturally capped because you can no longer
  over-equip).
- **④b — Passive ring effects:** the effective-stat layer — worn rings add their `modifier`
  to the wearer's effective stat, and the combat/status stat reads consume the effective
  value. Depends on ④a (rings must exist as equippable slot items first).

Out of scope (YAGNI / deferred): per-character anatomy variation and losing individual named
slots (humanoid default slot set is fixed); non-ring accessory effects; accessory durability;
equipping
costing an action (it stays free, as today).

---

## ④a — Equipment slots & handedness

### Slot kinds vs. named slots

The model separates the **kind** of slot an item fits from the **named, single-occupancy
slot positions** a character actually has. This is what makes the anatomy addressable: a
future spec can remove an individual named slot (a lost finger/limb) without touching item
data.

- **`SlotKind`** (the category an item fits): `Hand`, `Finger`, `Wrist`, `Head`, `Torso`,
  `Legs`, `Feet`.
- **`EquipmentSlot`** (a character's discrete, named positions, each holding ≤ 1 item):
  `Head`, `Torso`, `Legs`, `Feet`, `LeftWrist`, `RightWrist`, `LeftHand`, `RightHand`,
  `LeftIndexFinger`, `LeftRingFinger`, `RightIndexFinger`, `RightRingFinger`.
- A constant `SLOT_KIND: Record<EquipmentSlot, SlotKind>` maps each named slot to its kind
  (e.g. `LeftIndexFinger → Finger`, `RightHand → Hand`, `LeftWrist → Wrist`).

### Item slot fields (`src/lib/inventory.ts`)

- New `ItemType` value: `accessory` (rings, and future trinkets). Keeps rings out of the
  `weapon`/`armor` combat filters, which key on `type`.
- `Item` / `IItem` gain (authored, optional, immutable):
  - `slot?: SlotKind` — the kind of slot the item fits. Absent ⇒ not slot-equippable.
  - `twoHanded?: boolean` — weapons only; a two-handed weapon occupies BOTH hand slots
    (`LeftHand` + `RightHand`).
- Threaded through the constructor descriptor exactly like the durability fields.
- Authoring: weapon → `slot: Hand` (+ optional `twoHanded: true`); armor → a body kind
  (`Head`/`Torso`/`Legs`/`Feet`/`Wrist`), still `type: "armor"`, still mitigates per ③;
  ring → `type: "accessory"`, `slot: Finger` (its `stat`/`modifier` are its future buff,
  inert until ④b).

### Character anatomy (`src/lib/character/character.ts`)

A character has a fixed default set of the named `EquipmentSlot`s above (humanoid: head,
torso, legs, feet, two wrists, two hands, **two rings per hand** on the index and ring
fingers — four finger slots total). Each named slot holds at most one item; a two-handed
weapon spans both hand slots. The character tracks occupancy in an equipment map
`Map<EquipmentSlot, IItem>`; `item.properties.equipped` mirrors map membership so the
existing combat filters keep working unchanged.

(Per-character/anatomy variation — non-humanoids, and the future digit/limb-loss mechanic
that removes individual named slots — is deferred. The named-slot model is chosen now
specifically so that mechanic can later drop a single slot from a character's set.)

### Validated equip / unequip (`src/lib/character/character.ts`)

The character owns equip logic (only it knows every held item and which slots are filled).
New methods:

- `Character.equip(item, targetSlot?)`:
  1. Guard: the item is held, `properties.equippable`, and has a `slot` (kind); else throw
     `ProceduralViolation`.
  2. **Eligible slots** = the character's named slots whose kind === the item's `slot` kind
     (e.g. a ring → the four finger slots; a 1-handed weapon → `LeftHand`/`RightHand`).
     If the character has no slot of that kind (e.g. a lost limb, later), throw.
  3. **Resolve the target named slot:**
     - If `targetSlot` is given, it must be an eligible slot (right kind, exists on the
       character); else throw.
     - If omitted, pick the first **free** eligible slot in a fixed canonical order; if none
       is free, **auto-swap** the occupant of the first eligible slot.
  4. **Two-handed weapons** ignore a single `targetSlot` and require both `LeftHand` and
     `RightHand`; auto-swap displaces whatever occupies either hand.
  5. Place the item: set the equipment map for the slot(s), mark it equipped (firing the
     item's existing `equip` action / `onEquip`). A displaced occupant is unequipped first.
- `Character.unequip(item)`: find the item's slot(s) in the equipment map, clear them, mark
  it unequipped (firing `unequip`/`onUnequip`). Guard: item is held and currently equipped.
- Both are **free** (not registered as budgeted actions; no `recordAction`) — matching how
  equipping behaves today.
- Displaced items remain in inventory, simply `equipped === false` (and absent from the map).

`Character.equip`/`unequip` become the sanctioned entry points; the raw item-level
`actions.equip` is rerouted to flow through them so slot capacity can't be bypassed.

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

- `slot` (kind) / `twoHanded` authoring and threading; the `SLOT_KIND` map covers every
  named slot.
- Single-occupancy: equipping into an empty named slot fills it; equipping another item of
  that kind into an occupied slot auto-swaps the occupant (e.g. a second helm displaces the
  first from `Head`).
- Auto-assign vs. explicit target: with `targetSlot` omitted, a ring goes to the first free
  finger; with all four fingers full, the first finger's ring is displaced. With `targetSlot`
  given, the ring lands on that exact finger (and a wrong-kind or absent target throws).
- Two rings per hand: the four finger slots fill, then auto-swap; a fifth ring can't add a
  fifth finger.
- Hands: two 1-handed weapons fill `LeftHand`/`RightHand`; a two-handed weapon displaces
  both; equipping a 1-handed weapon while a two-handed is worn displaces the two-handed one.
- Displaced items stay in inventory, unequipped, and out of the equipment map.
- Guards throw (unheld / non-equippable / slot-less / no-such-slot-kind / bad targetSlot /
  unequip-not-equipped).
- equip/unequip record no history (free).
- The attack/armor sums are now bounded by the named slots (regression: you can't stack a
  third weapon into the attack).

---

## ④b — Passive ring effects (effective-stat layer)

### Effective stat (`src/lib/character/character.ts`)

- New `Character.effectiveStat(stat: StatType): number` =
  `this.stats[stat]` + Σ `modifier` of equipped items where `type === "accessory"` (i.e.
  rings, slot kind `Finger`) and `item.stat === stat`. Additive (with two fingers per hand,
  up to four +2-Sanity rings ⇒ +8). Base stats are never mutated.
- Rings reuse the existing `stat`/`modifier` fields: a ring authored
  `{ type: "accessory", slot: Finger, stat: Sanity, modifier: 2 }` grants **+2 effective
  Sanity** while worn.

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
- Additivity across multiple rings; interplay with the four finger slots from ④a (a fifth
  ring auto-swaps rather than stacking a fifth bonus).

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
