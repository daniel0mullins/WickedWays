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
  `move(room)`, `takeDamage(...)`, crafting and gear (`craft`, `repair`, `equip`, `unequip`),
  the keyring (`transferKey`, `consumeKey`), and the turn lifecycle (`startTurn` / `endTurn`).
- [`Combatant`](src/lib/character/combatant.ts) adds `attack(target)` (see Combat below) and
  is shared by player characters and mobs.
- [`PlayerCharacter`](src/lib/character/player-character.ts) adds `joinCampaign()` and
  co-located loot interaction: `openLootBox`, `takeFromLootBox`, `putInLootBox`.
- [`Mob`](src/lib/character/mob.ts) is an enemy with a smaller default budget (2 actions,
  2 inventory slots), a `drops` list, and `escape()` — a Health-gated roll (see Mob encounters
  below). It also tracks an `origin` (`"room"` / `"campaign"` / `"unbound"`) that controls
  whether it drops key items on defeat.
- [`NonPlayerCharacter`](src/lib/character/non-player-character.ts) stays on `Character`
  directly and exposes `dialogue(prompt?)` over a list of dialogue blocks.

### Character archetypes

Player characters choose an [`Archetype`](src/lib/archetype.ts) during setup. Archetypes are
authored, declarative descriptors registered on the campaign via `Campaign.registerArchetype`
(idempotent by id, like recipes), and a character adopts one with
`PlayerCharacter.selectArchetype(id)`. Selecting an archetype modifies the character's baseline
exactly once: `statModifiers` are added to the base stats, `inventorySlots` adjusts inventory
capacity (floored at 0), and `immunities` become a standing passive trait — a new source unioned
with equipped-gear immunities (Panic/Fear/Confused only; KO is never immunizable).

Selection is **once-only** and **setup-only** (it throws after the campaign begins), and
`Campaign.beginCampaign()` throws unless **every** party member has chosen an archetype — the same
shape as the existing GM-membership requirement.

### Rooms, the map, and scenes

- A [`Room`](src/lib/room.ts) has a description, a `loot` map, an `exits` map keyed by compass
  `Direction`, occupants, and a `spawnModifier` (default 1; 0 = never spawns) that scales the
  campaign's base encounter chance. `Room.placeMob` seats a mob as a room-attached resident
  (origin `"room"`), enabling key-item drops on defeat. Entering or exiting a room fires any
  [`Scene`](src/lib/scene.ts) registered for that phase.
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
- [`Item`](src/lib/inventory.ts) carries a type (weapon, armor, accessory, consumable,
  throwable, key), recipe, modifier, target stat, and properties
  (equippable/equipped/destroyable/usable), plus actions: `pickUp`, `equip`, `unequip`,
  `transfer`, `use`, `destroy`. Optional authored fields layer on behaviour: `maxDurability`
  (gear that wears), `slot` / `twoHanded` (equipment slots and handedness), `keyCode` /
  `consumeOnUse` (keys), and `teaches` (a recipe imparted to the party on pickup).
- Both characters and loot boxes are **item holders**. State that must not be forged is
  symbol-keyed: ownership through `HELD_BY` (read-only) and `CLAIM`, durability through
  `SET_DURABILITY`, and equip/unequip through `EQUIP` / `UNEQUIP` — so external code can't
  silently re-point a holder, refill durability, or bypass slot capacity.

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

Equipped, intact armor whose `stat` matches the attacked stat first subtracts its `modifier`
from the incoming strength (floored at 0); the remainder is then scaled by the *mitigating* stat
(max value 10):

```
mitigated   = max(0, attackStrength − armorModifiers)
finalDamage = mitigated × (10 − mitigator) × 0.2
```

So a fully-rested mitigator (10) absorbs all damage, while a depleted one (0) doubles it. Each
armor piece that absorbs a hit loses 1 durability and stops mitigating once it breaks (see
Durability below).

### Status effects

Statuses are triggered by stat thresholds (using effective stats — base plus any equipped-accessory bonuses):

- **KO** — Health ≤ 0
- **Panic** — Sanity ≤ 0
- **Fear** — 0 < Sanity < 5
- **Confused** — Energy ≤ 0 (with a (0, 1] hysteresis band so it does not flicker at the boundary)

A character with no active afflictions reports `isNormal === true`.

#### Consequences

Once triggered, statuses impose hard rules enforced by [`Afflictions.gate`](src/lib/character/afflictions.ts)
inside `Character.attemptAction`:

| Status | Allowed | Blocked |
|--------|---------|---------|
| **KO** | nothing — every gated action throws; `use` also throws | everything |
| **Panic** | `move`, `use` | all other actions |
| **Fear** | everything except `move` | `move` |
| **Confused** | all actions — but each has a 50 % chance to **fizzle** | — |

