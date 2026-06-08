# Combatant Base Class — Design

Date: 2026-06-08

## Problem

`PlayerCharacter.attack` and the in-progress `Mob` class both need an identical
attack. Today `attack` lives only on `PlayerCharacter`; `Mob` declares `attack`
on its `IMob` interface but implements neither `attack` nor `escape`, so `tsc`
fails (`TS2420: Class 'Mob' incorrectly implements interface 'IMob'`).

The attack logic depends only on members both classes already inherit from
`Character` (`this.inventory`, `this.recordAction`) plus the target's
`takeDamage`. So it can be shared. The goal: extract `attack` into a shared base
so `PlayerCharacter` and `Mob` reuse one implementation, and complete `Mob` so
it compiles.

## Approach

Introduce an intermediate `Combatant` base class between `Character` and the two
attacking classes. (Considered and rejected: a free `resolveAttack` helper —
still duplicates the `isActionMap` registration in each class; putting `attack`
on `Character` — leaks `attack` onto `NonPlayerCharacter`, which is not a
combatant.)

```
Character
├── Combatant (attack)
│   ├── PlayerCharacter (move, loot…)
│   └── Mob (escape)
└── NonPlayerCharacter
```

## Components

### New: `src/lib/character/combatant.ts`

```ts
export interface ICombatant extends ICharacter {
  attack: <C extends ICharacter>(c: C) => void;
}

export abstract class Combatant extends Character implements ICombatant {
  constructor(
    campaign: ICampaign,
    name: string,
    stats: Stats,
    inventorySlots: number = 5,
    actionsPerRound: number = 3,
  ) {
    super(campaign, name, stats, inventorySlots, actionsPerRound);
    this.isActionMap.set(this.attack, true);
  }

  attack(c: ICharacter) {
    // verbatim from today's PlayerCharacter.attack
  }
}
```

- `attack` is moved **verbatim** from `PlayerCharacter`. It only uses
  `this.inventory.items`, `this.recordAction(this.attack)`, and
  `c.takeDamage(...)`.
- The constructor forwards all of `Character`'s parameters and registers
  `attack` as a recordable action (so every combatant counts it the same way).
- `abstract` because it is a code-sharing base, never instantiated directly.

### Changed: `src/lib/character/player-character.ts`

- `IPlayerCharacter extends ICombatant` (drop its own `attack` declaration;
  keep `joinCampaign`, `openLootBox`, `takeFromLootBox`, `putInLootBox`).
- `class PlayerCharacter extends Combatant`.
- **Delete** the `attack` method and its `this.isActionMap.set(this.attack, …)`
  line (now inherited and registered by `Combatant`). Keep the `move`
  registration and all loot methods.
- Remove imports that become unused after `attack` is gone (`StatType`,
  `typedEntries`). Keep whatever the loot methods still use.

### Changed: `src/lib/character/mob.ts`

- `IMob extends ICombatant` (drop its own `attack` declaration; keep `escape`).
- `class Mob extends Combatant` (was `extends Character`).
- Register `this.escape` in the constructor: `this.isActionMap.set(this.escape, true)`.
- Implement `escape()`:

```ts
escape() {
  const exits = [...(this.currentRoom?.exits.values() ?? [])];
  const destination = exits[0];
  if (destination) {
    this.move(destination);
  }
  this.recordAction(this.escape);
}
```

  Flee to the first available exit. No-op move when the mob has no `currentRoom`
  or the room has no exits. The existing `drops`/`inventorySlots` constructor
  handling is preserved unchanged.

## Behavior / Data Flow

- **attack:** unchanged from today. No equipped weapon → 1-point Health attack;
  equipped weapons sum their `modifier` per target stat; damage applied via the
  target's `takeDamage`; records one `attack` action.
- **escape (action accounting):** `escape` is the registered action, **not**
  `move`. `Mob` does not register `move`, so the internal `this.move(destination)`
  performs the real room transition (firing exit/enter scenes) without
  double-counting; `recordAction(this.escape)` is what consumes the turn's action.

## Testing

### Regression — proves the extraction is behavior-preserving

The existing `PlayerCharacter.attack` suite in `player-character.test.ts` (the
`describe("attack", …)` block and "registers move and attack as recordable
actions") must stay green untouched. `pc.attack` now resolves to
`Combatant.prototype.attack`, and `pc.isActionMap.get(pc.attack)` is still
`true` (registered by `Combatant`'s constructor).

### New `Mob` tests — `src/lib/character/mob.test.ts`, real objects

- **attack parity:** a `Mob` with no equipped weapon deals 1-point Health damage
  (inherited logic works for `Mob`).
- **attack is recordable:** registered via `Combatant`, counts against
  `actionsPerRound`.
- **escape flees:** a `Mob` in a room with an exit calls `escape()` and ends up
  in the adjacent room (`currentRoom` changed, occupant moved out/in).
- **escape records an action:** `escape()` consumes one action (trips `endTurn`
  at the action budget) and is registered in `isActionMap`.
- **escape no-ops safely:** `escape()` with no `currentRoom`, and with a room
  that has no exits — does not throw, still records the action.

### Gates

- `tsc --noEmit` green: `Mob` fully implements `IMob` (`attack` inherited +
  `escape` implemented).
- `npm run checks` (lint + typecheck + all tests) passes.

## Out of Scope (YAGNI)

- Moving `NonPlayerCharacter` under `Combatant` (NPCs don't attack today).
- Storing/using `Mob.drops` beyond the existing inventory-slot sizing.
- Reworking the awkward `Mob` constructor parameter order (required `drops`
  after optional params) — pre-existing, not part of this change.
- Any change to `attack` semantics or the mitigation/status mechanics.
