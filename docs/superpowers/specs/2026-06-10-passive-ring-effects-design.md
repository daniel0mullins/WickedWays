# Passive Ring Effects (Effective-Stat Layer) — Design Spec

**Date:** 2026-06-10
**Sub-project:** ④b of the crafting/equipment initiative (follows ① material economy, ② crafting, ③ durability/armor/repair, ④a equipment slots & handedness)
**Status:** Approved design — pending user review

## Goal

Worn accessories (rings) passively buff the wearer's stats while equipped. A character's
combat mitigation and status thresholds read an **effective** stat — the base stat plus the
`modifier` of every equipped accessory targeting that stat — without ever mutating the base.
Removing a ring removes its bonus.

## Background (current state, after ④a)

- ④a added the `accessory` item type and the `Finger` slot kind; rings are authored
  `{ type: "accessory", slot: "finger", stat, modifier }` and equip into the four finger slots
  (two per hand). Their `stat`/`modifier` are inert today — equipping a ring changes nothing
  about combat or status.
- All gating stat **reads** live in `src/lib/character/character.ts`:
  - **Damage mitigation** (`takeDamage`, character.ts:580) reads the mitigator stat:
    `const mitigator = this.stats[MitigatorStatType[attackStat]]`, then
    `damageMultiplier = (MAX_STAT - mitigator) * MITIGATION_PER_POINT` (`MAX_STAT = 10`,
    `MITIGATION_PER_POINT = 0.2`). Damage is applied to the **base** stat.
  - **Status resolution** (`#resolveStatuses`, character.ts:186–213) reads Health/Sanity/Energy
    against the KO/Panic/Fear/Confused thresholds **and**, in the same `if`, floors each base
    stat at 0.