A **fizzle** (Confused) means the action has no effect but the attempt still consumes a budget slot and is
recorded in history as a `fumble`. Free actions (craft, equip, repair …) that fizzle return `null` / void
and still record a `fumble` to history — they just do not consume a budget slot. KO supersedes all other
statuses: when Health drops to ≤ 0 the engine clears Panic, Fear, and Confused immediately so only KO
remains active.

#### Self-clearing

Panic, Fear, and Confused are *latched* — they persist even if the stat that triggered them recovers
partially. Each status has two clearing paths:

1. **Stat recovery:** when the effective stat rises back above its threshold (e.g. Health above 0),
   `applyFromStats` clears the status immediately.
2. **Early shake-off (per-turn roll):** at the start of each of the character's turns,
   [`Afflictions.onTurnStart`](src/lib/character/afflictions.ts) rolls a
   [`roll(100, rng)`](src/lib/dice.ts) d100 against an escalating threshold:

   | Status | 1st turn | 2nd turn | 3rd turn | Guaranteed by |
   |--------|----------|----------|----------|---------------|
   | Fear | 40 % | 70 % | 100 % | turn 3 |
   | Panic | 20 % | 40 % | 60 % | turn 5 |
   | Confused | 15 % | 30 % | 45 % | turn 7 |

   A successful roll marks the status *shaken off* for the rest of that depressed episode; it does not
   re-trigger until the stat recovers past the threshold and drops again. Confused separately rolls its
   50 % per-action fizzle chance independently of the turn-start shake-off.

Status lifecycle is managed by the [`Afflictions`](src/lib/character/afflictions.ts) unit, which
`Character` delegates to. All randomness goes through the injected `rng` (a `() => number` constructor
option); passing a seeded RNG makes every roll deterministic for tests.

#### Immunity

Passive and timed immunity both cover Panic, Fear, and Confused only — KO can never be immunized:

- **Passive (equipped item):** an [`IItem`](src/lib/inventory.ts) with an `immunities?: Status[]` field
  confers immunity to those statuses while the item is equipped and intact. Consulted on every
  `applyFromStats` reconciliation, exactly like the accessory effectiveStat bonuses.
- **Timed (consumable):** an `IItem` with a `grantsImmunity?: { statuses: Status[]; turns: number }` field
  grants immunity for `turns` of the holder's turns when the item is used. The grant goes through the
  [`GRANT_IMMUNITY`](src/lib/inventory.ts) symbol seam (unforgeable by stray code); the timer ticks down
  in `Afflictions.onTurnStart` and the active status is cleared on grant.

Both fields are plain declarative `Item` descriptor fields — no factory or subclass required.

### Combat

`Combatant.attack(target)` collects the attacker's *equipped weapons*, sums each weapon's
modifier onto the stat it targets, and applies the result to the defender via `takeDamage`
(which runs the mitigation above). With no equipped weapon, an attack deals 1 point of
unarmed Health damage. Because weapons occupy hand slots (see Equipment below), an attacker
fields at most two one-handed weapons — or one two-handed — so the summed modifier is
naturally bounded.

### Mob encounters & loot

#### Mob origin

A mob's **origin** (`"room"` | `"campaign"` | `"unbound"`) gates which drops it releases on
defeat. Room-attached mobs (seated via `Room.placeMob`, which sets origin `"room"`) may drop
key items; campaign-roving mobs (spawned by the encounter table, origin `"campaign"`) never do.
A freshly constructed mob starts as `"unbound"` until the engine sets its origin.

#### Drop-on-defeat

When a mob's Health hits 0, its `onKnockOut` hook fires exactly once:

1. **Material drops** — any `materialDrops` in the mob's options are deposited into the
   campaign's shared material pool via `DEPOSIT_MATERIALS`.
2. **Item loot box** — held items are relinquished and placed into a fresh `Loot` box
   (named `"<mob>'s remains"`) which is added to the mob's current room. If the mob has
   no items and no keys to drop, no box is created.
3. **Key items** — if the mob is room-attached (`origin === "room"`), keys on its keyring
   are also stashed into the box via the `STASH_DROP` seam (past normal capacity, bypassing
   the key-exclusion guard on regular `stowItem`). Campaign-roving mobs never drop keys.

#### Escape

`Mob.escape()` is a budgeted action gated by Health. The success threshold is:

```
threshold = clamp(baseEscapeChance + effectiveStat(Health), 0, 100)
```

`baseEscapeChance` defaults to 50. A `roll(100)` at or below the threshold — **and** at
least one exit present — counts as a successful escape; the mob then moves through a randomly
chosen exit (gating suppressed, so the move does not consume a second action). Whether the
escape succeeds or fails, the action is recorded and the budget ticks.

