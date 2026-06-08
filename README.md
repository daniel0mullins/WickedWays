# Wicked Ways

![Wicked Ways](src/assets/images/wicked+ways.png)

A type-safe, turn-based tabletop RPG engine written in TypeScript. Wicked Ways models
a party-based horror campaign: a Game Master and player characters take turns across a
procedurally generated dungeon, fighting mobs, looting containers, talking to NPCs, and
accumulating damage across three interlocking stats. Game rules are enforced both by the
type system (branded IDs, hidden state) and at runtime (lifecycle guards that throw on
illegal moves).

## Core concepts

### Campaign

[`Campaign`](src/lib/campaign.ts) drives the turn loop and owns the campaign lifecycle:

- It tracks a `party` of player characters, a `gm` (always one of the party members), the
  current `round`, and `maxRounds` (default `100`).
- **Lifecycle:** `beginCampaign()` validates that the party is non-empty and that the GM is
  a member, then starts the campaign; `endCampaign()` finishes it. `nextPlayer()` advances
  the active character and ends the round once everyone has acted; the campaign auto-finishes
  when `round` reaches `maxRounds`.
- **Membership:** `addPlayer()` and `leaveCampaign()` adjust the party during play (the GM
  cannot leave), and `transfer()` hands the GM role to another member mid-campaign.
- The `gm` may only be assigned during setup; once the campaign has begun, the GM can only be
  changed via `transfer()`.
- Every illegal operation (acting before `beginCampaign()`, beginning twice, a GM leaving,
  etc.) throws a `ProceduralViolation`.

### Characters

The character hierarchy is layered so shared behavior lives in one place:

```
Character
├── Combatant (abstract)        adds attack()
│   ├── PlayerCharacter         joinCampaign, loot interaction, move action
│   └── Mob                     drops, escape()
└── NonPlayerCharacter          dialogue trees
```

- [`Character`](src/lib/character/character.ts) is the base: it holds `stats`, an `inventory`,
  a `campaign` reference, the current room, status effects, and the action-budget machinery.
  It implements the item-holder contract (`addToInventory` / `removeFromInventory`),
  `move(room)`, `takeDamage(...)`, and the turn lifecycle (`startTurn` / `endTurn`).
- [`Combatant`](src/lib/character/combatant.ts) adds `attack(target)` (see Combat below) and
  is shared by player characters and mobs.
- [`PlayerCharacter`](src/lib/character/player-character.ts) adds `joinCampaign()` and
  co-located loot interaction: `openLootBox`, `takeFromLootBox`, `putInLootBox`.
- [`Mob`](src/lib/character/mob.ts) is an enemy with a smaller default budget (2 actions,
  2 inventory slots), a `drops` list, and `escape()` — which flees through the first available
  exit. (`escape` is intentionally simple: it takes the first exit, with no pathfinding.)
- [`NonPlayerCharacter`](src/lib/character/non-player-character.ts) stays on `Character`
  directly and exposes `dialogue(prompt?)` over a list of dialogue blocks.

### Rooms, the map, and scenes

- A [`Room`](src/lib/room.ts) has a description, a `loot` map, an `exits` map keyed by compass
  `Direction`, and occupants. Entering or exiting a room fires any [`Scene`](src/lib/scene.ts)
  registered for that phase.
- [`buildMap(rooms, options)`](src/utils/build-map.ts) wires a list of rooms into a connected
  dungeon via a randomized **spanning tree** (every room reachable, `n - 1` edges). Exits are
  bidirectional (north↔south, etc.), a room is never connected to itself, and no room exceeds
  8 exits. `extraConnections` adds loops/shortcuts (an absolute count, or a fraction of `n - 1`
  when between 0 and 1), and an injectable `rng` makes generation deterministic.
- A `Scene` runs its `script(room)` only when the trigger phase (`"enter"` / `"exit"`) matches
  **and** all of its `preconditions` pass — preconditions short-circuit on the first failure.

### Loot and inventory

- [`Loot`](src/lib/loot.ts) is a fixed-capacity container (default: initial contents + 2 slots).
  `stowItem` throws `ContainerFullException` once full; `removeItems` extracts items by id.