- Mitigation cycle (`stats.ts`): `MitigatorStatType` = Health←Sanity, Sanity←Energy,
  Energy←Health (a stat's mitigator defends incoming damage to it).
- `#resolveStatuses` runs on `takeDamage`, `startTurn`, and `endTurn` — **not** on
  equip/unequip (equipping is a free slot operation in ④a).

## Scope

This is the second and final plan of sub-project ④ (one implementation plan, its own PR). It
adds the effective-stat layer and reroutes exactly two reads. It depends on ④a (rings must
exist as equippable Finger-slot accessories first).

**In scope:** `Character.effectiveStat(stat)`; rerouting the mitigation read and the status-
threshold reads through it; the use-site clamp that prevents negative damage.

**Out of scope (YAGNI / deferred):** a generalized buff/debuff/modifier layer (nothing but
accessories feeds effective stats yet); accessory durability; non-ring accessory effects;
capping the effective value itself; any equip→status coupling.

---

## Design

### Effective stat (`src/lib/character/character.ts`)

New method on `Character`, declared on `ICharacter`:

```
effectiveStat(stat: StatType): number
  = this.stats[stat]
  + Σ item.modifier  for each item in this.inventory.items where
      item.properties.equipped && item.type === "accessory" && item.stat === stat
```

- **Compute-on-read** — no cached state, no invalidation. The accessory set is tiny (≤ 4
  rings, per ④a's four finger slots), and the two consumers read infrequently, so summing on
  demand is free. `effectiveStat` is itself the seam any future buff source would plug into,
  so the simplest form loses nothing.
- **Uncapped** — returns the raw sum, which may exceed `MAX_STAT`. Capping is the use site's
  responsibility, not this method's.
- **Base is never mutated.** Pure read over base stats + worn accessories. A character with no
  accessories returns its base stat exactly (`effectiveStat(x) === stats[x]`).
- **Filters on `type === "accessory"`** — consistent with how the weapon/armor combat filters
  key on `type`, so weapons and armor are never double-counted. Accessories carry no
  durability, so there is no `isBroken` check.
- A ring authored `{ type: "accessory", slot: "finger", stat: "sanity", modifier: 2 }` grants
  **+2 effective Sanity** while worn. No new item fields — reuses the existing `stat`/`modifier`.
- Additive across rings: four +2-Sanity rings ⇒ +8 effective Sanity.

### Read routing — the only two sites

Every character stat **read that gates an outcome** switches from `this.stats[x]` to
`this.effectiveStat(x)`. Exactly these two sites change; nothing else.

**(a) Damage mitigation** (`takeDamage`, character.ts:580):

```ts
const mitigator = this.effectiveStat(MitigatorStatType[attackStat]);   // was this.stats[...]
const damageMultiplier = Math.max(0, MAX_STAT - mitigator) * MITIGATION_PER_POINT;
```

- The `Math.max(0, MAX_STAT - mitigator)` is the **use-site clamp**: an effective mitigator
  above `MAX_STAT` floors the multiplier at 0 (full absorption), so a ring can never produce a
  negative multiplier — incoming damage never heals.
- A ring boosting the mitigator stat therefore reduces incoming damage.
- Damage is still applied to the **base** stat (`this.stats[attackStat] -= finalAttackStrength`)
  — unchanged. Armor subtraction and armor wear are unchanged.

**(b) Status thresholds** (`#resolveStatuses`, character.ts:186–213): restructured to separate
two concerns currently tangled in one `if` — base flooring vs. status evaluation.

```ts
// 1. Floor each BASE stat unconditionally (previously done inside the status branch).
this.stats[StatType.Health] = Math.max(0, this.stats[StatType.Health]);
this.stats[StatType.Sanity] = Math.max(0, this.stats[StatType.Sanity]);
this.stats[StatType.Energy] = Math.max(0, this.stats[StatType.Energy]);

// 2. Evaluate status flags against EFFECTIVE values.
//    KO       : effectiveStat(Health) <= 0
//    Panic    : effectiveStat(Sanity) <= 0
//    Fear     : 0 < effectiveStat(Sanity) < 5
//    Confused : effectiveStat(Energy) <= 0   (preserve the existing `> 1` hysteresis gap:
//               Confused is cleared only when effective Energy > 1, left unchanged in (0, 1])
```

- A worn +Health ring keeps effective Health > 0 and staves off KO at base 0; a +Sanity ring
  above the Fear threshold prevents Fear; etc.
- **Flooring the base unconditionally is behavior-preserving**: `Math.max(0, base)` clamps
  exactly when `base <= 0`, the same condition that previously triggered the floor — it is just
  decoupled from the (now effective-gated) status flag.

### Timing — lazy status

Status is **lazy**: `Character.equip`/`unequip` remain pure slot operations and do **not** call
`#resolveStatuses()`. Effective stats change immediately for mitigation (read live in
`takeDamage`), but status flags refresh only at the next `takeDamage` / `startTurn` / `endTurn`.
So a life-saving ring donned mid-affliction clears the affliction at the next resolution
trigger, not the instant it is equipped; removing it re-applies the affliction at the next
trigger. This avoids coupling the equipment subsystem to status resolution.

### Behavior preservation

With no accessories equipped, `effectiveStat(x) === stats[x]`, so both rerouted sites compute
exactly as before. All existing mitigation and status tests stay green; the base-floor
restructure is value-identical.

## Error handling

None new. `effectiveStat` is a total function — no throws, no guards. A character with no
matching accessories returns its base stat.

## Testing

- **`effectiveStat`**: sums the `modifier` of equipped accessories whose `stat` matches; ignores
  accessories of other stats, unequipped accessories, and non-accessories (a worn weapon/armor
  with the same `stat` is not counted); leaves base unchanged; sums additively across multiple
  rings.
- **Mitigation**: a ring on the mitigator stat reduces incoming damage (compare the same hit
  with and without the ring); an over-cap effective mitigator floors the multiplier at 0 (full
  absorption — damage is 0, never negative/healing); damage still subtracts from the base stat.
- **Status (lazy)**: a +Sanity ring lifting effective Sanity past the Fear threshold prevents
  Fear at the next resolution trigger; a +Health ring keeps effective Health > 0 so a base-0
  character is not KO'd after a hit; unequipping the ring re-KOs at the next trigger. The base
  floor still applies (base reads 0).
- **Lossless**: equip → take damage (base drops) → unequip; base reflects only the real damage
  taken (no ring bonus baked in), effective reflects rings while worn.
- **Seam (integration)**: end-to-end — equip rings into finger slots, confirm both mitigation
  and status read the effective value, and that ④a's four-finger cap bounds the bonus (a fifth
  ring auto-swaps rather than stacking a fifth modifier).

## Reused existing API / patterns

- The `stat`/`modifier` item fields (rings reuse them, as durability/teaches reused the
  descriptor threading).
- `MitigatorStatType`, `MAX_STAT`, `MITIGATION_PER_POINT`, `#resolveStatuses`, `takeDamage` —
  the existing stat-read machinery this plan reroutes.
- ④a's `accessory` type, `Finger` slot kind, and four-finger slot cap.