#### Roving formations and the encounter table

`Campaign.addFormation` registers a weighted [`Formation`](src/lib/encounter-table.ts) — a
named factory (`build`) and a positive `weight`. The table rejects any formation whose mobs
carry key-item drops (roving mobs may not drop keys). `Campaign` is constructed with an
optional `baseEncounterChance` (default 20, on a 0–100 scale) and an injectable `rng`.

When a player character moves into a room, `PlayerCharacter.move` calls `Campaign.maybeSpawn`.
The spawn check runs only on the **first visit** to each room (the room is marked visited
regardless of outcome) and is suppressed when an active (non-KO) mob is already present. If
the check proceeds:

```
threshold = clamp(baseEncounterChance × room.spawnModifier, 0, 100)
roll(100) <= threshold  →  weighted formation chosen  →  mobs built + placed (origin "campaign")
```

A room with `spawnModifier = 0` can never spawn an encounter. Blocked or fizzled moves (e.g.
a Confused character whose move fizzles) do not reach the destination room and therefore do
not trigger a spawn check.

### Materials and crafting

Crafting components are pooled at the **campaign** level and shared party-wide, not held per
character. The pool ([`MaterialMap`](src/lib/inventory.ts)) is fed only through sanctioned paths
— destroying (scrapping) an item deposits its `recipe`, harvesting a material cache, and one-time
`Campaign.claimMaterials(claimId, …)` grants (idempotent by `claimId`, so a cache can't be
farmed). `Campaign.materials` exposes a read-only copy; `canAfford` / `withdrawMaterials` gate
spending, and a component is deleted from the pool when it reaches zero. All deposits go through
the `DEPOSIT_MATERIALS` symbol.

`Character.craft(recipeId)` turns a known recipe into an item and is a **free** action (no budget
tick, no history); it returns `null` if the attempt fizzles while the character is Confused. A
[`CraftingRecipe`](src/lib/inventory.ts) is discriminated into two tracks: a
**materials** recipe withdraws from the pool, while a **keys** recipe consumes keys by code
(validated atomically — every code must be fully available before any key is spent). Recipe
knowledge is party-wide: picking up an item whose `teaches` field names a recipe calls
`Campaign.discoverRecipe()` (idempotent by id), so the whole party can then craft it.

### Durability and repair

Gear authored with `maxDurability` wears with use. Armor loses 1 durability each time it absorbs
a hit and stops mitigating once `isBroken` (durability 0). Durability is read publicly but written
only through the `SET_DURABILITY` symbol, which clamps to `[0, maxDurability]`. `Character.repair(item)`
restores a held, damaged item to full for a material cost proportional to the missing fraction —
`ceil(recipe[c] × missing ∕ maxDurability)` per component — drawn from the campaign pool. Repair is
**free** and throws if the item is unheld, has no durability, is already full, or the party can't
afford it.

### Equipment slots and handedness

Equipping is bounded by named anatomy rather than an unlimited flag. An item declares a slot
**kind** ([`SlotKind`](src/lib/equipment.ts): hand, finger, wrist, head, torso, legs, feet); a
character has discrete, single-occupancy **named slots** ([`EquipmentSlot`](src/lib/equipment.ts))
— head/torso/legs/feet, two wrists, two hands, and two ring fingers per hand.
`Character.equip(item, targetSlot?)` validates that the item is held, equippable, and has a slot
kind, then fills the first free named slot of that kind (or an explicit `targetSlot`),
**auto-swapping** the occupant when none is free. A `twoHanded` weapon spans both hand slots, and
equipping a one-handed weapon displaces a worn two-hander; `Character.unequip(item)` clears every
slot the item occupies. Both are **free** and leave displaced items in inventory, unequipped.

Occupancy lives in the character's slot map but mirrors `properties.equipped`, so the combat
filters are unchanged — and now naturally capped. The item's own `actions.equip` routes a slotted
item through `Character.equip` (finishing via the `EQUIP` / `UNEQUIP` symbols), so slot capacity
can't be bypassed even through the item's own API.

### Keys

Keys ([`createKey`](src/lib/inventory.ts)) are a distinct item type that lives on a character's
keyring rather than in inventory slots. A key carries a `keyCode` matched by scene/lock gates and a
`consumeOnUse` flag. Keys are **transfer-only**: the generic drop path rejects them, so the only way
a key changes hands is `Character.transferKey(key, recipient)` (recorded as a pickup on the
recipient). `Character.consumeKey(key)` spends a key — removing it from the keyring and unhoming it
— used by scene scripts when a `consumeOnUse` gate is satisfied.

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
- **Tests:** [Vitest](https://vitest.dev) — 446 tests across 20 files, including an end-to-end
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