- [`Item`](src/lib/inventory.ts) carries a type, recipe, modifier, target stat, and properties
  (equippable/equipped/destroyable/usable), plus actions: `pickUp`, `equip`, `unequip`,
  `transfer`, `use`, `destroy`.
- Both characters and loot boxes are **item holders**. Ownership is tracked through the
  `HELD_BY` symbol (read-only) and reassigned only through the `CLAIM` symbol, so external code
  can't silently re-point an item's holder.

## Key mechanics

### Action budget

Each character has an `actionsPerRound` budget (default 3 for player characters, 2 for mobs).
Only methods registered in the character's `isActionMap` count against it — methods register
themselves by identity (e.g. `move`, `attack`, `escape`, `addToInventory`,
`removeFromInventory`). `recordAction(fn)` ignores unregistered functions and, once the budget
is spent, automatically calls `endTurn()`. Notably, `takeDamage` is **not** a recordable
action — taking a hit never consumes your turn.

### Stats and damage mitigation

Characters have three stats — **Health**, **Sanity**, and **Energy** — and each is mitigated by
another in a cycle:

| Damaged stat | Mitigated by |
|--------------|--------------|
| Health       | Sanity       |
| Sanity       | Energy       |
| Energy       | Health       |

Damage scales with the *mitigating* stat (max value 10):

```
finalDamage = attackStrength × (10 − mitigator) × 0.2
```

So a fully-rested mitigator (10) absorbs all damage, while a depleted one (0) doubles it.

### Status effects

After damage resolves, [statuses](src/lib/status.ts) are recomputed from the stats:

- **KO** — Health depleted (≤ 0)
- **Panic** — Sanity depleted (≤ 0)
- **Fear** — Sanity low but not gone (0 < Sanity < 5)
- **Confused** — Energy depleted (≤ 0)

A character with no active afflictions reports `isNormal === true`.

### Combat

`Combatant.attack(target)` collects the attacker's *equipped weapons*, sums each weapon's
modifier onto the stat it targets, and applies the result to the defender via `takeDamage`
(which runs the mitigation above). With no equipped weapon, an attack deals 1 point of
unarmed Health damage.

### Dialogue

`NonPlayerCharacter.dialogue(prompt)` returns the concatenated responses of every matching
dialogue block. Blocks match either **exactly** (case-insensitive whole-prompt match) or
**fuzzily** (every word in the trigger set appears somewhere in the prompt), and each block may
carry a `precondition(character)` gate. With no prompt it returns the NPC's initial line.

## Notable patterns

- **Branded ID types** ([`brand.d.ts`](src/lib/brand.d.ts)) give `CampaignId`, `CharacterId`,
  `RoomId`, `ItemId`, `LootId`, `SceneId`, etc. distinct compile-time identities at zero runtime
  cost, so one kind of id can't be passed where another is expected.
- **Lifecycle guards** throw `ProceduralViolation` to keep the game in a legal state.
- **Hidden state** — item holders, status maps, and campaign progress are exposed through
  getters and symbol-keyed accessors rather than mutable public fields.
- **Turn events** — [`CharacterEvents`](src/lib/character/events.ts) lets handlers hook
  `onTurnStart` / `onTurnEnd` for future passive effects.

## Tech stack & workflow

- **Language:** TypeScript in `strict` mode with `NodeNext` module resolution and the extra
  `noUncheckedIndexedAccess` / `noImplicitOverride` guards.
- **Tests:** [Vitest](https://vitest.dev) — 217 tests across 13 files, including an end-to-end
  [`src/integration.test.ts`](src/integration.test.ts) that wires up a full campaign and runs
  the turn loop. Shared helpers live in [`src/test-utils.ts`](src/test-utils.ts).
- **Linting:** ESLint flat config with type-aware `typescript-eslint`.
- **Dependencies:** `uuid` for id generation; `type-fest` for utility types.

### npm scripts

| Script | Description |
|--------|-------------|
| `npm test` | Run the test suite once (`vitest run`) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage over `src/**` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `npm run lint:fix` | Lint (and autofix) |
| `npm run checks` | Lint + typecheck + test, in sequence |
| `npm run build` | Compile to `dist/` via `tsconfig.build.json` |
