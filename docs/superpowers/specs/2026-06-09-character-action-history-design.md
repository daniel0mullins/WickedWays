# Character Action History — Design

Date: 2026-06-09

## Problem

Players want to see what they and their party have done up to a given point.
Today, characters take recorded actions (`attack`, `move`, `addToInventory`,
`removeFromInventory`, `takeDamage`) but nothing about those actions is
retained — `recordAction` only increments a per-round counter and is discarded.

The goal: every recorded action a character takes is appended to a per-character
history, with enough context to be meaningful ("attacked Goblin", "moved to the
Library", "took 4 sanity damage"). Since history lives on the base `Character`
class, all character types (`PlayerCharacter`, `Mob`, `NonPlayerCharacter`)
inherit it automatically.

## Decisions (from brainstorming)

- **Detail level:** action + context (not just a bare action name; not a full
  stats/status snapshot).
- **What to record:** everything that flows through `recordAction`, including the
  passive `takeDamage`. History reads as a full timeline.
- **Party view:** per-character only. Each character owns its `history`; a party
  view is consumers iterating `campaign.party` and reading each `.history`. No
  campaign-level aggregation or global sequence counter in this iteration.

## Approach

Approach A (approved): thread a typed, per-action context object through the
existing single choke point, `recordAction`.

`recordAction` is already the one place every recorded action passes through, so
extending it keeps logging and counting together and makes it impossible to
"count the action but forget to log it." (Rejected: a separate `logAction`
method — two calls per action that can drift; a name-registry `WeakMap` plus a
loose context bag — loses type safety in an otherwise strongly-typed codebase.)

## Prerequisite: add `name` to `Room` and `Item`

History entries should read with real names ("moved to the Library", "picked up
a Rusty Sword"), so the two types that lack a name gain one:

- **`IRoom` / `Room`:** add `name: string`. Constructor gains a leading `name`
  parameter: `constructor(name, description, loot, exits)`.
- **`IItem` / `Item`:** add `name: string`. The constructor's first destructured
  argument gains `name`: `{ type, recipe, modifier, stat, name }`.

Both are **required** fields. This ripples to every construction site — 13
`new Room(...)` calls and 3 `new Item(...)` calls (all in tests / map builders /
the integration test) must supply a name. Updating them is part of this work.

`ICharacter` already has `name`, so it is unchanged.

## Data model

New file `src/lib/character/history.ts`:

```ts
import { CharacterId } from "./character";
import { RoomId } from "../room";
import { ItemId } from "../inventory";
import { StatType } from "./stats";

export type ActionHistoryEntry =
  | { kind: "attack"; round: number; target: { id: CharacterId; name: string } }
  | { kind: "move"; round: number; room: { id: RoomId; name: string } }
  | { kind: "pickUp"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "drop"; round: number; items: { id: ItemId; name: string }[] }
  | { kind: "takeDamage"; round: number; amount: number; stat: StatType };

// The entry minus `round`; `round` is stamped by recordAction.
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
export type ActionDetail = DistributiveOmit<ActionHistoryEntry, "round">;

export function describeAction(entry: ActionHistoryEntry): string;
```

`ActionDetail` is a distributive `Omit` so each union member keeps its own shape
minus `round`. `describeAction` is a pure formatter that turns an entry into a
human-readable line; the library does not own any further UI concern. With the
prerequisite in place, every context object carries an `id` plus a `name`.

## `recordAction` change

```ts
recordAction(callingFn: ActionFn, detail: ActionDetail) {
  this.#history.push({ ...detail, round: this.campaign.round } as ActionHistoryEntry);

  if (this.isActionMap.get(callingFn)) {
    this.actionsThisRound = this.actionsThisRound + 1;
  }
  if (this.actionsThisRound === this.actionsPerRound) {
    this.endTurn();
  }
}
```

- `detail` is **required** — the types guarantee every recorded action carries a
  history entry.
- History is appended **unconditionally**, independent of `isActionMap`, so the
  passive `takeDamage` is logged even though it does not count toward the round.
- The interface signature on `ICharacter` changes to match.
- `round` is read from `this.campaign.round` (0 before the campaign begins).

## Call sites

The five existing `recordAction` calls each pass their detail:

- `attack` → `{ kind: "attack", target: { id: c.id, name: c.name } }`
- `move` → `{ kind: "move", room: { id: room.id, name: room.name } }`
- `addToInventory` → `{ kind: "pickUp", items: items.map(i => ({ id: i.id, name: i.name })) }`
- `removeFromInventory` → `{ kind: "drop", items: ... }`
- `takeDamage` → `{ kind: "takeDamage", amount: finalAttackStrength, stat: attackStat }`
  (the **mitigated** amount actually applied to the stat)

`PlayerCharacter.takeFromLootBox` / `putInLootBox` need no changes: they reuse
`addToInventory` / `removeFromInventory`, so a take yields exactly one `pickUp`
entry and a put exactly one `drop` entry.

## Exposure

```ts
get history(): readonly ActionHistoryEntry[];
```

on `ICharacter` and `Character`, backed by a private `#history: ActionHistoryEntry[]`.
Returned read-only so callers cannot mutate the log. A party timeline is built by
consumers iterating `campaign.party` and reading each member's `.history`.

## Testing (TDD)

- `attack` appends one `attack` entry with the target's id and name.
- `move` appends one `move` entry with the destination room's id and name.
- `addToInventory` / `removeFromInventory` append one `pickUp` / `drop` entry
  listing the affected items' id and name.
- `Room` and `Item` expose the `name` passed to their constructors.
- `takeDamage` appends one `takeDamage` entry with the **mitigated** amount and
  the correct stat.
- Entries are stored in append (chronological) order.
- Each entry's `round` matches `campaign.round` at the time of the action.
- A loot-box take produces a single `pickUp`; a loot-box put a single `drop`.
- `history` is read-only (mutating the returned array does not affect state).
- `describeAction` returns a readable string for each `kind`.

## Out of scope

- Campaign-level party aggregation / global chronological merge (deferred;
  per-character only this iteration).
- Stats/status snapshots per entry.
- Persistence / serialization of history beyond in-memory.
